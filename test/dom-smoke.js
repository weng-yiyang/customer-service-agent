/* =========================================================================
 * dom-smoke.js — DOM 层冒烟测试（最小 DOM 模拟，验证加载+首屏渲染不抛错）
 * 运行：node test/dom-smoke.js
 * ========================================================================= */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ROOT = path.resolve(__dirname, '..');

function makeEl() {
  const el = {
    style: {}, value: '', _text: '', _html: '',
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    children: [],
    appendChild(c) { this.children.push(c); return c; },
    addEventListener() {},
    querySelectorAll() { return []; },
    getAttribute() { return null; }, setAttribute() {},
    focus() {},
  };
  Object.defineProperty(el, 'textContent', { get() { return this._text; }, set(v) { this._text = v; } });
  Object.defineProperty(el, 'innerHTML', { get() { return this._html; }, set(v) { this._html = v; } });
  return el;
}

const mem = {};
const storageMock = {
  getItem: (k) => (k in mem ? mem[k] : null),
  setItem: (k, v) => { mem[k] = String(v); },
  removeItem: (k) => { delete mem[k]; },
};

const documentMock = {
  getElementById() { return makeEl(); },
  createElement() { return makeEl(); },
  querySelectorAll() { return []; },
  head: { appendChild() {} },
  body: makeEl(),
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
sandbox.setInterval = () => 0;
sandbox.clearInterval = () => {};
sandbox.location = { reload() {}, href: '', assign() {}, searchParams: { has() { return false; }, get() { return null; }, delete() {} } };
vm.createContext(sandbox);

function loadFile(rel) {
  const code = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  vm.runInContext(code, sandbox, { filename: rel });
}

let pass = 0, fail = 0;
try {
  loadFile('js/faq-data.js');
  loadFile('js/store.js');
  loadFile('js/engine.js');
  loadFile('js/cloud.js');
  console.log('  ✓ 数据/存储/引擎/云端模块加载无异常');
  pass++;
} catch (e) {
  fail++; console.log('  ✗ 模块加载抛错: ' + e.message);
}

// 等待 app.js 首屏异步渲染完成
setTimeout(() => {
  try {
    loadFile('js/app.js');
    console.log('  ✓ app.js 加载 + 首屏 renderHistory 无异常（顾客端）');
    pass++;
  } catch (e) {
    fail++; console.log('  ✗ app.js 抛错: ' + e.message);
  }
  try {
    loadFile('js/admin.js');
    console.log('  ✓ admin.js 加载无异常（后台登录视图）');
    pass++;
  } catch (e) {
    fail++; console.log('  ✗ admin.js 抛错: ' + e.message);
  }
  console.log('\n========================================');
  console.log(`DOM 冒烟: ${pass} 通过 / ${fail} 失败`);
  console.log('========================================');
  process.exit(fail ? 1 : 0);
}, 50);
