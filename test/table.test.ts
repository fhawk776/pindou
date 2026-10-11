/**
 * 工位与计费集成测试
 *
 * 重点验证门店真实业务规则：
 *   - 超时按"每满20分钟加收5元"计档（规则 B）
 *   - 打折日只对套餐打折，加购与超时费不打折
 *   - 周卡/月卡核销时不收钱，但记录使用
 *   - 一个工位同时只能有一个进行中的会话
 */
import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { getPool, closePool } from '../src/lib/db.js';
import { assertTestDatabase } from './helpers/guard.js';
import { openTable, settleSession, changeSessionProduct, getTableBoard } from '../src/services/tables.js';
import { addDaysStr } from '../src/lib/dates.js';
import { createMember, purchaseCard } from '../src/services/members.js';
import { listLedger, getRevenueSummary, reconcile, voidOrder } from '../src/services/revenue.js';
import { overtimeMinutesOf, isDiscountDay } from '../src/services/tables.js';

let dbAvailable = false;
let userId: number;
let tableId: number;
let tableId2: number;
const P: Record<string, number> = {};

const PRICING = {
  discount_days: [8, 18, 28],
  discount_rate_bp: 8000,
  remind_before_minutes: 15,
  overtime_base_minutes: 20,
  overtime_base_fee_cents: 500,
  overtime_step_minutes: 10,
  overtime_step_fee_cents: 188,
  overtime_round_up: true,
};

