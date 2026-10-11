/**
 * 权益核心逻辑：办卡（新办 / 累加 / 顺延 / 重算）与激活。
 *
 * 【为什么单独抽一层】
 *   办卡有两个入口：
 *     ① 会员详情页「办卡」
 *     ② 开台页选周卡（顾客当场办卡，办完立刻开台）
 *   两者必须产生**完全相同**的权益效果 —— 同一个产品，不管从哪个入口买，
 *   都是同一份卡权益。早前开台页把周卡当「普通套餐」处理，
 *   结果顾客花了 ¥188 却没有拿到权益，这是错的。
 *
 *   因此把「算日期 + 生成订单 + 授予权益」收在这一处，两个入口都调它。
 *   调用方负责开事务 —— 开台页买卡需要和开台同事务，避免钱收了台没开。
 */
import type pg from 'pg';
import { writeAudit } from './audit.js';
import {
  toDateString, shopToday, addDaysStr, cardExpiryFrom, isCardExpired,
} from '../lib/dates.js';

/** 权益操作失败（卡种不存在、会员停用等），对外映射为 400 */
export class CardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CardError';
  }
}

export interface GrantCardParams {
  memberId: number;
  productId: number;
  /** 兜底卡种；一般由产品自身的 card_type 决定，无需传 */
  cardType?: 'week' | 'month' | 'day';
  paymentMethod: 'cash' | 'wechat' | 'alipay' | 'other';
  operatorId: number;
  note?: string;
}

export interface GrantCardResult {
  orderId: number;
  orderNo: string;
  flowNo: string;
  priceCents: number;
  productName: string;
  /** 本期起始日；未激活时为 null */
  startedAt: string | null;
  /** 本期到期日；未激活时为 null */
  expiresAt: string | null;
  /** 未激活时累计的待生效天数 */
  pendingDays: number;
  /** 本次操作后该会员是否已激活 */
  activated: boolean;
}

/** 当日订单号：O + YYYYMMDD + 4 位序号 */
async function nextOrderNo(client: pg.PoolClient): Promise<string> {
  const { rows } = await client.query(
    'SELECT COUNT(*)::int AS c FROM orders WHERE completed_at::date = CURRENT_DATE'
  );
  const d = new Date();
  const ymd = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  return `O${ymd}${String((rows[0].c as number) + 1).padStart(4, '0')}`;
}

/** 当日流水号：F + YYYYMMDD + 4 位序号 */
async function nextFlowNo(client: pg.PoolClient): Promise<string> {
  const { rows } = await client.query(
    'SELECT COUNT(*)::int AS c FROM revenue_ledger WHERE created_at::date = CURRENT_DATE'
  );
  const d = new Date();
  const ymd = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  return `F${ymd}${String((rows[0].c as number) + 1).padStart(4, '0')}`;
}

/**
 * 办卡：收钱 + 授予权益。不负责开台（开台由调用方决定）。
 */
