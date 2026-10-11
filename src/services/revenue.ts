/**
 * 收入流水与账单
 *
 * revenue_ledger 只追加：任何冲正都写反向记录，绝不修改历史。
 * 对账以本表为准，orders 只反映"这笔生意应收多少"。
 */
import type pg from 'pg';
import { withTransaction } from '../lib/db.js';
import { writeAudit } from './audit.js';
import { toDateString } from './tables.js';

export class LedgerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LedgerError';
  }
}

/** 当日/当月营业汇总 */
export async function getRevenueSummary() {
  return withTransaction(async (client) => {
    const { rows } = await client.query(`
      WITH bounds AS (
        SELECT date_trunc('day', now() AT TIME ZONE 'Asia/Shanghai') AS day_start,
               date_trunc('month', now() AT TIME ZONE 'Asia/Shanghai') AS month_start
      )
      SELECT
        -- 今日
        COALESCE(SUM(CASE WHEN l.created_at >= b.day_start THEN l.amount_cents END), 0)::bigint AS today_amount,
        COUNT(CASE WHEN l.created_at >= b.day_start AND l.flow_type = 'consume' THEN 1 END)::int AS today_orders,
        COUNT(CASE WHEN l.created_at >= b.day_start AND l.flow_type = 'card_purchase' THEN 1 END)::int AS today_cards,
        -- 本月
        COALESCE(SUM(CASE WHEN l.created_at >= b.month_start THEN l.amount_cents END), 0)::bigint AS month_amount,
        COUNT(CASE WHEN l.created_at >= b.month_start AND l.flow_type = 'consume' THEN 1 END)::int AS month_orders,
        COUNT(CASE WHEN l.created_at >= b.month_start AND l.flow_type = 'card_purchase' THEN 1 END)::int AS month_cards
      FROM bounds b
      LEFT JOIN revenue_ledger l ON true
      GROUP BY b.day_start, b.month_start
    `);

    const { rows: memberStats } = await client.query(`
      SELECT
        COUNT(CASE WHEN joined_on = (now() AT TIME ZONE 'Asia/Shanghai')::date THEN 1 END)::int AS today_new,
        COUNT(CASE WHEN date_trunc('month', joined_on) = date_trunc('month', (now() AT TIME ZONE 'Asia/Shanghai')::date) THEN 1 END)::int AS month_new,
        COUNT(*)::int AS total
      FROM members WHERE status = 'active'
    `);

    // 按支付方式拆分（本月）
    const { rows: byMethod } = await client.query(`
      SELECT payment_method, COALESCE(SUM(amount_cents),0)::bigint AS amount, COUNT(*)::int AS cnt
        FROM revenue_ledger
       WHERE created_at >= date_trunc('month', now() AT TIME ZONE 'Asia/Shanghai')
       GROUP BY payment_method
       ORDER BY amount DESC
    `);

    const r = rows[0] ?? {};
    return {
      today: {
        amountCents: Number(r.today_amount ?? 0),
        orderCount: Number(r.today_orders ?? 0),
        cardCount: Number(r.today_cards ?? 0),
      },
      month: {
        amountCents: Number(r.month_amount ?? 0),
        orderCount: Number(r.month_orders ?? 0),
        cardCount: Number(r.month_cards ?? 0),
      },
      members: {
        todayNew: Number(memberStats[0]?.today_new ?? 0),
        monthNew: Number(memberStats[0]?.month_new ?? 0),
        total: Number(memberStats[0]?.total ?? 0),
      },
      byPaymentMethod: byMethod.map((x) => ({
        method: x.payment_method as string,
        amountCents: Number(x.amount),
        count: x.cnt as number,
      })),
    };
  });
}

