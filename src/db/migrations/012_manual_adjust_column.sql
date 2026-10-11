-- ============================================================================
-- 迁移 012：拆出「人工调整」列，让实收调整可以高于应收
--
-- 【问题】
--   结账时店员可以填任意实收金额（熟人少收、抹零、顾客给整钱不用找零）。
--   差额原先混进 discount_cents（打折日优惠），但该列有 CHECK (>= 0)：
--     · 少收 → 差额为正，能写入
--     · 多收 → 差额为负，触发约束违反，整个结账 500 失败
--   结果是「顾客给 ¥13 不用找零」这种最常见的情况反而结不了账，
--   店员只能把实收填回原价才走得掉 —— 账实就此产生差额。
--
-- 【修复】
--   把人工调整独立成 manual_adjust_cents 列，允许为负：
--     · discount_cents      只存打折日优惠，恒 >= 0
--     · manual_adjust_cents 存人工调整，可为负（多收）或正（少收）
--
--   恒等式改为精确等式（去掉 GREATEST）：
--     total_cents = product + addon + overtime - discount_cents - manual_adjust_cents
--   这样数据库能真正兜住「总额与分项之和对不上」的脏数据，
--   也顺带让报表能区分「打折日送了多少」与「人情送了多少」。
-- ============================================================================

ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS manual_adjust_cents BIGINT NOT NULL DEFAULT 0;

COMMENT ON COLUMN orders.manual_adjust_cents IS
  '人工调整：应收 - 实收。正数表示少收（熟人优惠/抹零），负数表示多收（不用找零）';

-- 放开旧的折扣列约束不变（打折日优惠本来就该非负），
-- 但要修正总额恒等式：引入人工调整，并去掉 GREATEST。
ALTER TABLE orders DROP CONSTRAINT IF EXISTS chk_order_math;

ALTER TABLE orders
  ADD CONSTRAINT chk_order_math CHECK (
    total_cents = product_amount_cents
                + addon_amount_cents
                + overtime_fee_cents
                - discount_cents
                - manual_adjust_cents
  );

-- 总额必须非负（已有的 orders_total_cents_check 保留，此处不重复添加）

-- ---------------------------------------------------------------------------
-- 回填历史数据：
--   旧订单把人工调整混在了 discount_cents 里，无法精确拆分。
--   策略：旧数据的 discount_cents 一律视为「打折日优惠」，manual_adjust 记 0。
--   这样历史订单的恒等式依然成立，且不会凭空捏造金额。
-- ---------------------------------------------------------------------------
UPDATE orders
   SET manual_adjust_cents = 0
 WHERE manual_adjust_cents IS NULL;

-- ---------------------------------------------------------------------------
-- 校验：新约束在当前数据上必须成立
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  bad integer;
BEGIN
  SELECT COUNT(*) INTO bad
    FROM orders
   WHERE total_cents <> product_amount_cents + addon_amount_cents
                       + overtime_fee_cents - discount_cents - manual_adjust_cents;

  IF bad > 0 THEN
    RAISE EXCEPTION '有 % 条订单不满足金额恒等式，迁移中止', bad;
  END IF;
END $$;