describe('工位与计费（集成测试）', () => {
  before(async () => {
    // 数据库不可用或指向非测试库时直接失败，而不是静默跳过 ——
    // 全跳过的测试套件仍会返回成功，那是最危险的"假通过"。
    await assertTestDatabase();
    dbAvailable = true;

    const { rows: u } = await getPool().query(
      `INSERT INTO users (username, password_hash, display_name, role)
       VALUES ('__t_op', 'x', '测试员', 'admin')
       ON CONFLICT (username) DO UPDATE SET display_name='测试员' RETURNING id`
    );
    userId = Number(u[0].id);

    for (const code of ['T1H_S', 'T3H_D', 'P78', 'WEEK_N', 'MONTH', 'ADD_BOARD', 'ADD_IRON', 'DAY_S']) {
      const { rows } = await getPool().query('SELECT id FROM products WHERE code = $1', [code]);
      P[code] = Number(rows[0].id);
    }

    const { rows: t } = await getPool().query(
      `SELECT id FROM tables ORDER BY sort_order LIMIT 2`
    );
    tableId = Number(t[0].id);
    tableId2 = Number(t[1].id);
  });

  after(async () => {
    if (dbAvailable) {
      await cleanup();
      // 审计日志会引用 users，必须先解除引用再删用户
      await getPool().query(`DELETE FROM audit_logs WHERE actor_id IN
        (SELECT id FROM users WHERE username = '__t_op')`);
      await getPool().query(`DELETE FROM users WHERE username = '__t_op'`);
    }
    await closePool();
  });

  async function cleanup() {
    // 顺序严格遵循外键依赖：
    //   流水 → card_records（引用 orders，需先解除）→ 明细 → 订单 → 开台 → 会员
    await getPool().query(`DELETE FROM revenue_ledger WHERE member_id IN
      (SELECT id FROM members WHERE member_no LIKE '__TM%')`);
    await getPool().query(`UPDATE card_records SET order_id = NULL WHERE member_id IN
      (SELECT id FROM members WHERE member_no LIKE '__TM%')`);
    await getPool().query(`DELETE FROM card_records WHERE member_id IN
      (SELECT id FROM members WHERE member_no LIKE '__TM%')`);
    await getPool().query(`DELETE FROM order_items WHERE order_id IN
      (SELECT id FROM orders WHERE member_id IN
        (SELECT id FROM members WHERE member_no LIKE '__TM%'))`);
    // 先把 order_id 关联解掉，避免 orders ↔ table_sessions 互相引用导致删不掉
    await getPool().query(`UPDATE table_sessions SET order_id = NULL WHERE order_id IN
      (SELECT id FROM orders WHERE member_id IN
        (SELECT id FROM members WHERE member_no LIKE '__TM%'))`);
    await getPool().query(`DELETE FROM orders WHERE member_id IN
      (SELECT id FROM members WHERE member_no LIKE '__TM%')`);
    await getPool().query(`DELETE FROM table_sessions WHERE member_id IN
      (SELECT id FROM members WHERE member_no LIKE '__TM%')`);
    await getPool().query(`DELETE FROM table_sessions WHERE guest_name LIKE '__TM%'`);
    await getPool().query(`DELETE FROM members WHERE member_no LIKE '__TM%'`);
  }

  beforeEach(async () => {
    if (!dbAvailable) return;
    await cleanup();
    // 兜底：任何残留的活跃会话都会导致"工位正在使用中"，
    // 从而让后续所有测试连锁失败。
    // 只清理本套件使用的两张桌，避免影响并行运行的其他测试文件
    // （Node 的测试运行器默认并行执行多个测试文件）。
    await getPool().query(
      `UPDATE table_sessions SET order_id = NULL
        WHERE table_id IN ($1, $2) AND status = 'active'`,
      [tableId, tableId2]
    );
    await getPool().query(
      `DELETE FROM table_sessions WHERE table_id IN ($1, $2) AND status = 'active'`,
      [tableId, tableId2]
    );
  });

  let seq = 0;
  async function mkMember(): Promise<number> {
    const r = await createMember({
      nickname: `测试${++seq}`,
      phoneTail: String(1000 + seq),
      operatorId: userId,
    });
    await getPool().query(
      `UPDATE members SET member_no = '__TM' || id WHERE id = $1`, [r.id]
    );
    return r.id;
  }

  // =========================================================================
  // 纯函数：超时分钟数与打折日
  //
  // 【重要】超时费已不再由系统计算 —— 店家线下自行决定。
  //   系统只算出「超了多少分钟」供界面提示，需要加收时店员手动填实收。
  //   因此这里只验证分钟数，不再验证任何金额。
  // =========================================================================
  describe('超时只计时不计费', () => {
    const overMin = (actual, prod) => overtimeMinutesOf(actual, prod);

    test('未超时 → 0 分钟', () => {
      assert.equal(overMin(60, 60), 0);
      assert.equal(overMin(59, 60), 0);
    });

    test('超时分钟数 = 实际 - 套餐时长', () => {
      assert.equal(overMin(61, 60), 1);
      assert.equal(overMin(80, 60), 20);
      assert.equal(overMin(90, 60), 30);
      assert.equal(overMin(240, 60), 180, '三小时套餐超时');
    });

    test('不限时套餐（限板/日卡）永远为 0', () => {
      assert.equal(overMin(300, null), 0);
      assert.equal(overMin(300, 0), 0);
    });
  });

  describe('打折日判断', () => {
    test('每月 8/18/28 号是打折日', () => {
      assert.ok(isDiscountDay(new Date('2026-10-08T12:00:00+08:00'), PRICING));
      assert.ok(isDiscountDay(new Date('2026-10-18T12:00:00+08:00'), PRICING));
      assert.ok(isDiscountDay(new Date('2026-10-28T12:00:00+08:00'), PRICING));
    });
    test('其他日期不是', () => {
      assert.ok(!isDiscountDay(new Date('2026-10-10T12:00:00+08:00'), PRICING));
      assert.ok(!isDiscountDay(new Date('2026-10-09T12:00:00+08:00'), PRICING));
    });
  });

  // =========================================================================
  // 开台
  // =========================================================================
  test('开台成功：占用工位并开始计时', async (t) => {
    if (!dbAvailable) return t.skip('数据库不可用');
    const m = await mkMember();

    const r = await openTable({
      tableId, memberId: m, productId: P.T1H_S!, operatorId: userId,
    });

    assert.ok(r.sessionId > 0);
    assert.ok(r.expectedEndAt, '限时套餐应有预计结束时间');

    // 预计结束时间应约为 60 分钟后
    const diffMin = (r.expectedEndAt!.getTime() - r.startedAt.getTime()) / 60_000;
    assert.ok(Math.abs(diffMin - 60) < 1, `预计时长应约 60 分钟，实际 ${diffMin}`);
  });

  test('同一工位不能被重复开台', async (t) => {
    if (!dbAvailable) return t.skip('数据库不可用');
    const m1 = await mkMember();
    const m2 = await mkMember();

    await openTable({ tableId, memberId: m1, productId: P.T1H_S!, operatorId: userId });

    await assert.rejects(
      () => openTable({ tableId, memberId: m2, productId: P.T1H_S!, operatorId: userId }),
      /正在使用中/
    );
  });

  test('同一会员不能同时在两个工位', async (t) => {
    if (!dbAvailable) return t.skip('数据库不可用');
    const m = await mkMember();

    await openTable({ tableId, memberId: m, productId: P.T1H_S!, operatorId: userId });

    await assert.rejects(
      () => openTable({ tableId: tableId2, memberId: m, productId: P.T1H_S!, operatorId: userId }),
      /已在.*开台/
    );
  });

  test('散客开台需要称呼', async (t) => {
    if (!dbAvailable) return t.skip('数据库不可用');

    await assert.rejects(
      () => openTable({ tableId, memberId: null, guestName: '', productId: P.T1H_S!, operatorId: userId }),
      /散客/
    );

    const r = await openTable({
      tableId, memberId: null, guestName: '小雨', productId: P.T1H_S!, operatorId: userId,
    });
    assert.ok(r.sessionId > 0);
  });

  test('散客无法用卡核销', async (t) => {
    if (!dbAvailable) return t.skip('数据库不可用');
    await assert.rejects(
      () => openTable({
        tableId, memberId: null, guestName: '小雨',
        productId: P.T1H_S!, useCard: true, operatorId: userId,
      }),
      /散客无法使用卡权益/
    );
  });

  test('没有卡的会员无法用卡核销', async (t) => {
    if (!dbAvailable) return t.skip('数据库不可用');
    const m = await mkMember();

    await assert.rejects(
      () => openTable({
        tableId, memberId: m, productId: P.T1H_S!, useCard: true, operatorId: userId,
      }),
      /没有有效的卡/
    );
  });

  test('换套餐：从原开始时间重新推算结束时间', async (t) => {
    if (!dbAvailable) return t.skip('数据库不可用');
    const m = await mkMember();

    const r = await openTable({ tableId, memberId: m, productId: P.T1H_S!, operatorId: userId });
    const before = r.expectedEndAt!.getTime();

    // 从 1 小时换成 3 小时
    const changed = await changeSessionProduct({
      sessionId: r.sessionId, productId: P.T3H_D!, operatorId: userId,
    });

    const after = changed.expectedEndAt!.getTime();
    assert.ok(after > before, '换成 3 小时后结束时间应推后');
    // 开始时间不变，所以结束时间应约为开始 + 180 分钟
    const totalMin = (after - r.startedAt.getTime()) / 60_000;
    assert.ok(Math.abs(totalMin - 180) < 1, `应约 180 分钟，实际 ${totalMin}`);
  });

  // =========================================================================
  // 结账：基本计费
  // =========================================================================
  test('结账：普通日按原价收费', async (t) => {
    if (!dbAvailable) return t.skip('数据库不可用');
    const m = await mkMember();

    const r = await openTable({ tableId, memberId: m, productId: P.T1H_S!, operatorId: userId });
    const settled = await settleSession({
      sessionId: r.sessionId, paymentMethod: 'wechat', operatorId: userId,
    });

    // 单人1小时 = 12.8 元，刚开台几乎没超时
    assert.equal(settled.productAmountCents, 1280);
    assert.equal(settled.overtimeFeeCents, 0);
    assert.equal(settled.totalCents, 1280);
    assert.ok(settled.flowNo, '应生成流水号');

    // 工位应被释放
    const { rows } = await getPool().query(
      `SELECT status FROM table_sessions WHERE id = $1`, [r.sessionId]
    );
    assert.equal(rows[0].status, 'settled');
  });

  test('结账：加购项计入总额', async (t) => {
    if (!dbAvailable) return t.skip('数据库不可用');
    const m = await mkMember();

    const r = await openTable({ tableId, memberId: m, productId: P.T1H_S!, operatorId: userId });
    const settled = await settleSession({
      sessionId: r.sessionId, addonItems: [{ id: P.ADD_BOARD!, qty: 1 }],   // 智能拼豆板 9.9
      paymentMethod: 'wechat', operatorId: userId,
    });

    assert.equal(settled.addonAmountCents, 990);
    assert.equal(settled.totalCents, 1280 + 990);
  });

  test('结账：非加购项不能当加购', async (t) => {
    if (!dbAvailable) return t.skip('数据库不可用');
    const m = await mkMember();

    const r = await openTable({ tableId, memberId: m, productId: P.T1H_S!, operatorId: userId });
    await assert.rejects(
      () => settleSession({
        sessionId: r.sessionId, addonItems: [{ id: P.T3H_D!, qty: 1 }],   // 套餐不是加购项
        paymentMethod: 'wechat', operatorId: userId,
      }),
      /不是加购项/
    );
  });

  test('结账：已结账的工位不能重复结账', async (t) => {
    if (!dbAvailable) return t.skip('数据库不可用');
    const m = await mkMember();

    const r = await openTable({ tableId, memberId: m, productId: P.T1H_S!, operatorId: userId });
    await settleSession({ sessionId: r.sessionId, paymentMethod: 'cash', operatorId: userId });

    await assert.rejects(
      () => settleSession({ sessionId: r.sessionId, paymentMethod: 'cash', operatorId: userId }),
      /已经结账/
    );
  });

  test('实收调整：少收，原因选填', async (t) => {
    if (!dbAvailable) return t.skip('数据库不可用');
    const m = await mkMember();

    const r = await openTable({ tableId, memberId: m, productId: P.T1H_S!, operatorId: userId });

    // 不填原因也能少收 —— 店主明确要求备注选填
    const ok = await settleSession({
      sessionId: r.sessionId, paymentMethod: 'cash',
      overrideTotalCents: 1000, operatorId: userId,
    });
    assert.equal(ok.totalCents, 1000, '实收应为 1000 分');
    // 差额记入人工调整（正数 = 少收）
    assert.equal(ok.manualAdjustCents, 1280 - 1000, '人工调整应为 280 分');
    assert.equal(ok.discountCents, 0, '打折日优惠不应被污染');
  });

  test('实收调整：多收（顾客给整钱不用找零）', async (t) => {
    if (!dbAvailable) return t.skip('数据库不可用');
    const m = await mkMember();

    const r = await openTable({ tableId, memberId: m, productId: P.T1H_S!, operatorId: userId });
    const ok = await settleSession({
      sessionId: r.sessionId, paymentMethod: 'cash',
      overrideTotalCents: 2000, overrideReason: '不用找零', operatorId: userId,
    });

    assert.equal(ok.totalCents, 2000, '实收应为 2000 分');
    assert.equal(ok.manualAdjustCents, 1280 - 2000, '人工调整应为 -720 分（多收）');
    assert.equal(ok.discountCents, 0, '折扣列必须保持非负，不能被负数污染');
  });

  test('结账后工位可再次开台', async (t) => {
    if (!dbAvailable) return t.skip('数据库不可用');
    const m1 = await mkMember();
    const m2 = await mkMember();

    const r = await openTable({ tableId, memberId: m1, productId: P.T1H_S!, operatorId: userId });
    await settleSession({ sessionId: r.sessionId, paymentMethod: 'cash', operatorId: userId });

    const r2 = await openTable({ tableId, memberId: m2, productId: P.T1H_S!, operatorId: userId });
    assert.ok(r2.sessionId > 0, '结账后工位应可再次使用');
  });

  // =========================================================================
  // 会员卡
  // =========================================================================
  test('办周卡：授予权益并生成流水', async (t) => {
    if (!dbAvailable) return t.skip('数据库不可用');
    const m = await mkMember();

    const r = await purchaseCard({
      memberId: m, cardType: 'week', productId: P.WEEK_N!,
      paymentMethod: 'wechat', operatorId: userId,
    });

    assert.equal(r.priceCents, 25800);
    assert.ok(r.flowNo);

    // 新模型：办卡后是「未激活」状态 —— 起止日期为空，只有待生效天数。
    // 7 天从首次用卡开台那天才开始算（见「未激活的卡：首次用卡才起算」）。
    assert.equal(r.activated, false, '刚办完应处于未激活');
    assert.equal(r.startedAt, null, '未激活不应有起始日');
    assert.equal(r.expiresAt, null, '未激活不应有到期日');
    assert.equal(r.pendingDays, 7, '待生效 7 天');

    const { rows } = await getPool().query(
      `SELECT card_type, card_started_at, card_expires_at, card_pending_days
         FROM members WHERE id = $1`, [m]
    );
    assert.equal(rows[0].card_type, 'week');
    assert.equal(rows[0].card_started_at, null, '未激活时起始日应为空');
    assert.equal(rows[0].card_expires_at, null, '未激活时到期日应为空');
    assert.equal(rows[0].card_pending_days, 7);
  });

  test('未激活的卡：首次用卡开台才起算，且起始日=当天', async (t) => {
    if (!dbAvailable) return t.skip('数据库不可用');
    const m = await mkMember();
    await purchaseCard({
      memberId: m, cardType: 'week', productId: P.WEEK_N!,
      paymentMethod: 'wechat', operatorId: userId,
    });

    // 开台前：未激活
    const before = await getPool().query(
      'SELECT card_started_at FROM members WHERE id = $1', [m]
    );
    assert.equal(before.rows[0].card_started_at, null);

    // 首次用卡开台 → 激活
    const r = await openTable({
      tableId, memberId: m, productId: P.T3H_D!, useCard: true, operatorId: userId,
    });
    assert.equal(r.useCard, true);
    assert.ok(r.cardStartedAt, '激活后应写入起始日');
    assert.ok(r.cardExpiresAt, '激活后应写入到期日');

    const after = await getPool().query(
      `SELECT card_started_at, card_expires_at, card_pending_days,
              (card_expires_at - card_started_at) AS span
         FROM members WHERE id = $1`, [m]
    );
    assert.equal(after.rows[0].card_pending_days, 0, '激活后待生效天数应清零');
    assert.equal(
      String(after.rows[0].span), '6',
      '7 天卡覆盖 7 个日历日（起始日 + 6），例：10/11 起 → 10/17 止'
    );

    // 会话上要留下本期权益区间快照
    const sess = await getPool().query(
      'SELECT card_started_at, card_expires_at FROM table_sessions WHERE id = $1',
      [r.sessionId]
    );
    assert.ok(sess.rows[0].card_started_at, '会话应记录权益起始日快照');
  });

  test('未激活时再办一张：天数累加', async (t) => {
    if (!dbAvailable) return t.skip('数据库不可用');
    const m = await mkMember();
    const a = await purchaseCard({
      memberId: m, cardType: 'week', productId: P.WEEK_N!,
      paymentMethod: 'wechat', operatorId: userId,
    });
    assert.equal(a.pendingDays, 7);

    const b = await purchaseCard({
      memberId: m, cardType: 'week', productId: P.WEEK_N!,
      paymentMethod: 'wechat', operatorId: userId,
    });
    assert.equal(b.activated, false, '仍未激活');
    assert.equal(b.pendingDays, 14, '两张周卡应累加为 14 天');

    // 激活后一次性生效 14 天
    const r = await openTable({
      tableId, memberId: m, productId: P.T3H_D!, useCard: true, operatorId: userId,
    });
    const { rows } = await getPool().query(
      `SELECT (card_expires_at - card_started_at) AS span FROM members WHERE id = $1`, [m]
    );
    assert.equal(String(rows[0].span), '13', '14 天卡覆盖 14 个日历日（起始日 + 13）');
    assert.ok(r.cardStartedAt);
  });

  test('续卡：本期起始日改为原到期日（不再是累计起点）', async (t) => {
    if (!dbAvailable) return t.skip('数据库不可用');
    const m = await mkMember();
    await purchaseCard({
      memberId: m, cardType: 'week', productId: P.WEEK_N!,
      paymentMethod: 'wechat', operatorId: userId,
    });
    // 首次用卡激活
    await openTable({
      tableId, memberId: m, productId: P.T3H_D!, useCard: true, operatorId: userId,
    });
    // 用 to_char 取字符串，避免 pg 把 DATE 读成 Date 对象后比较类型不一致
    const first = await getPool().query(
      `SELECT to_char(card_started_at, 'YYYY-MM-DD') AS s,
              to_char(card_expires_at, 'YYYY-MM-DD') AS e
         FROM members WHERE id = $1`, [m]
    );
    const firstStart = String(first.rows[0].s);
    const firstExpires = String(first.rows[0].e);

    // 结账把桌位释放掉，避免"该会员已在别的工位开台"
    const active = await getPool().query(
      `SELECT id FROM table_sessions WHERE member_id = $1 AND status = 'active'`, [m]
    );
    if (active.rows.length > 0) {
      await settleSession({
        sessionId: Number(active.rows[0].id), paymentMethod: 'card', operatorId: userId,
      });
    }

    // 续一张：新一期紧接原到期日的次日（连续、不重叠，不浪费任何一天）
    const r = await purchaseCard({
      memberId: m, cardType: 'week', productId: P.WEEK_N!,
      paymentMethod: 'wechat', operatorId: userId,
    });
    assert.equal(r.activated, true);
    assert.notEqual(
      String(r.startedAt), firstStart,
      '起始日应改为「本期」的起点，而不是沿用累计起点'
    );
    assert.equal(
      String(r.startedAt), addDaysStr(firstExpires, 1),
      '新一期应紧接原到期日的次日开始（连续覆盖，不重叠）'
    );
    // 新一期本身仍是 7 天
    assert.equal(
      addDaysStr(String(r.startedAt), 6), String(r.expiresAt),
      '新一期仍应覆盖 7 个日历日'
    );
  });

  test('双人套餐占两个台：仍是一套计时、一张单、一次超时费', async (t) => {
    if (!dbAvailable) return t.skip('数据库不可用');
    const m = await mkMember();

    // 双人3小时 ¥68.80，占 01 + 02 两个台
    const r = await openTable({
      tableId, extraTableIds: [tableId2], memberId: m,
      productId: P.T3H_D!, operatorId: userId,
    });

    assert.equal(r.tableNames.length, 2, '应占用两个台');
    assert.ok(r.tableNames.includes('01号桌') || r.tableNames.length === 2);

    // 两个台都被标记为占用，且指向同一个会话
    const board = await getTableBoard();
    const occupied = board.tables.filter((x) => x.session?.sessionId === r.sessionId);
    assert.equal(occupied.length, 2, '看板上有两个台显示同一会话');
    for (const card of occupied) {
      assert.equal(
        card.session!.groupTableNames,
        r.tableNames.join('、'),
        '每个台都能看到本组占用的全部桌位'
      );
    }

    // 只产生一个会话
    const { rows: sess } = await getPool().query(
      `SELECT count(*)::int AS c FROM table_sessions WHERE member_id = $1 AND status = 'active'`,
      [m]
    );
    assert.equal(sess[0].c, 1, '双人套餐只创建一个会话');

    // 两个台都记在 session_tables 里
    const { rows: st } = await getPool().query(
      `SELECT count(*)::int AS c FROM session_tables WHERE session_id = $1`, [r.sessionId]
    );
    assert.equal(st[0].c, 2, 'session_tables 里应有两条记录');

    // 结账：整组一起结，只出一个订单、一次超时费
    const settled = await settleSession({
      sessionId: r.sessionId, paymentMethod: 'cash', operatorId: userId,
    });
    assert.equal(settled.totalCents, 6880, '双人套餐应收 ¥68.80（只收一次）');

    // 结账后两个台都释放
    const board2 = await getTableBoard();
    const still = board2.tables.filter((x) =>
      r.tableNames.includes(x.tableName) && x.status === 'occupied');
    assert.equal(still.length, 0, '结账后两个台都应释放');

    // 防重复占用：第一个台已被别人占时，第二个台也不能再被抢
    const m2 = await mkMember();
    const r2 = await openTable({
      tableId, memberId: m2, productId: P.T1H_S!, operatorId: userId,
    });
    await assert.rejects(
      () => openTable({
        tableId: tableId2, extraTableIds: [tableId], memberId: null,
        guestName: '插队的', productId: P.T1H_S!, operatorId: userId,
      }),
      /正在使用中/,
      '其中一个台被占用时，整组开台都应被拒绝'
    );
    await settleSession({ sessionId: r2.sessionId, paymentMethod: 'cash', operatorId: userId });
  });

  test('两个入口买同一张卡：权益效果必须完全一致', async (t) => {
    if (!dbAvailable) return t.skip('数据库不可用');

    // ---- 路径 A：先去会员页办卡，再回来用卡开台 ----
    const mA = await mkMember();
    await purchaseCard({
      memberId: mA, cardType: 'week', productId: P.WEEK_N!,
      paymentMethod: 'wechat', operatorId: userId,
    });
    const rA = await openTable({
      tableId, memberId: mA, productId: P.T3H_D!, useCard: true, operatorId: userId,
    });

    // ---- 路径 B：直接在开台页买卡（办卡 + 开台一步完成）----
    const mB = await mkMember();
    const rB = await openTable({
      tableId: tableId2, memberId: mB, productId: null, useCard: true,
      cardProductId: P.WEEK_N!, cardPaymentMethod: 'wechat', operatorId: userId,
    });

    // 开台结果一致
    assert.equal(rA.useCard, rB.useCard, '两条路径都应是用卡核销');
    assert.equal(rA.cardStartedAt, rB.cardStartedAt, '权益起始日必须一致');
    assert.equal(rA.cardExpiresAt, rB.cardExpiresAt, '权益到期日必须一致');

    // 路径 B 必须真的产生办卡订单，而不是"变成普通套餐"
    assert.ok(rB.boughtCard, '开台页买卡应产生办卡订单');
    assert.ok(rB.boughtCard!.orderNo, '办卡订单号不应为空');
    assert.equal(rB.boughtCard!.priceCents, 25800, '办卡实收应为 ¥258');

    // 两个会员最终落库的权益字段必须完全相同
    const q = `SELECT card_type,
                      to_char(card_started_at, 'YYYY-MM-DD') AS s,
                      to_char(card_expires_at, 'YYYY-MM-DD') AS e,
                      card_pending_days AS pending
                 FROM members WHERE id = $1`;
    const a = (await getPool().query(q, [mA])).rows[0];
    const b = (await getPool().query(q, [mB])).rows[0];
    assert.deepEqual(b, a, '不同入口买同一产品，落库的权益必须完全一致');
  });

  test('用卡核销：不收钱，但记录使用次数', async (t) => {
    if (!dbAvailable) return t.skip('数据库不可用');
    const m = await mkMember();
    await purchaseCard({
      memberId: m, cardType: 'week', productId: P.WEEK_N!,
      paymentMethod: 'wechat', operatorId: userId,
    });

    const r = await openTable({
      tableId, memberId: m, productId: P.T3H_D!, useCard: true, operatorId: userId,
    });
    const settled = await settleSession({
      sessionId: r.sessionId, paymentMethod: 'card', operatorId: userId,
    });

    assert.equal(settled.usedCard, true);
    assert.equal(settled.totalCents, 0, '用卡核销不应收钱');
    assert.equal(settled.flowNo, '', '零金额不产生流水');

    const { rows } = await getPool().query(
      'SELECT card_used_count, visit_count FROM members WHERE id = $1', [m]
    );
    assert.equal(rows[0].card_used_count, 1, '核销次数应为 1');
    assert.equal(rows[0].visit_count, 1);
  });

  test('用卡核销时加购仍要收费', async (t) => {
    if (!dbAvailable) return t.skip('数据库不可用');
    const m = await mkMember();
    await purchaseCard({
      memberId: m, cardType: 'week', productId: P.WEEK_N!,
      paymentMethod: 'wechat', operatorId: userId,
    });

    const r = await openTable({
      tableId, memberId: m, productId: P.T3H_D!, useCard: true, operatorId: userId,
    });
    const settled = await settleSession({
      sessionId: r.sessionId, addonItems: [{ id: P.ADD_IRON!, qty: 1 }],  // 特殊烫 2.88
      paymentMethod: 'cash', operatorId: userId,
    });

    assert.equal(settled.totalCents, 288, '套餐免单但加购要收钱');
    assert.ok(settled.flowNo, '有金额就应有流水');
  });

  test('过期的卡不能用', async (t) => {
    if (!dbAvailable) return t.skip('数据库不可用');
    const m = await mkMember();
    await purchaseCard({
      memberId: m, cardType: 'week', productId: P.WEEK_N!,
      paymentMethod: 'wechat', operatorId: userId,
    });
    // 手动改成「已激活且已过期」：起始日必须有值，
    // 否则系统会认为是未激活（未激活走激活分支，不是过期分支）
    await getPool().query(
      `UPDATE members
          SET card_started_at = CURRENT_DATE - 8,
              card_expires_at = CURRENT_DATE - 1
        WHERE id = $1`, [m]
    );

    await assert.rejects(
      () => openTable({
        tableId, memberId: m, productId: P.T1H_S!, useCard: true, operatorId: userId,
      }),
      /已过期/
    );
  });

  // =========================================================================
  // 流水与对账
  // =========================================================================
  test('流水只追加：结账产生收入流水', async (t) => {
    if (!dbAvailable) return t.skip('数据库不可用');
    const m = await mkMember();

    const r = await openTable({ tableId, memberId: m, productId: P.T1H_S!, operatorId: userId });
    await settleSession({ sessionId: r.sessionId, paymentMethod: 'wechat', operatorId: userId });

    const led = await listLedger({ memberId: m });
    assert.equal(led.entries.length, 1);
    assert.equal(led.entries[0]!.amountCents, 1280);
    assert.equal(led.entries[0]!.flowType, 'consume');
  });

  test('作废订单写反向流水，不删除原记录', async (t) => {
    if (!dbAvailable) return t.skip('数据库不可用');
    const m = await mkMember();

    const r = await openTable({ tableId, memberId: m, productId: P.T1H_S!, operatorId: userId });
    const s = await settleSession({ sessionId: r.sessionId, paymentMethod: 'wechat', operatorId: userId });

    await voidOrder({ orderId: s.orderId, reason: '测试作废', operatorId: userId });

    const led = await listLedger({ memberId: m });
    assert.equal(led.entries.length, 2, '应有一条收款和一条退款流水');
    const refund = led.entries.find((x) => x.flowType === 'refund');
    assert.ok(refund, '应有退款流水');
    assert.equal(refund!.amountCents, -1280, '退款应为负');
  });

  test('【核心】对账：流水汇总 = 订单净额', async (t) => {
    if (!dbAvailable) return t.skip('数据库不可用');

    // 几笔不同方式的消费
    for (const pm of ['cash', 'wechat', 'alipay'] as const) {
      const m = await mkMember();
      const r = await openTable({ tableId, memberId: m, productId: P.T1H_S!, operatorId: userId });
      await settleSession({ sessionId: r.sessionId, paymentMethod: pm, operatorId: userId });
    }

    const rec = await reconcile();
    assert.equal(rec.diffCents, 0, `对账差异应为 0，实际 ${rec.diffCents}`);
    assert.ok(rec.balanced);
  });

  test('营收汇总能算出来', async (t) => {
    if (!dbAvailable) return t.skip('数据库不可用');
    const m = await mkMember();
    const r = await openTable({ tableId, memberId: m, productId: P.P78!, operatorId: userId });
    await settleSession({ sessionId: r.sessionId, paymentMethod: 'cash', operatorId: userId });

    const s = await getRevenueSummary();
    assert.ok(s.today.amountCents >= 2580, '今日营收应包含刚才的 25.8 元');
    assert.ok(s.today.orderCount >= 1);
  });
});
