/* =========================================================================
 * admin.js — 管理后台逻辑
 * -------------------------------------------------------------------------
 * 演示版：登录为前端口令（默认 admin888），数据来自同一浏览器的本地存储。
 * 生产版应改为云端：管理员用 WorkBuddy 账号登录，conversations 表仅管理员可读。
 * ========================================================================= */
(function () {
  const store = window.CS_STORE;
  const faqStore = window.CS_FAQ_STORE;
  const ADMIN_PASS = 'admin888'; // 演示口令；生产请改为云认证
  const LABEL_INTENT = window.CS_FAQ_CATEGORY_LABEL || {};
  const LABEL_STATUS = { ai: 'AI 处理中', transferred: '已转人工', resolved: '已解决' };
  const LABEL_CAT = { refund: '退款', order: '查询订单', tech: '技术支持', other: '其他' };

  const $ = (id) => document.getElementById(id);
  let current = []; // 当前列表（已过滤）
  let openId = null; // 当前详情会话 id

  // ---------- 登录 ----------
  if (sessionStorage.getItem('cs_admin_ok') !== '1') {
    $('loginView').style.display = 'flex';
    $('appView').style.display = 'none';
  } else {
    boot();
  }
  $('loginBtn').addEventListener('click', () => {
    if ($('loginPass').value === ADMIN_PASS) {
      sessionStorage.setItem('cs_admin_ok', '1');
      $('loginView').style.display = 'none';
      $('appView').style.display = 'block';
      boot();
    } else {
      $('loginErr').textContent = '口令错误';
    }
  });

  function fmtTime(iso) {
    const d = new Date(iso);
    return d.toLocaleString('zh-CN', { hour12: false });
  }
  function stars(n) {
    if (typeof n !== 'number' || n < 1 || n > 5) return '—';
    return '★★★★★'.slice(0, n) + '☆☆☆☆☆'.slice(0, 5 - n) + ' (' + n + ')';
  }

  async function boot() {
    await refresh();
    $('filterIntent').addEventListener('change', refresh);
    $('filterStatus').addEventListener('change', refresh);
    $('search').addEventListener('input', refresh);
    $('dateFrom').addEventListener('change', refresh);
    $('dateTo').addEventListener('change', refresh);
    $('exportBtn').addEventListener('click', exportCSV);
    // FAQ 管理
    $('faqAdd').addEventListener('click', () => openFaqForm(null));
    $('faqSave').addEventListener('click', saveFaq);
    $('faqCancel').addEventListener('click', () => { $('faqForm').style.display = 'none'; });
    // 详情弹窗：人工回复 + 标记已解决
    $('agentSend').addEventListener('click', sendAgentReply);
    $('resolveBtn').addEventListener('click', resolveConv);
    renderFaqTable();
  }

  async function refresh() {
    const all = await store.listConversations();
    const fi = $('filterIntent').value;
    const fs = $('filterStatus').value;
    const q = $('search').value.trim().toLowerCase();
    const df = $('dateFrom').value;
    const dt = $('dateTo').value;
    current = all.filter((c) => {
      if (fi && c.intent !== fi) return false;
      if (fs && c.status !== fs) return false;
      if (df && (c.createdAt || '') < df + 'T00:00:00') return false;
      if (dt && (c.createdAt || '') > dt + 'T23:59:59') return false;
      if (q) {
        const hit = (c.messages || []).some((m) => (m.content || '').toLowerCase().includes(q));
        if (!hit) return false;
      }
      return true;
    });
    renderStats(all);
    renderList();
  }

  function renderStats(all) {
    const statsP = typeof store.getStats === 'function' ? store.getStats() : Promise.resolve({});
    Promise.resolve(statsP).then((st) => {
      $('statTotal').textContent = all.length;
      $('statSat').textContent = st.satAvg != null ? st.satAvg + '★' : '—';
      const rate = st.satRate != null ? st.satRate + '%' : '—';
      $('satSub').textContent = '好评率 ' + rate + ' · ' + (st.satCount || 0) + ' 人评';
      $('statTransferred').textContent = (st.byStatus && st.byStatus.transferred) || 0;
      // 意图分布条
      const intentWrap = $('intentBars');
      intentWrap.innerHTML = '';
      const intents = ['refund', 'order', 'tech', 'other'];
      const maxI = Math.max(1, ...intents.map((i) => (st.byIntent && st.byIntent[i]) || 0));
      for (const i of intents) {
        const v = (st.byIntent && st.byIntent[i]) || 0;
        const row = document.createElement('div');
        row.className = 'bar-row';
        const lab = document.createElement('span');
        lab.className = 'bar-label';
        lab.textContent = LABEL_INTENT[i] || i;
        const track = document.createElement('div');
        track.className = 'bar-track';
        const fill = document.createElement('div');
        fill.className = 'bar-fill';
        fill.style.width = (v / maxI) * 100 + '%';
        const num = document.createElement('span');
        num.className = 'bar-num';
        num.textContent = v;
        track.appendChild(fill);
        row.appendChild(lab);
        row.appendChild(track);
        row.appendChild(num);
        intentWrap.appendChild(row);
      }
    });
  }

  function renderList() {
    const tbody = $('convList');
    tbody.innerHTML = '';
    if (!current.length) {
      tbody.innerHTML = '<tr><td colspan="6" class="empty">暂无对话记录</td></tr>';
      return;
    }
    for (const c of current) {
      const tr = document.createElement('tr');
      const sat = stars(c.satisfaction);
      tr.innerHTML =
        '<td>' + fmtTime(c.createdAt) + '</td>' +
        '<td>' + (LABEL_INTENT[c.intent] || c.intent) + '</td>' +
        '<td>' + (LABEL_STATUS[c.status] || c.status) + '</td>' +
        '<td>' + ((c.messages || []).length) + '</td>' +
        '<td>' + sat + '</td>' +
        '<td><button class="btn-mini" data-id="' + c.id + '">查看</button></td>';
      tbody.appendChild(tr);
    }
    tbody.querySelectorAll('button[data-id]').forEach((b) => {
      b.addEventListener('click', () => openDetail(b.getAttribute('data-id')));
    });
  }

  async function openDetail(id) {
    openId = id;
    const c = await store.getConversation(id);
    if (!c) return;
    const box = $('detailBody');
    box.innerHTML = '';
    for (const m of c.messages || []) {
      const d = document.createElement('div');
      let who, cls;
      if (m.role === 'user') { who = '顾客'; cls = 'd-user'; }
      else if (m.role === 'agent') { who = '人工客服'; cls = 'd-agent'; }
      else if (m.role === 'system') { who = '系统'; cls = 'd-bot'; }
      else { who = '智能客服'; cls = 'd-bot'; }
      d.className = 'd-msg ' + cls;
      d.textContent = '【' + who + '】' + m.content;
      box.appendChild(d);
    }
    if (c.contact) {
      const ct = document.createElement('div');
      ct.className = 'd-contact';
      ct.textContent = '📞 联系信息：' + c.contact.name + ' / ' + c.contact.phone;
      box.appendChild(ct);
    }
    if (typeof c.satisfaction === 'number') {
      const sv = document.createElement('div');
      sv.className = 'd-contact';
      sv.textContent = '⭐ 满意度评分：' + stars(c.satisfaction);
      box.appendChild(sv);
    }
    $('detailTitle').textContent =
      '对话详情 · ' + (LABEL_INTENT[c.intent] || c.intent) + ' · ' + (LABEL_STATUS[c.status] || c.status);
    $('agentReply').value = '';
    $('modal').style.display = 'flex';
  }

  async function sendAgentReply() {
    const text = $('agentReply').value.trim();
    if (!text || !openId) return;
    await store.appendMessage(openId, 'agent', text);
    await store.updateConversation(openId, { agentReplied: true });
    $('agentReply').value = '';
    await openDetail(openId);
    await refresh();
  }
  async function resolveConv() {
    if (!openId) return;
    await store.updateConversation(openId, { status: 'resolved' });
    await openDetail(openId);
    await refresh();
  }

  function exportCSV() {
    const header = ['时间', '意图', '状态', '消息数', '满意度', '联系方式', '最近消息'];
    const rows = current.map((c) => [
      fmtTime(c.createdAt),
      LABEL_INTENT[c.intent] || c.intent,
      LABEL_STATUS[c.status] || c.status,
      (c.messages || []).length,
      typeof c.satisfaction === 'number' ? c.satisfaction : '',
      c.contact ? c.contact.name + '/' + c.contact.phone : '',
      (c.messages || []).slice(-1)[0] ? (c.messages || []).slice(-1)[0].content : '',
    ]);
    const esc = (v) => '"' + String(v).replace(/"/g, '""') + '"';
    const csv = '﻿' + [header, ...rows].map((r) => r.map(esc).join(',')).join('\r\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = '客服对话记录_' + new Date().toISOString().slice(0, 10) + '.csv';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  // ---------- FAQ 管理 ----------
  function renderFaqTable() {
    const list = faqStore.list();
    const tbody = $('faqList');
    tbody.innerHTML = '';
    if (!list.length) {
      tbody.innerHTML = '<tr><td colspan="4" class="empty">暂无知识库条目</td></tr>';
      return;
    }
    for (const f of list) {
      const tr = document.createElement('tr');
      tr.innerHTML =
        '<td>' + (LABEL_CAT[f.category] || f.category) + '</td>' +
        '<td>' + (f.question || '') + '</td>' +
        '<td class="faq-ans">' + (f.answer || '') + '</td>' +
        '<td>' +
        '<button class="btn-mini" data-edit="' + f.id + '">编辑</button> ' +
        '<button class="btn-mini btn-danger" data-del="' + f.id + '">删除</button></td>';
      tbody.appendChild(tr);
    }
    tbody.querySelectorAll('button[data-edit]').forEach((b) =>
      b.addEventListener('click', () => openFaqForm(b.getAttribute('data-edit')))
    );
    tbody.querySelectorAll('button[data-del]').forEach((b) =>
      b.addEventListener('click', () => {
        if (confirm('确认删除该知识库条目？')) {
          faqStore.remove(b.getAttribute('data-del'));
          renderFaqTable();
        }
      })
    );
  }

  function openFaqForm(id) {
    const f = id ? faqStore.list().find((x) => x.id === id) : null;
    $('faqId').value = f ? f.id : '';
    $('faqCategory').value = f ? f.category : 'refund';
    $('faqQuestion').value = f ? f.question || '' : '';
    $('faqAnswer').value = f ? f.answer || '' : '';
    $('faqKeywords').value = f && f.keywords ? f.keywords.join('、') : '';
    $('faqForm').style.display = 'block';
  }

  function saveFaq() {
    const id = $('faqId').value || 'faq-' + Date.now();
    const item = {
      id,
      category: $('faqCategory').value,
      question: $('faqQuestion').value.trim(),
      answer: $('faqAnswer').value.trim(),
      keywords: $('faqKeywords').value
        .split(/[、,，\s]+/)
        .map((s) => s.trim())
        .filter(Boolean),
    };
    if (!item.question || !item.answer) {
      alert('请填写问题与回答');
      return;
    }
    faqStore.upsert(item);
    $('faqForm').style.display = 'none';
    renderFaqTable();
  }

  $('modalClose').addEventListener('click', () => ($('modal').style.display = 'none'));
  $('logoutBtn').addEventListener('click', () => {
    sessionStorage.removeItem('cs_admin_ok');
    location.reload();
  });
})();
