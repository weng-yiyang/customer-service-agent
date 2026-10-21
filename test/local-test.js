/* =========================================================================
 * local-test.js — 本地版核心逻辑测试（不依赖浏览器/云端）
 * 用 vm 在带 window/localStorage 模拟的上下文中加载 faq-data/store/engine，
 * 对意图识别、FAQ 检索、应答生成、持久化、1-5 满意度统计、FAQ 动态管理、
 * 转人工误触发修复、人工回复闭环做断言。
 * 运行：node test/local-test.js
 * ========================================================================= */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');

// ---- 模拟浏览器全局 ----
const mem = {};
const localStorageMock = {
  getItem: (k) => (k in mem ? mem[k] : null),
  setItem: (k, v) => { mem[k] = String(v); },
  removeItem: (k) => { delete mem[k]; },
};
const sandbox = {};
sandbox.window = sandbox;
sandbox.localStorage = localStorageMock;
sandbox.sessionStorage = localStorageMock;
sandbox.console = console;
sandbox.Math = Math;
sandbox.Date = Date;
sandbox.JSON = JSON;
vm.createContext(sandbox);

function loadFile(rel) {
  const code = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  vm.runInContext(code, sandbox, { filename: rel });
}

loadFile('js/faq-data.js');
loadFile('js/store.js');
loadFile('js/engine.js');

// ---- 断言工具 ----
let pass = 0, fail = 0;
const fails = [];
function assert(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; fails.push(name + (extra ? ' → ' + extra : '')); console.log('  ✗ ' + name + (extra ? ' → ' + extra : '')); }
}

const ENGINE = sandbox.window.CS_ENGINE;
const STORE = sandbox.window.CS_STORE;
const FAQ = sandbox.window.CS_FAQ;
const FAQ_STORE = sandbox.window.CS_FAQ_STORE;
const GET_FAQ = sandbox.window.CS_GET_FAQ;

