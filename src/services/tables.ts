/**
 * 工位服务：开台、结账、换套餐、看板
 *
 * 核心流程：
 *   开台  → 占用工位，开始计时
 *   结账  → 计算时长/超时/折扣，生成订单与流水，释放工位
 *
 * 计时与超时规则（可配置）：
 *   - 只有 timed（限时）类套餐计时并适用超时
 *   - 超时按"每满 N 分钟加收 M 元"计档
 *   - 不足一档的零头默认不计费（overtime_full_unit_only = true）
 */
import type pg from 'pg';
import { withTransaction } from '../lib/db.js';
import { applyBp, type Cents } from '../lib/money.js';
import { writeAudit } from './audit.js';
import {
  toDateString, shopToday, cardExpiryFrom, isCardExpired,
} from '../lib/dates.js';
import { grantCard, activateCard, type GrantCardResult } from './cards.js';

export class TableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TableError';
  }
}

export interface PricingConfig {
  discount_days: number[];
  discount_rate_bp: number;
  /** 提前多少分钟在看板提醒 */
  remind_before_minutes: number;

  /**
   * 超时阶梯计费（经店主确认）：
   *   超时 1 – base_minutes 分钟  → 收 base_fee_cents（打底）
   *   之后每满 step_minutes 分钟  → 加收 step_fee_cents
   *   不足一段时：round_up 为 true 则按一段算
   *
   * 例（base = 20 分钟 / ¥5，step = 10 分钟 / ¥1.88）：
   *   超时 15 分钟 → ¥5.00
   *   超时 20 分钟 → ¥5.00
   *   超时 25 分钟 → ¥6.88
   *   超时 45 分钟 → ¥10.64
   */
  overtime_base_minutes: number;
  overtime_base_fee_cents: number;
  overtime_step_minutes: number;
  overtime_step_fee_cents: number;
  overtime_round_up: boolean;
}

export interface ShopConfig {
  name: string;
  business_hours: string;
  timezone: string;
  member_no_prefix: string;
}

const DEFAULT_PRICING: PricingConfig = {
  discount_days: [8, 18, 28],
  discount_rate_bp: 8000,
  remind_before_minutes: 15,
  overtime_base_minutes: 20,
  overtime_base_fee_cents: 500,
  overtime_step_minutes: 10,
  overtime_step_fee_cents: 188,
  overtime_round_up: true,
};

/** 读取计价配置 */
export async function getPricingConfig(client: pg.PoolClient): Promise<PricingConfig> {
  const { rows } = await client.query(`SELECT value FROM settings WHERE key = 'pricing'`);
  if (rows.length === 0) return DEFAULT_PRICING;
  return { ...DEFAULT_PRICING, ...(rows[0].value as Partial<PricingConfig>) };
}

export async function getShopConfig(client: pg.PoolClient): Promise<ShopConfig> {
  const { rows } = await client.query(`SELECT value FROM settings WHERE key = 'shop'`);
  const fallback: ShopConfig = {
    name: '请拼豆', business_hours: '10:00-23:00',
    timezone: 'Asia/Shanghai', memberNoPrefix: 'PD',
  } as unknown as ShopConfig;
  if (rows.length === 0) return fallback;
  return { ...fallback, ...(rows[0].value as Partial<ShopConfig>) };
}

/** 判断某天是否为打折日（按门店时区的自然日） */
export function isDiscountDay(date: Date, cfg: PricingConfig, timeZone = 'Asia/Shanghai'): boolean {
  const day = Number(
    new Intl.DateTimeFormat('en-CA', { timeZone, day: '2-digit' }).format(date)
  );
  return cfg.discount_days.includes(day);
}

/**
 * 日期工具集中在 lib/dates.ts，办卡与开台共用同一套口径。
 * 这里 re-export，保持既有 `from './tables.js'` 的引用不受影响。
 */
export {
  toDateString, shopToday, addDaysStr, cardExpiryFrom, isCardExpired,
} from '../lib/dates.js';

/**
 * 计算已进行的分钟数。
 *
 * 【必须用 floor，不能用 round】
 *   顾客买 60 分钟套餐，实际用了 60 分 30 秒：
 *     floor → 60 分钟 → 未超时 → 不收超时费
 *     round → 61 分钟 → 超时 1 分 → 收 ¥5.00
 *   四舍五入会让超时费提前 30 秒触发，顾客当面问"我明明没超一小时"时没法解释。
 *   统一向下取整，与"满 60 秒才算 1 分钟"的常识一致。
 *
 * 看板、预览、结账三处共用本函数，避免口径再次分叉。
 */
export function elapsedMinutes(startedAt: Date | string, now: Date): number {
  const start = startedAt instanceof Date ? startedAt : new Date(startedAt);
  return Math.max(0, Math.floor((now.getTime() - start.getTime()) / 60_000));
}

export interface ResolvedAddon {
  id: number;
  name: string;
  price: number;
  qty: number;
}

/**
 * 解析加购项，供「预览」与「结账」共用。
 *
 * 【为什么必须共用】
 *   早先预览与结账各写了一份解析逻辑，且过滤条件不同：
 *     预览：WHERE ... AND category='addon' AND is_active  → 无效项静默忽略
 *     结账：WHERE ... AND is_active                       → 无效项直接报错
 *   当店员勾好加购项后管理员恰好下架了它，预览会少算这一项、
 *   显示的应收比实际收的少 —— 店员按低报价收钱，就是实实在在的少收。
 *   共用一份实现后，两个接口对同一份输入必然给出相同结论。
 *
 * 数量做法：
 *   · 同一 id 重复提交先合并
 *   · 合并后仍要求 1–99 件，超出直接报错（不静默截断，截断等于悄悄改价）
 *
 * 校验失败一律抛 TableError，预览与结账都会转成 400 反馈给店员。
 */
