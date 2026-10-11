/**
 * 门店一天 · 完整业务场景测试
 *
 * 以「店员 + 店长」的视角，把真实一天里会遇到的情况全部走一遍，
 * 包括正常流程和那些容易出错的边角（超时、暂停、多台、取消、多收少收）。
 *
 * 跑法（需先起 3102 指向 pindou_test）：
 *   node scripts/store-day.mjs
 */
import { execSync } from 'node:child_process';

const BASE = 'http://127.0.0.1:3102';
const PSQL = 'D:\\PostgreSQL\\bin\\psql.exe';
const ENV = { ...process.env, PGHOST: '127.0.0.1', PGPORT: '5432', PGUSER: 'postgres', PGPASSWORD: '', PGDATABASE: 'pindou_test' };

let cookie = '';
async function api(method, path, body) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (cookie) headers.Cookie = cookie;
  const res = await fetch(BASE + path, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  const sc = res.headers.getSetCookie?.() ?? [];
  if (sc.length) cookie = sc.map((c) => c.split(';')[0]).join('; ');
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch { data = { raw: text }; }
  return { ok: res.ok, status: res.status, data };
}
function sql(q) {
  try {
    return execSync(`"${PSQL}" -w -tAc "${q.replace(/"/g, '\\"')}"`, { env: ENV, encoding: 'utf8' }).trim();
  } catch (e) { return 'ERR:' + String(e.stderr || e.message).slice(0, 120); }
}

let pass = 0, fail = 0;
const failures = [];
function check(name, actual, expected) {
  const ok = String(actual) === String(expected);
  if (ok) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; failures.push(`${name}（期望 ${expected}，实际 ${actual}）`); console.log(`  ❌ ${name} — 期望 ${expected}，实际 ${actual}`); }
}
function section(t) { console.log(`\n${'═'.repeat(64)}\n  ${t}\n${'═'.repeat(64)}`); }

const yuan = (c) => '¥' + (c / 100).toFixed(2);

// ---------------------------------------------------------------- 开店
section('① 开店');
const login = await api('POST', '/api/v1/auth/login', { username: 'admin', password: 'Pindou2026Dev' });
check('登录成功', login.ok, 'true');

let board = (await api('GET', '/api/v1/board')).data;
check('看板 8 张桌', board.tables.length, 8);
check('开局全部空闲', board.tables.filter((t) => t.status === 'idle').length, 8);
check('定价规则加载', board.pricing.overtime_base_fee_cents, 500);

const prods = (await api('GET', '/api/v1/products')).data.products;
const P = {}; for (const p of prods) P[p.code] = p;
const idleIds = board.tables.filter((t) => t.status === 'idle').map((t) => t.tableId);
console.log(`  可用桌位: ${idleIds.join(', ')}`);

// ---------------------------------------------------------------- 散客
section('② 散客开台 → 正常结账（未超时）');
const r1 = await api('POST', '/api/v1/sessions', {
  tableId: idleIds[0], guestName: '穿蓝衣服的姐姐', productId: P.T1H_S.id,
});
check('开台成功', r1.ok, 'true');
check('桌位名', r1.data.tableName, '01号桌');
check('套餐名', r1.data.productName, '单人1小时');

const settle1 = await api('POST', `/api/v1/sessions/${r1.data.sessionId}/settle`, { paymentMethod: 'wechat' });
check('结账成功', settle1.ok, 'true');
check('应收 ¥12.80', settle1.data.totalCents, 1280);
check('实收 ¥12.80', settle1.data.paidCents, 1280);
check('无超时费', settle1.data.overtimeFeeCents, 0);
check('有流水号', Boolean(settle1.data.flowNo), 'true');

board = (await api('GET', '/api/v1/board')).data;
check('桌位已释放', board.tables.find((t) => t.tableId === idleIds[0]).status, 'idle');

// ---------------------------------------------------------------- 会员 + 暂停 + 加购
section('③ 会员开台 → 暂停 → 恢复 → 加购 → 结账');
const m1 = (await api('POST', '/api/v1/members', { nickname: '小雨', phoneTail: '5481' })).data;
check('建档成功', m1.memberNo, 'PD0001');
// createMember 只返回 id/memberNo/nickname/phoneTail，显示名由详情接口拼
const m1detail0 = (await api('GET', `/api/v1/members/${m1.id}`)).data.member;
check('会员显示名', m1detail0.displayName, '小雨 · 5481');

