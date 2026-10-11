/**
 * API 路由
 *
 * 约定：
 *   - 所有写操作服务端校验（Zod），前端校验只是体验优化
 *   - 金额一律传整数分
 *   - 时间一律 ISO8601
 */
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { config } from '../lib/config.js';
import { login, logout, changePassword, AuthError } from '../services/auth.js';
import {
  createMember, updateMember, searchMembers, getMemberDetail,
  purchaseCard, getMemberReminders, MemberError,
  refundCard, setCardFrozen, getCardRecords,
} from '../services/members.js';
import {
  openTable, settleSession, changeSessionProduct, getTableBoard, TableError,
} from '../services/tables.js';
import { toDateString } from '../services/tables.js';
import {
  getRevenueSummary, listLedger, listOrders, getOrderDetail,
  voidOrder, reconcile, LedgerError,
} from '../services/revenue.js';
import { getPool, withTransaction } from '../lib/db.js';
import { writeAudit } from '../services/audit.js';

function parse<T extends z.ZodTypeAny>(schema: T, data: unknown): z.infer<T> {
  const result = schema.safeParse(data);
  if (!result.success) {
    const first = result.error.issues[0];
    const err = new Error(`${first?.path.join('.') ?? ''} ${first?.message ?? '参数不合法'}`.trim());
    (err as { statusCode?: number }).statusCode = 400;
    (err as { code?: string }).code = 'VALIDATION_ERROR';
    throw err;
  }
  return result.data;
}

function requireAuth(req: FastifyRequest) {
  if (!req.user) {
    const err = new Error('请先登录');
    (err as { statusCode?: number }).statusCode = 401;
    (err as { code?: string }).code = 'UNAUTHORIZED';
    throw err;
  }
  return req.user;
}

function requireAdmin(req: FastifyRequest) {
  const user = requireAuth(req);
  if (user.role !== 'admin') {
    const err = new Error('需要管理员权限');
    (err as { statusCode?: number }).statusCode = 403;
    (err as { code?: string }).code = 'FORBIDDEN';
    throw err;
  }
  return user;
}