export async function resolveAddons(
  client: pg.PoolClient,
  items: Array<{ id: number; qty: number }> | undefined
): Promise<{
  details: ResolvedAddon[];
  totalCents: number;
  discountableCents: number;
}> {
  const details: ResolvedAddon[] = [];
  let totalCents = 0;
  let discountableCents = 0;

  if (!items || items.length === 0) return { details, totalCents, discountableCents };

  // 合并同 id 的数量
  const qtyById = new Map<number, number>();
  for (const it of items) {
    if (!Number.isInteger(it.id) || it.id <= 0) throw new TableError('加购项编号不正确');
    if (!Number.isInteger(it.qty) || it.qty <= 0) continue;   // 0 或负数视为未选
    qtyById.set(it.id, (qtyById.get(it.id) ?? 0) + it.qty);
  }
  if (qtyById.size === 0) return { details, totalCents, discountableCents };

  // 按 id 查全部字段（不限定 category/is_active），
  // 这样"已下架"与"不是加购项"能给出不同且准确的提示
  const { rows } = await client.query(
    `SELECT id, name, price_cents::bigint AS price_cents, category, discountable, is_active
       FROM products WHERE id = ANY($1::bigint[])`,
    [[...qtyById.keys()]]
  );

  const found = new Map<number, (typeof rows)[number]>();
  for (const r of rows) found.set(Number(r.id), r);

  for (const [id, qty] of qtyById) {
    const p = found.get(id);
    if (!p) throw new TableError('部分加购项不存在，请重新选择');
    if (p.category !== 'addon') throw new TableError(`「${p.name}」不是加购项`);
    if (p.is_active === false) throw new TableError(`加购项「${p.name}」已下架，请重新选择`);
    if (qty > 99) throw new TableError(`加购项「${p.name}」数量超出上限（最多 99 件）`);

    const price = Number(p.price_cents);
    const line = price * qty;
    totalCents += line;
    if (p.discountable) discountableCents += line;
    details.push({ id, name: p.name as string, price, qty });
  }

  return { details, totalCents, discountableCents };
}

/**
 * 计算超时费用（阶梯式）。
 *
 * 规则（经店主确认）：
 *   超时 1 – baseMinutes 分钟   → baseFee（打底，超一分钟就收）
 *   之后每满 stepMinutes 分钟   → 加收 stepFee
 *   不足一段：roundUp 为 true 按一段算，否则不计
 *
 * 返回结果为整数分。
 *
 * 换算示例（base=20/¥5，step=10/¥1.88，roundUp=true）：
 *   超时 15 → 500        超时 20 → 500
 *   超时 21 → 688        超时 30 → 688
 *   超时 31 → 876        超时 45 → 1064
 */
export function calcOvertimeFee(params: {
  actualMinutes: number;
  productMinutes: number | null;
  cfg: PricingConfig;
}): { overtimeMinutes: number; stepUnits: number; feeCents: number } {
  const { actualMinutes, productMinutes, cfg } = params;

  // 不限时套餐（限板、日卡）或未设时长 → 无超时
  if (productMinutes === null || productMinutes <= 0) {
    return { overtimeMinutes: 0, stepUnits: 0, feeCents: 0 };
  }

  const overtimeMinutes = actualMinutes - productMinutes;
  if (overtimeMinutes <= 0) {
    return { overtimeMinutes: 0, stepUnits: 0, feeCents: 0 };
  }

  const baseFee = Math.max(0, cfg.overtime_base_fee_cents ?? 500);
  const baseMinutes = Math.max(1, cfg.overtime_base_minutes ?? 20);
  const stepMinutes = Math.max(1, cfg.overtime_step_minutes ?? 10);
  const stepFee = Math.max(0, cfg.overtime_step_fee_cents ?? 188);
  const roundUp = cfg.overtime_round_up !== false;

  // 未超过打底区间：只收打底费
  if (overtimeMinutes <= baseMinutes) {
    return { overtimeMinutes, stepUnits: 0, feeCents: baseFee };
  }

  const beyond = overtimeMinutes - baseMinutes;
  const stepUnits = roundUp ? Math.ceil(beyond / stepMinutes) : Math.floor(beyond / stepMinutes);

  return {
    overtimeMinutes,
    stepUnits,
    feeCents: baseFee + stepUnits * stepFee,
  };
}

/** 生成订单号 */
async function nextOrderNo(client: pg.PoolClient): Promise<string> {
  const { rows } = await client.query(
    `SELECT COUNT(*)::int AS c FROM orders WHERE completed_at::date = CURRENT_DATE`
  );
  const d = new Date();
  const ymd = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  return `O${ymd}${String((rows[0].c as number) + 1).padStart(4, '0')}`;
}

/** 生成流水号 */
async function nextFlowNo(client: pg.PoolClient): Promise<string> {
  const { rows } = await client.query(
    `SELECT COUNT(*)::int AS c FROM revenue_ledger WHERE created_at::date = CURRENT_DATE`
  );
  const d = new Date();
  const ymd = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  return `F${ymd}${String((rows[0].c as number) + 1).padStart(4, '0')}`;
}

// ===========================================================================
// 开台
// ===========================================================================
export interface OpenTableInput {
  tableId: number;
  /**
   * 本次开台占用的「附加桌位」（不含 tableId）。
   *
   * 用于双人套餐：两个人各坐一张单人工位，但买的是一个套餐、
   * 一次结账、一次超时费。因此仍然只创建一个会话，只是多占几张桌子。
   * tableId 视为主台（换套餐、看板带出顾客信息以它为准）。
   */
  extraTableIds?: number[];
  memberId: number | null;
  guestName?: string | null;
  /**
   * 套餐 ID。
   * 用卡核销时不需要套餐（卡是全天不限时的通行权益），此时可省略。
   */
  productId?: number | null;
  operatorId: number;
  /** 是否用会员卡核销（周卡/月卡/日卡） */
  useCard?: boolean;
  /**
   * 同时办一张卡（产品 ID），办完立刻用这张卡开台。
   *
   * 这是「开台页选周卡」的入口：顾客当场办卡并开台，一个动作完成。
   * 关键：办卡走的是与会员详情页「办卡」**完全相同**的 grantCard 实现，
   * 因此同一个产品不管从哪个入口买，得到的权益都一致 ——
   * 不会出现"在开台页买的周卡变成普通套餐、顾客花了钱却没有权益"。
   */
  cardProductId?: number | null;
  /** 同时办卡时的收款方式，默认现金 */
  cardPaymentMethod?: 'cash' | 'wechat' | 'alipay' | 'other';
  note?: string;
}