/** 流水列表（可按日期、类型、支付方式筛选） */
export async function listLedger(params: {
  from?: string;
  to?: string;
  flowType?: 'consume' | 'card_purchase' | 'refund' | 'adjust';
  memberId?: number;
  cursor?: number;
  limit?: number;
}) {
  const limit = Math.min(Math.max(params.limit ?? 50, 1), 200);

  return withTransaction(async (client) => {
    const conds: string[] = [];
    const vals: unknown[] = [];

    if (params.from) { vals.push(params.from); conds.push(`l.created_at >= $${vals.length}::date`); }
    if (params.to) { vals.push(params.to); conds.push(`l.created_at < ($${vals.length}::date + interval '1 day')`); }
    if (params.flowType) { vals.push(params.flowType); conds.push(`l.flow_type = $${vals.length}`); }
    if (params.memberId) { vals.push(params.memberId); conds.push(`l.member_id = $${vals.length}`); }
    if (params.cursor) { vals.push(params.cursor); conds.push(`l.id < $${vals.length}`); }
    vals.push(limit);

    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';

    const { rows } = await client.query(
      `SELECT l.id, l.flow_no, l.flow_type, l.amount_cents::bigint AS amount_cents,
              l.payment_method, l.business_date, l.remark, l.created_at,
              l.order_id, l.member_id,
              m.nickname, m.phone_tail, m.member_no,
              u.display_name AS operator_name,
              o.order_no, o.table_name
         FROM revenue_ledger l
         LEFT JOIN members m ON m.id = l.member_id
         LEFT JOIN users u ON u.id = l.operator_id
         LEFT JOIN orders o ON o.id = l.order_id
         ${where}
        ORDER BY l.id DESC
        LIMIT $${vals.length}`,
      vals
    );

    // 合计（同一筛选条件）
    const { rows: totals } = await client.query(
      `SELECT COALESCE(SUM(l.amount_cents),0)::bigint AS total, COUNT(*)::int AS cnt
         FROM revenue_ledger l ${where.replace(/\sLIMIT.*$/i, '')}`,
      vals.slice(0, -1)
    );

    return {
      entries: rows.map((r) => ({
        id: Number(r.id),
        flowNo: r.flow_no,
        flowType: r.flow_type,
        amountCents: Number(r.amount_cents),
        paymentMethod: r.payment_method,
        businessDate: toDateString(r.business_date),
        remark: r.remark,
        createdAt: r.created_at,
        orderId: r.order_id === null ? null : Number(r.order_id),
        orderNo: r.order_no,
        memberId: r.member_id === null ? null : Number(r.member_id),
        memberName: r.nickname ? [r.nickname, r.phone_tail].filter(Boolean).join(' · ') : null,
        memberNo: r.member_no,
        tableName: r.table_name,
        operatorName: r.operator_name,
      })),
      totalCents: Number(totals[0]?.total ?? 0),
      totalCount: Number(totals[0]?.cnt ?? 0),
    };
  });
}

/** 订单列表 */
export async function listOrders(params: {
  from?: string;
  to?: string;
  memberId?: number;
  status?: string;
  cursor?: number;
  limit?: number;
}) {
  const limit = Math.min(Math.max(params.limit ?? 30, 1), 100);

  return withTransaction(async (client) => {
    const conds: string[] = [];
    const vals: unknown[] = [];

    if (params.from) { vals.push(params.from); conds.push(`o.completed_at >= $${vals.length}::date`); }
    if (params.to) { vals.push(params.to); conds.push(`o.completed_at < ($${vals.length}::date + interval '1 day')`); }
    if (params.memberId) { vals.push(params.memberId); conds.push(`o.member_id = $${vals.length}`); }
    if (params.status) { vals.push(params.status); conds.push(`o.status = $${vals.length}`); }
    if (params.cursor) { vals.push(params.cursor); conds.push(`o.id < $${vals.length}`); }
    vals.push(limit);

    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';

    const { rows } = await client.query(
      `SELECT o.id, o.order_no, o.status, o.total_cents::bigint AS total_cents,
              o.paid_cents::bigint AS paid_cents, o.refunded_cents::bigint AS refunded_cents,
              o.payment_method, o.completed_at, o.table_name, o.used_card,
              o.is_discount_day, o.actual_minutes, o.overtime_units,
              o.overtime_fee_cents::bigint AS overtime_fee_cents,
              o.discount_cents::bigint AS discount_cents,
              o.member_id, m.nickname, m.phone_tail, m.member_no,
              o.guest_name, u.display_name AS operator_name
         FROM orders o
         LEFT JOIN members m ON m.id = o.member_id
         LEFT JOIN users u ON u.id = o.operator_id
         ${where}
        ORDER BY o.id DESC LIMIT $${vals.length}`,
      vals
    );

    return {
      orders: rows.map((r) => ({
        id: Number(r.id),
        orderNo: r.order_no,
        status: r.status,
        totalCents: Number(r.total_cents),
        paidCents: Number(r.paid_cents),
        refundedCents: Number(r.refunded_cents),
        paymentMethod: r.payment_method,
        completedAt: r.completed_at,
        tableName: r.table_name,
        usedCard: r.used_card,
        isDiscountDay: r.is_discount_day,
        actualMinutes: r.actual_minutes,
        overtimeUnits: r.overtime_units,
        overtimeFeeCents: Number(r.overtime_fee_cents),
        discountCents: Number(r.discount_cents),
        memberId: r.member_id === null ? null : Number(r.member_id),
        memberName: r.nickname
          ? [r.nickname, r.phone_tail].filter(Boolean).join(' · ')
          : (r.guest_name as string) || '散客',
        memberNo: r.member_no,
        operatorName: r.operator_name,
      })),
    };
  });
}