const r2 = await api('POST', '/api/v1/sessions', {
  tableId: idleIds[1], memberId: m1.id, productId: P.T3H_S.id,
});
check('会员开台成功', r2.ok, 'true');

// 暂停
const p1 = await api('POST', `/api/v1/sessions/${r2.data.sessionId}/pause`);
check('暂停成功', p1.ok, 'true');
let detail = (await api('GET', `/api/v1/sessions/${r2.data.sessionId}`)).data.session;
check('状态=已暂停', detail.paused, 'true');
check('暂停时倒计时冻结', detail.elapsedMinutes, 0);

// 模拟暂停了 30 分钟
sql(`UPDATE table_sessions SET paused_at = now() - interval '30 minutes' WHERE id = ${r2.data.sessionId}`);
const p2 = await api('POST', `/api/v1/sessions/${r2.data.sessionId}/resume`);
check('恢复成功', p2.ok, 'true');
detail = (await api('GET', `/api/v1/sessions/${r2.data.sessionId}`)).data.session;
check('恢复后不再暂停', detail.paused, 'false');

// 加购
const pv = (await api('GET', `/api/v1/sessions/${r2.data.sessionId}/preview?addons=${P.ADD_BOARD.id}:2`)).data.preview;
check('加购 2 个拼豆板 = ¥19.80', pv.addonAmountCents, 1980);
check('应收 = 套餐 ¥33.80 + 加购 ¥19.80', pv.totalCents, 5360);

const settle2 = await api('POST', `/api/v1/sessions/${r2.data.sessionId}/settle`, {
  addonItems: [{ id: P.ADD_BOARD.id, qty: 2 }], paymentMethod: 'alipay',
});
check('结账实收', settle2.data.paidCents, 5360);
check('暂停期间不计费（未超时）', settle2.data.overtimeFeeCents, 0);
check('加购金额入账', settle2.data.addonAmountCents, 1980);

// ---------------------------------------------------------------- 超时
section('④ 超时收费（阶梯）');
const r3 = await api('POST', '/api/v1/sessions', {
  tableId: idleIds[2], guestName: '超时测试', productId: P.T1H_S.id,
});
// 模拟开台 90 分钟前 → 超时 30 分钟 → 打底 ¥5 + 1 档 ¥1.88
sql(`UPDATE table_sessions SET started_at = now() - interval '90 minutes' WHERE id = ${r3.data.sessionId}`);
const pv3 = (await api('GET', `/api/v1/sessions/${r3.data.sessionId}/preview`)).data.preview;
check('已进行 90 分钟', pv3.actualMinutes, 90);
check('超时 30 分钟', pv3.overtimeMinutes, 30);
check('超时费 ¥6.88（5 + 1.88）', pv3.overtimeFeeCents, 688);
check('应收 ¥19.68', pv3.totalCents, 1968);

// 模拟 61 分钟 → 只超 1 分钟 → 打底 ¥5
sql(`UPDATE table_sessions SET started_at = now() - interval '61 minutes' WHERE id = ${r3.data.sessionId}`);
const pv3b = (await api('GET', `/api/v1/sessions/${r3.data.sessionId}/preview`)).data.preview;
check('超时 1 分钟收打底 ¥5', pv3b.overtimeFeeCents, 500);

// 59 分钟 → 不超时
sql(`UPDATE table_sessions SET started_at = now() - interval '59 minutes' WHERE id = ${r3.data.sessionId}`);
const pv3c = (await api('GET', `/api/v1/sessions/${r3.data.sessionId}/preview`)).data.preview;
check('59 分钟不收超时费', pv3c.overtimeFeeCents, 0);
await api('POST', `/api/v1/sessions/${r3.data.sessionId}/settle`, { paymentMethod: 'cash' });

// ---------------------------------------------------------------- 办卡（开台页）
section('⑤ 办卡并开台（开台页入口）');
const m2 = (await api('POST', '/api/v1/members', { nickname: '阿梨', phoneTail: '8892' })).data;
const r4 = await api('POST', '/api/v1/sessions', {
  tableId: idleIds[3], memberId: m2.id, productId: null, useCard: true,
  cardProductId: P.WEEK_P.id, cardPaymentMethod: 'wechat',
});
check('办卡并开台成功', r4.ok, 'true');
check('是用卡核销', r4.data.useCard, 'true');
check('办了 ¥188 的卡', r4.data.boughtCard.priceCents, 18800);
check('权益起始日=今天', r4.data.cardStartedAt, sql('select to_char(CURRENT_DATE, \'YYYY-MM-DD\')'));
check('权益 7 天', sql(`select (card_expires_at - card_started_at) from members where id=${m2.id}`), 6);

