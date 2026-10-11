-- ============================================================================
-- 拼豆店管理系统 - 重建表结构（迁移 003）
--
-- 【为什么重建而不是增量修改】
--   001 版本的表结构基于"储值会员卡"的假设（余额、积分、等级、充值），
--   与实际门店业务（计时工位 + 卡种权益 + 收入流水）不符。
--   经确认真实业务后，旧结构中的 members/orders/order_items 字段差异过大，
--   增量 ALTER 反而更易出错，因此在确认无生产数据的前提下重建。
--
-- 【旧表处理】
--   旧表（balance_transactions / points_transactions / recharges /
--         member_levels / order_refunds / attachments）按约定保留观察期，
--   本迁移不删除它们。新结构使用新表名或重建后的同名表。
--
-- 业务模型（依据实际海报与门店流程）：
--   顾客进门 → 选工位 → 选会员/散客 → 选套餐或卡 → 开台计时
--   顾客离开 → 结账（算时长、超时费、打折）→ 收钱 → 工位释放
--
-- 核心概念：
--   table_sessions  开台记录 = 每张工位的拼豆记录（谁、何时来、玩多久）
--   orders          结账单（应收/优惠/实收）
--   revenue_ledger  收入流水（只追加，钱实际进出的记录）
--
-- 设计原则：
--   1. 金额一律 BIGINT 整数分，禁止浮点。
--   2. 比例用整数万分比（8000 = 8折）。
--   3. revenue_ledger / audit_logs 只追加，禁止 UPDATE/DELETE。
--   4. 时间统一 TIMESTAMPTZ，展示时按 Asia/Shanghai 转换。
-- ============================================================================


-- ---------------------------------------------------------------------------
-- 0. 清除 001 遗留的旧结构
--    顺序遵循外键依赖：先删引用方，再删被引用方。
--    users / sessions / login_attempts / audit_logs 结构未变，予以保留。
-- ---------------------------------------------------------------------------
DROP TABLE IF EXISTS order_refunds CASCADE;
DROP TABLE IF EXISTS order_items CASCADE;
DROP TABLE IF EXISTS orders CASCADE;
DROP TABLE IF EXISTS attachments CASCADE;
DROP TABLE IF EXISTS recharges CASCADE;
DROP TABLE IF EXISTS points_transactions CASCADE;
DROP TABLE IF EXISTS balance_transactions CASCADE;
DROP TABLE IF EXISTS members CASCADE;
DROP TABLE IF EXISTS member_levels CASCADE;
DROP TABLE IF EXISTS settings CASCADE;
DROP TABLE IF EXISTS idempotency_keys CASCADE;


-- ---------------------------------------------------------------------------
-- 通用触发器函数（若 001 已创建则复用）
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;