/** 订单详情（含明细） */
export async function getOrderDetail(orderId: number) {
  return withTransaction(async (client) => {
    const { rows } = await client.query(
      `SELECT o.*, m.nickname, m.phone_tail, m.member_no,
              u.display_name AS operator_name, v.display_name AS voided_by_name
         FROM orders o
         LEFT JOIN members m ON m.id = o.member_id
         LEFT JOIN users u ON u.id = o.operator_id
         LEFT JOIN users v ON v.id = o.voided_by
        WHERE o.id = $1`,
      [orderId]
    );
    if (rows.length === 0) return null;
    const o = rows[0];

    const { rows: items } = await client.query(
      `SELECT id, name, category, qty, unit_price_cents::bigint AS unit_price_cents,
              amount_cents::bigint AS amount_cents
         FROM order_items WHERE order_id = $1 ORDER BY sort_order, id`,
      [orderId]
    );

    const { rows: flows } = await client.query(
      `SELECT id, flow_no, flow_type, amount_cents::bigint AS amount_cents,
              payment_method, created_at, operator_id
         FROM revenue_ledger WHERE order_id = $1 ORDER BY id`,
      [orderId]
    );

    return {
      id: Number(o.id),
      orderNo: o.order_no,
      status: o.status,
      memberId: o.member_id === null ? null : Number(o.member_id),
      memberName: o.nickname
        ? [o.nickname, o.phone_tail].filter(Boolean).join(' · ')
        : (o.guest_name as string) || '散客',
      memberNo: o.member_no,
      tableName: o.table_name,
      tableSessionId: o.table_session_id === null ? null : Number(o.table_session_id),
      productAmountCents: Number(o.product_amount_cents),
      addonAmountCents: Number(o.addon_amount_cents),
      overtimeFeeCents: Number(o.overtime_fee_cents),
      discountCents: Number(o.discount_cents),
      totalCents: Number(o.total_cents),
      paidCents: Number(o.paid_cents),
      refundedCents: Number(o.refunded_cents),
      discountRateBp: o.discount_rate_bp,
      isDiscountDay: o.is_discount_day,
      startedAt: o.started_at,
      endedAt: o.ended_at,
      actualMinutes: o.actual_minutes,
      overtimeUnits: o.overtime_units,
      usedCard: o.used_card,
      paymentMethod: o.payment_method,
      operatorName: o.operator_name,
      note: o.note,
      completedAt: o.completed_at,
      voidedAt: o.voided_at,
      voidedByName: o.voided_by_name,
      voidReason: o.void_reason,
      items: items.map((it) => ({
        id: Number(it.id),
        name: it.name,
        category: it.category,
        qty: Number(it.qty),
        unitPriceCents: Number(it.unit_price_cents),
        amountCents: Number(it.amount_cents),
      })),
      flows: flows.map((f) => ({
        id: Number(f.id),
        flowNo: f.flow_no,
        flowType: f.flow_type,
        amountCents: Number(f.amount_cents),
        paymentMethod: f.payment_method,
        createdAt: f.created_at,
      })),
    };
  });
}

/**
 * 作废订单：写反向流水，订单标记作废，释放的工位不恢复（历史已发生）。
 * 不删除任何记录。
 */
export async function voidOrder(params: {
  orderId: number;
  reason: string;
  operatorId: number;
}) {
  const { orderId, reason, operatorId } = params;
  if (!reason?.trim()) throw new LedgerError('作废必须填写原因');

  return withTransaction(async (client) => {
    const { rows } = await client.query(
      `SELECT id, order_no, status, paid_cents::bigint AS paid_cents, member_id,
              table_session_id
         FROM orders WHERE id = $1 FOR UPDATE`,
      [orderId]
    );
    if (rows.length === 0) throw new LedgerError('订单不存在');
    const o = rows[0];
    if (o.status === 'voided') throw new LedgerError('该订单已作废');

    const paid = Number(o.paid_cents);

    // 反向流水（金额为负）
    let flowNo = '';
    if (paid > 0) {
      const { rows: cnt } = await client.query(
        `SELECT COUNT(*)::int AS c FROM revenue_ledger WHERE created_at::date = CURRENT_DATE`
      );
      const d = new Date();
      const ymd = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
      flowNo = `F${ymd}${String((cnt[0].c as number) + 1).padStart(4, '0')}`;

      const { rows: orig } = await client.query(
        `SELECT id FROM revenue_ledger WHERE order_id = $1 AND flow_type = 'consume'
          ORDER BY id LIMIT 1`,
        [orderId]
      );

      await client.query(
        `INSERT INTO revenue_ledger
           (flow_no, flow_type, amount_cents, payment_method, member_id, order_id,
            table_session_id, reverses_id, business_date, operator_id, remark)
         VALUES ($1,'refund',$2,'other',$3,$4,$5,$6,CURRENT_DATE,$7,$8)`,
        [
          flowNo, -paid, o.member_id, orderId, o.table_session_id,
          orig[0]?.id ?? null, operatorId, `作废订单 ${o.order_no}：${reason.trim()}`,
        ]
      );
    }

    await client.query(
      `UPDATE orders
          SET status = 'voided', voided_at = now(), voided_by = $1,
              void_reason = $2, refunded_cents = paid_cents
        WHERE id = $3`,
      [operatorId, reason.trim(), orderId]
    );

    await writeAudit(client, {
      actorId: operatorId,
      action: 'order.void',
      targetType: 'order',
      targetId: orderId,
      before: { status: o.status, paid },
      after: { status: 'voided', refunded: paid },
      summary: `作废订单 ${o.order_no}（-${(paid / 100).toFixed(2)} 元）：${reason.trim()}`,
    });

    return { orderId, reversedCents: paid, flowNo };
  });
}

