/**
 * 打包单文件离线演示。
 *
 * 关键点：所有内联内容都通过 readFileSync 读入后再拼接，
 * 绝不把 JS 源码写进模板字符串 —— 那会让 \/ 与 \d 之类的转义被吃掉，
 * 导致生成的文件在浏览器里报 "Invalid regular expression flags"。
 */
import { readFileSync, writeFileSync } from 'node:fs';

const WEB = 'D:\\DSH\\pindou\\web';
const SCRIPTS = 'D:\\DSH\\pindou\\scripts';
const SNAPSHOT = 'D:\\temp\\pindou-data-min.json';
const OUT = 'D:\\DSH\\pindou\\docs\\pindou-demo.html';

const css = readFileSync(`${WEB}\\app.css`, 'utf8');
const appJs = readFileSync(`${WEB}\\app.js`, 'utf8');
const runtimeJs = readFileSync(`${SCRIPTS}\\demo-runtime.js`, 'utf8');
const snapshot = readFileSync(SNAPSHOT, 'utf8');

// 数据里若出现 </script 会提前闭合标签，需要打散
const safeSnapshot = snapshot.split('</script').join('<\\/script');

const PARTS = [];

PARTS.push(`<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<!-- 移动端关键设置：
     width=device-width 让布局宽度跟随屏幕，而不是按 980px 缩放后缩小显示。
     maximum-scale 不设限，允许用户双指放大查看细节。
     viewport-fit=cover 适配刘海屏。 -->
<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
<meta name="theme-color" content="#FF6B9D">
<meta name="format-detection" content="telephone=no">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-title" content="请拼豆">
<title>请拼豆 · 会员管理系统（演示）</title>
<style>
`);

PARTS.push(css);

PARTS.push(`

/* ---------- 演示模式专用样式 ---------- */
.demo-banner {
  position: fixed; right: 12px; bottom: calc(88px + env(safe-area-inset-bottom, 0px));
  z-index: 150; background: rgba(74, 59, 66, .82); color: #fff;
  font-size: 11px; padding: 6px 12px; border-radius: 999px;
  backdrop-filter: blur(8px); pointer-events: none; letter-spacing: .3px;
}
@media (min-width: 720px) { .demo-banner { bottom: 16px; } }

.demo-toast {
  position: fixed; left: 50%; transform: translateX(-50%);
  bottom: calc(140px + env(safe-area-inset-bottom, 0px));
  background: #4A3B42; color: #fff; font-size: 12px;
  padding: 8px 16px; border-radius: 999px; z-index: 160;
  max-width: 88vw; text-align: center; opacity: .95;
}
</style>
</head>
<body>
<div id="app"></div>
<div class="demo-banner">演示版 · 数据为快照</div>

<script id="demo-data" type="application/json">`);

PARTS.push(safeSnapshot);

PARTS.push(`</script>

<script>
`);

PARTS.push(runtimeJs);

PARTS.push(`
</script>

<script>
`);

PARTS.push(appJs);

PARTS.push(`
</script>
</body>
</html>
`);

const html = PARTS.join('');
writeFileSync(OUT, html, 'utf8');

const kb = (Buffer.byteLength(html, 'utf8') / 1024).toFixed(1);
console.log('已生成: ' + OUT);
console.log('大小: ' + kb + ' KB');