export async function registerRoutes(app: FastifyInstance): Promise<void> {
  // =========================================================================
  // 认证
  // =========================================================================
  app.post('/api/v1/auth/login', {
    config: { rateLimit: { max: config.security.loginRateMax, timeWindow: config.security.loginRateWindowMs } },
  }, async (req, reply) => {
    const body = parse(z.object({
      username: z.string().min(1).max(64),
      password: z.string().min(1).max(256),
    }), req.body);

    const result = await login({
      username: body.username, password: body.password,
      ip: req.ip, userAgent: req.headers['user-agent'],
    });

    reply.setCookie(config.session.cookieName, result.token, {
      path: '/', httpOnly: true,
      secure: config.security.cookieSecure,
      sameSite: 'lax', expires: result.expiresAt,
    });
    return { user: result.user };
  });

  app.post('/api/v1/auth/logout', async (req, reply) => {
    const token = req.cookies[config.session.cookieName];
    if (token) await logout(token);
    reply.clearCookie(config.session.cookieName, { path: '/' });
    return { ok: true };
  });

  app.get('/api/v1/auth/me', async (req) => ({ user: requireAuth(req) }));

  app.post('/api/v1/auth/password', async (req) => {
    const user = requireAuth(req);
    const body = parse(z.object({
      oldPassword: z.string().min(1),
      newPassword: z.string().min(10),
    }), req.body);
    await changePassword({ userId: user.id, oldPassword: body.oldPassword, newPassword: body.newPassword });
    return { ok: true };
  });

  // =========================================================================
  // 工位看板（核心页面）
  // =========================================================================
  app.get('/api/v1/board', async (req) => {
    requireAuth(req);
    return getTableBoard();
  });

  app.get('/api/v1/tables', async (req) => {
    requireAuth(req);
    const { rows } = await getPool().query(
      `SELECT id, name, capacity, status, sort_order FROM tables
        WHERE is_active = true ORDER BY sort_order, id`
    );
    return {
      tables: rows.map((r) => ({
        id: Number(r.id), name: r.name, capacity: r.capacity,
        status: r.status, sortOrder: r.sort_order,
      })),
    };
  });

  app.post('/api/v1/tables', async (req) => {
    const user = requireAdmin(req);
    const body = parse(z.object({
      name: z.string().min(1).max(20),
      capacity: z.number().int().min(1).max(20).default(2),
      sortOrder: z.number().int().default(0),
    }), req.body);

    const { rows } = await withTransaction(async (client) => {
      const r = await client.query(
        `INSERT INTO tables (name, capacity, sort_order) VALUES ($1,$2,$3) RETURNING id`,
        [body.name, body.capacity, body.sortOrder]
      );
      await writeAudit(client, {
        actorId: user.id, action: 'table.create', targetType: 'table',
        targetId: Number(r.rows[0].id), after: body, summary: `新增工位 ${body.name}`,
      });
      return r;
    });
    return { id: Number(rows[0].id) };
  });

  app.patch('/api/v1/tables/:id', async (req) => {
    const user = requireAdmin(req);
    const { id } = parse(z.object({ id: z.coerce.number().int().positive() }), req.params);
    const body = parse(z.object({
      name: z.string().min(1).max(20).optional(),
      capacity: z.number().int().min(1).max(20).optional(),
      status: z.enum(['idle', 'maintenance']).optional(),
      isActive: z.boolean().optional(),
    }), req.body);

    await withTransaction(async (client) => {
      const sets: string[] = [];
      const vals: unknown[] = [];
      let i = 1;
      if (body.name !== undefined) { sets.push(`name = $${i++}`); vals.push(body.name); }
      if (body.capacity !== undefined) { sets.push(`capacity = $${i++}`); vals.push(body.capacity); }
      if (body.status !== undefined) { sets.push(`status = $${i++}`); vals.push(body.status); }
      if (body.isActive !== undefined) { sets.push(`is_active = $${i++}`); vals.push(body.isActive); }
      if (sets.length === 0) return;
      vals.push(id);
      await client.query(`UPDATE tables SET ${sets.join(', ')} WHERE id = $${i}`, vals);
      await writeAudit(client, {
        actorId: user.id, action: 'table.update', targetType: 'table',
        targetId: id, after: body, summary: `修改工位设置`,
      });
    });
    return { ok: true };
  });

  // =========================================================================
  // 开台 / 结账
  // =========================================================================
  app.post('/api/v1/sessions', async (req) => {
    const user = requireAuth(req);
    const body = parse(z.object({
      tableId: z.number().int().positive(),
      memberId: z.number().int().positive().nullable().default(null),
      guestName: z.string().max(20).nullish(),
      // 用卡核销时不需要套餐。
      // 同时接受 null 与键缺失两种情况：
      //   · 前端可能发送 productId: null
      //   · 也可能完全不带这个键
      productId: z.number().int().positive().nullable().optional(),
      useCard: z.boolean().default(false),
      note: z.string().max(200).optional(),
    }), req.body);

    if (!body.useCard && !body.productId) {
      const err = new Error('非用卡开台必须选择套餐');
      (err as { statusCode?: number }).statusCode = 400;
      throw err;
    }

    return openTable({
      tableId: body.tableId, memberId: body.memberId,
      guestName: body.guestName ?? null, productId: body.productId ?? null,
      useCard: body.useCard, operatorId: user.id, note: body.note,
    });
  });

  app.patch('/api/v1/sessions/:id/product', async (req) => {
    const user = requireAuth(req);
    const { id } = parse(z.object({ id: z.coerce.number().int().positive() }), req.params);
    const body = parse(z.object({ productId: z.number().int().positive() }), req.body);
    return changeSessionProduct({ sessionId: id, productId: body.productId, operatorId: user.id });
  });

  app.get('/api/v1/sessions/:id', async (req) => {
    requireAuth(req);
    const { id } = parse(z.object({ id: z.coerce.number().int().positive() }), req.params);

    return withTransaction(async (client) => {
      const { rows } = await client.query(
        `SELECT ts.*, t.name AS table_name, m.nickname, m.phone_tail, m.member_no,
                m.card_type,
                m.card_expires_at AS card_expires_at_member
           FROM table_sessions ts
           JOIN tables t ON t.id = ts.table_id
           LEFT JOIN members m ON m.id = ts.member_id
          WHERE ts.id = $1`,
        [id]
      );
      if (rows.length === 0) {
        const err = new Error('开台记录不存在');
        (err as { statusCode?: number }).statusCode = 404;
        throw err;
      }
      const s = rows[0];

      // 暂停时倒计时冻结：以「暂停那一刻」为基准计算已进行/剩余
      const paused = Boolean(s.paused_at);
      const effectiveNow = paused ? new Date(s.paused_at).getTime() : Date.now();
      const startedAt = new Date(s.started_at);
      const elapsedMin = Math.max(0, Math.floor((effectiveNow - startedAt.getTime()) / 60_000));
      const remainingMinutes = s.expected_end_at
        ? Math.round((new Date(s.expected_end_at).getTime() - effectiveNow) / 60_000)
        : null;

      return {
        session: {
          id: Number(s.id),
          tableId: Number(s.table_id),
          tableName: s.table_name,
          memberId: s.member_id === null ? null : Number(s.member_id),
          memberName: s.nickname
            ? [s.nickname, s.phone_tail].filter(Boolean).join(' · ')
            : s.guest_name,
          productId: s.product_id === null ? null : Number(s.product_id),
          productName: s.product_name,
          productPriceCents: s.product_price_cents === null ? 0 : Number(s.product_price_cents),
          usedCard: s.used_card,
          cardType: s.card_type,
          // 优先用开台时记录的权益到期日（快照），
          // 会员后来退卡或续卡都不应改变这次开台的历史事实
          cardExpiresAt: toDateString(s.card_expires_at) ?? toDateString(s.card_expires_at_member),
          startedAt: s.started_at,
          expectedEndAt: s.expected_end_at,
          elapsedMinutes: elapsedMin, remainingMinutes,
          paused,
          pausedAt: s.paused_at ?? null,
          status: s.status,
        },
      };
    });
  });

  /** 暂停计时：顾客中途离开时暂停，暂停时段不计费 */
  app.post('/api/v1/sessions/:id/pause', async (req) => {
    const user = requireAuth(req);
    const { id } = parse(z.object({ id: z.coerce.number().int().positive() }), req.params);
    const { pauseSession } = await import('../services/tables.js');
    return pauseSession(id, user.id);
  });

  /** 恢复计时：暂停时长自动折算进开始时间，计费自然扣除 */
  app.post('/api/v1/sessions/:id/resume', async (req) => {
    const user = requireAuth(req);
    const { id } = parse(z.object({ id: z.coerce.number().int().positive() }), req.params);
    const { resumeSession } = await import('../services/tables.js');
    return resumeSession(id, user.id);
  });

  app.post('/api/v1/sessions/:id/settle', async (req) => {
    const user = requireAuth(req);
    const { id } = parse(z.object({ id: z.coerce.number().int().positive() }), req.params);
    const body = parse(z.object({
      // 加购项带数量。上限 5 种、每种最多 99 件，防止误填巨额数量
      addonItems: z.array(z.object({
        id: z.number().int().positive(),
        qty: z.number().int().min(1).max(99),
      })).max(5).default([]),
      paymentMethod: z.enum(['cash', 'wechat', 'alipay', 'card', 'free', 'other']),
      overrideTotalCents: z.number().int().min(0).max(100_000_000).optional(),
      overrideReason: z.string().max(200).optional(),
      note: z.string().max(200).optional(),
      idempotencyKey: z.string().max(128).optional(),
    }), req.body);

    // 实收调整不限角色：店主与店员都可能在柜台遇到熟人抹零、找零等情况。
    // 每一次调整都会连同操作人、时间、金额与备注写进审计日志。
    return settleSession({
      sessionId: id, addonItems: body.addonItems, paymentMethod: body.paymentMethod,
      overrideTotalCents: body.overrideTotalCents, overrideReason: body.overrideReason,
      note: body.note, idempotencyKey: body.idempotencyKey, operatorId: user.id,
    });
  });

  /** 预估费用（结账前预览，不落库） */
  app.get('/api/v1/sessions/:id/preview', async (req) => {
    requireAuth(req);
    const { id } = parse(z.object({ id: z.coerce.number().int().positive() }), req.params);
    // 加购以 "id:数量,id:数量" 形式传入，例如 addons=3:2,4:1
    const q = parse(z.object({ addons: z.string().optional() }), req.query);

    const addonItems: Array<{ id: number; qty: number }> = [];
    if (q.addons) {
      for (const part of q.addons.split(',')) {
        const [idStr, qtyStr] = part.split(':');
        const aid = Number.parseInt(idStr ?? '', 10);
        const qty = qtyStr === undefined ? 1 : Number.parseInt(qtyStr, 10);
        if (Number.isInteger(aid) && aid > 0 && Number.isInteger(qty) && qty > 0) {
          addonItems.push({ id: aid, qty: Math.min(qty, 99) });
        }
      }
    }

    return withTransaction(async (client) => {
      const { rows } = await client.query(
        `SELECT ts.*, t.name AS table_name FROM table_sessions ts
           JOIN tables t ON t.id = ts.table_id WHERE ts.id = $1`,
        [id]
      );
      if (rows.length === 0) {
        const err = new Error('开台记录不存在');
        (err as { statusCode?: number }).statusCode = 404;
        throw err;
      }
      const s = rows[0];

      const { getPricingConfig, isDiscountDay, calcOvertimeFee, elapsedMinutes, resolveAddons } = await import('../services/tables.js');
      const { applyBp } = await import('../lib/money.js');
      const cfg = await getPricingConfig(client);

      const now = new Date();
      const actualMinutes = elapsedMinutes(s.started_at, now);
      const usedCard = Boolean(s.used_card);

      const { rows: prows } = await client.query(
        `SELECT category, duration_minutes, discountable, overtime_applicable
           FROM products WHERE id = $1`,
        [s.product_id]
      );
      const product = prows[0] ?? {};

      // 超时：阶梯式计算，返回档数与金额
      let overtimeUnits = 0;
      let overtimeFee = 0;
      let overtimeMinutes = 0;
      if (product.overtime_applicable && !usedCard) {
        const ot = calcOvertimeFee({
          actualMinutes, productMinutes: product.duration_minutes, cfg,
        });
        overtimeUnits = ot.stepUnits;
        overtimeFee = ot.feeCents;
        overtimeMinutes = ot.overtimeMinutes;
      }

      const productAmount = Number(s.product_price_cents ?? 0);
      const discountDay = isDiscountDay(now, cfg);
      const rate = cfg.discount_rate_bp;

      // 套餐折扣
      const canDiscountProduct = discountDay && product.discountable && !usedCard;
      const discountedProduct = canDiscountProduct
        ? applyBp(productAmount, rate)
        : (usedCard ? 0 : productAmount);
      const productDiscountCents = (usedCard ? 0 : productAmount) - discountedProduct;

      // 加购：与套餐独立判断，用卡核销时加购照样可打折
      let addonAmount = 0;
      let addonDiscountableAmount = 0;
      // 与结账接口共用同一份解析：无效/下架/超量的加购项一律报错，
      // 不再静默忽略 —— 静默忽略会让预览价低于实际收款价。
      const resolvedAddons = await resolveAddons(client, addonItems);
      addonAmount = resolvedAddons.totalCents;
      addonDiscountableAmount = resolvedAddons.discountableCents;

      const canDiscountAddon = discountDay && addonDiscountableAmount > 0;
      const discountedAddon = canDiscountAddon
        ? applyBp(addonAmount, rate)
        : addonAmount;
      const addonDiscountCents = addonAmount - discountedAddon;

      const discountCents = productDiscountCents + addonDiscountCents;
      const canDiscount = canDiscountProduct || canDiscountAddon;

      const total = Math.max(0, discountedProduct + discountedAddon + overtimeFee);

      return {
        preview: {
          productAmountCents: productAmount,
          discountCents,
          isDiscountDay: canDiscount,
          discountRateBp: canDiscount ? cfg.discount_rate_bp : null,
          // 返回折后金额，与下方 totalCents 的口径保持一致；
          // 原价另给一个字段，便于界面展示"原价 → 折后"
          addonAmountCents: discountedAddon,
          addonOriginalCents: addonAmount,
          addonDiscountCents,
          productOriginalCents: usedCard ? 0 : productAmount,
          overtimeUnits,
          overtimeMinutes,
          overtimeFeeCents: overtimeFee,
          totalCents: total,
          actualMinutes,
          usedCard,
        },
      };
    });
  });

  // =========================================================================
  // 会员
  // =========================================================================
  app.get('/api/v1/members', async (req) => {
    requireAuth(req);
    const q = parse(z.object({
      q: z.string().optional(),
      cursor: z.coerce.number().int().positive().optional(),
      limit: z.coerce.number().int().min(1).max(100).optional(),
    }), req.query);
    return { members: await searchMembers({ q: q.q, cursor: q.cursor, limit: q.limit }) };
  });

  app.post('/api/v1/members', async (req) => {
    const user = requireAuth(req);
    const body = parse(z.object({
      nickname: z.string().min(1).max(20),
      phoneTail: z.string().regex(/^[0-9]{4}$/).nullish(),
      joinedOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      remark: z.string().max(500).optional(),
    }), req.body);

    return createMember({
      nickname: body.nickname, phoneTail: body.phoneTail ?? null,
      joinedOn: body.joinedOn, remark: body.remark, operatorId: user.id,
    });
  });

  app.get('/api/v1/members/reminders', async (req) => {
    requireAuth(req);
    const q = parse(z.object({ days: z.coerce.number().int().min(1).max(30).default(3) }), req.query);
    return { reminders: await getMemberReminders(q.days) };
  });

  app.get('/api/v1/members/:id', async (req) => {
    requireAuth(req);
    const { id } = parse(z.object({ id: z.coerce.number().int().positive() }), req.params);
    const member = await getMemberDetail(id);
    if (!member) {
      const err = new Error('会员不存在');
      (err as { statusCode?: number }).statusCode = 404;
      throw err;
    }
    return { member };
  });

  app.patch('/api/v1/members/:id', async (req) => {
    const user = requireAuth(req);
    const { id } = parse(z.object({ id: z.coerce.number().int().positive() }), req.params);
    const body = parse(z.object({
      nickname: z.string().min(1).max(20).optional(),
      phoneTail: z.string().regex(/^[0-9]{4}$/).nullish(),
      remark: z.string().max(500).optional(),
      status: z.enum(['active', 'disabled']).optional(),
    }), req.body);

    await updateMember({ memberId: id, operatorId: user.id, ...body });
    return { ok: true };
  });

  app.post('/api/v1/members/:id/card', async (req) => {
    const user = requireAuth(req);
    const { id } = parse(z.object({ id: z.coerce.number().int().positive() }), req.params);
    const body = parse(z.object({
      cardType: z.enum(['week', 'month', 'day']),
      productId: z.number().int().positive(),
      paymentMethod: z.enum(['cash', 'wechat', 'alipay', 'other']),
      note: z.string().max(200).optional(),
    }), req.body);

    return purchaseCard({
      memberId: id, cardType: body.cardType, productId: body.productId,
      paymentMethod: body.paymentMethod, operatorId: user.id, note: body.note,
    });
  });

  /** 退卡：作废权益并退款。退款金额手动填，必须写原因。仅管理员可操作。 */
  app.post('/api/v1/members/:id/card/refund', async (req) => {
    const user = requireAdmin(req);
    const { id } = parse(z.object({ id: z.coerce.number().int().positive() }), req.params);
    const body = parse(z.object({
      refundCents: z.number().int().min(0).max(100_000_000),
      refundMethod: z.enum(['cash', 'wechat', 'alipay', 'other']),
      reason: z.string().min(1).max(300),
    }), req.body);

    return refundCard({
      memberId: id, refundCents: body.refundCents,
      refundMethod: body.refundMethod, reason: body.reason, operatorId: user.id,
    });
  });

  /** 冻结 / 解冻卡权益。冻结不退款，卡号与到期日保留。 */
  app.post('/api/v1/members/:id/card/freeze', async (req) => {
    const user = requireAdmin(req);
    const { id } = parse(z.object({ id: z.coerce.number().int().positive() }), req.params);
    const body = parse(z.object({
      frozen: z.boolean(),
      reason: z.string().max(300).optional(),
    }), req.body);

    return setCardFrozen({
      memberId: id, frozen: body.frozen, reason: body.reason, operatorId: user.id,
    });
  });

  /** 卡权益流水 */
  app.get('/api/v1/members/:id/card-records', async (req) => {
    requireAuth(req);
    const { id } = parse(z.object({ id: z.coerce.number().int().positive() }), req.params);
    return { records: await getCardRecords(id) };
  });

  // =========================================================================
  // 价目表
  // =========================================================================
  app.get('/api/v1/products', async (req) => {
    requireAuth(req);
    const q = parse(z.object({
      category: z.string().optional(),
      // 默认只返回在售套餐（开台/结账用）。
      // 设置页需要连已停用的一起看，才能显示"已停用"并重新启用。
      includeInactive: z.enum(['true', 'false']).optional(),
    }), req.query);

    const showAll = q.includeInactive === 'true';
    const conds: string[] = showAll ? [] : ['is_active = true'];
    const vals: unknown[] = [];
    // 注意 $${vals.length} 生成的是参数占位符 $1。
    // 若误写成 ${vals.length}，会生成字面量 "category = 1"，
    // PostgreSQL 找不到 text = integer 的操作符，报 42883 undefined_function。
    if (q.category) { vals.push(q.category); conds.push(`category = $${vals.length}`); }

    const { rows } = await getPool().query(
      `SELECT id, code, name, category, price_cents::bigint AS price_cents,
              duration_minutes, pins, people_count, card_valid_days, card_type,
              discountable, overtime_applicable, sort_order, is_active
         FROM products ${conds.length ? 'WHERE ' + conds.join(' AND ') : ''}
        ORDER BY sort_order, id`,
      vals
    );

    return {
      products: rows.map((r) => ({
        id: Number(r.id), code: r.code, name: r.name, category: r.category,
        priceCents: Number(r.price_cents),
        durationMinutes: r.duration_minutes, pins: r.pins,
        peopleCount: r.people_count,
        cardValidDays: r.card_valid_days, cardType: r.card_type,
        discountable: r.discountable, overtimeApplicable: r.overtime_applicable,
        sortOrder: r.sort_order,
        isActive: r.is_active,
      })),
    };
  });

  app.post('/api/v1/products', async (req) => {
    const user = requireAdmin(req);
    const body = parse(z.object({
      code: z.string().min(1).max(32).regex(/^[A-Z0-9_]+$/),
      name: z.string().min(1).max(40),
      category: z.enum(['timed', 'board', 'day', 'card', 'addon']),
      priceCents: z.number().int().min(0).max(100_000_000),
      durationMinutes: z.number().int().positive().nullish(),
      pins: z.number().int().positive().nullish(),
      peopleCount: z.number().int().positive().max(20).default(1),
      cardValidDays: z.number().int().positive().nullish(),
      cardType: z.enum(['week', 'month', 'day']).nullish(),
      discountable: z.boolean().default(true),
      overtimeApplicable: z.boolean().default(false),
      sortOrder: z.number().int().default(0),
    }), req.body);

    const { rows } = await withTransaction(async (client) => {
      const r = await client.query(
        `INSERT INTO products (code, name, category, price_cents, duration_minutes, pins,
                               people_count, card_valid_days, card_type, discountable,
                               overtime_applicable, sort_order)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
        [body.code, body.name, body.category, body.priceCents, body.durationMinutes ?? null,
         body.pins ?? null, body.peopleCount, body.cardValidDays ?? null,
         body.cardType ?? null, body.discountable, body.overtimeApplicable, body.sortOrder]
      );
      await writeAudit(client, {
        actorId: user.id, action: 'product.create', targetType: 'product',
        targetId: Number(r.rows[0].id), after: body, summary: `新增套餐 ${body.name}`,
      });
      return r;
    });
    return { id: Number(rows[0].id) };
  });

  app.patch('/api/v1/products/:id', async (req) => {
    const user = requireAdmin(req);
    const { id } = parse(z.object({ id: z.coerce.number().int().positive() }), req.params);
    const body = parse(z.object({
      name: z.string().min(1).max(40).optional(),
      priceCents: z.number().int().min(0).max(100_000_000).optional(),
      durationMinutes: z.number().int().positive().nullish(),
      // 钉数、人数、卡种也开放编辑 —— 店主可能调整规格
      pins: z.number().int().positive().nullish(),
      peopleCount: z.number().int().positive().max(20).optional(),
      cardValidDays: z.number().int().positive().nullish(),
      cardType: z.enum(['week', 'month', 'day']).nullish(),
      discountable: z.boolean().optional(),
      overtimeApplicable: z.boolean().optional(),
      isActive: z.boolean().optional(),
      sortOrder: z.number().int().optional(),
    }), req.body);

    await withTransaction(async (client) => {
      const { rows: before } = await client.query(
        `SELECT name, category, price_cents::bigint AS price_cents,
                duration_minutes, pins, card_valid_days, card_type
           FROM products WHERE id = $1`,
        [id]
      );
      if (before.length === 0) throw new Error('套餐不存在');

      // 校验"改动之后"的整体组合是否合法。
      // 数据库有 chk_timed_fields / chk_board_fields / chk_card_fields 兜底，
      // 但直接撞约束只会得到一句英文报错，店主看不懂。
      // 这里提前判断，给出能照着做的提示。
      {
        const b = before[0];
        const cat = b.category as string;
        const dur = body.durationMinutes !== undefined ? body.durationMinutes : b.duration_minutes;
        const pins = body.pins !== undefined ? body.pins : b.pins;
        const cvd = body.cardValidDays !== undefined ? body.cardValidDays : b.card_valid_days;
        const ctype = body.cardType !== undefined ? body.cardType : b.card_type;
        const ot = body.overtimeApplicable !== undefined ? body.overtimeApplicable : undefined;

        if (cat === 'timed') {
          if (dur === null || dur === undefined) {
            throw new TableError('限时套餐必须有时长（分钟），不能清空');
          }
          if (ot === false) {
            throw new TableError('限时套餐必须允许超时。若要不限时，请把分类改为限板或日卡');
          }
        }
        if (cat === 'board' && (pins === null || pins === undefined)) {
          throw new TableError('限板套餐必须填写钉数');
        }
        if (cat === 'card' && (cvd === null || cvd === undefined || !ctype)) {
          throw new TableError('周卡必须填写有效天数与卡种');
        }
      }

      const sets: string[] = [];
      const vals: unknown[] = [];
      let i = 1;
      if (body.name !== undefined) { sets.push(`name = $${i++}`); vals.push(body.name); }
      if (body.priceCents !== undefined) { sets.push(`price_cents = $${i++}`); vals.push(body.priceCents); }
      if (body.durationMinutes !== undefined) { sets.push(`duration_minutes = $${i++}::int`); vals.push(body.durationMinutes); }
      if (body.pins !== undefined) { sets.push(`pins = $${i++}::int`); vals.push(body.pins); }
      if (body.peopleCount !== undefined) { sets.push(`people_count = $${i++}::int`); vals.push(body.peopleCount); }
      if (body.cardValidDays !== undefined) { sets.push(`card_valid_days = $${i++}::int`); vals.push(body.cardValidDays); }
      if (body.cardType !== undefined) { sets.push(`card_type = $${i++}::text`); vals.push(body.cardType); }
      if (body.discountable !== undefined) { sets.push(`discountable = $${i++}`); vals.push(body.discountable); }
      if (body.overtimeApplicable !== undefined) { sets.push(`overtime_applicable = $${i++}`); vals.push(body.overtimeApplicable); }
      if (body.isActive !== undefined) { sets.push(`is_active = $${i++}`); vals.push(body.isActive); }
      if (body.sortOrder !== undefined) { sets.push(`sort_order = $${i++}`); vals.push(body.sortOrder); }
      if (sets.length === 0) return;
      vals.push(id);
      await client.query(`UPDATE products SET ${sets.join(', ')} WHERE id = $${i}`, vals);

      await writeAudit(client, {
        actorId: user.id, action: 'product.update', targetType: 'product',
        targetId: id, before: before[0], after: body,
        summary: `修改套餐 ${before[0].name}`,
      });
    });
    return { ok: true };
  });

  /**
   * 删除套餐。
   *
   * 删除有个绕不开的约束：orders 与 table_sessions 都用 RESTRICT 引用了 products，
   * 只要这个套餐被任何一笔订单或开台记录用过，数据库就不允许物理删除 ——
   * 这是对的，删了历史账目就断了，以后查账看不到当时卖的什么。
   *
   * 因此这里先探测引用情况：
   *   · 从未被使用  → 直接删除
   *   · 已被使用    → 返回明确提示，让店主改用「停用」
   *
   * 前端会据此把按钮显示成「删除」或「停用」，不让店主撞上数据库报错。
   */
  app.delete('/api/v1/products/:id', async (req) => {
    const user = requireAdmin(req);
    const { id } = parse(z.object({ id: z.coerce.number().int().positive() }), req.params);

    return withTransaction(async (client) => {
      const { rows: before } = await client.query(
        'SELECT name FROM products WHERE id = $1', [id]
      );
      if (before.length === 0) {
        const err = new Error('套餐不存在');
        (err as { statusCode?: number }).statusCode = 404;
        throw err;
      }

      // 统计引用次数
      const { rows: refs } = await client.query(
        `SELECT
           (SELECT COUNT(*)::int FROM order_items WHERE product_id = $1) AS order_count,
           (SELECT COUNT(*)::int FROM table_sessions WHERE product_id = $1) AS session_count`,
        [id]
      );
      const orderCount = refs[0].order_count as number;
      const sessionCount = refs[0].session_count as number;

      if (orderCount > 0 || sessionCount > 0) {
        const err = new Error(
          `「${before[0].name}」已经用过（${orderCount} 笔订单、${sessionCount} 次开台），` +
          `删除会让历史账目查不到它。请改用「停用」，它会从开台页消失但历史记录保留。`
        );
        (err as { statusCode?: number }).statusCode = 409;
        throw err;
      }

      await client.query('DELETE FROM products WHERE id = $1', [id]);
      await writeAudit(client, {
        actorId: user.id, action: 'product.delete', targetType: 'product',
        targetId: id, before: before[0],
        summary: `删除套餐 ${before[0].name}`,
      });

      return { ok: true, deleted: true };
    });
  });

  /**
   * 查询某个套餐能否被删除。
   * 前端打开编辑面板时先问一下，据此决定显示「删除」还是「停用」。
   */
  app.get('/api/v1/products/:id/usage', async (req) => {
    requireAuth(req);
    const { id } = parse(z.object({ id: z.coerce.number().int().positive() }), req.params);

    const { rows } = await getPool().query(
      `SELECT
         (SELECT COUNT(*)::int FROM order_items WHERE product_id = $1) AS order_count,
         (SELECT COUNT(*)::int FROM table_sessions WHERE product_id = $1) AS session_count`,
      [id]
    );
    const orderCount = rows[0].order_count as number;
    const sessionCount = rows[0].session_count as number;

    return {
      orderCount,
      sessionCount,
      canDelete: orderCount === 0 && sessionCount === 0,
    };
  });

  // =========================================================================
  // 收入 / 账单
  // =========================================================================
  app.get('/api/v1/revenue/summary', async (req) => {
    requireAuth(req);
    return getRevenueSummary();
  });

  app.get('/api/v1/revenue/ledger', async (req) => {
    requireAuth(req);
    const q = parse(z.object({
      from: z.string().optional(),
      to: z.string().optional(),
      flowType: z.enum(['consume', 'card_purchase', 'refund', 'adjust']).optional(),
      memberId: z.coerce.number().int().positive().optional(),
      cursor: z.coerce.number().int().positive().optional(),
      limit: z.coerce.number().int().min(1).max(200).optional(),
    }), req.query);

    return listLedger({
      from: q.from, to: q.to, flowType: q.flowType,
      memberId: q.memberId, cursor: q.cursor, limit: q.limit,
    });
  });

  app.get('/api/v1/orders', async (req) => {
    requireAuth(req);
    const q = parse(z.object({
      from: z.string().optional(),
      to: z.string().optional(),
      memberId: z.coerce.number().int().positive().optional(),
      status: z.enum(['completed', 'refunded', 'voided']).optional(),
      cursor: z.coerce.number().int().positive().optional(),
      limit: z.coerce.number().int().min(1).max(100).optional(),
    }), req.query);

    return listOrders({
      from: q.from, to: q.to, memberId: q.memberId,
      status: q.status, cursor: q.cursor, limit: q.limit,
    });
  });

  app.get('/api/v1/orders/:id', async (req) => {
    requireAuth(req);
    const { id } = parse(z.object({ id: z.coerce.number().int().positive() }), req.params);
    const order = await getOrderDetail(id);
    if (!order) {
      const err = new Error('订单不存在');
      (err as { statusCode?: number }).statusCode = 404;
      throw err;
    }
    return { order };
  });

  app.post('/api/v1/orders/:id/void', async (req) => {
    const user = requireAdmin(req);
    const { id } = parse(z.object({ id: z.coerce.number().int().positive() }), req.params);
    const body = parse(z.object({ reason: z.string().min(1).max(500) }), req.body);
    return voidOrder({ orderId: id, reason: body.reason, operatorId: user.id });
  });

  app.get('/api/v1/revenue/reconcile', async (req) => {
    requireAdmin(req);
    return reconcile();
  });

  // =========================================================================
  // 设置
  // =========================================================================
  app.get('/api/v1/settings', async (req) => {
    requireAuth(req);
    const { rows } = await getPool().query('SELECT key, value FROM settings');
    const out: Record<string, unknown> = {};
    for (const r of rows) out[r.key as string] = r.value;
    return { settings: out };
  });

  app.put('/api/v1/settings/:key', async (req) => {
    const user = requireAdmin(req);
    const { key } = parse(z.object({ key: z.enum(['shop', 'pricing', 'card_prices']) }), req.params);
    const body = parse(z.object({ value: z.unknown() }), req.body);

    await withTransaction(async (client) => {
      const { rows: before } = await client.query('SELECT value FROM settings WHERE key = $1', [key]);
      await client.query(
        `INSERT INTO settings (key, value, updated_at, updated_by)
         VALUES ($1,$2,now(),$3)
         ON CONFLICT (key) DO UPDATE
           SET value = EXCLUDED.value, updated_at = now(), updated_by = EXCLUDED.updated_by`,
        [key, JSON.stringify(body.value), user.id]
      );
      await writeAudit(client, {
        actorId: user.id, action: 'settings.update', targetType: 'settings', targetId: null,
        before: before[0]?.value ?? null, after: body.value, summary: `修改配置 ${key}`,
      });
    });
    return { ok: true };
  });

  // =========================================================================
  // 审计日志
  // =========================================================================
  app.get('/api/v1/audit-logs', async (req) => {
    requireAdmin(req);
    const q = parse(z.object({
      action: z.string().optional(),
      targetType: z.string().optional(),
      cursor: z.coerce.number().int().positive().optional(),
      limit: z.coerce.number().int().min(1).max(200).optional(),
    }), req.query);

    const limit = Math.min(q.limit ?? 50, 200);
    return withTransaction(async (client) => {
      const conds: string[] = [];
      const vals: unknown[] = [];
      if (q.action) { vals.push(`${q.action}%`); conds.push(`action LIKE $${vals.length}`); }
      if (q.targetType) { vals.push(q.targetType); conds.push(`target_type = $${vals.length}`); }
      if (q.cursor) { vals.push(q.cursor); conds.push(`id < $${vals.length}`); }
      vals.push(limit);
      const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';

      const { rows } = await client.query(
        `SELECT id, actor_name, action, target_type, target_id, summary, created_at
           FROM audit_logs ${where} ORDER BY id DESC LIMIT $${vals.length}`,
        vals
      );
      return {
        logs: rows.map((r) => ({
          id: Number(r.id), actorName: r.actor_name, action: r.action,
          targetType: r.target_type,
          targetId: r.target_id === null ? null : Number(r.target_id),
          summary: r.summary, createdAt: r.created_at,
        })),
      };
    });
  });

  // 让错误类型被引用，便于后续扩展统一处理
  void MemberError; void TableError; void LedgerError; void AuthError;
}
