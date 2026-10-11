/**
 * 抓取当前系统的真实数据快照，供离线演示文件使用。
 */
import { writeFileSync } from 'node:fs';

const BASE = 'http://127.0.0.1:3101';
const OUT = 'D:\\temp\\pindou-data-min.json';

let cookie = '';

async function req(method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const setCookie = res.headers.getSetCookie?.() ?? [];
  if (setCookie.length) cookie = setCookie.map((c) => c.split(';')[0]).join('; ');
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${text}`);
  return text ? JSON.parse(text) : null;
}

const snap = {};

await req('POST', '/api/v1/auth/login', { username: 'admin', password: 'Pindou2026Dev' });

snap.board = await req('GET', '/api/v1/board');
snap.members = await req('GET', '/api/v1/members?limit=50');
snap.products = await req('GET', '/api/v1/products');
snap.tables = await req('GET', '/api/v1/tables');
snap.summary = await req('GET', '/api/v1/revenue/summary');
snap.orders = await req('GET', '/api/v1/orders?limit=30');
snap.ledger = await req('GET', '/api/v1/revenue/ledger?limit=30');
snap.settings = await req('GET', '/api/v1/settings');

// 每个会员的详情 + 卡权益流水
snap.memberDetails = [];
snap.cardRecords = {};
for (const m of snap.members.members) {
  const d = await req('GET', `/api/v1/members/${m.id}`);
  snap.memberDetails.push(d.member);
  const r = await req('GET', `/api/v1/members/${m.id}/card-records`);
  snap.cardRecords[String(m.id)] = r.records;
}

writeFileSync(OUT, JSON.stringify(snap), 'utf8');

console.log('快照已生成');
console.log(`  工位 ${snap.board.tables.length} 张（使用中 ${snap.board.summary.occupied}）`);
console.log(`  会员 ${snap.members.members.length} 人`);
console.log(`  套餐 ${snap.products.products.length} 个`);
console.log(`  订单 ${snap.orders.orders.length} 笔`);
console.log(`  流水 ${snap.ledger.entries.length} 条`);
console.log(`  权益记录 ${Object.values(snap.cardRecords).flat().length} 条`);