export async function openTable(input: OpenTableInput): Promise<{
  sessionId: number;
  tableName: string;
  /** 本次占用的全部桌位名（第一个是主台），用于提示与看板 */
  tableNames: string[];
  productName: string;
  startedAt: Date;
  expectedEndAt: Date | null;
  useCard: boolean;
  cardStartedAt: string | null;
  cardExpiresAt: string | null;
  /** 本次同时办卡的结果（订单号、实收等），未办卡为 null */
  boughtCard: GrantCardResult | null;
}> {
  const { tableId, memberId, productId, operatorId } = input;

  // 本次占用的全部桌位：主台 + 附加台，去重、去无效值。
  // 排序后统一锁，避免两个并发开台以不同顺序锁同一批桌位而死锁。
  const allTableIds = Array.from(
    new Set([tableId, ...(input.extraTableIds ?? [])].filter((n) => Number.isInteger(n) && n > 0))
  ).sort((a, b) => a - b);
  if (allTableIds.length > 4) throw new TableError('一次最多占用 4 个台');

  return withTransaction(async (client) => {
    // 桌位必须都可用（按 id 升序锁，避免死锁）
    const { rows: trows } = await client.query(
      `SELECT id, name, status, is_active FROM tables
        WHERE id = ANY($1::bigint[]) ORDER BY id FOR UPDATE`,
      [allTableIds]
    );
    if (trows.length !== allTableIds.length) throw new TableError('有桌位不存在');
    for (const t of trows) {
      if (!t.is_active) throw new TableError(`${t.name} 已停用`);
      if (t.status === 'maintenance') throw new TableError(`${t.name} 正在维护中`);
    }

    // 桌位不能已被别的活跃会话占用。
    // 走 session_tables（一个会话可能占多个台），不是只看 table_sessions.table_id。
    const { rows: busy } = await client.query(
      `SELECT t.name FROM session_tables st
         JOIN table_sessions ts ON ts.id = st.session_id
         JOIN tables t ON t.id = st.table_id
        WHERE st.table_id = ANY($1::bigint[]) AND ts.status = 'active'`,
      [allTableIds]
    );
    if (busy.length > 0) {
      throw new TableError(`${busy.map((b) => b.name).join('、')} 正在使用中`);
    }

    const table = trows.find((t) => Number(t.id) === tableId) ?? trows[0];

    // 会员校验
    let memberRow: {
      id: number;
      card_type: string | null;
      card_started_at: string | null;
      card_expires_at: string | null;
      card_pending_days: number;
    } | null = null;
    if (memberId !== null) {
      const { rows } = await client.query(
        `SELECT id, card_type, card_started_at, card_expires_at,
                card_pending_days, status
           FROM members WHERE id = $1 FOR UPDATE`,
        [memberId]
      );
      if (rows.length === 0) throw new TableError('会员不存在');
      if (rows[0].status !== 'active') throw new TableError('该会员已停用');
      memberRow = rows[0];

      // 该会员不能已经在别处开台（可能占多台，把台名一起列出来）
      const { rows: mBusy } = await client.query(
        `SELECT string_agg(t.name, '、' ORDER BY st.is_primary DESC, t.id) AS names
           FROM table_sessions ts
           JOIN session_tables st ON st.session_id = ts.id
           JOIN tables t ON t.id = st.table_id
          WHERE ts.member_id = $1 AND ts.status = 'active'`,
        [memberId]
      );
      if (mBusy.length > 0 && mBusy[0].names) {
        throw new TableError(`该会员已在 ${mBusy[0].names} 开台，请先结账`);
      }
    } else {
      // 散客必须有称呼，便于店员喊人。
      // 这里提前校验，避免直接撞数据库约束而抛出难以理解的错误。
      const guest = input.guestName?.trim();
      if (!guest) throw new TableError('散客开台需要填写称呼');
      if (guest.length > 20) throw new TableError('称呼不能超过 20 个字');
    }

    // ---- 同时办卡：先授予权益，随后立刻用这张卡开台 ----
    //
    // 这是「开台页选周卡」的路径。关键是办卡走 grantCard ——
    // 与会员详情页「办卡」同一份实现，所以两个入口买同一个产品，
    // 得到的权益完全一致（不会变成"花 ¥188 买了个普通套餐"）。
    //
    // 与开台同事务：要么都成功、要么都回滚，
    // 不会出现「钱收了、台没开」或「台开了、权益没给」。
    let boughtCard: GrantCardResult | null = null;
    if (input.cardProductId != null) {
      if (memberId === null) throw new TableError('散客无法办卡，请先建立会员');
      boughtCard = await grantCard(client, {
        memberId,
        productId: input.cardProductId,
        paymentMethod: input.cardPaymentMethod ?? 'cash',
        operatorId,
      });
    }

    // ---- 用卡核销 ----
    // 刚办完卡的会员此时是「未激活」状态，下面这一步就是这张卡的第一次使用。
    const useCard = Boolean(input.useCard) || boughtCard !== null;
    let cardStartedAt: string | null = null;
    let cardExpiresAt: string | null = null;
    if (useCard) {
      if (memberId === null) throw new TableError('散客无法使用卡权益');

      const { rows: frows } = await client.query(
        'SELECT card_type, card_frozen, card_frozen_reason FROM members WHERE id = $1',
        [memberId]
      );
      if (!frows[0]?.card_type) throw new TableError('该会员没有有效的卡');
      if (frows[0].card_frozen) {
        const why = frows[0].card_frozen_reason ? `（${frows[0].card_frozen_reason}）` : '';
        throw new TableError(`该卡已被冻结${why}，无法核销`);
      }

      // 未激活 → 此刻激活并写入本期起止；已激活 → 校验是否过期
      const act = await activateCard(client, memberId, operatorId);
      cardStartedAt = act.startedAt;
      cardExpiresAt = act.expiresAt;
    }

    // 套餐：用卡核销时不需要套餐（卡是全天不限时的通行权益）
    let product: {
      id: number | null; name: string | null; price_cents: number;
      duration_minutes: number | null;
    } | null = null;

    if (!useCard) {
      const { rows: prows } = await client.query(
        `SELECT id, name, category, price_cents::bigint AS price_cents,
                duration_minutes, card_type, card_valid_days
           FROM products WHERE id = $1 AND is_active = true`,
        [productId]
      );
      if (prows.length === 0) throw new TableError('套餐不存在或已下架');
      product = {
        id: Number(prows[0].id),
        name: prows[0].name as string,
        price_cents: Number(prows[0].price_cents),
        duration_minutes: prows[0].duration_minutes as number | null,
      };
    }

    // 预计结束时间：
    //   · 用卡核销 → 不设结束时间（当天可一直玩，不产生超时）
    //   · 限时套餐 → 开始时间 + 套餐时长
    //   · 限板/日卡类 → 无结束时间限制
    const startedAt = new Date();
    const expectedEndAt = (!useCard && product?.duration_minutes)
      ? new Date(startedAt.getTime() + product.duration_minutes * 60_000)
      : null;

    const { rows: srows } = await client.query(
      `INSERT INTO table_sessions
         (table_id, member_id, guest_name, product_id, product_name, product_price_cents,
          used_card, card_started_at, card_expires_at, started_at, expected_end_at, opened_by, note)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       RETURNING id, started_at, expected_end_at`,
      [
        tableId, memberId, input.guestName?.trim() || null,
        product?.id ?? null, product?.name ?? null, product?.price_cents ?? null,
        useCard, cardStartedAt, cardExpiresAt, startedAt, expectedEndAt, operatorId, input.note ?? '',
      ]
    );

    // 记录本次占用的所有桌位（双人套餐会有两个台）。
    // 主台 is_primary = true，换套餐与看板展示以它为准。
    for (const tid of allTableIds) {
      await client.query(
        `INSERT INTO session_tables (session_id, table_id, is_primary) VALUES ($1,$2,$3)`,
        [srows[0].id, tid, tid === tableId]
      );
    }

    // 会员到店次数 +1；用卡则核销次数 +1
    if (memberId !== null) {
      await client.query(
        `UPDATE members
            SET visit_count = visit_count + 1,
                card_used_count = card_used_count + CASE WHEN $2 THEN 1 ELSE 0 END,
                row_version = row_version + 1
          WHERE id = $1`,
        [memberId, useCard]
      );
    }

    // 会话名：刚办卡的用卡名（此时 memberRow.card_type 还是办卡前的旧值），
    // 已持有权益的用卡种名。
    const cardLabel = boughtCard
      ? boughtCard.productName
      : (memberRow?.card_type ? cardTypeName(memberRow.card_type) : '权益');
    const sessionLabel = useCard ? `${cardLabel}核销` : product!.name!;

    await writeAudit(client, {
      actorId: operatorId,
      action: 'table.open',
      targetType: 'table_session',
      targetId: Number(srows[0].id),
      after: {
        table: table.name, product: product?.name ?? null,
        memberId, guestName: input.guestName, useCard, cardStartedAt, cardExpiresAt,
        boughtCard: boughtCard
          ? { orderNo: boughtCard.orderNo, productName: boughtCard.productName, priceCents: boughtCard.priceCents }
          : null,
      },
      summary: `开台 ${table.name} · ${sessionLabel}`
        + (boughtCard ? ` · 同时办卡 ${boughtCard.productName} ¥${(boughtCard.priceCents / 100).toFixed(2)}` : '')
        + (useCard ? `（权益 ${cardStartedAt} 至 ${cardExpiresAt}）` : ''),
    });

    return {
      sessionId: Number(srows[0].id),
      tableName: table.name as string,
      tableNames: trows.map((t) => t.name as string),
      productName: sessionLabel,
      startedAt: srows[0].started_at as Date,
      expectedEndAt: srows[0].expected_end_at as Date | null,
      useCard,
      cardStartedAt,
      cardExpiresAt,
      boughtCard,
    };
  });
}

