-- ============================================================================
-- 迁移 006：卡权益的退卡与停用
--
-- 需求：
--   1. 退卡 —— 顾客不要这张卡了，退钱并把卡作废。
--      退款金额由店员手动填写（不自动折算），因此必须记录退款金额与原因。
--   2. 停卡 —— 暂时冻结权益，不退款，卡的信息保留。冻结期间不能用于核销。
--
-- 设计取舍：
--   · 卡的历史不删除。members 上保留"最近一次卡的结局"，完整历史见 orders 与
--     card_records 表，保证查账时能追溯"这张卡从哪来、怎么没的"。
--   · 新表 card_records 专门记录每次办卡/退卡/停卡/恢复，与只追加原则一致。
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. members 增加冻结标记
-- ---------------------------------------------------------------------------
ALTER TABLE members ADD COLUMN card_frozen BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE members ADD COLUMN card_frozen_reason TEXT;
ALTER TABLE members ADD COLUMN card_frozen_at TIMESTAMPTZ;

-- 冻结只能发生在有卡的情况下
ALTER TABLE members ADD CONSTRAINT chk_frozen_needs_card CHECK (
  NOT card_frozen OR card_type IS NOT NULL
);

COMMENT ON COLUMN members.card_frozen IS '权益是否被冻结；冻结期间不能用于开台核销';


-- ---------------------------------------------------------------------------
-- 2. 卡权益流水（只追加）
--    每一次办卡、退卡、冻结、恢复都记一行，用于追溯。
-- ---------------------------------------------------------------------------
CREATE TABLE card_records (
  id           BIGSERIAL PRIMARY KEY,
  member_id    BIGINT      NOT NULL REFERENCES members(id) ON DELETE RESTRICT,
  -- issue 办卡 / renew 续卡 / refund 退卡 / freeze 冻结 / unfreeze 解冻
  action       TEXT        NOT NULL
                           CHECK (action IN ('issue','renew','refund','freeze','unfreeze')),
  card_type    TEXT        CHECK (card_type IS NULL OR card_type IN ('week','month','day')),
  started_at   DATE,
  expires_at   DATE,
  -- 办卡实收 / 退卡退款（退卡为正数表示退给顾客的金额）
  amount_cents BIGINT      NOT NULL DEFAULT 0,
  -- 退款去向，仅 refund 有意义
  refund_method TEXT       CHECK (refund_method IS NULL OR refund_method IN ('cash','wechat','alipay','other')),
  reason       TEXT,
  order_id     BIGINT      REFERENCES orders(id) ON DELETE RESTRICT,
  operator_id  BIGINT      NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_card_records_member ON card_records(member_id, created_at DESC);
CREATE INDEX idx_card_records_action ON card_records(action, created_at DESC);

COMMENT ON TABLE card_records IS '卡权益流水，只追加，禁止 UPDATE/DELETE';

-- 回填：为已有的办卡记录补一条 issue 流水，保证历史可查
INSERT INTO card_records (member_id, action, card_type, started_at, expires_at,
                          amount_cents, order_id, operator_id, reason, created_at)
SELECT m.id, 'issue', m.card_type, m.card_started_at, m.card_expires_at,
       COALESCE(o.paid_cents, 0), m.card_order_id,
       COALESCE(o.operator_id, (SELECT id FROM users ORDER BY id LIMIT 1)),
       '历史数据回填', COALESCE(o.completed_at, m.updated_at)
  FROM members m
  LEFT JOIN orders o ON o.id = m.card_order_id
 WHERE m.card_type IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM card_records c WHERE c.member_id = m.id);