/**
 * 对账：核对收入流水与业务单据是否一致。
 *
 * 为什么要分两块：
 *   revenue_ledger 里混合了两类钱 —— 到店消费 与 办卡/退卡。
 *   而订单表只对应前者（办卡虽然也生成订单，但退卡没有对应订单）。
 *   若把两者混在一起比，退卡之后必然对不上。
 *
 * 因此分别核对：
 *   consume 类流水  ←→  订单的实收净额（排除办卡订单）
 *   办卡/退卡流水    ←→  卡权益流水的净额
 */
export async function reconcile() {
  return withTransaction(async (client) => {
    const { rows } = await client.query(`
      WITH
      -- 到店消费：流水侧
      consume_ledger AS (
        SELECT COALESCE(SUM(amount_cents), 0)::bigint AS v
          FROM revenue_ledger WHERE flow_type = 'consume'
      ),
      -- 到店消费：订单侧（排除含卡项的订单，那些属于办卡）
      consume_orders AS (
        SELECT COALESCE(SUM(o.paid_cents - o.refunded_cents), 0)::bigint AS v
          FROM orders o
         WHERE o.status <> 'voided'
           AND NOT EXISTS (
             SELECT 1 FROM order_items oi WHERE oi.order_id = o.id AND oi.category = 'card'
           )
      ),
      -- 办卡与退卡：流水侧
      card_ledger AS (
        SELECT COALESCE(SUM(amount_cents), 0)::bigint AS v
          FROM revenue_ledger WHERE flow_type = 'card_purchase'
      ),
      card_refund_ledger AS (
        SELECT COALESCE(SUM(amount_cents), 0)::bigint AS v
          FROM revenue_ledger WHERE flow_type = 'refund' AND order_id IS NULL
      ),
      -- 办卡与退卡：卡权益流水侧（退卡记为正数，需取负）
      card_records_net AS (
        SELECT COALESCE(SUM(
                 CASE WHEN action IN ('issue','renew') THEN amount_cents
                      WHEN action = 'refund' THEN -amount_cents
                      ELSE 0 END), 0)::bigint AS v
          FROM card_records
      )
      SELECT
        (SELECT v FROM consume_ledger)       AS consume_ledger,
        (SELECT v FROM consume_orders)       AS consume_orders,
        ((SELECT v FROM card_ledger) + (SELECT v FROM card_refund_ledger)) AS card_ledger,
        (SELECT v FROM card_records_net)     AS card_records
    `);

    const r = rows[0];
    const consumeLedger = Number(r.consume_ledger);
    const consumeOrders = Number(r.consume_orders);
    const cardLedger = Number(r.card_ledger);
    const cardRecords = Number(r.card_records);

    const consumeDiff = consumeLedger - consumeOrders;
    const cardDiff = cardLedger - cardRecords;

    return {
      // 到店消费
      consumeLedgerCents: consumeLedger,
      consumeOrdersCents: consumeOrders,
      consumeDiffCents: consumeDiff,
      // 办卡与退卡
      cardLedgerCents: cardLedger,
      cardRecordsCents: cardRecords,
      cardDiffCents: cardDiff,
      // 总体
      ledgerTotalCents: Number(
        (await client.query(
          `SELECT COALESCE(SUM(amount_cents),0)::bigint AS v FROM revenue_ledger`
        )).rows[0].v
      ),
      diffCents: consumeDiff,
      balanced: consumeDiff === 0 && cardDiff === 0,
    };
  });
}