/** 卡类型的中文名 */
function cardTypeName(t: string): string {
  return { week: '周卡', month: '月卡', day: '日卡' }[t] ?? '卡';
}

// ===========================================================================
// 换套餐（加钟 / 升档）
// ===========================================================================
export async function changeSessionProduct(params: {
  sessionId: number;
  productId: number;
  operatorId: number;
}): Promise<{ productName: string; expectedEndAt: Date | null }> {
  const { sessionId, productId, operatorId } = params;

  return withTransaction(async (client) => {
    const { rows } = await client.query(
      `SELECT id, table_id, product_id, product_name, started_at, status, expected_end_at
         FROM table_sessions WHERE id = $1 FOR UPDATE`,
      [sessionId]
    );
    if (rows.length === 0) throw new TableError('开台记录不存在');
    const session = rows[0];
    if (session.status !== 'active') throw new TableError('该工位已结账，无法修改');

    const { rows: prows } = await client.query(
      `SELECT id, name, category, price_cents::bigint AS price_cents, duration_minutes
         FROM products WHERE id = $1 AND is_active = true`,
      [productId]
    );
    if (prows.length === 0) throw new TableError('套餐不存在');
    const product = prows[0];

    // 卡类（周卡）是购买后授予的会员权益，不能作为"换套餐"的目标
    if (product.category === 'card') {
      throw new TableError('周卡属于会员权益，不能作为套餐更换');
    }
    if (product.category === 'addon') {
      throw new TableError('加购项不能作为套餐，请在结账时选择');
    }

    // 从原开始时间重新推算结束时间（换套餐不重置计时起点）
    // 限时套餐 → 开始时间 + 时长；限板/日卡 → 不限时，结束时间为空
    const startedAt = new Date(session.started_at);
    const expectedEndAt = product.duration_minutes
      ? new Date(startedAt.getTime() + product.duration_minutes * 60_000)
      : null;

    await client.query(
      `UPDATE table_sessions
          SET product_id = $1, product_name = $2, product_price_cents = $3,
              expected_end_at = $4, overtime_units = 0, overtime_fee_cents = 0
        WHERE id = $5`,
      [productId, product.name, Number(product.price_cents), expectedEndAt, sessionId]
    );

    await writeAudit(client, {
      actorId: operatorId,
      action: 'table.change_product',
      targetType: 'table_session',
      targetId: sessionId,
      before: { product: session.product_name },
      after: { product: product.name },
      summary: `换套餐：${session.product_name} → ${product.name}`,
    });

    return { productName: product.name as string, expectedEndAt };
  });
}

// ===========================================================================
// 结账
// ===========================================================================
export interface SettleSessionInput {
  sessionId: number;
  operatorId: number;
  /**
   * 加购项，带数量。
   * 同一项重复提交会合并数量（如特殊烫 ×2 与 ×1 合并为 ×3）。
   */
  addonItems?: Array<{ id: number; qty: number }>;
  paymentMethod: 'cash' | 'wechat' | 'alipay' | 'card' | 'free' | 'other';
  /** 手动改价（可选，填了就用这个金额，用于特殊情况） */
  overrideTotalCents?: Cents;
  overrideReason?: string;
  note?: string;
  idempotencyKey?: string;
}

