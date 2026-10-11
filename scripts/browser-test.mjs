/**
 * 用 Playwright 风格的 CDP 直连做浏览器端验证
 * 没有装 playwright，改用 Edge 的远程调试 + 原生 WebSocket
 */
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 9222;
const BASE = 'http://127.0.0.1:3101';

// 启动带调试端口的 Edge
const proc = spawn(EDGE, [
  `--remote-debugging-port=${PORT}`,
  '--headless=new',
  '--disable-gpu',
  '--no-first-run',
  `--user-data-dir=C:\\temp\\edge-cdp-${Date.now()}`,
  BASE,
], { stdio: 'ignore', detached: false });

await sleep(4000);

async function cdpTargets() {
  const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
  return res.json();
}

let targets;
try {
  targets = await cdpTargets();
} catch (e) {
  console.log('无法连接调试端口:', e.message);
  proc.kill();
  process.exit(1);
}

const page = targets.find((t) => t.type === 'page' && t.url.includes('3101'));
if (!page) {
  console.log('未找到页面。现有目标:', targets.map((t) => `${t.type}:${t.url}`).join(', '));
  proc.kill();
  process.exit(1);
}
console.log('已连接页面:', page.url);

const ws = new WebSocket(page.webSocketDebuggerUrl);
let msgId = 0;
const pending = new Map();
const consoleLogs = [];

ws.addEventListener('message', (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg);
    pending.delete(msg.id);
  }
  if (msg.method === 'Runtime.consoleAPICalled') {
    const text = msg.params.args.map((a) => a.value ?? a.description ?? '').join(' ');
    consoleLogs.push(`[${msg.params.type}] ${text}`);
  }
  if (msg.method === 'Runtime.exceptionThrown') {
    const d = msg.params.exceptionDetails;
    consoleLogs.push(`[EXCEPTION] ${d.exception?.description ?? d.text}`);
  }
});

await new Promise((r) => ws.addEventListener('open', r));

function send(method, params = {}) {
  const id = ++msgId;
  return new Promise((resolve) => {
    pending.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params }));
  });
}

async function evaluate(expr) {
  const r = await send('Runtime.evaluate', {
    expression: expr, awaitPromise: true, returnByValue: true,
  });
  if (r.result?.exceptionDetails) {
    return { error: r.result.exceptionDetails.exception?.description ?? 'unknown' };
  }
  return { value: r.result?.result?.value };
}

await send('Runtime.enable');
await send('Page.enable');

// ---- 等待应用加载 ----
await sleep(2500);
let r = await evaluate(`document.querySelector('#app')?.innerText?.slice(0,80) ?? 'EMPTY'`);
console.log('\n=== 初始页面 ===');
console.log(r.value);

// ---- 登录 ----
console.log('\n=== 执行登录 ===');
r = await evaluate(`
(async () => {
  document.querySelector('#username').value = 'admin';
  document.querySelector('#password').value = 'Pindou2026Dev';
  await doLogin();
  await new Promise(r => setTimeout(r, 2500));
  return document.querySelector('#app')?.innerText?.slice(0, 200) ?? 'EMPTY';
})()
`);
console.log(r.value ?? r.error);

// ---- 找到一个空闲工位并点击 ----
console.log('\n=== 查找空闲工位 ===');
r = await evaluate(`
(() => {
  const idle = [...document.querySelectorAll('.seat.idle')];
  return { count: idle.length, first: idle[0]?.querySelector('.seat-name')?.innerText ?? null };
})()
`);
console.log('空闲工位:', JSON.stringify(r.value));

if (!r.value?.first) {
  console.log('没有空闲工位，无法继续');
  ws.close(); proc.kill(); process.exit(0);
}

console.log('\n=== 点击空闲工位，进入开台页 ===');
r = await evaluate(`
(async () => {
  document.querySelector('.seat.idle').click();
  await new Promise(r => setTimeout(r, 2000));
  return {
    hasGuestInput: !!document.querySelector('#guestName'),
    text: document.querySelector('#app')?.innerText?.slice(0, 250) ?? 'EMPTY'
  };
})()
`);
console.log('散客输入框存在:', r.value?.hasGuestInput);
console.log('页面内容:', r.value?.text);

// ---- 填散客名并点「以散客身份开台」 ----
console.log('\n=== 填写散客称呼并点击按钮 ===');
r = await evaluate(`
(async () => {
  const input = document.querySelector('#guestName');
  if (!input) return { error: '找不到散客输入框' };
  input.value = "小明的妈妈";
  // 找到「以散客身份开台」按钮
  const btn = [...document.querySelectorAll('button')].find(b => b.innerText.includes('散客身份'));
  if (!btn) return { error: '找不到散客按钮' };
  btn.click();
  await new Promise(r => setTimeout(r, 2000));
  return {
    cards: document.querySelectorAll('.product-card').length,
    text: document.querySelector('#app')?.innerText?.slice(0, 250) ?? 'EMPTY'
  };
})()
`);
console.log('套餐卡片数:', r.value?.cards);
console.log('页面内容:', r.value?.text ?? r.error);

// ---- 点一个套餐，完成开台 ----
console.log('\n=== 点击套餐开台 ===');
r = await evaluate(`
(async () => {
  const card = document.querySelector('.product-card');
  if (!card) return { error: '找不到套餐卡片' };
  const name = card.querySelector('.pname')?.innerText;
  card.click();
  await new Promise(r => setTimeout(r, 2500));
  return {
    clicked: name,
    url: location.href,
    text: document.querySelector('#app')?.innerText?.slice(0, 300) ?? 'EMPTY'
  };
})()
`);
console.log('点击的套餐:', r.value?.clicked);
console.log('页面内容:', r.value?.text ?? r.error);

// ---- 检查控制台错误 ----
console.log('\n=== 浏览器控制台 ===');
if (consoleLogs.length === 0) console.log('（无错误输出）');
else consoleLogs.slice(0, 15).forEach((l) => console.log(l));

ws.close();
proc.kill();
console.log('\n完成');
process.exit(0);
