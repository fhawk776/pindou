/**
 * 会员服务
 *
 * 会员标识：昵称（自由填，如"杨先生"或"小雨"）+ 手机尾号（选填）
 * 卡种权益直接挂在会员上：一个人同时只持有一张有效卡。
 */
import type pg from 'pg';
import { withTransaction } from '../lib/db.js';
import { writeAudit } from './audit.js';
import { getShopConfig, toDateString } from './tables.js';

export class MemberError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MemberError';
  }
}

export interface CreateMemberInput {
  nickname: string;
  phoneTail?: string | null;
  joinedOn?: string;
  remark?: string;
  operatorId: number;
}

/** 生成会员编号 PD0001 */
async function nextMemberNo(client: pg.PoolClient): Promise<string> {
  const shop = await getShopConfig(client);
  const prefix = (shop as unknown as { member_no_prefix?: string }).member_no_prefix ?? 'PD';

  const { rows } = await client.query(
    `SELECT member_no FROM members
      WHERE member_no ~ $1
      ORDER BY LENGTH(member_no) DESC, member_no DESC
      LIMIT 1`,
    [`^${prefix}[0-9]+$`]
  );
  let next = 1;
  if (rows.length > 0) {
    const num = Number.parseInt(String(rows[0].member_no).slice(prefix.length), 10);
    if (!Number.isNaN(num)) next = num + 1;
  }
  return `${prefix}${String(next).padStart(4, '0')}`;
}

export async function createMember(input: CreateMemberInput): Promise<{
  id: number;
  memberNo: string;
  nickname: string;
  phoneTail: string | null;
}> {
  const nickname = input.nickname?.trim();
  if (!nickname) throw new MemberError('昵称不能为空');
  if (nickname.length > 20) throw new MemberError('昵称不能超过 20 个字');

  const tail = input.phoneTail?.trim() || null;
  if (tail !== null && !/^[0-9]{4}$/.test(tail)) {
    throw new MemberError('手机尾号必须是 4 位数字');
  }

  return withTransaction(async (client) => {
    const memberNo = await nextMemberNo(client);
    const { rows } = await client.query(
      `INSERT INTO members (member_no, nickname, phone_tail, joined_on, remark)
       VALUES ($1,$2,$3,COALESCE($4::date, CURRENT_DATE),$5)
       RETURNING id, member_no, nickname, phone_tail`,
      [memberNo, nickname, tail, input.joinedOn ?? null, input.remark ?? '']
    );

    await writeAudit(client, {
      actorId: input.operatorId,
      action: 'member.create',
      targetType: 'member',
      targetId: Number(rows[0].id),
      after: { memberNo, nickname, phoneTail: tail },
      summary: `新会员 ${nickname}${tail ? ' · ' + tail : ''}（${memberNo}）`,
    });

    return {
      id: Number(rows[0].id),
      memberNo: rows[0].member_no as string,
      nickname: rows[0].nickname as string,
      phoneTail: (rows[0].phone_tail as string) ?? null,
    };
  });
}