/**
 * 暂停计时。
 * 顾客中途离开（吃饭 / 上厕所 / 接电话）时由店员暂停，暂停时段不计费。
 * 同一会话不可重复暂停；已结账 / 已作废的会话也不能暂停。
 */
export async function pauseSession(sessionId: number, operatorId: number): Promise<{ pausedAt: string }> {
  return withTransaction(async (client) => {
    const { rows } = await client.query(
      `UPDATE table_sessions SET paused_at = now()
        WHERE id = $1 AND status = 'active' AND paused_at IS NULL
       RETURNING paused_at`,
      [sessionId]
    );
    if (rows.length === 0) throw new TableError('无法暂停：会话不存在、已结束，或已经处于暂停中');

    await writeAudit(client, {
      actorId: operatorId, action: 'table.pause', targetType: 'table_session',
      targetId: sessionId, summary: '暂停计时',
    });
    return { pausedAt: rows[0].paused_at };
  });
}

/**
 * 恢复计时。
 * 把暂停时长折算进 started_at 与 expected_end_at，让计费自然扣除暂停时段。
 * 例：14:00 开台、14:30 暂停、15:00 恢复 → started_at 变为 14:30，等于只计 30 分钟。
 */
export async function resumeSession(sessionId: number, operatorId: number): Promise<{ startedAt: string; expectedEndAt: string | null }> {
  return withTransaction(async (client) => {
    const { rows } = await client.query(
      `UPDATE table_sessions
          SET started_at = started_at + (now() - paused_at),
              expected_end_at = expected_end_at + (now() - paused_at),
              paused_at = NULL
        WHERE id = $1 AND status = 'active' AND paused_at IS NOT NULL
       RETURNING started_at, expected_end_at`,
      [sessionId]
    );
    if (rows.length === 0) throw new TableError('无法恢复：会话不存在、已结束，或并未处于暂停');

    await writeAudit(client, {
      actorId: operatorId, action: 'table.resume', targetType: 'table_session',
      targetId: sessionId, summary: '恢复计时',
    });
    return {
      startedAt: rows[0].started_at,
      expectedEndAt: rows[0].expected_end_at ? rows[0].expected_end_at : null,
    };
  });
}

/**
 * 取消开台：把进行中的会话作废并释放桌位。
 *
 * 【与「整单作废」的区别】
 *   本函数处理「还没结账」的开台 —— 顾客开台后马上走了、套餐选错了想撤销、
 *   顾客临时不玩了等。不涉及任何金额，只是把会话标记为 voided。
 *   voidOrder 处理的是「已经结账」的订单，会写反向流水冲账。
 *
 *   如果这里发现该开台已经结过账，直接拒绝并提示改用「整单作废」，
 *   避免绕过流水冲账逻辑造成账目不平。
 */
export async function cancelSession(
  sessionId: number,
  operatorId: number,
  reason: string
): Promise<{ ok: true; sessionId: number }> {
  return withTransaction(async (client) => {
    const { rows } = await client.query(
      `SELECT id, table_id, status, product_name, product_price_cents, used_card, started_at
         FROM table_sessions WHERE id = $1 FOR UPDATE`,
      [sessionId]
    );
    if (rows.length === 0) throw new TableError('开台记录不存在');

    const s = rows[0];
    if (s.status !== 'active') {
      throw new TableError(
        s.status === 'settled' ? '这个台已经结账了，请改用「整单作废」' : '这个台已经取消过了'
      );
    }

    // 双保险：即使 status 还是 active，只要已生成有效订单，也必须走订单作废流程
    const { rows: ord } = await client.query(
      `SELECT id FROM orders WHERE table_session_id = $1 AND status <> 'voided' LIMIT 1`,
      [sessionId]
    );
    if (ord.length > 0) throw new TableError('这个台已经结账了，请改用「整单作废」');

    await client.query(
      `UPDATE table_sessions
          SET status = 'voided', ended_at = now(), paused_at = NULL
        WHERE id = $1`,
      [sessionId]
    );
    // 不需要动 tables.status：桌位是否被占用由「是否存在活跃会话」决定
    // （看板通过 session_tables JOIN table_sessions.status='active' 判断）。
    // 早前这里会把 tables.status 改成 'idle'，那会把"维护中"的桌位误改成空闲。

    await writeAudit(client, {
      actorId: operatorId,
      action: 'table.cancel',
      targetType: 'table_session',
      targetId: sessionId,
      before: {
        status: s.status,
        productName: s.product_name,
        productPriceCents: Number(s.product_price_cents),
        usedCard: s.used_card,
        startedAt: s.started_at,
      },
      after: { status: 'voided' },
      summary: `取消开台：${reason}`,
    });

    return { ok: true as const, sessionId };
  });
}

export interface SettleResult {
  orderId: number;
  orderNo: string;
  flowNo: string;
  totalCents: Cents;
  paidCents: Cents;
  productAmountCents: Cents;
  addonAmountCents: Cents;
  overtimeFeeCents: Cents;
  discountCents: Cents;
  /** 其中由人工改价产生的减免 */
  manualAdjustCents: Cents;
  actualMinutes: number;
  overtimeUnits: number;
  isDiscountDay: boolean;
  usedCard: boolean;
}

