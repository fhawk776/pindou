import { getPool, closePool } from '../src/lib/db.js';
import { isCardExpired, isDiscountDay } from '../src/services/tables.js';

console.log('=== 当前时区信息 ===');
console.log('Node TZ:', process.env.TZ ?? '(未设置)');
console.log('本机时间:', new Date().toString());
console.log('上海日期:', new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
}).format(new Date()));
console.log('UTC 日期:', new Date().toISOString().slice(0, 10));

console.log('\n=== isCardExpired 测试 ===');
const cases: Array<[string | null, boolean]> = [
  ['2020-01-01', true],   // 很久以前 → 过期
  ['2026-01-01', true],   // 过去 → 过期
  ['2099-12-31', false],  // 未来 → 有效
  [null, true],           // 无值 → 视为过期
];
for (const [input, expected] of cases) {
  const actual = isCardExpired(input);
  console.log(`  ${String(input).padEnd(12)} → ${actual}  ${actual === expected ? '✓' : '✗ 期望 ' + expected}`);
}

// 查数据库里的实际存储格式
const pool = getPool();
const { rows } = await pool.query(`
  SELECT card_expires_at, card_expires_at::text AS as_text,
         (card_expires_at - CURRENT_DATE) AS days_left,
         CURRENT_DATE::text AS today
    FROM members WHERE card_expires_at IS NOT NULL LIMIT 3
`);
console.log('\n=== 数据库中的实际值 ===');
for (const r of rows) {
  console.log(`  原始: ${r.card_expires_at}  文本: ${r.as_text}  剩余天数: ${r.days_left}  今天: ${r.today}`);
}
console.log('\n注：DATE 经 pg 驱动读回后会被转成 JS Date（本地时区零点），');
console.log('    因此 String() 得到的可能是 GMT 格式字符串，直接 slice(0,10) 会失真。');

await closePool();
