-- ============================================================================
-- 迁移版本: 002
-- 修复幂等约束在 ref_id 为 NULL 时失效的问题
--
-- 【问题】
--   001 中唯一约束为 (ref_type, ref_id, tx_type)。
--   PostgreSQL 中 NULL != NULL，因此当 ref_id IS NULL（人工调整场景）时
--   唯一索引完全不生效，同一笔操作可被重复记账。
--
-- 【为什么不能简单改成 COALESCE(ref_id, 0)】
--   那样会导致"人工调整"这类 ref_id 恒为 NULL 的业务只能做一次，
--   第二次调整会被唯一约束挡住 —— 这是把 bug 换成了另一个 bug。
--
-- 【正确设计】
--   区分两类幂等来源：
--     1. 有明确业务对象的（订单、充值）：用 (ref_type, ref_id, tx_type) 保证
--        "同一订单只能扣一次款"。
--     2. 无业务对象的（人工调整）：用可选的 idempotency_key 保证
--        "同一张表单只能提交一次"，但不同次调整互不影响。
--   因此把唯一约束改为部分索引，只约束 ref_id 非空的行。
-- ============================================================================

-- 移除旧约束
ALTER TABLE balance_transactions DROP CONSTRAINT IF EXISTS uq_balance_tx_idempotent;
ALTER TABLE points_transactions  DROP CONSTRAINT IF EXISTS uq_points_tx_idempotent;

-- 新增：外部幂等键（人工操作防重复提交）
ALTER TABLE balance_transactions ADD COLUMN idempotency_key TEXT;
ALTER TABLE points_transactions  ADD COLUMN idempotency_key TEXT;

-- 部分唯一索引 1：有业务对象时，同一对象同一类型只能有一条
CREATE UNIQUE INDEX uq_balance_tx_ref
  ON balance_transactions (ref_type, ref_id, tx_type)
  WHERE ref_id IS NOT NULL;

-- 部分唯一索引 2：带幂等键时，同一键只能有一条
CREATE UNIQUE INDEX uq_balance_tx_idem
  ON balance_transactions (idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- 积分流水同理
CREATE UNIQUE INDEX uq_points_tx_ref
  ON points_transactions (ref_type, ref_id, tx_type)
  WHERE ref_id IS NOT NULL;

CREATE UNIQUE INDEX uq_points_tx_idem
  ON points_transactions (idempotency_key)
  WHERE idempotency_key IS NOT NULL;

COMMENT ON COLUMN balance_transactions.idempotency_key IS
  '外部幂等键，用于人工操作防重复提交；有业务对象时用 ref_id 即可';