export async function settleSession(input: SettleSessionInput): Promise<SettleResult> {
  const { sessionId, operatorId } = input;

  return withTransaction(async (client) => {
    // 锁定会话
    const { rows } = await client.query(
      `SELECT ts.*, t.name AS table_name
         FROM table_sessions ts
         JOIN tables t ON t.id = ts.table_id
        WHERE ts.id = $1 FOR UPDATE`,
      [sessionId]
    );
    if (rows.length === 0) throw new TableError('开台记录不存在');
    const session = rows[0];
    if (session.status === 'settled') throw new TableError('该工位已经结账');
    if (session.status === 'voided') throw new TableError('该开台记录已作废');

    // 若还处于暂停中，先把暂停时长折算进 started_at 与 expected_end_at，
    // 再结算。这样下面基于 started_at 的 elapsedMinutes 自然扣掉了暂停时段。
    if (session.paused_at) {
      const { rows: r2 } = await client.query(
        `UPDATE table_sessions
            SET started_at = started_at + (now() - paused_at),
                expected_end_at = expected_end_at + (now() - paused_at),
                paused_at = NULL
          WHERE id = $1 AND paused_at IS NOT NULL
         RETURNING started_at`,
        [sessionId]
      );
      if (r2[0]) session.started_at = r2[0].started_at;
    }

    const cfg = await getPricingConfig(client);
    const now = new Date();
    const startedAt = new Date(session.started_at);
    const actualMinutes = elapsedMinutes(startedAt, now);

    const usedCard = Boolean(session.used_card);
    const productAmount = usedCard ? 0 : Number(session.product_price_cents ?? 0);

    // 套餐信息（判断是否计时、是否可超时、是否打折）
    // 用卡核销的会话没有套餐，因此走默认值；且卡不计超时。
    let product: {
      category: string; duration_minutes: number | null;
      discountable: boolean; overtime_applicable: boolean;
    } = { category: 'card', duration_minutes: null, discountable: false, overtime_applicable: false };

    if (session.product_id) {
      const { rows: prows } = await client.query(
        `SELECT id, name, category, duration_minutes, discountable, overtime_applicable
           FROM products WHERE id = $1`,
        [session.product_id]
      );
      if (prows[0]) {
        product = {
          category: prows[0].category as string,
          duration_minutes: prows[0].duration_minutes as number | null,
          discountable: prows[0].discountable as boolean,
          overtime_applicable: prows[0].overtime_applicable as boolean,
        };
      }
    }

    // ---- 超时计算（阶梯式） ----
    // 用卡核销不计超时（卡是全天不限时的通行权益）
    // 限板 / 日卡套餐的 overtime_applicable 为 false，同样不计
    let overtimeUnits = 0;
    let overtimeFee = 0;
    let overtimeMinutes = 0;
    if (product.overtime_applicable && !usedCard) {
      const ot = calcOvertimeFee({
        actualMinutes,
        productMinutes: product.duration_minutes,
        cfg,
      });
      overtimeUnits = ot.stepUnits;
      overtimeFee = ot.feeCents;
      overtimeMinutes = ot.overtimeMinutes;
    }

    // ---- 加购 ----
    const addonItems = (input.addonItems ?? []).filter((x) => x.qty > 0);
    // 与预览接口共用同一份解析，保证"看到的价"就是"收的价"
    const resolved = await resolveAddons(client, addonItems);
    const addonDetails = resolved.details;
    const addonAmount = resolved.totalCents;
    const addonDiscountableAmount = resolved.discountableCents;

    // ---- 折扣 ----
    // 规则（经店主确认）：
    //   · 打折日 + 该商品可打折 + 未用卡核销
    //   · 套餐与加购项都参与折扣
    //   · 超时费不参与（它是惩罚性收费，不是商品）
    //   · 用卡核销时套餐本身免费，加购仍可打折
    const discountDay = isDiscountDay(now, cfg);
    const discountRate = cfg.discount_rate_bp;

    // 套餐部分
    const productDiscountable = product.discountable && !usedCard;
    const canDiscountProduct = discountDay && productDiscountable;
    const discountedProductAmount = canDiscountProduct
      ? applyBp(productAmount, discountRate)
      : (usedCard ? 0 : productAmount);
    const productDiscountCents = (usedCard ? 0 : productAmount) - discountedProductAmount;

    // 加购部分：与套餐独立判断，用卡核销时加购照样能打折
    const canDiscountAddon = discountDay && addonDiscountableAmount > 0;
    const discountedAddonAmount = canDiscountAddon
      ? applyBp(addonAmount, discountRate)
      : addonAmount;
    const addonDiscountCents = addonAmount - discountedAddonAmount;

    const discountCents = productDiscountCents + addonDiscountCents;
    const canDiscount = canDiscountProduct || canDiscountAddon;

    const computedTotal = Math.max(
      0,
      discountedProductAmount + discountedAddonAmount + overtimeFee
    );

    // ---- 实收调整（熟人折扣 / 抹零 / 找零等） ----
    //
    // 语义：把"应收"与"实收"的差额记成一笔人工优惠，而不是让费用构成对不上。
    // 这样 orders 表始终满足恒等式：
    //     应收 = 套餐 + 加购 + 超时 - 优惠
    //     实收 = 应收
    // 对账永远平，报表也能解释"为什么只收了这么多"。
    //
    // 允许实收高于应收（如顾客给整钱不用找零）。此时差额为负数优惠，
    // 报表上会显示为负值 —— 看着略怪，但账目可追溯，远好过让金额凭空消失。
    let total = computedTotal;
    let manualAdjustCents = 0;
    if (input.overrideTotalCents !== undefined) {
      if (!Number.isSafeInteger(input.overrideTotalCents) || input.overrideTotalCents < 0) {
        throw new TableError('实收金额必须是非负整数分');
      }
      // 差额 = 应收 - 实收。少收为正（优惠），多收为负（加收）
      manualAdjustCents = computedTotal - input.overrideTotalCents;
      total = input.overrideTotalCents;
    }

    // 用卡核销时不应再收钱（除非有加购或人工调整）
    if (usedCard && total > 0 && addonAmount === 0 && input.overrideTotalCents === undefined) {
      throw new TableError('用卡核销时不应产生费用');
    }

    // ---- 写订单 ----
    // 折扣与人工调整分列存储：
    //   discount_cents        打折日优惠，恒 >= 0
    //   manual_adjust_cents   人工调整 = 应收 - 实收，正数少收、负数多收
    // 分开存才能让报表区分"打折日送了多少"与"人情送了多少"，
    // 也才能容纳"顾客给整钱不用找零"这类多收场景（差额为负）。
    const orderDiscountCents = discountCents;
    const manualAdjustCentsFinal = manualAdjustCents;

    const orderNo = await nextOrderNo(client);
    const { rows: orows } = await client.query(
      `INSERT INTO orders (
         order_no, member_id, guest_name, table_session_id, table_name,
         product_amount_cents, addon_amount_cents, overtime_fee_cents, discount_cents,
         manual_adjust_cents,
         total_cents, paid_cents, discount_rate_bp, is_discount_day,
         started_at, ended_at, actual_minutes, overtime_units,
         used_card, payment_method, operator_id, note
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)
       RETURNING id`,
      [
        orderNo, session.member_id, session.guest_name, sessionId, session.table_name,
        usedCard ? 0 : productAmount, addonAmount, overtimeFee, orderDiscountCents,
        manualAdjustCentsFinal,
        total, total,
        canDiscount ? cfg.discount_rate_bp : null, discountDay,
        startedAt, now, actualMinutes, overtimeUnits,
        usedCard, input.paymentMethod, operatorId, input.note ?? '',
      ]
    );
    const orderId = Number(orows[0].id);

    // 明细：套餐 + 加购
    // 用卡核销没有套餐，只留一条 0 元标记，便于统计"卡用了几次"
    let sort = 0;
    if (usedCard) {
      // 从会员身上取卡种名用于明细展示（会话只存了权益到期日）
      let usedCardType = 'week';
      if (session.member_id) {
        const { rows: cm } = await client.query(
          'SELECT card_type FROM members WHERE id = $1', [session.member_id]
        );
        if (cm[0]?.card_type) usedCardType = cm[0].card_type as string;
      }
      await client.query(
        `INSERT INTO order_items (order_id, product_id, name, category, qty,
                                  unit_price_cents, amount_cents, sort_order)
         VALUES ($1,NULL,$2,'card',1,0,0,$3)`,
        [orderId, `${cardTypeName(usedCardType)}核销`, sort++]
      );
    } else {
      await client.query(
        `INSERT INTO order_items (order_id, product_id, name, category, qty,
                                  unit_price_cents, amount_cents, sort_order)
         VALUES ($1,$2,$3,'timed',1,$4,$5,$6)`,
        [orderId, session.product_id, session.product_name, productAmount,
         discountedProductAmount, sort++]
      );
    }
    // 加购明细：数量按实际填写，金额按"单价 × 数量"再打折。
    // 折扣按整行计算后再补取整误差，保证明细合计与订单里的加购金额一致。
    for (const a of addonDetails) {
      const gross = a.price * a.qty;
      const lineAmount = canDiscountAddon ? applyBp(gross, discountRate) : gross;
      await client.query(
        `INSERT INTO order_items (order_id, product_id, name, category, qty,
                                  unit_price_cents, amount_cents, sort_order)
         VALUES ($1,$2,$3,'addon',$4,$5,$6,$7)`,
        [orderId, a.id, a.name, a.qty, a.price, lineAmount, sort++]
      );
    }

    // 加购明细的取整误差补到第一条加购上，确保明细合计等于订单里的加购金额
    if (canDiscountAddon && addonDetails.length > 0) {
      const { rows: sumRows } = await client.query(
        `SELECT COALESCE(SUM(amount_cents), 0)::bigint AS s
           FROM order_items WHERE order_id = $1 AND category = 'addon'`,
        [orderId]
      );
      const listed = Number(sumRows[0].s);
      const diff = discountedAddonAmount - listed;
      if (diff !== 0) {
        await client.query(
          `UPDATE order_items SET amount_cents = amount_cents + $1
            WHERE id = (SELECT id FROM order_items
                         WHERE order_id = $2 AND category = 'addon'
                         ORDER BY sort_order LIMIT 1)`,
          [diff, orderId]
        );
      }
    }
    if (overtimeFee > 0) {
      // 明细写清算法，便于查账时解释"为什么收这么多"
      const desc = overtimeUnits > 0
        ? `超时费（超 ${overtimeMinutes} 分钟：打底 ¥${(cfg.overtime_base_fee_cents / 100).toFixed(2)}` +
          ` + ${overtimeUnits} × ¥${(cfg.overtime_step_fee_cents / 100).toFixed(2)}）`
        : `超时费（超 ${overtimeMinutes} 分钟）`;
      await client.query(
        `INSERT INTO order_items (order_id, product_id, name, category, qty,
                                  unit_price_cents, amount_cents, sort_order)
         VALUES ($1,NULL,$2,'overtime',1,$3,$4,$5)`,
        [orderId, desc, overtimeFee, overtimeFee, sort++]
      );
    }

    // ---- 写收入流水（只追加） ----
    // 金额为 0 的订单（纯卡核销）不产生流水，避免污染对账
    let flowNo = '';
    if (total > 0) {
      flowNo = await nextFlowNo(client);
      await client.query(
        `INSERT INTO revenue_ledger
           (flow_no, flow_type, amount_cents, payment_method, member_id, order_id,
            table_session_id, business_date, operator_id, remark, idempotency_key)
         VALUES ($1,'consume',$2,$3,$4,$5,$6,CURRENT_DATE,$7,$8,$9)`,
        [
          flowNo, total, input.paymentMethod, session.member_id, orderId,
          sessionId, operatorId,
          `${session.table_name} · ${session.product_name}`, input.idempotencyKey ?? null,
        ]
      );
    }

    // ---- 更新会话状态，释放工位 ----
    await client.query(
      `UPDATE table_sessions
          SET status = 'settled', ended_at = $1, actual_minutes = $2,
              overtime_units = $3, overtime_fee_cents = $4, order_id = $5, settled_by = $6
        WHERE id = $7`,
      [now, actualMinutes, overtimeUnits, overtimeFee, orderId, operatorId, sessionId]
    );

    await writeAudit(client, {
      actorId: operatorId,
      action: 'table.settle',
      targetType: 'table_session',
      targetId: sessionId,
      after: {
        orderNo, total, computedTotal, actualMinutes, overtimeUnits,
        usedCard, discountDay: canDiscount,
        // 只要有出入就记录，不论少收还是多收
        ...(manualAdjustCents !== 0
          ? { manualAdjustCents, adjustNote: input.overrideReason ?? '' }
          : {}),
      },
      summary: `结账 ${session.table_name} · ${session.product_name} · ` +
               `${(total / 100).toFixed(2)} 元（${actualMinutes} 分钟）` +
               (manualAdjustCents > 0
                 ? `｜少收 ${(manualAdjustCents / 100).toFixed(2)} 元${input.overrideReason ? '：' + input.overrideReason : ''}`
                 : manualAdjustCents < 0
                   ? `｜多收 ${(-manualAdjustCents / 100).toFixed(2)} 元${input.overrideReason ? '：' + input.overrideReason : ''}`
                   : ''),
    });

    return {
      orderId,
      orderNo,
      flowNo,
      totalCents: total,
      paidCents: total,
      productAmountCents: usedCard ? 0 : productAmount,
      addonAmountCents: addonAmount,
      overtimeFeeCents: overtimeFee,
      // 只含打折日优惠；人工调整单独返回，便于前端区分展示
      discountCents: orderDiscountCents,
      manualAdjustCents: manualAdjustCentsFinal,
      actualMinutes,
      overtimeUnits,
      isDiscountDay: canDiscount,
      usedCard,
    };
  });
}

