// 全场景验收测试：模拟店员一天的操作，逐项核对金额
const BASE = 'http://127.0.0.1:3101';
let cookie = '';

async function api(method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const setC = res.headers.getSetCookie?.() ?? [];
  if (setC.length) cookie = setC.map((c) => c.split(';')[0]).join('; ');
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  if (!res.ok) throw new Error(data?.error?.message ?? `HTTP ${res.status}`);
  return data;
}

const yuan = (c) => '¥' + (c / 100).toFixed(2);
let pass = 0, fail = 0;
function check(label, actual, expected) {
  const ok = actual === expected;
  if (ok) pass++; else fail++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}` + (ok ? '' : `  期望 ${expected}，实际 ${actual}`));
}

await api('POST', '/api/v1/auth/login', { username: 'admin', password: 'Pindou2026Dev' });
const prods = (await api('GET', '/api/v1/products')).products;
const P = {};
for (const p of prods) P[p.code] = p;
const tables = (await api('GET', '/api/v1/tables')).tables;

async function idleTable(n = 1) {
  const now = (await api('GET', '/api/v1/tables')).tables.filter((t) => t.status === 'idle');
  if (now.length < n) throw new Error('空闲桌不足');
  return now;
}

// ─────────────────────────────────────────────
console.log('\n【1】散客 · 限时套餐 · 无加购');
{
  const [t] = await idleTable();
  const r = await api('POST', '/api/v1/sessions', { tableId: t.id, guestName: '散客甲', productId: P.T1H_S.id });
  const pv = (await api('GET', `/api/v1/sessions/${r.sessionId}/preview`)).preview;
  check('预览应收 = 套餐价', pv.totalCents, P.T1H_S.priceCents);

  const st = await api('POST', `/api/v1/sessions/${r.sessionId}/settle`, { paymentMethod: 'cash' });
  check('结账实收 = 套餐价', st.paidCents, P.T1H_S.priceCents);
}

// ─────────────────────────────────────────────
console.log('\n【2】加购数量 · 预览与结账必须一致');
{
  const [t] = await idleTable();
  const r = await api('POST', '/api/v1/sessions', { tableId: t.id, guestName: '散客乙', productId: P.P78.id });
  const addons = `${P.ADD_BOARD.id}:2,${P.ADD_IRON.id}:3`;

  const pv = (await api('GET', `/api/v1/sessions/${r.sessionId}/preview?addons=${addons}`)).preview;
  const expectAddon = P.ADD_BOARD.priceCents * 2 + P.ADD_IRON.priceCents * 3;
  check('预览加购 = 9.90×2 + 2.88×3', pv.addonOriginalCents, expectAddon);
  check('预览应收 = 套餐 + 加购', pv.totalCents, P.P78.priceCents + expectAddon);

  const st = await api('POST', `/api/v1/sessions/${r.sessionId}/settle`, {
    addonItems: [
      { id: P.ADD_BOARD.id, qty: 2 },
      { id: P.ADD_IRON.id, qty: 3 },
    ],
    paymentMethod: 'wechat',
  });
  check('结账加购金额一致', st.addonAmountCents, expectAddon);
  check('结账实收一致', st.paidCents, pv.totalCents);
}

// ─────────────────────────────────────────────
console.log('\n【3】同一加购项重复提交 → 数量合并');
{
  const [t] = await idleTable();
  const r = await api('POST', '/api/v1/sessions', { tableId: t.id, guestName: '散客丙', productId: P.T1H_S.id });
  const st = await api('POST', `/api/v1/sessions/${r.sessionId}/settle`, {
    addonItems: [
      { id: P.ADD_IRON.id, qty: 1 },
      { id: P.ADD_IRON.id, qty: 2 },
    ],
    paymentMethod: 'cash',
  });
  check('特殊烫 1+2 合并为 3 件', st.addonAmountCents, P.ADD_IRON.priceCents * 3);
}

// ─────────────────────────────────────────────
console.log('\n【4】实收调整：少收');
{
  const [t] = await idleTable();
  const r = await api('POST', '/api/v1/sessions', { tableId: t.id, guestName: '熟人A', productId: P.T1H_S.id });
  const st = await api('POST', `/api/v1/sessions/${r.sessionId}/settle`, {
    paymentMethod: 'cash', overrideTotalCents: 500, overrideReason: '熟客',
  });
  check('少收为 5.00', st.paidCents, 500);
}

console.log('\n【5】实收调整：多收（不用找零）');
{
  const [t] = await idleTable();
  const r = await api('POST', '/api/v1/sessions', { tableId: t.id, guestName: '顾客B', productId: P.T1H_S.id });
  const st = await api('POST', `/api/v1/sessions/${r.sessionId}/settle`, {
    paymentMethod: 'cash', overrideTotalCents: 2000, overrideReason: '不用找零',
  });
  check('多收为 20.00', st.paidCents, 2000);
}

// ─────────────────────────────────────────────
console.log('\n【6】用卡核销：套餐免费，加购照收');
{
  const members = (await api('GET', '/api/v1/members?limit=50')).members;
  let m = members.find((x) => x.cardType && x.cardValid && !x.cardFrozen);
  if (!m) {
    const nm = await api('POST', '/api/v1/members', { nickname: '验收员', phoneTail: '7777' });
    await api('POST', `/api/v1/members/${nm.id}/card`, { cardType: 'week', productId: P.WEEK_N.id, paymentMethod: 'wechat' });
    m = (await api('GET', `/api/v1/members/${nm.id}`)).member;
  }
  const [t] = await idleTable();
  const r = await api('POST', '/api/v1/sessions', { tableId: t.id, memberId: m.id, useCard: true });
  check('用卡开台无预计结束时间', r.expectedEndAt, null);

  const pv = (await api('GET', `/api/v1/sessions/${r.sessionId}/preview?addons=${P.ADD_BOARD.id}:1`)).preview;
  check('用卡时套餐费为 0', pv.productOriginalCents, 0);
  check('用卡时加购照收', pv.addonOriginalCents, P.ADD_BOARD.priceCents);
  check('用卡时不计超时', pv.overtimeFeeCents, 0);

  const st = await api('POST', `/api/v1/sessions/${r.sessionId}/settle`, {
    addonItems: [{ id: P.ADD_BOARD.id, qty: 1 }], paymentMethod: 'card',
  });
  check('用卡结账只收加购', st.paidCents, P.ADD_BOARD.priceCents);
}

// ─────────────────────────────────────────────
console.log('\n【7】限板套餐不计超时');
{
  const [t] = await idleTable();
  const r = await api('POST', '/api/v1/sessions', { tableId: t.id, guestName: '限板客', productId: P.P104.id });
  const pv = (await api('GET', `/api/v1/sessions/${r.sessionId}/preview`)).preview;
  check('限板无超时费', pv.overtimeFeeCents, 0);
  check('限板无超时分钟', pv.overtimeMinutes, 0);
  const st = await api('POST', `/api/v1/sessions/${r.sessionId}/settle`, { paymentMethod: 'cash' });
  check('限板实收 = 套餐价', st.paidCents, P.P104.priceCents);
}

// ─────────────────────────────────────────────
console.log('\n【8】日卡不计超时');
{
  const [t] = await idleTable();
  const r = await api('POST', '/api/v1/sessions', { tableId: t.id, guestName: '日卡客', productId: P.DAY_S.id });
  const pv = (await api('GET', `/api/v1/sessions/${r.sessionId}/preview`)).preview;
  check('日卡无超时费', pv.overtimeFeeCents, 0);
  await api('POST', `/api/v1/sessions/${r.sessionId}/settle`, { paymentMethod: 'cash' });
}

// ─────────────────────────────────────────────
console.log('\n【9】超时阶梯（用 SQL 把开始时间改到过去）');
{
  const { execSync } = await import('node:child_process');
  const psql = 'D:\\PostgreSQL\\bin\\psql.exe';

  for (const [overMin, expectFee] of [[10, 500], [20, 500], [21, 688], [31, 876], [45, 1064]]) {
    const [t] = await idleTable();
    const r = await api('POST', '/api/v1/sessions', { tableId: t.id, guestName: `超时${overMin}`, productId: P.T1H_S.id });
    // 单人1小时，把开始时间改到 (60 + overMin) 分钟前
    const total = 60 + overMin;
    execSync(`"${psql}" -w -h 127.0.0.1 -p 5432 -U postgres -d pindou -c "UPDATE table_sessions SET started_at = now() - interval '${total} minutes', expected_end_at = now() - interval '${overMin} minutes' WHERE id = ${r.sessionId}"`, { stdio: 'ignore' });

    const pv = (await api('GET', `/api/v1/sessions/${r.sessionId}/preview`)).preview;
    check(`超时 ${overMin} 分钟 → ${yuan(expectFee)}`, pv.overtimeFeeCents, expectFee);
    await api('POST', `/api/v1/sessions/${r.sessionId}/settle`, { paymentMethod: 'cash' });
  }
}

// ─────────────────────────────────────────────
console.log('\n【10】结账后桌位释放');
{
  const board = await api('GET', '/api/v1/board');
  const idle = board.tables.filter((t) => t.status === 'idle').length;
  check('所有测试桌已释放', board.tables.filter((t) => t.status === 'occupied' && t.session?.displayName?.includes('客')).length, 0);
  console.log(`     当前占用 ${board.summary.occupied} / 空闲 ${board.summary.idle}`);
}

// ─────────────────────────────────────────────
console.log('\n【11】对账');
{
  const rec = await api('GET', '/api/v1/revenue/reconcile');
  console.log(`     消费 流水 ${yuan(rec.consumeLedgerCents)} / 订单 ${yuan(rec.consumeOrdersCents)}`);
  console.log(`     办卡 流水 ${yuan(rec.cardLedgerCents)} / 记录 ${yuan(rec.cardRecordsCents)}`);
  check('账目平衡', rec.balanced, true);
}

// ─────────────────────────────────────────────
console.log('\n【12】冲突防护');
{
  const tables2 = (await api('GET', '/api/v1/tables')).tables;
  const busy = tables2.find((t) => t.status === 'occupied');
  if (busy) {
    let rejected = false;
    try {
      await api('POST', '/api/v1/sessions', { tableId: busy.id, guestName: '冲突', productId: P.T1H_S.id });
    } catch { rejected = true; }
    check('占用中的桌位拒绝重复开台', rejected, true);
  } else {
    console.log('     （无占用桌位，跳过）');
  }
}

console.log(`\n${'='.repeat(50)}`);
console.log(`通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail > 0 ? 1 : 0);