// ---------------------------------------------------------------- 用卡开台（已持卡）
section('⑥ 用卡开台（已持卡，不收钱）');
// 先把上一个台的会话结掉（用卡核销 → ¥0）
const settleCard = await api('POST', `/api/v1/sessions/${r4.data.sessionId}/settle`, { paymentMethod: 'card' });
check('用卡结账收 ¥0', settleCard.data.totalCents, 0);
check('零金额无流水', settleCard.data.flowNo, '');

const r5 = await api('POST', '/api/v1/sessions', {
  tableId: idleIds[3], memberId: m2.id, productId: null, useCard: true,
});
check('二次用卡开台成功', r5.ok, 'true');
check('权益区间一致', r5.data.cardExpiresAt, r4.data.cardExpiresAt);
await api('POST', `/api/v1/sessions/${r5.data.sessionId}/settle`, { paymentMethod: 'card' });

// ---------------------------------------------------------------- 未激活卡
section('⑦ 未激活卡 → 首次用卡才起算');
const m3 = (await api('POST', '/api/v1/members', { nickname: '小李', phoneTail: '3344' })).data;
const buy = await api('POST', `/api/v1/members/${m3.id}/card`, {
  cardType: 'week', productId: P.WEEK_N.id, paymentMethod: 'wechat',
});
check('只办卡不开台', buy.ok, 'true');
check('未激活', buy.data.activated, 'false');
check('待生效 7 天', buy.data.pendingDays, 7);
check('无起始日', buy.data.startedAt, 'null');

const m3detail = (await api('GET', `/api/v1/members/${m3.id}`)).data.member;
check('详情显示未激活', m3detail.cardActivated, 'false');
check('详情可开台（cardValid）', m3detail.cardValid, 'true');

const r6 = await api('POST', '/api/v1/sessions', {
  tableId: idleIds[4], memberId: m3.id, productId: null, useCard: true,
});
check('首次用卡开台成功', r6.ok, 'true');
check('此刻激活，起始=今天', r6.data.cardStartedAt, sql('select to_char(CURRENT_DATE, \'YYYY-MM-DD\')'));
await api('POST', `/api/v1/sessions/${r6.data.sessionId}/settle`, { paymentMethod: 'card' });

// ---------------------------------------------------------------- 双人套餐多台
section('⑧ 双人套餐占两个台（一张单、一次超时费）');
const m4 = (await api('POST', '/api/v1/members', { nickname: '双人组', phoneTail: '7777' })).data;
const r7 = await api('POST', '/api/v1/sessions', {
  tableId: idleIds[5], extraTableIds: [idleIds[6]], memberId: m4.id, productId: P.T1H_D.id,
});
check('开台成功', r7.ok, 'true');
check('占用两个台', r7.data.tableNames.length, 2);

board = (await api('GET', '/api/v1/board')).data;
const grp = board.tables.filter((t) => t.session && t.session.sessionId === r7.data.sessionId);
check('看板两个台显示同一会话', grp.length, 2);
check('两台都标出同组', grp[0].session.groupTableNames, grp[1].session.groupTableNames);

// 【回归】看板桌位数必须严格等于桌位表的行数。
// session_tables 是只增不删的（保留历史），若查询时直接 JOIN 全表，
// 一个台有几条历史就多渲染几行"幽灵空闲桌" —— 曾把 8 张桌渲染成 11 个卡片。
check('看板桌位数 = 桌位表行数', board.tables.length,
  sql(`select count(1) from tables where is_active`));
check('没有重复的桌号',
  sql(`select count(1) from (select name from tables group by name having count(*) > 1) x`), 0);
const names = board.tables.map((t) => t.tableName);
check('看板桌号无重复', new Set(names).size, names.length);

// 别的顾客不能抢其中任一台
const clash = await api('POST', '/api/v1/sessions', {
  tableId: idleIds[6], guestName: '插队', productId: P.T1H_S.id,
});
check('已占的台不能被抢', clash.status, 400);