// ===========================================================================
// 工位看板
// ===========================================================================
export interface TableCard {
  tableId: number;
  tableName: string;
  capacity: number;
  status: 'idle' | 'occupied' | 'maintenance';
  /** 进行中的会话信息 */
  session: {
    sessionId: number;
    memberId: number | null;
    memberNo: string | null;
    displayName: string;
    phoneTail: string | null;
    productName: string;
    category: string;
    startedAt: string;
    expectedEndAt: string | null;
    /** 剩余分钟；负数表示已超时。null 表示不计时 */
    remainingMinutes: number | null;
    /** 已进行分钟 */
    elapsedMinutes: number;
    usedCard: boolean;
    cardType: string | null;
    cardExpiresAt: string | null;
    /** 是否处于暂停计时中 */
    paused: boolean;
    /** 暂停开始时间（未暂停为 null） */
    pausedAt: string | null;
    /**
     * 这一组占用的全部桌位名，如「01号桌、02号桌」。
     * 双人套餐会占两个台，看板据此提示"这一组还占着别的台"。
     */
    groupTableNames: string | null;
    /** 提醒级别 */
    alertLevel: 'normal' | 'warning' | 'overtime';
  } | null;
}

export async function getTableBoard(): Promise<{
  summary: { total: number; occupied: number; idle: number; maintenance: number };
  tables: TableCard[];
  pricing: PricingConfig;
  serverTime: string;
}> {
  return withTransaction(async (client) => {
    const cfg = await getPricingConfig(client);

    const { rows } = await client.query(
      `SELECT t.id, t.name, t.capacity, t.status,
              ts.id AS session_id, ts.member_id, ts.guest_name,
              ts.product_name, ts.started_at, ts.expected_end_at, ts.used_card,
              ts.paused_at,
              m.nickname, m.phone_tail, m.member_no, m.card_type, m.card_expires_at,
              p.category,
              -- 该会话占用的全部桌位（双人套餐会占两个台）。
              -- 每个被占的台都会带出同一份信息，前端据此显示「01号桌、02号桌」。
              (SELECT string_agg(t2.name, '、' ORDER BY st2.is_primary DESC, t2.id)
                 FROM session_tables st2
                 JOIN tables t2 ON t2.id = st2.table_id
                WHERE st2.session_id = ts.id) AS group_table_names
         FROM tables t
         -- 【必须只关联「活跃」的会话】
         --   session_tables 是只增不删的：会话结束后记录仍在，
         --   用于追溯"这一台当时属于哪个会话"。
         --   若直接 LEFT JOIN 全表，一个台有几条历史就会多出几行，
         --   其中只有一行能接上活跃会话，其余行 ts 为 NULL、被当成空闲桌，
         --   于是看板上出现重复的幽灵桌位（曾出现 8 张桌渲染成 11 个卡片）。
         --   这里用子查询先把范围收敛到 active，保证每个台最多一行。
         LEFT JOIN (
           SELECT s.*, st.table_id AS occupied_table_id
             FROM session_tables st
             JOIN table_sessions s ON s.id = st.session_id
            WHERE s.status = 'active'
         ) ts ON ts.occupied_table_id = t.id
         LEFT JOIN members m ON m.id = ts.member_id
         LEFT JOIN products p ON p.id = ts.product_id
        WHERE t.is_active = true
        ORDER BY t.sort_order, t.id`
    );

    const now = Date.now();
    const tables: TableCard[] = rows.map((r) => {
      if (!r.session_id) {
        return {
          tableId: Number(r.id),
          tableName: r.name as string,
          capacity: r.capacity as number,
          status: r.status === 'maintenance' ? 'maintenance' : 'idle',
          session: null,
        };
      }

      // 暂停时倒计时冻结：用「暂停那一刻」作为基准计算已进行/剩余，
      // 前端再根据 paused 显示「已暂停」徽章。
      const paused = Boolean(r.paused_at);
      const effectiveNow = paused ? new Date(r.paused_at as Date).getTime() : now;

      const startedAt = new Date(r.started_at as Date);
      const elapsed = elapsedMinutes(startedAt, new Date(effectiveNow));

      let remainingMinutes: number | null = null;
      let alertLevel: 'normal' | 'warning' | 'overtime' = 'normal';

      if (r.expected_end_at) {
        const expected = new Date(r.expected_end_at as Date);
        remainingMinutes = Math.round((expected.getTime() - effectiveNow) / 60_000);
        if (remainingMinutes <= 0) {
          alertLevel = 'overtime';
        } else if (remainingMinutes <= cfg.remind_before_minutes) {
          alertLevel = 'warning';
        }
      }

      // 卡核销的会话不计时提醒（卡是通行权益，到期日才是关键）
      const usedCard = Boolean(r.used_card);
      if (usedCard) alertLevel = 'normal';
      // 暂停中的会话不看提醒色（避免暂停期间被误判为超时）
      if (paused) alertLevel = 'normal';

      const displayName = r.member_id
        ? [r.nickname, r.phone_tail].filter(Boolean).join(' · ')
        : (r.guest_name as string) || '散客';

      return {
        tableId: Number(r.id),
        tableName: r.name as string,
        capacity: r.capacity as number,
        status: 'occupied' as const,
        session: {
          sessionId: Number(r.session_id),
          memberId: r.member_id === null ? null : Number(r.member_id),
          memberNo: (r.member_no as string) ?? null,
          displayName,
          phoneTail: (r.phone_tail as string) ?? null,
          productName: r.product_name as string,
          category: (r.category as string) ?? 'timed',
          startedAt: startedAt.toISOString(),
          expectedEndAt: r.expected_end_at ? new Date(r.expected_end_at as Date).toISOString() : null,
          remainingMinutes,
          elapsedMinutes: elapsed,
          usedCard,
          cardType: (r.card_type as string) ?? null,
          cardExpiresAt: toDateString(r.card_expires_at),
          paused,
          pausedAt: r.paused_at ? new Date(r.paused_at as Date).toISOString() : null,
          groupTableNames: (r.group_table_names as string) ?? null,
          alertLevel,
        },
      };
    });

    return {
      summary: {
        total: tables.length,
        occupied: tables.filter((x) => x.status === 'occupied').length,
        idle: tables.filter((x) => x.status === 'idle').length,
        maintenance: tables.filter((x) => x.status === 'maintenance').length,
      },
      tables,
      pricing: cfg,
      serverTime: new Date().toISOString(),
    };
  });
}
