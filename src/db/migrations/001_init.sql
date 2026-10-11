-- ============================================================================
-- 拼豆店会员管理系统 - 初始表结构
-- 迁移版本: 001
--
-- 设计原则（重要，后续所有迁移都必须遵守）：
--   1. 所有金额一律使用 BIGINT 存"分"，禁止浮点数。字段名统一以 _cents 结尾。
--   2. 所有比例（折扣、积分倍率）使用整数万分比 _bp，9500 = 95折。
--   3. 资金表、积分表、审计表为"只追加"(append-only)，禁止 UPDATE / DELETE。
--      任何冲正、退款、作废都必须插入反向记录，不得修改历史行。
--   4. members.balance_cents / points_balance 是流水汇总的物化缓存，
--      真相以 *_transactions 表为准。二者必须始终相等（见 reconcile）。
--   5. 余额、积分不允许为负，用 CHECK 约束在数据库层兜底。
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 通用：自动更新 updated_at
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;


-- ---------------------------------------------------------------------------
-- 1. 账号与会话
-- ---------------------------------------------------------------------------
CREATE TABLE users (
  id            BIGSERIAL PRIMARY KEY,
  username      TEXT        NOT NULL UNIQUE,
  password_hash TEXT        NOT NULL,
  display_name  TEXT        NOT NULL DEFAULT '',
  -- 第一版只有 admin，但结构上预留 staff，以后加角色不用改表
  role          TEXT        NOT NULL DEFAULT 'admin'
                            CHECK (role IN ('admin', 'staff')),
  is_active     BOOLEAN     NOT NULL DEFAULT true,
  failed_count  INTEGER     NOT NULL DEFAULT 0,
  locked_until  TIMESTAMPTZ,
  last_login_at TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TRIGGER trg_users_updated BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- 会话：Cookie 里只放随机 token，库里存哈希，泄露库也拿不到有效 token
CREATE TABLE sessions (
  id          BIGSERIAL PRIMARY KEY,
  user_id     BIGINT      NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash  TEXT        NOT NULL UNIQUE,
  expires_at  TIMESTAMPTZ NOT NULL,
  idle_expires_at TIMESTAMPTZ NOT NULL,
  ip          TEXT,
  user_agent  TEXT,
  revoked_at  TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_sessions_user ON sessions(user_id);
CREATE INDEX idx_sessions_expires ON sessions(expires_at) WHERE revoked_at IS NULL;

-- 登录尝试记录，用于限速与失败锁定
CREATE TABLE login_attempts (
  id         BIGSERIAL PRIMARY KEY,
  username   TEXT        NOT NULL,
  ip         TEXT        NOT NULL,
  success    BOOLEAN     NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_login_attempts_lookup ON login_attempts(username, ip, created_at DESC);


-- ---------------------------------------------------------------------------
-- 2. 会员等级
-- ---------------------------------------------------------------------------
CREATE TABLE member_levels (
  id             BIGSERIAL PRIMARY KEY,
  code           TEXT        NOT NULL UNIQUE,
  name           TEXT        NOT NULL,
  -- 折扣万分比：10000 = 不打折，9500 = 95折，8800 = 88折
  discount_bp    INTEGER     NOT NULL DEFAULT 10000
                             CHECK (discount_bp > 0 AND discount_bp <= 10000),
  -- 积分倍率万分比：10000 = 1倍，20000 = 双倍积分
  points_rate_bp INTEGER     NOT NULL DEFAULT 10000
                             CHECK (points_rate_bp >= 0),
  sort_order     INTEGER     NOT NULL DEFAULT 0,
  is_active      BOOLEAN     NOT NULL DEFAULT true,
  is_default     BOOLEAN     NOT NULL DEFAULT false,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TRIGGER trg_member_levels_updated BEFORE UPDATE ON member_levels
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
-- 只允许一个默认等级
CREATE UNIQUE INDEX idx_member_levels_default ON member_levels(is_default)
  WHERE is_default = true;


-- ---------------------------------------------------------------------------
-- 3. 会员
-- ---------------------------------------------------------------------------
CREATE TABLE members (
  id             BIGSERIAL PRIMARY KEY,
  -- 系统生成的会员编号，唯一，用于区分重名
  member_no      TEXT        NOT NULL UNIQUE,
  -- 称呼 = 姓氏 + 性别 + 尾号四位，如"杨先生5481"
  -- 注意：这个组合允许重复，它只是称呼，不是主键
  surname        TEXT        NOT NULL CHECK (length(btrim(surname)) BETWEEN 1 AND 10),
  gender         TEXT        NOT NULL DEFAULT 'unknown'
                             CHECK (gender IN ('male', 'female', 'unknown')),
  phone_tail     TEXT        CHECK (phone_tail IS NULL OR phone_tail ~ '^[0-9]{4}$'),
  -- 完整手机号字段预留但当前不用，以后要做短信通知时启用
  phone          TEXT        UNIQUE,
  joined_on      DATE        NOT NULL DEFAULT CURRENT_DATE,
  level_id       BIGINT      REFERENCES member_levels(id) ON DELETE RESTRICT,
  -- 余额 = 本金 + 赠送，均以分为单位，且不允许为负
  balance_cents       BIGINT NOT NULL DEFAULT 0 CHECK (balance_cents >= 0),
  gift_balance_cents  BIGINT NOT NULL DEFAULT 0 CHECK (gift_balance_cents >= 0),
  -- 赠送余额不能超过总余额
  CONSTRAINT chk_gift_le_total CHECK (gift_balance_cents <= balance_cents),
  points_balance INTEGER NOT NULL DEFAULT 0 CHECK (points_balance >= 0),
  status         TEXT        NOT NULL DEFAULT 'active'
                             CHECK (status IN ('active', 'disabled')),
  remark         TEXT        NOT NULL DEFAULT '',
  -- 乐观锁版本号，用于本地缓存/前端并发提交检测
  row_version    INTEGER     NOT NULL DEFAULT 0,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TRIGGER trg_members_updated BEFORE UPDATE ON members
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- 搜索用索引：姓氏、尾号、编号
CREATE INDEX idx_members_surname ON members(surname);
CREATE INDEX idx_members_phone_tail ON members(phone_tail) WHERE phone_tail IS NOT NULL;
CREATE INDEX idx_members_created ON members(created_at DESC);
CREATE INDEX idx_members_joined ON members(joined_on DESC);

-- 生成的"称呼"列，方便搜索与展示（杨先生5481）
ALTER TABLE members ADD COLUMN display_name TEXT
  GENERATED ALWAYS AS (
    surname ||
    CASE gender WHEN 'male' THEN '先生' WHEN 'female' THEN '女士' ELSE '' END ||
    COALESCE(phone_tail, '')
  ) STORED;
CREATE INDEX idx_members_display_name ON members(display_name);


-- ---------------------------------------------------------------------------
-- 4. 订单
-- ---------------------------------------------------------------------------
CREATE TABLE orders (
  id              BIGSERIAL PRIMARY KEY,
  order_no        TEXT        NOT NULL UNIQUE,
  -- 散客单 member_id 为空，不计积分、不扣余额，但计入营业额
  member_id       BIGINT      REFERENCES members(id) ON DELETE RESTRICT,
  status          TEXT        NOT NULL DEFAULT 'completed'
                              CHECK (status IN ('completed', 'partially_refunded',
                                                'refunded', 'voided')),
  -- 金额构成（全部为分）
  subtotal_cents     BIGINT NOT NULL CHECK (subtotal_cents >= 0),  -- 原价合计
  discount_cents     BIGINT NOT NULL DEFAULT 0 CHECK (discount_cents >= 0), -- 整单优惠
  points_deduct_cents BIGINT NOT NULL DEFAULT 0 CHECK (points_deduct_cents >= 0), -- 积分抵扣
  total_cents        BIGINT NOT NULL CHECK (total_cents >= 0),     -- 应收 = 小计-优惠-积分抵扣
  -- 实收构成
  paid_balance_cents BIGINT NOT NULL DEFAULT 0 CHECK (paid_balance_cents >= 0),
  paid_cash_cents    BIGINT NOT NULL DEFAULT 0 CHECK (paid_cash_cents >= 0),
  paid_other_cents   BIGINT NOT NULL DEFAULT 0 CHECK (paid_other_cents >= 0),
  -- 实收合计必须等于应收
  CONSTRAINT chk_paid_equals_total CHECK (
    paid_balance_cents + paid_cash_cents + paid_other_cents = total_cents
  ),
  -- 已退款金额（用于部分退款）
  refunded_cents     BIGINT NOT NULL DEFAULT 0 CHECK (refunded_cents >= 0),
  CONSTRAINT chk_refund_le_total CHECK (refunded_cents <= total_cents),
  payment_method  TEXT        NOT NULL DEFAULT 'cash'
                              CHECK (payment_method IN ('cash', 'wechat', 'alipay',
                                                        'balance', 'mixed', 'other')),
  -- 积分变动
  points_earned   INTEGER     NOT NULL DEFAULT 0 CHECK (points_earned >= 0),
  points_redeemed INTEGER     NOT NULL DEFAULT 0 CHECK (points_redeemed >= 0),
  -- 积分规则快照（保证历史订单可解释：当时按什么规则算的）
  points_rule_snapshot JSONB,
  operator_id     BIGINT      NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  note            TEXT        NOT NULL DEFAULT '',
  completed_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  voided_at       TIMESTAMPTZ,
  voided_by       BIGINT      REFERENCES users(id) ON DELETE RESTRICT,
  void_reason     TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- 作废必须留下原因和操作人
  CONSTRAINT chk_void_fields CHECK (
    (status <> 'voided') OR (voided_at IS NOT NULL AND voided_by IS NOT NULL
                             AND void_reason IS NOT NULL AND btrim(void_reason) <> '')
  )
);
CREATE TRIGGER trg_orders_updated BEFORE UPDATE ON orders
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE INDEX idx_orders_member ON orders(member_id, completed_at DESC);
CREATE INDEX idx_orders_completed ON orders(completed_at DESC);
CREATE INDEX idx_orders_status ON orders(status);
-- 看板统计用：只统计有效订单
CREATE INDEX idx_orders_dashboard ON orders(completed_at)
  WHERE status IN ('completed', 'partially_refunded');

-- 订单明细：保留下单时的名称与单价快照，之后改价目表不影响历史
CREATE TABLE order_items (
  id              BIGSERIAL PRIMARY KEY,
  order_id        BIGINT      NOT NULL REFERENCES orders(id) ON DELETE RESTRICT,
  name            TEXT        NOT NULL CHECK (btrim(name) <> ''),
  qty             NUMERIC(12,3) NOT NULL CHECK (qty > 0),
  unit_price_cents BIGINT     NOT NULL CHECK (unit_price_cents >= 0),
  discount_cents  BIGINT      NOT NULL DEFAULT 0 CHECK (discount_cents >= 0),
  line_total_cents BIGINT     NOT NULL CHECK (line_total_cents >= 0),
  -- 该项是否参与积分抵扣
  points_deductible BOOLEAN   NOT NULL DEFAULT true,
  sort_order      INTEGER     NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_order_items_order ON order_items(order_id);

-- 退款记录：每次退款一行，保留完整审计
CREATE TABLE order_refunds (
  id                   BIGSERIAL PRIMARY KEY,
  order_id             BIGINT      NOT NULL REFERENCES orders(id) ON DELETE RESTRICT,
  amount_cents         BIGINT      NOT NULL CHECK (amount_cents > 0),
  balance_refund_cents BIGINT      NOT NULL DEFAULT 0 CHECK (balance_refund_cents >= 0),
  cash_refund_cents    BIGINT      NOT NULL DEFAULT 0 CHECK (cash_refund_cents >= 0),
  CONSTRAINT chk_refund_split CHECK (balance_refund_cents + cash_refund_cents = amount_cents),
  points_reversed      INTEGER     NOT NULL DEFAULT 0 CHECK (points_reversed >= 0),
  points_returned      INTEGER     NOT NULL DEFAULT 0 CHECK (points_returned >= 0),
  reason               TEXT        NOT NULL CHECK (btrim(reason) <> ''),
  operator_id          BIGINT      NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_order_refunds_order ON order_refunds(order_id);


-- ---------------------------------------------------------------------------
-- 5. 资金流水（核心，只追加）
-- ---------------------------------------------------------------------------
CREATE TABLE balance_transactions (
  id            BIGSERIAL PRIMARY KEY,
  member_id     BIGINT      NOT NULL REFERENCES members(id) ON DELETE RESTRICT,
  tx_type       TEXT        NOT NULL CHECK (tx_type IN (
                  'recharge',        -- 充值
                  'recharge_revoke', -- 充值撤销
                  'consume',         -- 消费扣款
                  'refund',          -- 退款回充
                  'adjust',          -- 人工调整
                  'gift_expire'      -- 赠送过期
                )),
  -- 带符号：充值为正，消费为负
  amount_cents  BIGINT      NOT NULL CHECK (amount_cents <> 0),
  -- 本次变动中"赠送部分"的增减（用于退款时判断能否退赠送）
  gift_delta_cents BIGINT   NOT NULL DEFAULT 0,
  -- 变动后余额快照，便于对账与展示
  balance_after_cents BIGINT NOT NULL CHECK (balance_after_cents >= 0),
  -- 来源对象：order / recharge / manual
  ref_type      TEXT        NOT NULL CHECK (ref_type IN ('order', 'recharge', 'manual')),
  ref_id        BIGINT,
  operator_id   BIGINT      REFERENCES users(id) ON DELETE RESTRICT,
  remark        TEXT        NOT NULL DEFAULT '',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- 幂等锁：同一来源 + 同一类型只能有一条，防止重复扣款
  CONSTRAINT uq_balance_tx_idempotent UNIQUE (ref_type, ref_id, tx_type)
);
CREATE INDEX idx_balance_tx_member ON balance_transactions(member_id, created_at DESC);
CREATE INDEX idx_balance_tx_created ON balance_transactions(created_at DESC);

-- 积分流水（只追加）
CREATE TABLE points_transactions (
  id            BIGSERIAL PRIMARY KEY,
  member_id     BIGINT      NOT NULL REFERENCES members(id) ON DELETE RESTRICT,
  tx_type       TEXT        NOT NULL CHECK (tx_type IN (
                  'earn',          -- 消费获得
                  'redeem',        -- 积分抵扣
                  'refund_revoke', -- 退款追回积分
                  'refund_return', -- 退款返还抵扣的积分
                  'adjust'         -- 人工调整
                )),
  points_delta  INTEGER     NOT NULL CHECK (points_delta <> 0),
  points_after  INTEGER     NOT NULL CHECK (points_after >= 0),
  ref_type      TEXT        NOT NULL CHECK (ref_type IN ('order', 'manual', 'rule')),
  ref_id        BIGINT,
  operator_id   BIGINT      REFERENCES users(id) ON DELETE RESTRICT,
  remark        TEXT        NOT NULL DEFAULT '',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_points_tx_idempotent UNIQUE (ref_type, ref_id, tx_type)
);
CREATE INDEX idx_points_tx_member ON points_transactions(member_id, created_at DESC);


-- ---------------------------------------------------------------------------
-- 6. 充值
-- ---------------------------------------------------------------------------
CREATE TABLE recharges (
  id             BIGSERIAL PRIMARY KEY,
  member_id      BIGINT      NOT NULL REFERENCES members(id) ON DELETE RESTRICT,
  recharge_no    TEXT        NOT NULL UNIQUE,
  -- 实付金额与赠送金额分离：退款时通常只退本金、不退赠送
  amount_cents   BIGINT      NOT NULL CHECK (amount_cents > 0),
  gift_cents     BIGINT      NOT NULL DEFAULT 0 CHECK (gift_cents >= 0),
  payment_method TEXT        NOT NULL DEFAULT 'cash'
                             CHECK (payment_method IN ('cash', 'wechat', 'alipay', 'other')),
  operator_id    BIGINT      NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  note           TEXT        NOT NULL DEFAULT '',
  revoked_at     TIMESTAMPTZ,
  revoked_by     BIGINT      REFERENCES users(id) ON DELETE RESTRICT,
  revoke_reason  TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_recharge_revoke CHECK (
    (revoked_at IS NULL) OR (revoked_by IS NOT NULL AND revoke_reason IS NOT NULL
                             AND btrim(revoke_reason) <> '')
  )
);
CREATE INDEX idx_recharges_member ON recharges(member_id, created_at DESC);
CREATE INDEX idx_recharges_created ON recharges(created_at DESC);


-- ---------------------------------------------------------------------------
-- 7. 配置
-- ---------------------------------------------------------------------------
CREATE TABLE settings (
  key        TEXT        PRIMARY KEY,
  value      JSONB       NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by BIGINT      REFERENCES users(id) ON DELETE RESTRICT
);

-- 幂等键：防止网络重试导致重复提交
CREATE TABLE idempotency_keys (
  key          TEXT        PRIMARY KEY,
  user_id      BIGINT      NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint     TEXT        NOT NULL,
  request_hash TEXT        NOT NULL,
  response     JSONB,
  status_code  INTEGER,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ
);
CREATE INDEX idx_idem_created ON idempotency_keys(created_at DESC);

-- 附件（OSS 预留）：只存引用，不存文件本体
CREATE TABLE attachments (
  id          BIGSERIAL PRIMARY KEY,
  owner_type  TEXT        NOT NULL CHECK (owner_type IN ('member', 'order')),
  owner_id    BIGINT      NOT NULL,
  storage     TEXT        NOT NULL DEFAULT 'oss' CHECK (storage IN ('oss')),
  object_key  TEXT        NOT NULL,
  url         TEXT        NOT NULL,
  mime        TEXT,
  size_bytes  BIGINT,
  created_by  BIGINT      REFERENCES users(id) ON DELETE RESTRICT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_attachments_owner ON attachments(owner_type, owner_id);


-- ---------------------------------------------------------------------------
-- 8. 审计日志（只追加）
-- ---------------------------------------------------------------------------
CREATE TABLE audit_logs (
  id          BIGSERIAL PRIMARY KEY,
  actor_id    BIGINT      REFERENCES users(id) ON DELETE RESTRICT,
  actor_name  TEXT        NOT NULL DEFAULT '',
  action      TEXT        NOT NULL,
  target_type TEXT        NOT NULL,
  target_id   BIGINT,
  before_data JSONB,
  after_data  JSONB,
  summary     TEXT        NOT NULL DEFAULT '',
  ip          TEXT,
  user_agent  TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_audit_actor ON audit_logs(actor_id, created_at DESC);
CREATE INDEX idx_audit_target ON audit_logs(target_type, target_id, created_at DESC);
CREATE INDEX idx_audit_created ON audit_logs(created_at DESC);
CREATE INDEX idx_audit_action ON audit_logs(action);


-- ---------------------------------------------------------------------------
-- 9. 默认数据
-- ---------------------------------------------------------------------------
INSERT INTO member_levels (code, name, discount_bp, points_rate_bp, sort_order, is_default)
VALUES ('NORMAL', '普通会员', 10000, 10000, 0, true);

INSERT INTO settings (key, value) VALUES
  ('points_rule', '{"earn_per_yuan": 1, "redeem_rate_bp": 100, "max_deduct_bp": 5000, "min_redeem": 100}'::jsonb),
  ('shop', '{"name": "拼豆店", "timezone": "Asia/Shanghai", "member_no_prefix": "PD"}'::jsonb);

COMMENT ON TABLE balance_transactions IS '资金流水，只追加，禁止 UPDATE/DELETE';
COMMENT ON TABLE points_transactions IS '积分流水，只追加，禁止 UPDATE/DELETE';
COMMENT ON TABLE audit_logs IS '审计日志，只追加，禁止 UPDATE/DELETE';
COMMENT ON COLUMN members.balance_cents IS '余额（分），物化缓存，真相见 balance_transactions';
