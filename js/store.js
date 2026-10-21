/* =========================================================================
 * store.js — 对话持久化层
 * -------------------------------------------------------------------------
 * 演示版：使用浏览器 localStorage 存储。
 * 云端版：当 window.CLOUD_CONFIG 存在时，由 cloud.js 提供同接口实现（异步）。
 *
 * 统一接口（全部可用 await 调用；本地版同步返回，云端版返回 Promise）：
 *   createConversation({ sessionId, intent })      -> conversation
 *   getConversation(id)                            -> conversation | null
 *   appendMessage(id, role, content)               -> conversation
 *   updateConversation(id, patch)                  -> conversation
 *   listConversations()                            -> conversation[]
 *   getStats()                                     -> stats 对象
 *
 * 知识库动态管理（演示版落地 localStorage，云端版落地 faqs 表）：
 *   CS_FAQ_STORE.list()        -> faq[]
 *   CS_FAQ_STORE.upsert(item)  -> faq
 *   CS_FAQ_STORE.remove(id)    -> faq[]
 *   CS_GET_FAQ()               -> 生效中的 faq[]（引擎统一从这里取）
 *
 * conversation 结构：
 *   { id, sessionId, intent, status, satisfaction,
 *     contact, agentReplied, createdAt, updatedAt, messages: [{role,content,ts}] }
 *   status: 'ai'（AI 处理中）| 'transferred'（已转人工）| 'resolved'（已解决）
 *   satisfaction: null | 1~5（1-5 星评分）
 *   role: 'user' | 'bot' | 'agent'（人工客服） | 'system'
 * ========================================================================= */

(function () {
  const KEY = 'cs_conversations_v1';
  const FAQ_KEY = 'cs_faqs_v1';

  function readAll() {
    try {
      return JSON.parse(localStorage.getItem(KEY) || '[]');
    } catch (e) {
      return [];
    }
  }
  function writeAll(l) {
    localStorage.setItem(KEY, JSON.stringify(l));
  }
  function nowISO() {
    return new Date().toISOString();
  }

  // 内存中维护同一份会话对象，避免 createConversation 返回对象与后续
  // appendMessage/updateConversation 修改的对象不一致（导致首屏欢迎语不渲染）。
  let list = readAll();
  function persist() {
    writeAll(list);
  }

  // ---- PII 脱敏（隐私保护）：手机号、邮箱中间打码 ----
  function maskPII(text) {
    if (typeof text !== 'string') return text;
    return text
      .replace(/1[3-9]\d{9}/g, (m) => m.slice(0, 3) + '****' + m.slice(7))
      .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, (m) => {
        const [u, d] = m.split('@');
        return (u.length <= 2 ? u : u.slice(0, 2) + '***') + '@' + d;
      });
  }

  const LocalStore = {
    createConversation({ sessionId, intent = 'other' }) {
      const conv = {
        id: 'c_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
        sessionId,
        intent,
        status: 'ai',
        satisfaction: null,
        contact: null,
        agentReplied: false,
        createdAt: nowISO(),
        updatedAt: nowISO(),
        messages: [],
      };
      list.push(conv);
      persist();
      return conv;
    },
    getConversation(id) {
      return list.find((c) => c.id === id) || null;
    },
    appendMessage(id, role, content) {
      const conv = list.find((c) => c.id === id);
      if (!conv) return null;
      // 用户输入落库前脱敏（隐私保护）
      const safe = role === 'user' ? maskPII(content) : content;
      conv.messages.push({ role, content: safe, ts: nowISO() });
      conv.updatedAt = nowISO();
      persist();
      return conv;
    },
    updateConversation(id, patch) {
      const conv = list.find((c) => c.id === id);
      if (!conv) return null;
      Object.assign(conv, patch, { updatedAt: nowISO() });
      persist();
      return conv;
    },
    listConversations() {
      return [...list].sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
    },
    // ---- 满意度改为 1-5 分制统计 ----
    getStats() {
      const list = readAll();
      const byIntent = {};
      const byStatus = {};
      const satDist = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
      let satCount = 0;
      let satSum = 0;
      const byDay = {};
      for (const c of list) {
        byIntent[c.intent] = (byIntent[c.intent] || 0) + 1;
        byStatus[c.status] = (byStatus[c.status] || 0) + 1;
        if (typeof c.satisfaction === 'number' && c.satisfaction >= 1 && c.satisfaction <= 5) {
          satCount++;
          satSum += c.satisfaction;
          satDist[c.satisfaction]++;
        }
        const day = (c.createdAt || '').slice(0, 10);
        if (day) byDay[day] = (byDay[day] || 0) + 1;
      }
      const satAvg = satCount ? Math.round((satSum / satCount) * 100) / 100 : null;
      const satisfied = satDist[4] + satDist[5];
      const satRate = satCount ? Math.round((satisfied / satCount) * 100) : null; // 好评率（4~5 星）
      return {
        total: list.length,
        byIntent,
        byStatus,
        satCount,
        satAvg,
        satRate,
        satDist,
        byDay,
      };
    },
  };

  // ---------- 动态 FAQ 存储（管理后台可维护） ----------
  function readFaqs() {
    try {
      const raw = localStorage.getItem(FAQ_KEY);
      if (raw == null) return null;
      return JSON.parse(raw);
    } catch (e) {
      return null;
    }
  }
  function writeFaqs(arr) {
    localStorage.setItem(FAQ_KEY, JSON.stringify(arr));
  }
  const LocalFaqStore = {
    list() {
      let arr = readFaqs();
      if (!arr) {
        // 首次：用内置示例库播种，便于后台直接编辑
        arr = (window.CS_FAQ || []).map((f) => ({ ...f }));
        writeFaqs(arr);
      }
      return arr;
    },
    upsert(item) {
      const arr = this.list();
      const i = arr.findIndex((f) => f.id === item.id);
      if (i >= 0) arr[i] = item;
      else arr.push(item);
      writeFaqs(arr);
      return item;
    },
    remove(id) {
      const arr = this.list().filter((f) => f.id !== id);
      writeFaqs(arr);
      return arr;
    },
  };

  // 云端版在 cloud.js 中赋值：window.CS_CLOUD_STORE / window.CS_CLOUD_FAQ_STORE
  window.CS_STORE = window.CS_CLOUD_STORE || LocalStore;
  window.CS_FAQ_STORE = window.CS_CLOUD_FAQ_STORE || LocalFaqStore;
  // 引擎统一从这里取 FAQ（云端就绪后自动走云端 faqs 表）
  window.CS_GET_FAQ = function () {
    if (window.CS_CLOUD_FAQ_STORE) return window.CS_CLOUD_FAQ_STORE.list();
    return LocalFaqStore.list();
  };
})();