(async () => {
  console.log('\n=== FAQ 数据 ===');
  assert('FAQ 非空且覆盖 4 类', FAQ.length >= 10 && new Set(FAQ.map(f => f.category)).size === 4, 'count=' + FAQ.length);

  console.log('\n=== 意图识别 classifyIntent ===');
  const ci = (t) => ENGINE.classifyIntent(t).intent;
  assert('退款: 我要申请退款', ci('我要申请退款') === 'refund', ci('我要申请退款'));
  assert('退款: 退钱', ci('买错了想退钱') === 'refund', ci('买错了想退钱'));
  assert('订单: 我的订单到哪了', ci('我的订单到哪了') === 'order', ci('我的订单到哪了'));
  assert('订单: 查物流', ci('麻烦查一下物流') === 'order', ci('麻烦查一下物流'));
  assert('技术: App闪退', ci('App 闪退打不开') === 'tech', ci('App 闪退打不开'));
  assert('技术: 无法登录', ci('账号无法登录') === 'tech', ci('账号无法登录'));
  assert('其他: 你好', ci('你好') === 'other', ci('你好'));

  console.log('\n=== 转人工误触发修复 detectTransfer ===');
  assert('"转人工" 触发转人工', ENGINE.detectTransfer('请转人工') === true, ENGINE.detectTransfer('请转人工'));
  assert('"人工智能" 不误触发', ENGINE.detectTransfer('人工智能是什么') === false, ENGINE.detectTransfer('人工智能是什么'));
  assert('"客服时间" 不误触发', ENGINE.detectTransfer('客服时间是几点') === false, ENGINE.detectTransfer('客服时间是几点'));
  const rAI = await ENGINE.generateReply('人工智能能做什么', []);
  assert('人工智能 不进入转人工分支', rAI.transfer === false, 'transfer=' + rAI.transfer);

  console.log('\n=== FAQ 检索 retrieveFAQ（动态知识库） ===');
  const faqRefund = ENGINE.retrieveFAQ('怎么申请退款', 3);
  assert('退款问题能检索到 FAQ', faqRefund.length > 0 && faqRefund[0].faq.category === 'refund', JSON.stringify(faqRefund.map(f=>f.faq.id)));
  const faqOrder = ENGINE.retrieveFAQ('快递到哪了', 3);
  assert('物流问题能检索到 FAQ', faqOrder.length > 0 && faqOrder[0].faq.category === 'order', JSON.stringify(faqOrder.map(f=>f.faq.id)));

  console.log('\n=== 应答生成 generateReply ===');
  const r1 = await ENGINE.generateReply('如何申请退款？', []);
  assert('FAQ 命中时回复包含答案片段', r1.reply.includes('我的订单') || r1.reply.includes('申请退款'), r1.reply.slice(0, 40));
  assert('FAQ 命中时给出意图', r1.intent === 'refund', r1.intent);
  const r2 = await ENGINE.generateReply('转人工', []);
  assert('转人工触发 transfer', r2.transfer === true, 'transfer=' + r2.transfer);
  const r3 = await ENGINE.generateReply('你好', []);
  assert('问候触发欢迎语(非FAQ)', r3.reply.includes('小云'), r3.reply.slice(0, 30));

  console.log('\n=== P2-2 多轮意图继承 ===');
  const ctx = [
    { role: 'user', content: '我的订单到哪了' },
    { role: 'bot', content: '已为您定位订单问题' },
  ];
  const rCtx = await ENGINE.generateReply('那物流呢', ctx);
  assert('弱意图时继承历史意图(order)', rCtx.intent === 'order', rCtx.intent);

  console.log('\n=== P1-1 动态 FAQ 管理 CS_FAQ_STORE ===');
  const before = FAQ_STORE.list().length;
  const added = FAQ_STORE.upsert({ id: 'faq-test-1', category: 'tech', question: '测试专属问题xyz', answer: '这是测试答案', keywords: ['xyz专属'] });
  assert('upsert 新增条目', FAQ_STORE.list().length === before + 1, 'before=' + before + ' now=' + FAQ_STORE.list().length);
  assert('GET_FAQ 包含新增条目', GET_FAQ().some(f => f.id === 'faq-test-1'), 'len=' + GET_FAQ().length);
  const hit = ENGINE.retrieveFAQ('xyz专属', 3);
  assert('引擎能检索到新增 FAQ', hit.length > 0 && hit[0].faq.id === 'faq-test-1', JSON.stringify(hit.map(f=>f.faq.id)));
  FAQ_STORE.remove('faq-test-1');
  assert('remove 删除条目', !FAQ_STORE.list().some(f => f.id === 'faq-test-1'), 'len=' + FAQ_STORE.list().length);

  console.log('\n=== 持久化 store ===');
  // 会话 A：退款 + 转人工 + 人工回复（保持 transferred 状态用于统计）
  const c = await STORE.createConversation({ sessionId: 'test_s', intent: 'refund' });
  assert('创建会话带 id/status', !!c.id && c.status === 'ai', JSON.stringify({id:c.id, status:c.status}));
  await STORE.appendMessage(c.id, 'user', '我要退款 手机13812345678 邮箱user2024@mail.com');
  await STORE.appendMessage(c.id, 'bot', '好的，已为您定位退款问题');
  const c2 = await STORE.getConversation(c.id);
  assert('消息落库(2条)', c2.messages.length === 2, 'len=' + c2.messages.length);
  assert('P1-5 用户输入脱敏(手机)', c2.messages[0].content.includes('138****5678'), c2.messages[0].content);
  assert('P1-5 用户输入脱敏(邮箱)', c2.messages[0].content.includes('us***@mail.com'), c2.messages[0].content);
  await STORE.updateConversation(c.id, { status: 'transferred' });
  const c3 = await STORE.getConversation(c.id);
  assert('状态更新为 transferred', c3.status === 'transferred', c3.status);
  await STORE.appendMessage(c.id, 'agent', '您好，我是人工客服，正在为您处理');
  await STORE.updateConversation(c.id, { agentReplied: true });
  const c3b = await STORE.getConversation(c.id);
  assert('P0-2 人工回复落库(agent角色)', c3b.messages.some(m => m.role === 'agent'), JSON.stringify(c3b.messages.map(m=>m.role)));
  assert('P0-2 agentReplied 标记', c3b.agentReplied === true, 'agentReplied=' + c3b.agentReplied);

  // 会话 B：已解决 + 5 星评分（用于 resolved 与满意度统计）
  const cb = await STORE.createConversation({ sessionId: 'test_s2', intent: 'order' });
  await STORE.updateConversation(cb.id, { status: 'resolved', satisfaction: 5 });
  const cbGot = await STORE.getConversation(cb.id);
  assert('P0-1 状态可置为 resolved', cbGot.status === 'resolved', cbGot.status);
  assert('P2-1 满意度写入(5星)', cbGot.satisfaction === 5, 'sat=' + cbGot.satisfaction);

  const list = await STORE.listConversations();
  assert('列表包含会话 A', list.some(x => x.id === c.id), 'list=' + list.length);
  const stats = await STORE.getStats();
  Promise.resolve(stats).then((st) => {
    assert('统计: 总数=2', st.total >= 2, 'total=' + st.total);
    assert('统计: 退款意图计数', (st.byIntent.refund || 0) >= 1, JSON.stringify(st.byIntent));
    assert('统计: 转人工计数', (st.byStatus.transferred || 0) >= 1, JSON.stringify(st.byStatus));
    assert('统计: resolved 计数', (st.byStatus.resolved || 0) >= 1, JSON.stringify(st.byStatus));
    assert('P2-1 满意均分=5', st.satAvg === 5, 'satAvg=' + st.satAvg);
    assert('P2-1 好评率=100%', st.satRate === 100, 'satRate=' + st.satRate);
    assert('P2-1 满意度分布[5]=1', st.satDist[5] === 1, JSON.stringify(st.satDist));

    console.log('\n========================================');
    console.log(`结果: ${pass} 通过 / ${fail} 失败`);
    if (fail) { console.log('失败项:'); fails.forEach(f => console.log('  - ' + f)); }
    console.log('========================================');
    process.exit(fail ? 1 : 0);
  });
})();
