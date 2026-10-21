/* =========================================================================
 * flow-test.js — 顾客端关键点击流集成测试（轻量 DOM 模拟，无需 jsdom）
 * 覆盖：发送 -> 多轮应答；转人工 -> 面板出现；新建对话 -> 5 星评分 ->
 * 状态置 resolved；后台写入人工回复 -> 轮询自动显示。
 * 运行：node test/flow-test.js
 * ========================================================================= */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ROOT = path.resolve(__dirname, '..');

function makeEl(tag) {
  const handlers = {};
  const el = {
    tagName: tag, style: {}, value: '', _text: '', _html: '', children: [], _classes: new Set(), _attrs: {},
    classList: {
      add: (c) => el._classes.add(c),
      remove: (c) => el._classes.delete(c),
      toggle: (c, f) => {
        if (f === undefined) { el._classes.has(c) ? el._classes.delete(c) : el._classes.add(c); }
        else { f ? el._classes.add(c) : el._classes.delete(c); }
      },
      contains: (c) => el._classes.has(c),
    },
    appendChild(c) { this.children.push(c); return c; },
    addEventListener(ev, fn) { (handlers[ev] = handlers[ev] || []).push(fn); },
    _fire(ev, arg) {
      const a = arg || { preventDefault() {} };
      return Promise.all((handlers[ev] || []).map((fn) => fn(a)));
    },
    querySelectorAll() { return []; },
    getAttribute(a) { return el._attrs[a] != null ? el._attrs[a] : null; },
    setAttribute(a, v) { el._attrs[a] = v; },
    focus() {},
  };
  Object.defineProperty(el, 'textContent', { get() { return el._text; }, set(v) { el._text = v; } });
  Object.defineProperty(el, 'innerHTML', { get() { return el._html; }, set(v) { el._html = v; el.children = []; } });
  return el;
}

const mem = {};
const storageMock = {
  getItem: (k) => (k in mem ? mem[k] : null),
  setItem: (k, v) => { mem[k] = String(v); },
  removeItem: (k) => { delete mem[k]; },
};

const ids = {};
const intervals = [];
const documentMock = {
  getElementById(id) {
    if (!ids[id]) ids[id] = makeEl('div');
    return ids[id];
  },
  createElement(tag) { return makeEl(tag); },
  querySelectorAll(sel) {
    if (sel === '#stars .star') return ids['stars'] ? ids['stars'].children : [];
    return [];
  },
  head: { appendChild() {} },
  body: makeEl('body'),
};

const sandbox = {};
sandbox.window = sandbox;
sandbox.document = documentMock;
sandbox.localStorage = storageMock;
sandbox.sessionStorage = storageMock;
sandbox.console = console;
sandbox.Math = Math; sandbox.Date = Date; sandbox.JSON = JSON;
sandbox.alert = (m) => console.log('[alert]', m);
sandbox.confirm = () => true;
sandbox.setInterval = (fn) => { intervals.push(fn); return intervals.length; };
sandbox.clearInterval = () => {};
sandbox.location = { reload() {}, href: '', assign() {}, searchParams: { has() { return false; }, get() { return null; }, delete() {} } };
vm.createContext(sandbox);

function loadFile(rel) {
  const code = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  vm.runInContext(code, sandbox, { filename: rel });
}
const tick = () => new Promise((r) => setTimeout(r, 40));

let pass = 0, fail = 0;
const fails = [];
function assert(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; fails.push(name + (extra ? ' → ' + extra : '')); console.log('  ✗ ' + name + (extra ? ' → ' + extra : '')); }
}

(async () => {
  // 读取某 wrap 内的 bubble 文本（addBubble 用 className 字符串设类）
  const wrapText = (b) => {
    const txt = (b.children || []).map((c) => (c.className === 'bubble' ? c._text : '')).join('');
    return txt || b._text || '';
  };
  const hasClass = (b, cls) => (b.className && b.className.indexOf(cls) >= 0) || (b._classes && b._classes.has(cls));
  const messages = () => documentMock.getElementById('messages').children;

  try {
    loadFile('js/faq-data.js');
    loadFile('js/store.js');
    loadFile('js/engine.js');
    loadFile('js/cloud.js');
    // 预置 5 颗星（app.js 加载时绑定）
    const starsBox = documentMock.getElementById('stars');
    for (let v = 1; v <= 5; v++) {
      const s = makeEl('button');
      s.setAttribute('data-v', String(v));
      s._attrs['data-v'] = String(v);
      starsBox.appendChild(s);
    }
    loadFile('js/app.js');
    await tick(); // 等待首屏 renderHistory 完成
    console.log('  ✓ 模块加载 + 首屏渲染完成');
    pass++;
  } catch (e) {
    fail++; console.log('  ✗ 加载抛错: ' + e.message);
    console.log(e.stack);
    process.exit(1);
  }

  const STORE = sandbox.window.CS_STORE;

  // 1) 发送 -> 多轮应答
  documentMock.getElementById('input').value = '我要退款怎么操作';
  await documentMock.getElementById('sendBtn')._fire('click');
  const bubbles1 = messages();
  const text1 = bubbles1.map(wrapText).join(' | ');
  assert('发送后消息气泡 >= 3（欢迎+用户+机器人）', bubbles1.length >= 3, 'len=' + bubbles1.length);
  assert('机器人回复命中退款内容', /退款|订单/.test(text1), text1.slice(0, 60));

  // 2) 转人工 -> 面板出现
  documentMock.getElementById('input').value = '转人工';
  await documentMock.getElementById('sendBtn')._fire('click');
  assert('转人工后面板显示', documentMock.getElementById('transferPanel').style.display === 'block', documentMock.getElementById('transferPanel').style.display);

  // 3) 新建对话 -> 5 星评分 -> resolved
  await documentMock.getElementById('newChatBtn')._fire('click');
  await tick();
  const star5 = documentMock.getElementById('stars').children[4]; // data-v=5
  await star5._fire('click');
  const activeId1 = sandbox.sessionStorage.getItem('cs_active_conv');
  const convRated = await STORE.getConversation(activeId1);
  assert('5 星评分写入满意度', convRated.satisfaction === 5, 'sat=' + convRated.satisfaction);
  assert('评分后状态置 resolved', convRated.status === 'resolved', convRated.status);

  // 4) 后台写入人工回复 -> 轮询自动显示
  await STORE.appendMessage(activeId1, 'agent', '您好，我是人工客服，正在为您处理退款。');
  await STORE.updateConversation(activeId1, { agentReplied: true });
  await Promise.all(intervals.map((fn) => fn())); // 触发轮询
  const bubbles2 = messages();
  const hasAgent = bubbles2.some((b) => hasClass(b, 'msg-agent'));
  assert('轮询后显示人工回复气泡', hasAgent, 'len=' + bubbles2.length);

  console.log('\n========================================');
  console.log(`流程测试: ${pass} 通过 / ${fail} 失败`);
  if (fail) { console.log('失败项:'); fails.forEach((f) => console.log('  - ' + f)); }
  console.log('========================================');
  process.exit(fail ? 1 : 0);
})();
