/* =========================================================================
 * engine.js — 智能客服引擎
 * -------------------------------------------------------------------------
 * 演示版：本地规则引擎（意图识别 + FAQ 检索 + 模板应答），无需联网/大模型。
 * 云端版：当 window.CLOUD_CONFIG 存在时，由 cloud.js 提供同接口实现（真大模型）。
 *
 * 统一接口：
 *   classifyIntent(text)                 -> { intent, score }
 *   retrieveFAQ(text, topK=3)            -> [{faq, score}, ...]
 *   generateReply(text, history)         -> Promise<{ reply, intent, faqs, transfer }>
 * ========================================================================= */

(function () {
  const INTENT_KEYWORDS = {
    refund: ['退款', '退货', '退钱', '退订', '退单', '不想要了', '申请退款', '退', '取消订单', '不退款', '退款申请', '退不了'],
    order: ['订单', '物流', '发货', '快递', '运单', '到哪', '查单', '下单', '购买记录', '收货', '地址', '什么时候发货', '催发货', '到货', '查快递'],
    tech: ['登录', '闪退', '打不开', '崩溃', '卡死', '白屏', '用不了', '故障', 'bug', '报错', '怎么用', '如何设置', '教程', '设置', '密码', '账号', '卡顿', '无法使用', '登不进', '收不到验证码', '卡了'],
    other: ['营业', '客服时间', '电话', '联系方式', '人工客服', '转人工', '人工服务'],
  };

  // P1-2 转人工强信号词表（避免误触发 "人工智能" / "客服时间" 等）
  const TRANSFER_STRONG = [
    '转人工', '人工客服', '人工服务', '真人客服', '真人', '转接人工',
    '联系人工', '人工接听', '在线人工', '人工坐席', '找人工', '人工帮助',
  ];
  // 抑制词：出现这些语境时，即便命中弱信号也不转人工
  const TRANSFER_SUPPRESS = ['人工智能', '智能客服', '机器人', '客服时间', '客服热线', '客服电话', '客服中心'];

  function getFAQ() {
    return typeof window.CS_GET_FAQ === 'function' ? window.CS_GET_FAQ() : window.CS_FAQ || [];
  }

  function classifyIntent(text) {
    const t = (text || '').toLowerCase();
    let best = 'other';
    let bestScore = 0;
    for (const intent of Object.keys(INTENT_KEYWORDS)) {
      let score = 0;
      for (const kw of INTENT_KEYWORDS[intent]) {
        if (t.includes(kw.toLowerCase())) score += kw.length >= 2 ? 2 : 1;
      }
      if (score > bestScore) {
        bestScore = score;
        best = intent;
      }
    }
    return { intent: best, score: bestScore };
  }

  function retrieveFAQ(text, topK = 3) {
    const t = (text || '').toLowerCase();
    const faqs = getFAQ();
    const scored = [];
    for (const faq of faqs) {
      let score = 0;
      // 问题直接包含
      if (t.includes(faq.question.toLowerCase().slice(0, 6))) score += 5;
      for (const kw of faq.keywords || []) {
        if (t.includes(kw.toLowerCase())) score += kw.length >= 3 ? 3 : 1;
      }
      // 关键词反向匹配（用户词命中 FAQ 关键词）
      if (score > 0) scored.push({ faq, score });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, topK);
  }

  function detectTransfer(text) {
    const t = (text || '').toLowerCase();
    if (TRANSFER_SUPPRESS.some((w) => t.includes(w.toLowerCase()))) return false;
    return TRANSFER_STRONG.some((kw) => t.includes(kw.toLowerCase()));
  }

  // P2-2 多轮意图继承：当前弱意图时，沿用历史最近一条用户消息的强意图
  function inheritIntent(text, history) {
    const cur = classifyIntent(text);
    if (cur.intent !== 'other' && cur.score > 0) return cur;
    const userMsgs = (history || []).filter((m) => m.role === 'user');
    for (let i = userMsgs.length - 1; i >= 0; i--) {
      const prev = classifyIntent(userMsgs[i].content);
      if (prev.intent !== 'other' && prev.score > 1) return prev;
    }
    return cur;
  }

  const INTENT_TEMPLATE = {
    refund: '我已为您定位到【退款】相关问题。',
    order: '我已为您定位到【订单/物流】相关问题。',
    tech: '我已为您定位到【技术支持】相关问题。',
    other: '我已收到您的消息。',
  };

  async function generateReply(text, history) {
    // 云端优先
    if (window.CS_CLOUD_ENGINE) {
      return window.CS_CLOUD_ENGINE.generateReply(text, history);
    }

    const { intent, score } = inheritIntent(text, history);
    const transfer = detectTransfer(text);
    const faqs = retrieveFAQ(text, 3);

    let reply;
    if (transfer) {
      reply =
        '好的，正在为您转接人工客服。请稍候，并在下方留下您的联系方式，我们的客服会尽快与您联系。';
      return { reply, intent, faqs, transfer: true };
    }

    if (faqs.length && faqs[0].score >= 3) {
      const top = faqs[0].faq;
      reply =
        INTENT_TEMPLATE[intent] +
        '\n\n' +
        top.answer +
        '\n\n（以上来自常见问题库，若仍未解决可回复"转人工"。）';
    } else if (score > 0) {
      reply =
        INTENT_TEMPLATE[intent] +
        '\n\n' +
        '为更快帮到您，能否补充一些细节？例如订单号、具体报错信息或设备型号。您也可以回复"转人工"联系人工客服。';
    } else {
      reply =
        '您好，我是智能客服小云。我可以帮您处理【退款】【查询订单/物流】【技术支持】等问题。请描述您遇到的情况，或回复"转人工"联系人工客服。';
    }
    return { reply, intent, faqs, transfer: false };
  }

  // 云端版在 cloud.js 中赋值：window.CS_CLOUD_ENGINE
  window.CS_ENGINE = window.CS_CLOUD_ENGINE || {
    classifyIntent,
    retrieveFAQ,
    detectTransfer,
    generateReply,
    _local: true,
  };
})();
