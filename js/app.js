/* =========================================================================
 * app.js — 终端顾客聊天页逻辑
 * ========================================================================= */
(function () {
  const store = window.CS_STORE;
  const engine = window.CS_ENGINE;

  const $ = (id) => document.getElementById(id);

  let sessionId =
    sessionStorage.getItem('cs_session_id') ||
    's_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
  sessionStorage.setItem('cs_session_id', sessionId);
  let activeId = sessionStorage.getItem('cs_active_conv') || null;
  let intent = 'other';
  let renderedCount = 0; // 已渲染消息数（用于轮询增量渲染人工回复）

  // ---- P1-5 输入安全：长度限制 & 频率限制 ----
  const MAX_LEN = 500;
  const RATE_MAX = 20; // 60 秒内最多 20 条
  const RATE_WINDOW = 60000;
  function sendTimes() {
    try {
      return JSON.parse(sessionStorage.getItem('cs_send_times') || '[]');
    } catch (e) {
      return [];
    }
  }
  function checkRate() {
    const now = Date.now();
    let arr = sendTimes().filter((t) => now - t < RATE_WINDOW);
    if (arr.length >= RATE_MAX) {
      sessionStorage.setItem('cs_send_times', JSON.stringify(arr));
      return false;
    }
    arr.push(now);
    sessionStorage.setItem('cs_send_times', JSON.stringify(arr));
    return true;
  }

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  function scrollBottom() {
    const m = $('messages');
    m.scrollTop = m.scrollHeight;
  }
  function addBubble(role, text) {
    const wrap = el('div', 'msg ' + (role === 'user' ? 'msg-user' : role === 'agent' ? 'msg-agent' : 'msg-bot'));
    const avatarText = role === 'user' ? '你' : role === 'agent' ? '客' : '🤖';
    const avatar = el('div', 'avatar', avatarText);
    const bubble = el('div', 'bubble', text);
    wrap.appendChild(avatar);
    wrap.appendChild(bubble);
    $('messages').appendChild(wrap);
    scrollBottom();
    return bubble;
  }
  function updateIntent(i) {
    intent = i;
    const label = (window.CS_FAQ_CATEGORY_LABEL && window.CS_FAQ_CATEGORY_LABEL[i]) || '其他';
    const b = $('intentBadge');
    b.textContent = '当前意图：' + label;
    b.style.display = 'inline-block';
  }
  async function ensureConv() {
    if (activeId) {
      const c = await store.getConversation(activeId);
      if (c) return c;
    }
    const c = await store.createConversation({ sessionId, intent });
    activeId = c.id;
    sessionStorage.setItem('cs_active_conv', activeId);
    await store.appendMessage(activeId, 'bot', '您好，我是智能客服小云 👋\n请问有什么可以帮您？您可以咨询【退款】【查询订单/物流】【技术支持】，或回复"转人工"联系人工客服。');
    return c;
  }
  async function historyForModel() {
    const c = await store.getConversation(activeId);
    return (c ? c.messages : []).map((m) => ({ role: m.role, content: m.content }));
  }
  function showTransfer() {
    $('transferPanel').style.display = 'block';
  }
  function showTransferDone(contact) {
    $('transferPanel').style.display = 'block';
    $('transferPanel').classList.add('done');
    if (contact) {
      $('transferNote').textContent =
        '已收到您的联系方式：' + contact.name + ' / ' + contact.phone + '，客服会尽快联系您。';
      $('transferForm').style.display = 'none';
    }
  }
  function setStars(v) {
    document.querySelectorAll('#stars .star').forEach((b) => {
      b.classList.toggle('active', Number(b.getAttribute('data-v')) <= v);
    });
  }
  async function renderHistory() {
    const c = await ensureConv();
    $('messages').innerHTML = '';
    for (const m of c.messages) addBubble(m.role, m.content);
    renderedCount = c.messages.length;
    updateIntent(c.intent);
    if (c.status === 'transferred') showTransferDone(c.contact);
    if (typeof c.satisfaction === 'number' && c.satisfaction >= 1 && c.satisfaction <= 5) {
      $('satPanel').classList.add('rated');
      setStars(c.satisfaction);
      $('satThanks').style.display = 'inline';
    }
    scrollBottom();
  }
  async function send() {
    let raw = $('input').value.trim();
    if (!raw) return;
    if (raw.length > MAX_LEN) raw = raw.slice(0, MAX_LEN); // 超长截断（安全）
    if (!checkRate()) {
      alert('发送过于频繁，请稍后再试。');
      return;
    }
    $('input').value = '';
    await ensureConv();
    addBubble('user', raw);
    await store.appendMessage(activeId, 'user', raw); // store 层自动脱敏
    renderedCount++;

    const typing = addBubble('bot', '正在输入…');
    typing.classList.add('typing');
    let res;
    try {
      res = await engine.generateReply(raw, await historyForModel());
    } catch (e) {
      typing.textContent = '抱歉，服务暂时不可用，请稍后再试或回复"转人工"。';
      return;
    }
    typing.textContent = res.reply;
    await store.appendMessage(activeId, 'bot', res.reply);
    renderedCount++;
    updateIntent(res.intent);
    if (res.transfer) {
      await store.updateConversation(activeId, { status: 'transferred' });
      showTransfer();
    }
  }
  async function submitContact() {
    const name = $('contactName').value.trim();
    const phone = $('contactPhone').value.trim();
    if (!name || !phone) {
      alert('请填写称呼与联系电话');
      return;
    }
    await store.updateConversation(activeId, { contact: { name, phone } });
    $('transferNote').textContent = '已收到您的联系方式：' + name + ' / ' + phone + '，客服会尽快联系您。';
    $('transferForm').style.display = 'none';
    $('transferPanel').classList.add('done');
  }
  async function rate(v) {
    await store.updateConversation(activeId, { satisfaction: v });
    // 评分即视为本次会话结束：AI 处理中 -> 已解决；已转人工且人工已回复 -> 已解决
    const c = await store.getConversation(activeId);
    if (c && c.status === 'ai') {
      await store.updateConversation(activeId, { status: 'resolved' });
    } else if (c && c.status === 'transferred' && c.agentReplied) {
      await store.updateConversation(activeId, { status: 'resolved' });
    }
    $('satPanel').classList.add('rated');
    setStars(v);
    $('satThanks').style.display = 'inline';
  }
  function newChat() {
    activeId = null;
    sessionStorage.removeItem('cs_active_conv');
    $('transferPanel').style.display = 'none';
    $('transferPanel').classList.remove('done');
    $('transferForm').style.display = 'block';
    $('transferNote').textContent = '';
    $('contactName').value = '';
    $('contactPhone').value = '';
    $('satPanel').classList.remove('rated');
    setStars(0);
    $('satThanks').style.display = 'none';
    renderHistory();
  }

  // P0-2 轮询：检测后台人工回复并实时显示（演示版同浏览器 localStorage 共享）
  async function pollAgentReply() {
    if (!activeId) return;
    const c = await store.getConversation(activeId);
    if (!c) return;
    if (c.messages.length > renderedCount) {
      for (let i = renderedCount; i < c.messages.length; i++) {
        const m = c.messages[i];
        if (m.role === 'agent') {
          addBubble('agent', m.content);
          // 人工回复后，若顾客此前已转人工，自动提示
          if (c.status === 'transferred') showTransferDone(c.contact);
        }
      }
      renderedCount = c.messages.length;
    }
  }

  // 事件绑定
  $('sendBtn').addEventListener('click', send);
  $('input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  });
  $('newChatBtn').addEventListener('click', newChat);
  $('transferSubmit').addEventListener('click', submitContact);
  document.querySelectorAll('#stars .star').forEach((b) => {
    b.addEventListener('click', () => rate(Number(b.getAttribute('data-v'))));
  });

  renderHistory();
  setInterval(pollAgentReply, 3000);
})();
