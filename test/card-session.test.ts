/**
 * 卡权益会话测试
 *
 * 重点验证：周卡/月卡/日卡是"全天不限时的通行权"，
 * 用卡开台不选套餐、不计超时、不收费（加购另计）。
 *
 * 这是一个曾经出过错的地方：早期实现要求用卡也选限时套餐，
 * 导致周卡会员玩满 1 小时就被判定超时并加收费用。
 */
import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { getPool, closePool } from '../src/lib/db.js';
import { assertTestDatabase } from './helpers/guard.js';
import { openTable, settleSession } from '../src/services/tables.js';
import { createMember, purchaseCard } from '../src/services/members.js';

let dbAvailable = false;
let userId: number;
let tableId: number;
let weekProductId: number;
let timedProductId: number;
let addonProductId: number;

describe('卡权益会话（全天不限时）', () => {
  before(async () => {
    // 数据库不可用或指向非测试库时直接失败，而不是静默跳过 ——
    // 全跳过的测试套件仍会返回成功，那是最危险的"假通过"。
    await assertTestDatabase();
    dbAvailable = true;

    const { rows: u } = await getPool().query(
      `INSERT INTO users (username, password_hash, display_name, role)
       VALUES ('__t_card', 'x', '测试员', 'admin')
       ON CONFLICT (username) DO UPDATE SET display_name='测试员' RETURNING id`
    );
    userId = Number(u[0].id);

    const { rows: t } = await getPool().query(
      `SELECT id FROM tables ORDER BY sort_order LIMIT 1`
    );
    tableId = Number(t[0].id);
    // 用最后一张桌，避免与 table.test.ts 争抢同一张桌。
    // Node 的测试运行器默认并行执行多个测试文件，若两个套件都用第一张桌，
    // 彼此的 beforeEach 会清掉对方正在进行的会话，导致随机失败。
    const { rows: t2 } = await getPool().query(
      `SELECT id FROM tables ORDER BY sort_order DESC LIMIT 1`
    );
    tableId = Number(t2[0].id);

    const { rows: p } = await getPool().query(
      `SELECT id, category FROM products WHERE code IN ('WEEK_N', 'T1H_S', 'ADD_BOARD')`
    );
    for (const row of p) {
      if (row.category === 'card') weekProductId = Number(row.id);
      if (row.category === 'timed') timedProductId = Number(row.id);
      if (row.category === 'addon') addonProductId = Number(row.id);
    }
  });

  after(async () => {
    if (dbAvailable) {
      await cleanup();
      await getPool().query(`DELETE FROM audit_logs WHERE actor_id IN
        (SELECT id FROM users WHERE username = '__t_card')`);
      await getPool().query(`DELETE FROM users WHERE username = '__t_card'`);
    }
    await closePool();
  });

  async function cleanup() {
    // 顺序严格遵循外键依赖：
    //   card_records 引用 orders，因此必须先解除引用再删订单
    await getPool().query(`DELETE FROM revenue_ledger WHERE member_id IN
      (SELECT id FROM members WHERE member_no LIKE '__TC%')`);
    await getPool().query(`UPDATE card_records SET order_id = NULL WHERE member_id IN
      (SELECT id FROM members WHERE member_no LIKE '__TC%')`);
    await getPool().query(`DELETE FROM card_records WHERE member_id IN
      (SELECT id FROM members WHERE member_no LIKE '__TC%')`);
    await getPool().query(`DELETE FROM order_items WHERE order_id IN
      (SELECT id FROM orders WHERE member_id IN
        (SELECT id FROM members WHERE member_no LIKE '__TC%'))`);
    await getPool().query(`UPDATE table_sessions SET order_id = NULL WHERE member_id IN
      (SELECT id FROM members WHERE member_no LIKE '__TC%')`);
    await getPool().query(`DELETE FROM orders WHERE member_id IN
      (SELECT id FROM members WHERE member_no LIKE '__TC%')`);
    await getPool().query(`DELETE FROM table_sessions WHERE member_id IN
      (SELECT id FROM members WHERE member_no LIKE '__TC%')`);
    await getPool().query(`DELETE FROM members WHERE member_no LIKE '__TC%'`);
  }

  beforeEach(async () => {
    if (!dbAvailable) return;
    await cleanup();
    // 只清理本套件使用的桌位，避免影响并行运行的其他测试文件
    await getPool().query(
      `UPDATE table_sessions SET order_id = NULL WHERE table_id = $1 AND status = 'active'`,
      [tableId]
    );
    await getPool().query(
      `DELETE FROM table_sessions WHERE table_id = $1 AND status = 'active'`,
      [tableId]
    );
  });

  let seq = 0;
  /** 建一个持有有效周卡的会员 */
  async function mkCardMember(): Promise<number> {
    const r = await createMember({
      nickname: `卡会员${++seq}`,
      phoneTail: String(2000 + seq),
      operatorId: userId,
    });
    await getPool().query(`UPDATE members SET member_no = '__TC' || id WHERE id = $1`, [r.id]);
    await purchaseCard({
      memberId: r.id, cardType: 'week', productId: weekProductId,
      paymentMethod: 'wechat', operatorId: userId,
    });
    return r.id;
  }

  async function getSession(id: number) {
    const { rows } = await getPool().query(
      `SELECT product_id, product_name, product_price_cents, used_card,
              card_expires_at, expected_end_at, overtime_units, overtime_fee_cents, status
         FROM table_sessions WHERE id = $1`, [id]
    );
    return rows[0];
  }

  // =========================================================================
  test('【核心】用卡开台不需要套餐', async (t) => {
    if (!dbAvailable) return t.skip('数据库不可用');
    const m = await mkCardMember();

    const r = await openTable({
      tableId, memberId: m, productId: null, useCard: true, operatorId: userId,
    });

    assert.ok(r.sessionId > 0);
    assert.equal(r.useCard, true);
    assert.ok(r.cardExpiresAt, '应记录权益到期日');

    const s = await getSession(r.sessionId);
    assert.equal(s.product_id, null, '用卡会话不应绑定套餐');
    assert.equal(s.product_price_cents, null, '用卡会话套餐金额应为空');
    assert.ok(s.card_expires_at, '应记录权益到期日');
  });

  test('【核心】用卡会话没有预计结束时间，因此不会超时', async (t) => {
    if (!dbAvailable) return t.skip('数据库不可用');
    const m = await mkCardMember();

    const r = await openTable({
      tableId, memberId: m, productId: null, useCard: true, operatorId: userId,
    });

    assert.equal(r.expectedEndAt, null, '用卡会话不应有结束时间');

    const s = await getSession(r.sessionId);
    assert.equal(s.expected_end_at, null);
  });

  test('【核心】用卡结账：不收套餐费，也不产生超时费', async (t) => {
    if (!dbAvailable) return t.skip('数据库不可用');
    const m = await mkCardMember();

    const r = await openTable({
      tableId, memberId: m, productId: null, useCard: true, operatorId: userId,
    });
    const settled = await settleSession({
      sessionId: r.sessionId, paymentMethod: 'card', operatorId: userId,
    });

    assert.equal(settled.usedCard, true);
    assert.equal(settled.productAmountCents, 0, '用卡不应收套餐费');
    assert.equal(settled.overtimeUnits, 0, '用卡不应产生超时档数');
    assert.equal(settled.overtimeFeeCents, 0, '用卡不应收超时费');
    assert.equal(settled.totalCents, 0, '无加购时应收为 0');
    assert.equal(settled.flowNo, '', '零金额不产生收入流水');
  });

  test('用卡时可以加购，加购照常收费', async (t) => {
    if (!dbAvailable) return t.skip('数据库不可用');
    const m = await mkCardMember();

    const r = await openTable({
      tableId, memberId: m, productId: null, useCard: true, operatorId: userId,
    });
    const settled = await settleSession({
      sessionId: r.sessionId, addonItems: [{ id: addonProductId, qty: 1 }],
      paymentMethod: 'cash', operatorId: userId,
    });

    assert.ok(settled.addonAmountCents > 0, '加购应有金额');
    assert.equal(settled.overtimeFeeCents, 0, '仍然不收超时费');
    assert.equal(settled.totalCents, settled.addonAmountCents, '应收等于加购金额');
    assert.ok(settled.flowNo, '有金额就应有流水');
  });

  test('【核心】模拟长时间使用：即使超过 3 小时也不算超时', async (t) => {
    if (!dbAvailable) return t.skip('数据库不可用');
    const m = await mkCardMember();

    const r = await openTable({
      tableId, memberId: m, productId: null, useCard: true, operatorId: userId,
    });

    // 把开始时间改成 5 小时前，模拟长时间使用
    await getPool().query(
      `UPDATE table_sessions SET started_at = now() - interval '5 hours' WHERE id = $1`,
      [r.sessionId]
    );

    const settled = await settleSession({
      sessionId: r.sessionId, paymentMethod: 'card', operatorId: userId,
    });

    assert.ok(settled.actualMinutes >= 299, `实际时长应约 300 分钟，实际 ${settled.actualMinutes}`);
    assert.equal(settled.overtimeUnits, 0, '用卡 5 小时也不应算超时');
    assert.equal(settled.overtimeFeeCents, 0);
    assert.equal(settled.totalCents, 0, '用卡 5 小时仍然免费');
  });

  test('对照：限时套餐超过时长仍会正常计超时', async (t) => {
    if (!dbAvailable) return t.skip('数据库不可用');
    const m = await mkCardMember();

    const r = await openTable({
      tableId, memberId: m, productId: timedProductId, useCard: false, operatorId: userId,
    });

    // 单人1小时套餐，改成 1 小时 40 分前开台 → 超 40 分钟 = 2 档 = 10 元
    await getPool().query(
      `UPDATE table_sessions SET started_at = now() - interval '100 minutes' WHERE id = $1`,
      [r.sessionId]
    );

    const settled = await settleSession({
      sessionId: r.sessionId, paymentMethod: 'cash', operatorId: userId,
    });

    assert.equal(settled.usedCard, false);
    // 新阶梯规则：超 40 分钟 = 打底 ¥5 + 超出 20 分钟的部分按 2 段 × ¥1.88
    assert.equal(settled.overtimeUnits, 2, '超 40 分钟应为 2 段');
    assert.equal(settled.overtimeFeeCents, 876, '¥5.00 + 2 × ¥1.88 = ¥8.76');
    assert.ok(settled.totalCents >= 876, '应收应含超时费');
  });

  test('用卡开台必须持有效卡', async (t) => {
    if (!dbAvailable) return t.skip('数据库不可用');
    const r = await createMember({ nickname: `无卡${++seq}`, operatorId: userId });
    await getPool().query(`UPDATE members SET member_no = '__TC' || id WHERE id = $1`, [r.id]);

    await assert.rejects(
      () => openTable({
        tableId, memberId: r.id, productId: null, useCard: true, operatorId: userId,
      }),
      /没有有效的卡/
    );
  });

  test('冻结期间不能用卡开台', async (t) => {
    if (!dbAvailable) return t.skip('数据库不可用');
    const m = await mkCardMember();
    await getPool().query(
      `UPDATE members SET card_frozen = true, card_frozen_reason = '测试' WHERE id = $1`, [m]
    );

    await assert.rejects(
      () => openTable({
        tableId, memberId: m, productId: null, useCard: true, operatorId: userId,
      }),
      /已被冻结/
    );
  });

  test('非用卡开台必须选套餐', async (t) => {
    if (!dbAvailable) return t.skip('数据库不可用');
    const m = await mkCardMember();

    await assert.rejects(
      () => openTable({
        tableId, memberId: m, productId: null, useCard: false, operatorId: userId,
      }),
      /套餐/
    );
  });

  test('用卡核销后核销次数 +1、到店次数 +1', async (t) => {
    if (!dbAvailable) return t.skip('数据库不可用');
    const m = await mkCardMember();

    const before = await getPool().query(
      'SELECT visit_count, card_used_count FROM members WHERE id = $1', [m]
    );

    await openTable({
      tableId, memberId: m, productId: null, useCard: true, operatorId: userId,
    });

    const after = await getPool().query(
      'SELECT visit_count, card_used_count FROM members WHERE id = $1', [m]
    );

    assert.equal(after.rows[0].visit_count, before.rows[0].visit_count + 1);
    assert.equal(after.rows[0].card_used_count, before.rows[0].card_used_count + 1);
  });

  test('结账后订单明细记录卡核销而非套餐', async (t) => {
    if (!dbAvailable) return t.skip('数据库不可用');
    const m = await mkCardMember();

    const r = await openTable({
      tableId, memberId: m, productId: null, useCard: true, operatorId: userId,
    });
    const settled = await settleSession({
      sessionId: r.sessionId, paymentMethod: 'card', operatorId: userId,
    });

    const { rows } = await getPool().query(
      `SELECT name, category, amount_cents FROM order_items WHERE order_id = $1`,
      [settled.orderId]
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0].category, 'card', '明细类别应为卡核销');
    assert.ok(String(rows[0].name).includes('核销'));
    assert.equal(Number(rows[0].amount_cents), 0);
  });

  test('对账：用卡零金额不影响流水与订单的一致性', async (t) => {
    if (!dbAvailable) return t.skip('数据库不可用');
    const m = await mkCardMember();

    const r = await openTable({
      tableId, memberId: m, productId: null, useCard: true, operatorId: userId,
    });
    await settleSession({ sessionId: r.sessionId, paymentMethod: 'card', operatorId: userId });

    const { rows } = await getPool().query(
      `SELECT COALESCE(SUM(amount_cents),0)::bigint AS v FROM revenue_ledger WHERE member_id = $1`,
      [m]
    );
    // 该会员的流水只有办卡那一笔，用卡核销不产生新流水
    const cardPrice = await getPool().query(
      `SELECT COALESCE(SUM(amount_cents),0)::bigint AS v FROM card_records
        WHERE member_id = $1 AND action IN ('issue','renew')`, [m]
    );
    assert.equal(Number(rows[0].v), Number(cardPrice.rows[0].v),
      '用卡核销不应增加收入流水');
  });
});