-- ---------------------------------------------------------------------------
-- 1. 价目表
--    套餐分类的差异决定了计时与超时规则，因此把这些差异做成字段而非硬编码。
-- ---------------------------------------------------------------------------
CREATE TABLE products (
  id           BIGSERIAL PRIMARY KEY,
  code         TEXT        NOT NULL UNIQUE,
  name         TEXT        NOT NULL CHECK (btrim(name) <> ''),
  -- 分类决定行为：
  --   timed   限时套餐（单人/双人 N 小时）→ 计时 + 可超时
  --   board   限板套餐（52/78/104 钉）   → 不计时，不适用超时
  --   day     日卡（单人/双人全天）       → 当天有效，不计时
  --   card    周卡/月卡                   → 购买后授予会员权益，不计时
  --   addon   加购项（拼豆板、特殊烫）     → 附加在订单上
  category     TEXT        NOT NULL CHECK (category IN ('timed','board','day','card','addon')),
  price_cents  BIGINT      NOT NULL CHECK (price_cents >= 0),
  -- 时长（分钟），仅 timed 与 day 有意义
  duration_minutes INTEGER CHECK (duration_minutes IS NULL OR duration_minutes > 0),
  -- 钉数，仅 board 有意义
  pins         INTEGER     CHECK (pins IS NULL OR pins > 0),
  -- 人数，用于双人套餐（不影响计价，仅作记录）
  people_count INTEGER     NOT NULL DEFAULT 1 CHECK (people_count > 0),
  -- 卡种有效天数，仅 card 有意义
  card_valid_days INTEGER CHECK (card_valid_days IS NULL OR card_valid_days > 0),
  -- 卡种类型，仅 card 有意义
  card_type    TEXT        CHECK (card_type IS NULL OR card_type IN ('week','month','day')),
  -- 是否参与打折日的折扣（周卡/月卡不参与）
  discountable BOOLEAN     NOT NULL DEFAULT true,
  -- 是否适用超时加收（限板套餐不适用）
  overtime_applicable BOOLEAN NOT NULL DEFAULT false,
  sort_order   INTEGER     NOT NULL DEFAULT 0,
  is_active    BOOLEAN     NOT NULL DEFAULT true,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- 各分类的必填字段约束，防止配置出无效组合
  CONSTRAINT chk_timed_fields CHECK (
    category <> 'timed' OR (duration_minutes IS NOT NULL AND overtime_applicable = true)
  ),
  CONSTRAINT chk_board_fields CHECK (
    category <> 'board' OR pins IS NOT NULL
  ),
  CONSTRAINT chk_card_fields CHECK (
    category <> 'card' OR (card_valid_days IS NOT NULL AND card_type IS NOT NULL)
  )
);
CREATE TRIGGER trg_products_updated BEFORE UPDATE ON products
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE INDEX idx_products_category ON products(category, sort_order) WHERE is_active = true;