export async function updateMember(params: {
  memberId: number;
  nickname?: string;
  phoneTail?: string | null;
  remark?: string;
  status?: 'active' | 'disabled';
  operatorId: number;
}): Promise<void> {
  const { memberId, operatorId, ...changes } = params;

  await withTransaction(async (client) => {
    const { rows: before } = await client.query(
      `SELECT member_no, nickname, phone_tail, remark, status
         FROM members WHERE id = $1 FOR UPDATE`,
      [memberId]
    );
    if (before.length === 0) throw new MemberError('会员不存在');

    const sets: string[] = [];
    const values: unknown[] = [];
    let i = 1;

    if (changes.nickname !== undefined) {
      const n = changes.nickname.trim();
      if (!n) throw new MemberError('昵称不能为空');
      if (n.length > 20) throw new MemberError('昵称不能超过 20 个字');
      sets.push(`nickname = $${i++}`); values.push(n);
    }
    if (changes.phoneTail !== undefined) {
      const t = changes.phoneTail?.trim() || null;
      if (t !== null && !/^[0-9]{4}$/.test(t)) throw new MemberError('手机尾号必须是 4 位数字');
      sets.push(`phone_tail = $${i++}`); values.push(t);
    }
    if (changes.remark !== undefined) { sets.push(`remark = $${i++}`); values.push(changes.remark); }
    if (changes.status !== undefined) { sets.push(`status = $${i++}`); values.push(changes.status); }

    if (sets.length === 0) return;
    sets.push('row_version = row_version + 1');
    values.push(memberId);

    await client.query(`UPDATE members SET ${sets.join(', ')} WHERE id = $${i}`, values);

    await writeAudit(client, {
      actorId: operatorId,
      action: 'member.update',
      targetType: 'member',
      targetId: memberId,
      before: before[0],
      after: changes,
      summary: `修改会员资料 ${before[0].member_no}`,
    });
  });
}

/** 快速搜索：支持昵称、尾号、会员编号 */
export async function searchMembers(params: {
  q?: string;
  cursor?: number;
  limit?: number;
}) {
  const limit = Math.min(Math.max(params.limit ?? 20, 1), 100);
  const q = params.q?.trim() ?? '';

  return withTransaction(async (client) => {
    const conditions: string[] = [];
    const values: unknown[] = [];

    if (q) {
      values.push(`%${q}%`);
      const like = `$${values.length}`;
      values.push(q);
      const exact = `$${values.length}`;
      // 尾号用前缀匹配，昵称与编号用模糊匹配
      conditions.push(
        `(m.nickname ILIKE ${like} OR m.member_no ILIKE ${like}
          OR COALESCE(m.phone_tail,'') LIKE ${like} OR m.phone_tail = ${exact})`
      );
    }
    if (params.cursor) {
      values.push(params.cursor);
      conditions.push(`m.id < $${values.length}`);
    }
    values.push(limit);
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const { rows } = await client.query(
      `SELECT m.id, m.member_no, m.nickname, m.phone_tail, m.joined_on,
              m.card_type, m.card_started_at, m.card_expires_at,
              m.card_frozen, m.card_frozen_reason,
              m.visit_count, m.card_used_count, m.status,
              (m.card_expires_at IS NOT NULL AND m.card_expires_at >= CURRENT_DATE) AS card_valid,
              -- 消费口径拆分：办卡与到店消费分开统计，
              -- 避免把办卡金额算进"玩了多少钱"，两者对顾客的含义不同。
              COALESCE(o.card_paid, 0)::bigint  AS card_paid_cents,
              COALESCE(o.visit_paid, 0)::bigint AS visit_paid_cents,
              COALESCE(o.order_count, 0)::int   AS order_count
         FROM members m
         LEFT JOIN (
           SELECT oo.member_id,
                  SUM(CASE WHEN oi.is_card   THEN oo.paid_cents ELSE 0 END) AS card_paid,
                  SUM(CASE WHEN NOT oi.is_card THEN oo.paid_cents ELSE 0 END) AS visit_paid,
                  COUNT(*) AS order_count
             FROM orders oo
             LEFT JOIN (
               SELECT order_id, bool_or(category = 'card') AS is_card
                 FROM order_items GROUP BY order_id
             ) oi ON oi.order_id = oo.id
            WHERE oo.status <> 'voided' AND oo.member_id IS NOT NULL
            GROUP BY oo.member_id
         ) o ON o.member_id = m.id
         ${where}
        ORDER BY m.id DESC
        LIMIT $${values.length}`,
      values
    );

    return rows.map((r) => ({
      id: Number(r.id),
      memberNo: r.member_no as string,
      nickname: r.nickname as string,
      phoneTail: (r.phone_tail as string) ?? null,
      displayName: [r.nickname, r.phone_tail].filter(Boolean).join(' · '),
      joinedOn: toDateString(r.joined_on),
      cardType: (r.card_type as string) ?? null,
      cardStartedAt: toDateString(r.card_started_at),
      cardExpiresAt: toDateString(r.card_expires_at),
      cardValid: Boolean(r.card_valid),
      cardFrozen: Boolean(r.card_frozen),
      cardFrozenReason: (r.card_frozen_reason as string) ?? null,
      visitCount: r.visit_count as number,
      cardUsedCount: r.card_used_count as number,
      status: r.status as string,
      // 消费统计：cardPaid = 办卡花的钱，visitPaid = 到店玩花的钱
      cardPaidCents: Number(r.card_paid_cents),
      visitPaidCents: Number(r.visit_paid_cents),
      totalPaidCents: Number(r.card_paid_cents) + Number(r.visit_paid_cents),
      orderCount: r.order_count as number,
    }));
  });
}