const settle7 = await api('POST', `/api/v1/sessions/${r7.data.sessionId}/settle`, { paymentMethod: 'cash' });
check('双人套餐只收一次 ¥23.80', settle7.data.totalCents, 2380);
board = (await api('GET', '/api/v1/board')).data;
check('两个台都释放',
  board.tables.filter((t) => idleIds[5] === t.tableId || idleIds[6] === t.tableId).every((t) => t.status === 'idle'),
  'true');

// 人数限制：单人套餐只能占 1 个台，双人套餐最多 2 个台
const m4b = (await api('POST', '/api/v1/members', { nickname: '人数测试', phoneTail: '5555' })).data;
const oneOnTwo = await api('POST', '/api/v1/sessions', {
  tableId: idleIds[5], extraTableIds: [idleIds[6]], memberId: m4b.id, productId: P.T1H_S.id,
});
check('单人套餐不能占 2 个台', oneOnTwo.status, 400);
check('提示是单人套餐', String(oneOnTwo.data?.error?.message ?? '').includes('单人套餐'), 'true');

const twoOnTwo = await api('POST', '/api/v1/sessions', {
  tableId: idleIds[5], extraTableIds: [idleIds[6]], memberId: m4b.id, productId: P.T1H_D.id,
});
check('双人套餐可以占 2 个台', twoOnTwo.ok, 'true');
await api('POST', `/api/v1/sessions/${twoOnTwo.data.sessionId}/settle`, { paymentMethod: 'cash' });

// 双人是「小于等于 2」：只占 1 个台也要允许（一个人买双人套餐、或两人挤一桌）
const twoOnOne = await api('POST', '/api/v1/sessions', {
  tableId: idleIds[5], memberId: m4b.id, productId: P.T1H_D.id,
});
check('双人套餐也可以只占 1 个台', twoOnOne.ok, 'true');
await api('POST', `/api/v1/sessions/${twoOnOne.data.sessionId}/settle`, { paymentMethod: 'cash' });

const twoOnThree = await api('POST', '/api/v1/sessions', {
  tableId: idleIds[5], extraTableIds: [idleIds[6], idleIds[7]], memberId: m4b.id, productId: P.T1H_D.id,
});
check('双人套餐不能占 3 个台', twoOnThree.status, 400);

// 用卡核销也是个人权益，只能占 1 个台
const cardOnTwo = await api('POST', '/api/v1/sessions', {
  tableId: idleIds[5], extraTableIds: [idleIds[6]], memberId: m2.id, productId: null, useCard: true,
});
check('用卡核销不能占 2 个台', cardOnTwo.status, 400);

// ---------------------------------------------------------------- 换套餐
section('⑨ 换套餐');
const r8 = await api('POST', '/api/v1/sessions', {
  tableId: idleIds[0], guestName: '换套餐测试', productId: P.T1H_S.id,
});
const chg = await api('PATCH', `/api/v1/sessions/${r8.data.sessionId}/product`, { productId: P.P78.id });
check('换成 78 钉', chg.ok, 'true');
const pv8 = (await api('GET', `/api/v1/sessions/${r8.data.sessionId}/preview`)).data.preview;
const det8 = (await api('GET', `/api/v1/sessions/${r8.data.sessionId}`)).data.session;
check('不限时（无结束时间）', det8.expectedEndAt, 'null');
check('不限时则无超时费', pv8.overtimeFeeCents, 0);
await api('POST', `/api/v1/sessions/${r8.data.sessionId}/settle`, { paymentMethod: 'cash' });

// ---------------------------------------------------------------- 取消开台
section('⑩ 取消开台（未消费就走了）');
const r9 = await api('POST', '/api/v1/sessions', {
  tableId: idleIds[1], guestName: '临时走了', productId: P.T3H_S.id,
});
const cancel = await api('POST', `/api/v1/sessions/${r9.data.sessionId}/cancel`, { reason: '顾客临时有事离开' });
check('取消成功', cancel.ok, 'true');
check('会话作废', sql(`select status from table_sessions where id=${r9.data.sessionId}`), 'voided');
board = (await api('GET', '/api/v1/board')).data;
check('桌位释放', board.tables.find((t) => t.tableId === idleIds[1]).status, 'idle');