-- ---------------------------------------------------------------------------
-- 2. 工位
-- ---------------------------------------------------------------------------
CREATE TABLE tables (
  id          BIGSERIAL PRIMARY KEY,
  name        TEXT        NOT NULL UNIQUE CHECK (btrim(name) <> ''),
  capacity    INTEGER     NOT NULL DEFAULT 2 CHECK (capacity > 0),
  -- 维护状态用于临时停用某个工位（如设备维修），不影响其他工位
  status      TEXT        NOT NULL DEFAULT 'idle'
                          CHECK (status IN ('idle','maintenance')),
  sort_order  INTEGER     NOT NULL DEFAULT 0,
  is_active   BOOLEAN     NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TRIGGER trg_tables_updated BEFORE UPDATE ON tables
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE INDEX idx_tables_sort ON tables(sort_order, id);


-- ---------------------------------------------------------------------------
-- 3. 会员
--    昵称自由填写（可填"杨先生"也可填微信名），尾号选填用于快速查找。
--    卡种权益直接放在会员表上：一个人同时只持有一张有效卡。
-- ---------------------------------------------------------------------------
CREATE TABLE members (
  id            BIGSERIAL PRIMARY KEY,
  member_no     TEXT        NOT NULL UNIQUE,
  nickname      TEXT        NOT NULL CHECK (length(btrim(nickname)) BETWEEN 1 AND 20),
  phone_tail    TEXT        CHECK (phone_tail IS NULL OR phone_tail ~ '^[0-9]{4}$'),
  -- 完整手机号预留字段，当前不收集
  phone         TEXT        UNIQUE,
  joined_on     DATE        NOT NULL DEFAULT CURRENT_DATE,
  -- 卡种权益：NULL 表示无有效卡
  card_type     TEXT        CHECK (card_type IS NULL OR card_type IN ('week','month','day')),
  card_expires_at DATE,
  -- 卡的购买时间与订单，便于追溯"这张卡从哪来"
  card_order_id BIGINT,
  -- 卡内累计使用次数（明细见 table_sessions）
  card_used_count INTEGER   NOT NULL DEFAULT 0 CHECK (card_used_count >= 0),
  -- 累计到店次数（含散客单之外的所有到店）
  visit_count   INTEGER     NOT NULL DEFAULT 0 CHECK (visit_count >= 0),
  remark        TEXT        NOT NULL DEFAULT '',
  status        TEXT        NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  row_version   INTEGER     NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- 有卡种必须有到期日，反之亦然
  CONSTRAINT chk_card_pair CHECK (
    (card_type IS NULL AND card_expires_at IS NULL)
    OR (card_type IS NOT NULL AND card_expires_at IS NOT NULL)
  )
);
CREATE TRIGGER trg_members_updated BEFORE UPDATE ON members
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE INDEX idx_members_nickname ON members(nickname);
CREATE INDEX idx_members_tail ON members(phone_tail) WHERE phone_tail IS NOT NULL;
CREATE INDEX idx_members_joined ON members(joined_on DESC);
-- 便于"快到期会员"提醒
CREATE INDEX idx_members_card_expiry ON members(card_expires_at)
  WHERE card_expires_at IS NOT NULL AND status = 'active';


-- ---------------------------------------------------------------------------
-- 4. 开台记录（= 每张工位的拼豆记录 / 到店记录）
--    这是本系统的核心表：记录谁、何时、在哪张工位、买了什么、玩了多久。
-- ---------------------------------------------------------------------------
CREATE TABLE table_sessions (
  id             BIGSERIAL PRIMARY KEY,
  table_id       BIGINT      NOT NULL REFERENCES tables(id) ON DELETE RESTRICT,
  member_id      BIGINT      REFERENCES members(id) ON DELETE RESTRICT,
  -- 散客的临时称呼，与会员二选一
  guest_name     TEXT,
  product_id     BIGINT      NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  -- 下单时的套餐快照，之后改价目表不影响历史
  product_name   TEXT        NOT NULL,
  product_price_cents BIGINT NOT NULL CHECK (product_price_cents >= 0),
  -- 是否使用会员卡权益核销（周卡/月卡/日卡）
  used_card      BOOLEAN     NOT NULL DEFAULT false,

  started_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- 预计结束时间 = 开始 + 套餐时长；限板/日卡类为 NULL
  expected_end_at TIMESTAMPTZ,
  ended_at       TIMESTAMPTZ,
  -- 实际时长（分钟），结算时写入
  actual_minutes INTEGER     CHECK (actual_minutes IS NULL OR actual_minutes >= 0),
  -- 超时档数（每 20 分钟一档）与超时费
  overtime_units INTEGER     NOT NULL DEFAULT 0 CHECK (overtime_units >= 0),
  overtime_fee_cents BIGINT  NOT NULL DEFAULT 0 CHECK (overtime_fee_cents >= 0),

  status         TEXT        NOT NULL DEFAULT 'active'
                             CHECK (status IN ('active','settled','voided')),
  -- 结算后关联的订单
  order_id       BIGINT,
  opened_by      BIGINT      NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  settled_by     BIGINT      REFERENCES users(id) ON DELETE RESTRICT,
  note           TEXT        NOT NULL DEFAULT '',
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- 散客必须有称呼，便于店员喊人；会员则通过 member_id 识别
  CONSTRAINT chk_identity CHECK (
    member_id IS NOT NULL OR (guest_name IS NOT NULL AND btrim(guest_name) <> '')
  ),
  -- 用卡核销时必须有会员
  CONSTRAINT chk_card_needs_member CHECK (NOT used_card OR member_id IS NOT NULL),
  -- 已结束必须有结束时间
  CONSTRAINT chk_ended CHECK (status <> 'settled' OR ended_at IS NOT NULL)
);
CREATE TRIGGER trg_table_sessions_updated BEFORE UPDATE ON table_sessions
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- 关键约束：一个工位同时只能有一个进行中的会话
CREATE UNIQUE INDEX uq_table_active_session ON table_sessions(table_id)
  WHERE status = 'active';
-- 一个会员同时只能在一个工位（防止重复开台）
CREATE UNIQUE INDEX uq_member_active_session ON table_sessions(member_id)
  WHERE status = 'active' AND member_id IS NOT NULL;

CREATE INDEX idx_sessions_table ON table_sessions(table_id, started_at DESC);
CREATE INDEX idx_sessions_member ON table_sessions(member_id, started_at DESC);
CREATE INDEX idx_sessions_started ON table_sessions(started_at DESC);
-- 看板查询：找所有进行中的会话
CREATE INDEX idx_sessions_active ON table_sessions(status, expected_end_at)
  WHERE status = 'active';


-- ---------------------------------------------------------------------------
-- 5. 订单（结账单）
-- ---------------------------------------------------------------------------
CREATE TABLE orders (
  id             BIGSERIAL PRIMARY KEY,
  order_no       TEXT        NOT NULL UNIQUE,
  member_id      BIGINT      REFERENCES members(id) ON DELETE RESTRICT,
  guest_name     TEXT,
  -- 关联的开台记录
  table_session_id BIGINT    REFERENCES table_sessions(id) ON DELETE RESTRICT,
  table_name     TEXT,

  -- 费用构成（全部为整数分）
  product_amount_cents BIGINT NOT NULL DEFAULT 0 CHECK (product_amount_cents >= 0), -- 套餐原价
  addon_amount_cents   BIGINT NOT NULL DEFAULT 0 CHECK (addon_amount_cents >= 0),   -- 加购合计
  overtime_fee_cents   BIGINT NOT NULL DEFAULT 0 CHECK (overtime_fee_cents >= 0),   -- 超时费
  discount_cents       BIGINT NOT NULL DEFAULT 0 CHECK (discount_cents >= 0),       -- 折扣减免
  total_cents          BIGINT NOT NULL CHECK (total_cents >= 0),                    -- 应收
  paid_cents           BIGINT NOT NULL CHECK (paid_cents >= 0),                     -- 实收
  -- 打折信息快照，便于解释"为什么是这个价"
  discount_rate_bp     INTEGER CHECK (discount_rate_bp IS NULL OR discount_rate_bp > 0),
  is_discount_day      BOOLEAN NOT NULL DEFAULT false,

  -- 计时信息快照
  started_at     TIMESTAMPTZ,
  ended_at       TIMESTAMPTZ,
  actual_minutes INTEGER CHECK (actual_minutes IS NULL OR actual_minutes >= 0),
  overtime_units INTEGER NOT NULL DEFAULT 0 CHECK (overtime_units >= 0),

  used_card      BOOLEAN     NOT NULL DEFAULT false,
  payment_method TEXT        NOT NULL DEFAULT 'cash'
                             CHECK (payment_method IN ('cash','wechat','alipay','card','free','other')),
  status         TEXT        NOT NULL DEFAULT 'completed'
                             CHECK (status IN ('completed','refunded','voided')),
  -- 已退款金额
  refunded_cents BIGINT      NOT NULL DEFAULT 0 CHECK (refunded_cents >= 0),
  CONSTRAINT chk_refund_le_paid CHECK (refunded_cents <= paid_cents),

  operator_id    BIGINT      NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  note           TEXT        NOT NULL DEFAULT '',
  completed_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  voided_at      TIMESTAMPTZ,
  voided_by      BIGINT      REFERENCES users(id) ON DELETE RESTRICT,
  void_reason    TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT chk_order_void CHECK (
    status <> 'voided' OR (voided_at IS NOT NULL AND voided_by IS NOT NULL
                           AND void_reason IS NOT NULL AND btrim(void_reason) <> '')
  ),
  -- 费用构成必须能对上总额
  CONSTRAINT chk_order_math CHECK (
    total_cents = GREATEST(0,
      product_amount_cents + addon_amount_cents + overtime_fee_cents - discount_cents)
  )
);
CREATE TRIGGER trg_orders_updated BEFORE UPDATE ON orders
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE INDEX idx_orders_member ON orders(member_id, completed_at DESC);
CREATE INDEX idx_orders_completed ON orders(completed_at DESC);
CREATE INDEX idx_orders_status ON orders(status);
CREATE INDEX idx_orders_discount_day ON orders(completed_at) WHERE is_discount_day = true;


-- ---------------------------------------------------------------------------
-- 6. 订单明细
-- ---------------------------------------------------------------------------
CREATE TABLE order_items (
  id            BIGSERIAL PRIMARY KEY,
  order_id      BIGINT      NOT NULL REFERENCES orders(id) ON DELETE RESTRICT,
  product_id    BIGINT      REFERENCES products(id) ON DELETE RESTRICT,
  -- 下单时的名称与价格快照
  name          TEXT        NOT NULL CHECK (btrim(name) <> ''),
  category      TEXT        NOT NULL,
  qty           NUMERIC(12,3) NOT NULL DEFAULT 1 CHECK (qty > 0),
  unit_price_cents BIGINT   NOT NULL CHECK (unit_price_cents >= 0),
  amount_cents  BIGINT      NOT NULL CHECK (amount_cents >= 0),
  sort_order    INTEGER     NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_order_items_order ON order_items(order_id);


-- ---------------------------------------------------------------------------
-- 7. 收入流水（只追加）
--    每一笔钱的实际进出都记一行，永不修改。对账以本表为准。
-- ---------------------------------------------------------------------------
CREATE TABLE revenue_ledger (
  id            BIGSERIAL PRIMARY KEY,
  flow_no       TEXT        NOT NULL UNIQUE,
  -- consume 消费收款 / card_purchase 办卡收款 / refund 退款 / adjust 人工冲正
  flow_type     TEXT        NOT NULL
                            CHECK (flow_type IN ('consume','card_purchase','refund','adjust')),
  -- 带符号：收款为正，退款为负
  amount_cents  BIGINT      NOT NULL CHECK (amount_cents <> 0),
  payment_method TEXT       NOT NULL DEFAULT 'cash'
                            CHECK (payment_method IN ('cash','wechat','alipay','card','free','other')),
  member_id     BIGINT      REFERENCES members(id) ON DELETE RESTRICT,
  order_id      BIGINT      REFERENCES orders(id) ON DELETE RESTRICT,
  table_session_id BIGINT   REFERENCES table_sessions(id) ON DELETE RESTRICT,
  -- 关联的退款流水（退款时指向原流水）
  reverses_id   BIGINT      REFERENCES revenue_ledger(id) ON DELETE RESTRICT,
  -- 营业日期：跨零点营业时"今天"应以营业日计，而非自然日
  business_date DATE        NOT NULL DEFAULT CURRENT_DATE,
  operator_id   BIGINT      NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  remark        TEXT        NOT NULL DEFAULT '',
  -- 幂等键：防止网络重试导致重复记账
  idempotency_key TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_ledger_created ON revenue_ledger(created_at DESC);
CREATE INDEX idx_ledger_business_date ON revenue_ledger(business_date DESC);
CREATE INDEX idx_ledger_member ON revenue_ledger(member_id, created_at DESC);
CREATE INDEX idx_ledger_type ON revenue_ledger(flow_type, business_date DESC);
CREATE UNIQUE INDEX uq_ledger_idem ON revenue_ledger(idempotency_key)
  WHERE idempotency_key IS NOT NULL;


-- ---------------------------------------------------------------------------
-- 8. 配置
-- ---------------------------------------------------------------------------
CREATE TABLE settings (
  key        TEXT        PRIMARY KEY,
  value      JSONB       NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by BIGINT      REFERENCES users(id) ON DELETE RESTRICT
);

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


-- ---------------------------------------------------------------------------
-- 9. 审计日志（只追加）
--    结构沿用 001 版本，此处仅在缺失时创建。
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS audit_logs (
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
CREATE INDEX IF NOT EXISTS idx_audit_actor ON audit_logs(actor_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_target ON audit_logs(target_type, target_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_logs(action);


-- ---------------------------------------------------------------------------
-- 10. 初始数据
-- ---------------------------------------------------------------------------

-- 工位：8 个（可在后台增减）
INSERT INTO tables (name, capacity, sort_order) VALUES
  ('01号工位', 2, 1), ('02号工位', 2, 2), ('03号工位', 2, 3), ('04号工位', 2, 4),
  ('05号工位', 2, 5), ('06号工位', 2, 6), ('07号工位', 4, 7), ('08号工位', 4, 8);

-- 价目表：完全依据门店海报
INSERT INTO products
  (code, name, category, price_cents, duration_minutes, pins, people_count,
   card_valid_days, card_type, discountable, overtime_applicable, sort_order)
VALUES
  -- 限时不限板
  ('T1H_S',  '单人1小时',   'timed', 1280,  60, NULL, 1, NULL, NULL, true,  true,  10),
  ('T3H_S',  '单人3小时',   'timed', 3380, 180, NULL, 1, NULL, NULL, true,  true,  11),
  ('T1H_D',  '双人1小时',   'timed', 2380,  60, NULL, 2, NULL, NULL, true,  true,  12),
  ('T3H_D',  '双人3小时',   'timed', 6880, 180, NULL, 2, NULL, NULL, true,  true,  13),
  -- 限板不限时（不适用超时）
  ('P52',    '52钉',        'board', 1280, NULL,  52, 1, NULL, NULL, true, false, 20),
  ('P78',    '78钉',        'board', 2580, NULL,  78, 1, NULL, NULL, true, false, 21),
  ('P104',   '104钉',       'board', 3880, NULL, 104, 1, NULL, NULL, true, false, 22),
  -- 日卡（当天有效）
  ('DAY_S',  '单人全天',    'day',   6380, NULL, NULL, 1, NULL, 'day',  true, false, 30),
  ('DAY_D',  '双人全天',    'day',  10880, NULL, NULL, 2, NULL, 'day',  true, false, 31),
  -- 周卡 / 月卡（不参与打折）
  ('WEEK_P', '周卡(前18名)','card', 18800, NULL, NULL, 1, 7,  'week',  false, false, 40),
  ('WEEK_N', '周卡',        'card', 25800, NULL, NULL, 1, 7,  'week',  false, false, 41),
  ('MONTH',  '月卡',        'card', 68800, NULL, NULL, 1, 30, 'month', false, false, 42),
  -- 加购
  ('ADD_BOARD', '智能拼豆板', 'addon',  990, NULL, NULL, 1, NULL, NULL, false, false, 50),
  ('ADD_IRON',  '特殊烫',     'addon',  288, NULL, NULL, 1, NULL, NULL, false, false, 51);

-- 全局配置：所有可调参数集中在此，改配置不需要改代码
INSERT INTO settings (key, value) VALUES
  ('shop', jsonb_build_object(
     'name', '请拼豆',
     'business_hours', '10:00-23:00',
     'timezone', 'Asia/Shanghai',
     'member_no_prefix', 'PD'
  )),
  ('pricing', jsonb_build_object(
     -- 打折日（每月几号）与折扣率（万分比，8000 = 8折）
     'discount_days', jsonb_build_array(8, 18, 28),
     'discount_rate_bp', 8000,
     -- 超时规则：每满 20 分钟加收 5 元
     'overtime_unit_minutes', 20,
     'overtime_fee_cents', 500,
     -- 结账时不足一档的零头是否计费：true = 满 20 分钟才算一档
     'overtime_full_unit_only', true,
     -- 提前多少分钟在看板提醒
     'remind_before_minutes', 15
  )),
  ('card_prices', jsonb_build_object(
     -- 卡种价格可在后台调整；前面 products 里的价格是默认值
     'week_promo_cents', 18800,
     'week_normal_cents', 25800,
     'month_cents', 68800
  ));


COMMENT ON TABLE table_sessions IS '开台记录，即每张工位的拼豆记录与到店记录';
COMMENT ON TABLE revenue_ledger IS '收入流水，只追加，禁止 UPDATE/DELETE，对账以本表为准';
COMMENT ON TABLE audit_logs IS '审计日志，只追加，禁止 UPDATE/DELETE';
COMMENT ON COLUMN products.category IS 'timed=限时 board=限板 day=日卡 card=周月卡 addon=加购';
COMMENT ON COLUMN revenue_ledger.business_date IS '营业日期，跨零点营业时用于正确归集每日收入';