/** 会员详情，含到店记录与消费记录 */
export async function getMemberDetail(memberId: number) {
  return withTransaction(async (client) => {
    const { rows } = await client.query(
      `SELECT m.*,
              (m.card_expires_at IS NOT NULL AND m.card_expires_at >= CURRENT_DATE) AS card_valid
         FROM members m WHERE m.id = $1`,
      [memberId]
    );
    if (rows.length === 0) return null;
    const m = rows[0];

    // 消费汇总（排除已作废）。办卡与到店消费分开统计。
    const { rows: stats } = await client.query(
      `SELECT
         COALESCE(SUM(o.paid_cents), 0)::bigint AS total_paid,
         COALESCE(SUM(CASE WHEN oi.is_card THEN o.paid_cents ELSE 0 END), 0)::bigint AS card_paid,
         COALESCE(SUM(CASE WHEN NOT oi.is_card THEN o.paid_cents ELSE 0 END), 0)::bigint AS visit_paid,
         COUNT(*)::int AS order_count,
         MAX(o.completed_at) AS last_visit_at,
         COALESCE(SUM(o.overtime_fee_cents), 0)::bigint AS total_overtime
       FROM orders o
       LEFT JOIN (
         SELECT order_id, bool_or(category = 'card') AS is_card
           FROM order_items GROUP BY order_id
       ) oi ON oi.order_id = o.id
      WHERE o.member_id = $1 AND o.status <> 'voided'`,
      [memberId]
    );

    // 到店记录（即拼豆记录）
    const { rows: visits } = await client.query(
      `SELECT ts.id, ts.product_name, ts.started_at, ts.ended_at, ts.actual_minutes,
              ts.overtime_units, ts.used_card, ts.status,
              t.name AS table_name
         FROM table_sessions ts
         LEFT JOIN tables t ON t.id = ts.table_id
        WHERE ts.member_id = $1
        ORDER BY ts.started_at DESC LIMIT 30`,
      [memberId]
    );

    // 消费记录
    const { rows: orders } = await client.query(
      `SELECT o.id, o.order_no, o.total_cents::bigint AS total_cents,
              o.paid_cents::bigint AS paid_cents, o.status, o.completed_at,
              o.table_name, o.used_card, o.is_discount_day, o.actual_minutes
         FROM orders o WHERE o.member_id = $1
        ORDER BY o.id DESC LIMIT 30`,
      [memberId]
    );

    return {
      id: Number(m.id),
      memberNo: m.member_no as string,
      nickname: m.nickname as string,
      phoneTail: (m.phone_tail as string) ?? null,
      displayName: [m.nickname, m.phone_tail].filter(Boolean).join(' · '),
      joinedOn: toDateString(m.joined_on),
      remark: m.remark as string,
      status: m.status as string,
      cardType: (m.card_type as string) ?? null,
      cardStartedAt: toDateString(m.card_started_at),
      cardExpiresAt: toDateString(m.card_expires_at),
      cardValid: Boolean(m.card_valid),
      cardFrozen: Boolean(m.card_frozen),
      cardFrozenReason: (m.card_frozen_reason as string) ?? null,
      cardFrozenAt: m.card_frozen_at,
      cardUsedCount: m.card_used_count as number,
      visitCount: m.visit_count as number,
      stats: {
        totalPaidCents: Number(stats[0].total_paid),
        cardPaidCents: Number(stats[0].card_paid),
        visitPaidCents: Number(stats[0].visit_paid),
        orderCount: stats[0].order_count as number,
        lastVisitAt: stats[0].last_visit_at,
        totalOvertimeCents: Number(stats[0].total_overtime),
      },
      visits: visits.map((v) => ({
        id: Number(v.id),
        tableName: v.table_name,
        productName: v.product_name,
        startedAt: v.started_at,
        endedAt: v.ended_at,
        actualMinutes: v.actual_minutes,
        overtimeUnits: v.overtime_units,
        usedCard: v.used_card,
        status: v.status,
      })),
      orders: orders.map((o) => ({
        id: Number(o.id),
        orderNo: o.order_no,
        totalCents: Number(o.total_cents),
        paidCents: Number(o.paid_cents),
        status: o.status,
        completedAt: o.completed_at,
        tableName: o.table_name,
        usedCard: o.used_card,
        isDiscountDay: o.is_discount_day,
        actualMinutes: o.actual_minutes,
      })),
    };
  });
}

