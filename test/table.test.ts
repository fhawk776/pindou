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
import { openTable, settleSession, changeSessionProduct } from '../src/services/tables.js';
import { createMember, purchaseCard } from '../src/services/members.js';
import { listLedger, getRevenueSummary, reconcile, voidOrder } from '../src/services/revenue.js';
import { calcOvertimeFee, isDiscountDay } from '../src/services/tables.js';

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
  // 纯函数：超时与打折日
  // =========================================================================
  describe('超时阶梯计费', () => {
    const fee = (actual, prod) => calcOvertimeFee({ actualMinutes: actual, productMinutes: prod, cfg: PRICING });

    test('未超时不收费', () => {
      assert.equal(fee(60, 60).feeCents, 0);
      assert.equal(fee(59, 60).feeCents, 0);
    });

    test('超时 1–20 分钟只收打底 ¥5', () => {
      assert.equal(fee(61, 60).feeCents, 500, '超 1 分钟');
      assert.equal(fee(70, 60).feeCents, 500, '超 10 分钟');
      assert.equal(fee(75, 60).feeCents, 500, '超 15 分钟');
      assert.equal(fee(80, 60).feeCents, 500, '超 20 分钟（边界）');
    });

    test('超出 20 分钟后每满 10 分钟加 ¥1.88', () => {
      assert.equal(fee(81, 60).feeCents, 688, '超 21 分钟 → 5 + 1.88');
      assert.equal(fee(90, 60).feeCents, 688, '超 30 分钟 → 5 + 1.88');
      assert.equal(fee(91, 60).feeCents, 876, '超 31 分钟 → 5 + 2×1.88');
      assert.equal(fee(100, 60).feeCents, 876, '超 40 分钟 → 5 + 2×1.88');
      assert.equal(fee(101, 60).feeCents, 1064, '超 41 分钟 → 5 + 3×1.88');
      assert.equal(fee(120, 60).feeCents, 1252, '超 60 分钟 → 5 + 4×1.88');
    });

    test('不足一段按一段算（round_up = true）', () => {
      // 超 21 分钟：超出打底 1 分钟，不足 10 分钟也按一段算
      assert.equal(fee(81, 60).stepUnits, 1);
      // 超 30 分钟：正好一整段
      assert.equal(fee(90, 60).stepUnits, 1);
      // 超 31 分钟：多出 1 分钟也要算一段
      assert.equal(fee(91, 60).stepUnits, 2);
    });

    test('限板套餐不计超时', () => {
      const r = fee(300, null);
      assert.equal(r.feeCents, 0);
      assert.equal(r.overtimeMinutes, 0);
    });

    test('超过三小时的长时超时', () => {
      // 套餐 60 分钟，实际 240 分钟 → 超时 180 分钟
      // 打底 5 + ceil((180-20)/10)=16 段 × 1.88 = 5 + 30.08 = 35.08
      const r = fee(240, 60);
      assert.equal(r.overtimeMinutes, 180);
      assert.equal(r.stepUnits, 16);
      assert.equal(r.feeCents, 500 + 16 * 188);
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

    const { rows } = await getPool().query(
      'SELECT card_type, card_expires_at FROM members WHERE id = $1', [m]
    );
    assert.equal(rows[0].card_type, 'week');
    assert.ok(rows[0].card_expires_at);
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
    // 手动把卡改成过期
    await getPool().query(
      `UPDATE members SET card_expires_at = CURRENT_DATE - 1 WHERE id = $1`, [m]
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