// 已结账的台不能取消
const cancelSettled = await api('POST', `/api/v1/sessions/${r1.data.sessionId}/cancel`, { reason: '试试' });
check('已结账的台拒绝取消', cancelSettled.status, 400);

// ---------------------------------------------------------------- 实收调整
section('⑪ 实收调整（多收 / 少收）');
const r10 = await api('POST', '/api/v1/sessions', {
  tableId: idleIds[2], guestName: '少收测试', productId: P.T1H_S.id,
});
const settle10 = await api('POST', `/api/v1/sessions/${r10.data.sessionId}/settle`, {
  paymentMethod: 'cash', overrideTotalCents: 1000, overrideReason: '熟人少收',
});
check('少收：实收 ¥10', settle10.data.paidCents, 1000);
// 少收体现在人工调整（正数=减免），而不是折扣字段
check('少收差额 ¥2.80 记入人工调整', settle10.data.manualAdjustCents, 280);

const r11 = await api('POST', '/api/v1/sessions', {
  tableId: idleIds[2], guestName: '多收测试', productId: P.T1H_S.id,
});
const settle11 = await api('POST', `/api/v1/sessions/${r11.data.sessionId}/settle`, {
  paymentMethod: 'cash', overrideTotalCents: 1500, overrideReason: '不用找零',
});
check('多收：实收 ¥15', settle11.data.paidCents, 1500);
// 多收记为负数（等于向顾客多收了钱）
check('多收 ¥2.20 记入人工调整（负）', settle11.data.manualAdjustCents, -220);

// ---------------------------------------------------------------- 打折日
section('⑫ 打折日 8 折');
// settings.value 是 jsonb，直接传 jsonb 字面量（不能转 text）
sql(`UPDATE settings SET value = jsonb_set(value, '{discount_days}', '[${new Date().getDate()}]'::jsonb) WHERE key='pricing'`);
const r12 = await api('POST', '/api/v1/sessions', {
  tableId: idleIds[3], guestName: '打折日', productId: P.T1H_S.id,
});
const pv12 = (await api('GET', `/api/v1/sessions/${r12.data.sessionId}/preview`)).data.preview;
check('识别为打折日', pv12.isDiscountDay, 'true');
check('8 折后 ¥10.24', pv12.totalCents, 1024);
await api('POST', `/api/v1/sessions/${r12.data.sessionId}/settle`, { paymentMethod: 'cash' });
// 还原
sql(`UPDATE settings SET value = jsonb_set(value, '{discount_days}', '[8,18,28]'::jsonb) WHERE key='pricing'`);

// ---------------------------------------------------------------- 续卡
section('⑬ 续卡（新一期紧接上一期）');
const before = (await api('GET', `/api/v1/members/${m2.id}`)).data.member;
const renew = await api('POST', `/api/v1/members/${m2.id}/card`, {
  cardType: 'week', productId: P.WEEK_N.id, paymentMethod: 'wechat',
});
check('续卡成功', renew.ok, 'true');
// 首次用卡激活时会补记一条 activate 流水（含本期起止），从这里取上一期的到期日
check('新起始日 = 原到期日次日', renew.data.startedAt, sql(`select to_char(expires_at + 1, 'YYYY-MM-DD') from card_records where member_id=${m2.id} and action='activate' order by id desc limit 1`));
check('新一期仍是 7 天', sql(`select (card_expires_at - card_started_at) from members where id=${m2.id}`), 6);
check('激活事件已记入权益流水', sql(`select count(1) from card_records where member_id=${m2.id} and action='activate'`), 1);

// ---------------------------------------------------------------- 冻结
section('⑭ 冻结 / 解冻');
const fr = await api('POST', `/api/v1/members/${m2.id}/card/freeze`, { reason: '有纠纷先停用', frozen: true });
check('冻结成功', fr.ok, 'true');
const frozenOpen = await api('POST', '/api/v1/sessions', {
  tableId: idleIds[4], memberId: m2.id, productId: null, useCard: true,
});
check('冻结后不能核销', frozenOpen.status, 400);
await api('POST', `/api/v1/members/${m2.id}/card/freeze`, { reason: '', frozen: false });
const unfrozenOpen = await api('POST', '/api/v1/sessions', {
  tableId: idleIds[4], memberId: m2.id, productId: null, useCard: true,
});
check('解冻后可核销', unfrozenOpen.ok, 'true');
await api('POST', `/api/v1/sessions/${unfrozenOpen.data.sessionId}/settle`, { paymentMethod: 'card' });