export async function grantCard(
  client: pg.PoolClient,
  params: GrantCardParams
): Promise<GrantCardResult> {
  const { memberId, productId, cardType, paymentMethod, operatorId } = params;

  // ---- 会员（锁定，防止并发办卡算错天数）----
  const { rows: mrows } = await client.query(
    `SELECT id, member_no, nickname, card_type, card_started_at, card_expires_at,
            card_pending_days, card_activated_at, status
       FROM members WHERE id = $1 FOR UPDATE`,
    [memberId]
  );
  if (mrows.length === 0) throw new CardError('会员不存在');
  if (mrows[0].status !== 'active') throw new CardError('该会员已停用');

  // ---- 卡种 ----
  const { rows: prows } = await client.query(
    `SELECT id, name, category, price_cents::bigint AS price_cents, card_valid_days, card_type
       FROM products WHERE id = $1 AND is_active = true`,
    [productId]
  );
  if (prows.length === 0) throw new CardError('卡种不存在或已下架');
  const product = prows[0];
  if (product.category !== 'card') throw new CardError('所选项目不是卡种');

  const days = Number(product.card_valid_days ?? (cardType === 'month' ? 30 : 7));
  const price = Number(product.price_cents);

  // ---- 权益流转（四种情况）----
  //   ① 没有卡          → 新办，进入「未激活」，待生效天数 = 本次天数
  //   ② 有卡种但未激活  → 天数累加（未激活的卡永久有效，不限激活期限）
  //   ③ 本期生效中      → 顺延：新一期紧接原到期日的次日，不重叠也不浪费
  //   ④ 已过期          → 重新起算：从今天开始
  const today = shopToday();
  const oldType = (mrows[0].card_type as string | null) ?? null;
  const oldStarted = toDateString(mrows[0].card_started_at);
  const oldExpires = toDateString(mrows[0].card_expires_at);
  const oldPending = Number(mrows[0].card_pending_days ?? 0);

  const newType = (product.card_type as string | null) ?? oldType ?? cardType;
  let newStarted: string | null;
  let newExpires: string | null;
  let newPending = 0;

  if (oldType === null) {
    // ① 新办 → 未激活
    newStarted = null;
    newExpires = null;
    newPending = days;
  } else if (oldStarted === null) {
    // ② 未激活状态下再办 → 累加
    newStarted = null;
    newExpires = null;
    newPending = oldPending + days;
  } else if (oldExpires !== null && oldExpires >= today) {
    // ③ 本期还在有效期内 → 顺延
    newStarted = addDaysStr(oldExpires, 1);
    newExpires = cardExpiryFrom(newStarted, days);
  } else {
    // ④ 已过期 → 从今天重新起算
    newStarted = today;
    newExpires = cardExpiryFrom(today, days);
  }

  // ---- 订单 ----
  const orderNo = await nextOrderNo(client);
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

  // ---- 收入流水 ----
  const flowNo = await nextFlowNo(client);
  await client.query(
    `INSERT INTO revenue_ledger
       (flow_no, flow_type, amount_cents, payment_method, member_id, order_id,
        business_date, operator_id, remark)
     VALUES ($1,'card_purchase',$2,$3,$4,$5,CURRENT_DATE,$6,$7)`,
    [flowNo, price, paymentMethod, memberId, orderId, operatorId, `办理 ${product.name}`]
  );

  // ---- 授予权益 ----
  // card_activated_at 只在「新办」时清空；续卡/累加保留原激活时间（历史事实）
  await client.query(
    `UPDATE members
        SET card_type = $1,
            card_started_at = $2,
            card_expires_at = $3,
            card_pending_days = $4,
            card_activated_at = CASE WHEN $5::boolean THEN NULL ELSE card_activated_at END,
            card_order_id = $6,
            card_frozen = false, card_frozen_reason = NULL, card_frozen_at = NULL,
            row_version = row_version + 1
      WHERE id = $7`,
    [newType, newStarted, newExpires, newPending, oldType === null, orderId, memberId]
  );

  // ---- 权益流水（只追加，用于追溯每期权益）----
  await client.query(
    `INSERT INTO card_records
       (member_id, action, card_type, started_at, expires_at, amount_cents, order_id, operator_id, reason)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [
      memberId,
      oldType === null ? 'issue' : 'renew',
      newType, newStarted, newExpires, price, orderId, operatorId,
      params.note ?? '',
    ]
  );

  // ---- 审计 ----
  const validDesc = newStarted !== null
    ? `有效期 ${newStarted} 至 ${newExpires}`
    : `未激活，待生效 ${newPending} 天（首次用卡开台时才开始计算）`;
  await writeAudit(client, {
    actorId: operatorId,
    action: 'member.purchase_card',
    targetType: 'member',
    targetId: memberId,
    after: {
      cardType: newType, startedAt: newStarted, expiresAt: newExpires,
      pendingDays: newPending, price, orderNo,
    },
    summary: `办理 ${product.name}，${validDesc}`,
  });

  return {
    orderId, orderNo, flowNo, priceCents: price,
    productName: product.name as string,
    startedAt: newStarted,
    expiresAt: newExpires,
    pendingDays: newPending,
    activated: newStarted !== null,
  };
}

/**
 * 激活权益（首次用卡开台时调用）。
 *
 *   未激活 → 写入本期起止：起始 = 今天，到期 = 今天 + 待生效天数 - 1，并清零待生效天数。
 *   已激活 → 原样返回，不做改动。
 *
 * 这样「办卡后一直不来」不会白流天数 —— 计时从第一次真正使用开始。
 */
export async function activateCard(
  client: pg.PoolClient,
  memberId: number
): Promise<{ startedAt: string; expiresAt: string; justActivated: boolean }> {
  const { rows } = await client.query(
    `SELECT card_started_at, card_expires_at, card_pending_days
       FROM members WHERE id = $1 FOR UPDATE`,
    [memberId]
  );
  if (rows.length === 0) throw new CardError('会员不存在');
  const row = rows[0];

  const existingStart = toDateString(row.card_started_at);
  if (existingStart !== null) {
    // 已激活：过期的不允许核销。
    // 未激活的卡不走这里 —— 它没有到期日，第一次使用本身就是激活。
    if (isCardExpired(row.card_expires_at)) {
      throw new CardError('该会员的卡已过期');
    }
    return {
      startedAt: existingStart,
      expiresAt: toDateString(row.card_expires_at) ?? existingStart,
      justActivated: false,
    };
  }

  const pendingDays = Number(row.card_pending_days ?? 0);
  if (pendingDays <= 0) {
    throw new CardError('这张卡没有可用的天数，请先办理');
  }
  const startedAt = shopToday();
  const expiresAt = cardExpiryFrom(startedAt, pendingDays);

  await client.query(
    `UPDATE members
        SET card_started_at = $1, card_expires_at = $2,
            card_pending_days = 0, card_activated_at = now(),
            row_version = row_version + 1
      WHERE id = $3`,
    [startedAt, expiresAt, memberId]
  );

  return { startedAt, expiresAt, justActivated: true };
}