/** 办卡：授予会员卡权益并生成办卡订单与流水 */
export async function purchaseCard(params: {
  memberId: number;
  cardType: 'week' | 'month' | 'day';
  productId: number;
  paymentMethod: 'cash' | 'wechat' | 'alipay' | 'other';
  operatorId: number;
  note?: string;
}): Promise<{
  orderId: number;
  orderNo: string;
  flowNo: string;
  priceCents: number;
  startedAt: string;
  expiresAt: string;
}> {
  const { memberId, cardType, productId, paymentMethod, operatorId } = params;

  return withTransaction(async (client) => {
    const { rows: mrows } = await client.query(
      'SELECT id, member_no, nickname, card_type, card_expires_at, status FROM members WHERE id = $1 FOR UPDATE',
      [memberId]
    );
    if (mrows.length === 0) throw new MemberError('会员不存在');
    if (mrows[0].status !== 'active') throw new MemberError('该会员已停用');

    const { rows: prows } = await client.query(
      `SELECT id, name, category, price_cents::bigint AS price_cents, card_valid_days, card_type
         FROM products WHERE id = $1 AND is_active = true`,
      [productId]
    );
    if (prows.length === 0) throw new MemberError('卡种不存在');
    const product = prows[0];
    if (product.category !== 'card') throw new MemberError('所选项目不是卡种');

    const days = Number(product.card_valid_days ?? (cardType === 'month' ? 30 : 7));
    const price = Number(product.price_cents);

    // 续卡逻辑：
    //   起始日 —— 若原卡仍在有效期内则保持不变（展示"累计有效期"的起点），
    //             否则以今天为新的起点。
    //   到期日 —— 若原卡未过期则从原到期日顺延，避免浪费剩余天数；
    //             已过期则从今天起算。
    const todayStr = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' });
    const oldExpires = toDateString(mrows[0].card_expires_at);
    const oldStarted = toDateString(mrows[0].card_started_at);

    let startStr: string;
    let baseDate: Date;

    if (oldExpires && oldExpires >= todayStr) {
      // 卡还在有效期内：起点沿用，到期日顺延
      startStr = oldStarted ?? todayStr;
      baseDate = new Date(`${oldExpires}T00:00:00+08:00`);
    } else {
      // 新卡或已过期：从今天重新起算
      startStr = todayStr;
      baseDate = new Date(`${todayStr}T00:00:00+08:00`);
    }

    const expires = new Date(baseDate.getTime() + days * 24 * 60 * 60 * 1000);
    const expiresStr = expires.toISOString().slice(0, 10);

    // 生成订单
    const { rows: cnt } = await client.query(
      `SELECT COUNT(*)::int AS c FROM orders WHERE completed_at::date = CURRENT_DATE`
    );
    const d = new Date();
    const ymd = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
    const orderNo = `O${ymd}${String((cnt[0].c as number) + 1).padStart(4, '0')}`;

    const { rows: orows } = await client.query(
      `INSERT INTO orders (
         order_no, member_id, product_amount_cents, addon_amount_cents,
         overtime_fee_cents, discount_cents, total_cents, paid_cents,
         payment_method, is_discount_day, used_card, operator_id, note
       ) VALUES ($1,$2,$3,0,0,0,$3,$3,$4,false,false,$5,$6)
       RETURNING id`,
      [orderNo, memberId, price, paymentMethod, operatorId, params.note ?? '']
    );
    const orderId = Number(orows[0].id);

    await client.query(
      `INSERT INTO order_items (order_id, product_id, name, category, qty,
                                unit_price_cents, amount_cents, sort_order)
       VALUES ($1,$2,$3,'card',1,$4,$4,0)`,
      [orderId, productId, product.name, price]
    );

    // 流水
    const { rows: fcnt } = await client.query(
      `SELECT COUNT(*)::int AS c FROM revenue_ledger WHERE created_at::date = CURRENT_DATE`
    );
    const flowNo = `F${ymd}${String((fcnt[0].c as number) + 1).padStart(4, '0')}`;

    await client.query(
      `INSERT INTO revenue_ledger
         (flow_no, flow_type, amount_cents, payment_method, member_id, order_id,
          business_date, operator_id, remark)
       VALUES ($1,'card_purchase',$2,$3,$4,$5,CURRENT_DATE,$6,$7)`,
      [flowNo, price, paymentMethod, memberId, orderId, operatorId, `办理 ${product.name}`]
    );

    // 授予权益
    await client.query(
      `UPDATE members
          SET card_type = $1, card_started_at = $2, card_expires_at = $3,
              card_order_id = $4,
              card_frozen = false, card_frozen_reason = NULL, card_frozen_at = NULL,
              row_version = row_version + 1
        WHERE id = $5`,
      [product.card_type ?? cardType, startStr, expiresStr, orderId, memberId]
    );

    // 卡权益流水（续卡还是新办，用于追溯）
    await client.query(
      `INSERT INTO card_records
         (member_id, action, card_type, started_at, expires_at, amount_cents, order_id, operator_id, reason)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        memberId,
        mrows[0].card_type ? 'renew' : 'issue',
        product.card_type ?? cardType, startStr, expiresStr, price, orderId, operatorId,
        params.note ?? '',
      ]
    );

    await writeAudit(client, {
      actorId: operatorId,
      action: 'member.purchase_card',
      targetType: 'member',
      targetId: memberId,
      after: { cardType: product.card_type, startedAt: startStr, expiresAt: expiresStr, price, orderNo },
      summary: `办理 ${product.name}，有效期 ${startStr} 至 ${expiresStr}`,
    });

    return { orderId, orderNo, flowNo, priceCents: price, startedAt: startStr, expiresAt: expiresStr };
  });
}

/**
 * 退卡：把权益作废并退款。
 *
 * 退款金额由操作者手动填写（不做自动折算），因为现实中常出现
 * "全退给他"、"用了 5 次退一半"这类需要人为判断的情况。
 * 但金额必须记录清楚，并写一条反向流水，保证账目可追溯。
 */
export async function refundCard(params: {
  memberId: number;
  refundCents: number;
  refundMethod: 'cash' | 'wechat' | 'alipay' | 'other';
  reason: string;
  operatorId: number;
}): Promise<{ refundCents: number; flowNo: string; cardType: string }> {
  const { memberId, refundCents, refundMethod, reason, operatorId } = params;

  if (!Number.isSafeInteger(refundCents) || refundCents < 0) {
    throw new MemberError('退款金额必须是非负整数分');
  }
  if (!reason?.trim()) throw new MemberError('退卡必须填写原因');

  return withTransaction(async (client) => {
    const { rows } = await client.query(
      `SELECT id, member_no, nickname, card_type, card_started_at, card_expires_at,
              card_frozen, status
         FROM members WHERE id = $1 FOR UPDATE`,
      [memberId]
    );
    if (rows.length === 0) throw new MemberError('会员不存在');
    const m = rows[0];

    if (!m.card_type) throw new MemberError('该会员当前没有卡，无需退卡');
    if (m.status !== 'active') throw new MemberError('该会员已停用');

    const cardType = m.card_type as string;
    const startedAt = toDateString(m.card_started_at);
    const expiresAt = toDateString(m.card_expires_at);

    // 退款金额不能超过当初办卡的实收金额，防止手误多退
    const { rows: paidRows } = await client.query(
      `SELECT COALESCE(SUM(amount_cents), 0)::bigint AS paid
         FROM revenue_ledger
        WHERE member_id = $1 AND flow_type = 'card_purchase'`,
      [memberId]
    );
    const totalPaid = Number(paidRows[0].paid);
    if (refundCents > totalPaid) {
      throw new MemberError(
        `退款金额不能超过该会员累计办卡金额 ¥${(totalPaid / 100).toFixed(2)}`
      );
    }

    // 写反向流水（退款为负）
    let flowNo = '';
    if (refundCents > 0) {
      const { rows: cnt } = await client.query(
        `SELECT COUNT(*)::int AS c FROM revenue_ledger WHERE created_at::date = CURRENT_DATE`
      );
      const d = new Date();
      const ymd = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
      flowNo = `F${ymd}${String((cnt[0].c as number) + 1).padStart(4, '0')}`;

      await client.query(
        `INSERT INTO revenue_ledger
           (flow_no, flow_type, amount_cents, payment_method, member_id,
            business_date, operator_id, remark)
         VALUES ($1,'refund',$2,$3,$4,CURRENT_DATE,$5,$6)`,
        [flowNo, -refundCents, refundMethod, memberId, operatorId, `退卡：${reason.trim()}`]
      );
    }

    // 作废权益
    await client.query(
      `UPDATE members
          SET card_type = NULL, card_started_at = NULL, card_expires_at = NULL,
              card_order_id = NULL, card_used_count = 0,
              card_frozen = false, card_frozen_reason = NULL, card_frozen_at = NULL,
              row_version = row_version + 1
        WHERE id = $1`,
      [memberId]
    );

    // 卡权益流水
    await client.query(
      `INSERT INTO card_records
         (member_id, action, card_type, started_at, expires_at, amount_cents,
          refund_method, reason, operator_id)
       VALUES ($1,'refund',$2,$3,$4,$5,$6,$7,$8)`,
      [memberId, cardType, startedAt, expiresAt, refundCents, refundMethod, reason.trim(), operatorId]
    );

    await writeAudit(client, {
      actorId: operatorId,
      action: 'member.refund_card',
      targetType: 'member',
      targetId: memberId,
      before: { cardType, startedAt, expiresAt },
      after: { cardType: null, refundCents, refundMethod, reason },
      summary: `退卡（${cardTypeName(cardType)}），退款 ¥${(refundCents / 100).toFixed(2)}：${reason.trim()}`,
    });

    return { refundCents, flowNo, cardType };
  });
}

/** 冻结 / 解冻卡权益。冻结不退款，卡的信息保留。 */
export async function setCardFrozen(params: {
  memberId: number;
  frozen: boolean;
  reason?: string;
  operatorId: number;
}): Promise<{ frozen: boolean; cardType: string }> {
  const { memberId, frozen, operatorId } = params;

  return withTransaction(async (client) => {
    const { rows } = await client.query(
      `SELECT id, card_type, card_frozen FROM members WHERE id = $1 FOR UPDATE`,
      [memberId]
    );
    if (rows.length === 0) throw new MemberError('会员不存在');
    const m = rows[0];

    if (!m.card_type) throw new MemberError('该会员当前没有卡');
    if (Boolean(m.card_frozen) === frozen) {
      throw new MemberError(frozen ? '该卡已经处于冻结状态' : '该卡未被冻结');
    }
    if (frozen && !params.reason?.trim()) throw new MemberError('冻结必须填写原因');

    const reason = params.reason?.trim() || null;

    await client.query(
      `UPDATE members
          SET card_frozen = $1, card_frozen_reason = $2,
              card_frozen_at = CASE WHEN $1 THEN now() ELSE NULL END,
              row_version = row_version + 1
        WHERE id = $3`,
      [frozen, frozen ? reason : null, memberId]
    );

    await client.query(
      `INSERT INTO card_records
         (member_id, action, card_type, reason, operator_id)
       VALUES ($1,$2,$3,$4,$5)`,
      [memberId, frozen ? 'freeze' : 'unfreeze', m.card_type, reason, operatorId]
    );

    await writeAudit(client, {
      actorId: operatorId,
      action: frozen ? 'member.freeze_card' : 'member.unfreeze_card',
      targetType: 'member',
      targetId: memberId,
      after: { frozen, reason },
      summary: frozen ? `冻结卡权益：${reason}` : '解冻卡权益',
    });

    return { frozen, cardType: m.card_type as string };
  });
}

/** 卡类型的中文名 */
function cardTypeName(t: string): string {
  return { week: '周卡', month: '月卡', day: '日卡' }[t] ?? t;
}

/** 查某会员的卡权益流水 */
export async function getCardRecords(memberId: number) {
  return withTransaction(async (client) => {
    const { rows } = await client.query(
      `SELECT c.id, c.action, c.card_type, c.started_at, c.expires_at,
              c.amount_cents::bigint AS amount_cents, c.refund_method, c.reason,
              c.created_at, u.display_name AS operator_name
         FROM card_records c
         LEFT JOIN users u ON u.id = c.operator_id
        WHERE c.member_id = $1
        ORDER BY c.id DESC`,
      [memberId]
    );
    return rows.map((r) => ({
      id: Number(r.id),
      action: r.action as string,
      cardType: (r.card_type as string) ?? null,
      startedAt: toDateString(r.started_at),
      expiresAt: toDateString(r.expires_at),
      amountCents: Number(r.amount_cents),
      refundMethod: (r.refund_method as string) ?? null,
      reason: (r.reason as string) ?? '',
      operatorName: (r.operator_name as string) ?? '',
      createdAt: r.created_at,
    }));
  });
}

/** 待办提醒：即将到期或今天生日的会员 */
export async function getMemberReminders(withinDays = 3) {
  return withTransaction(async (client) => {
    const { rows } = await client.query(
      `SELECT id, member_no, nickname, phone_tail, card_type, card_expires_at,
              (card_expires_at - CURRENT_DATE) AS days_left
         FROM members
        WHERE status = 'active'
          AND card_expires_at IS NOT NULL
          AND card_expires_at >= CURRENT_DATE
          AND card_expires_at <= CURRENT_DATE + $1::int
        ORDER BY card_expires_at`,
      [withinDays]
    );
    return rows.map((r) => ({
      id: Number(r.id),
      memberNo: r.member_no as string,
      nickname: r.nickname as string,
      phoneTail: (r.phone_tail as string) ?? null,
      displayName: [r.nickname, r.phone_tail].filter(Boolean).join(' · '),
      cardType: r.card_type as string,
      cardExpiresAt: toDateString(r.card_expires_at),
      daysLeft: Number(r.days_left),
    }));
  });
}