// ---------------------------------------------------------------- 退卡
section('⑮ 退卡');
const refund = await api('POST', `/api/v1/members/${m3.id}/card/refund`, {
  refundCents: 20000, refundMethod: 'wechat', reason: '顾客不想要了',
});
check('退卡成功', refund.ok, 'true');
const m3after = (await api('GET', `/api/v1/members/${m3.id}`)).data.member;
check('权益已清除', m3after.cardType, 'null');

// ---------------------------------------------------------------- 作废订单
section('⑯ 作废订单（反向流水）');
const orders = (await api('GET', '/api/v1/orders?limit=50')).data.orders;
const toVoid = orders.find((o) => o.paidCents === 1280);
if (toVoid) {
  const v = await api('POST', `/api/v1/orders/${toVoid.id}/void`, { reason: '收错钱了' });
  check('作废成功', v.ok, 'true');
  check('订单状态作废', sql(`select status from orders where id=${toVoid.id}`), 'voided');
} else {
  console.log('  （没有可作废的订单，跳过）');
}

// ---------------------------------------------------------------- 桌位维护
section('⑰ 桌位维护');
const maint = await api('PATCH', `/api/v1/tables/${idleIds[7]}`, { status: 'maintenance' });
check('设为维护中', maint.ok, 'true');
board = (await api('GET', '/api/v1/board')).data;
check('看板显示维护中', board.tables.find((t) => t.tableId === idleIds[7]).status, 'maintenance');
const maintOpen = await api('POST', '/api/v1/sessions', {
  tableId: idleIds[7], guestName: '试试', productId: P.T1H_S.id,
});
check('维护中不能开台', maintOpen.status, 400);
await api('PATCH', `/api/v1/tables/${idleIds[7]}`, { status: 'idle' });
board = (await api('GET', '/api/v1/board')).data;
check('恢复空闲且仍是 idle',
  board.tables.find((t) => t.tableId === idleIds[7]).status, 'idle');

// ---------------------------------------------------------------- 价目表
section('⑱ 价目表增删改（店长）');
const np = await api('POST', '/api/v1/products', {
  code: 'TEST_NEW', name: '测试套餐', category: 'timed',
  priceCents: 990, durationMinutes: 30, peopleCount: 1, discountable: true, overtimeApplicable: true,
});
check('新增套餐', np.ok, 'true');
const patch = await api('PATCH', `/api/v1/products/${np.data.id}`, { priceCents: 1990, name: '测试套餐(改)' });
check('修改价格', patch.ok, 'true');
const usage = (await api('GET', `/api/v1/products/${np.data.id}/usage`)).data;
check('未被引用可删', usage.canDelete, 'true');
const del = await api('DELETE', `/api/v1/products/${np.data.id}`);
check('删除成功', del.ok, 'true');

// 被引用过的不能删
const usedUsage = (await api('GET', `/api/v1/products/${P.T1H_S.id}/usage`)).data;
check('用过的套餐不可删', usedUsage.canDelete, 'false');
const delUsed = await api('DELETE', `/api/v1/products/${P.T1H_S.id}`);
check('删除被引用套餐被拒绝', delUsed.status, 409);

// ---------------------------------------------------------------- 对账
section('⑲ 日终对账');
const rec = (await api('GET', '/api/v1/revenue/reconcile')).data;
check('消费流水 = 订单金额', rec.consumeDiffCents, 0);
check('办卡流水 = 退卡记录', rec.cardDiffCents, 0);
check('账目平衡', rec.balanced, 'true');
console.log(`  消费 ${yuan(rec.consumeLedgerCents)} / 办卡 ${yuan(rec.cardLedgerCents)}`);

const sum = (await api('GET', '/api/v1/revenue/summary')).data;
console.log(`  今日营业额 ${yuan(sum.today.amountCents)} · 单数 ${sum.today.orderCount} · 办卡 ${sum.today.cardCount} 张`);

// ---------------------------------------------------------------- 汇总
console.log(`\n${'═'.repeat(64)}`);
console.log(`  通过 ${pass} 项，失败 ${fail} 项`);
if (failures.length) {
  console.log('\n  失败清单：');
  failures.forEach((f) => console.log(`    · ${f}`));
}
console.log('═'.repeat(64));
process.exit(fail === 0 ? 0 : 1);
