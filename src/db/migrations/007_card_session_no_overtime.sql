-- ============================================================================
-- 迁移 007：修正用卡核销的计时逻辑
--
-- 【问题】
--   原实现要求用卡核销时也必须选一个限时套餐（如"单人1小时"），
--   并按该套餐时长计算超时。这导致周卡/月卡/日卡会员玩了 1 小时
--   就被判定超时并加收费用 —— 与"全天不限时"的卡权益本质冲突。
--
-- 【正确模型】
--   周卡/月卡/日卡是"买断某段时间内的不限时通行权"：
--     · 开台时不需要选套餐
--     · 不设预计结束时间，因此不存在超时
--     · 权益的有效边界是卡到期日当天结束
--
-- 【改动】
--   1. table_sessions.product_id 允许为空（用卡开台时无套餐）
--   2. 为用卡会话记录权益到期日，供看板显示
-- ============================================================================

-- 用卡开台时没有套餐，因此 product_id 必须可空
ALTER TABLE table_sessions ALTER COLUMN product_id DROP NOT NULL;

-- 套餐相关字段在使用卡开台时也允许为空
ALTER TABLE table_sessions ALTER COLUMN product_name DROP NOT NULL;
ALTER TABLE table_sessions ALTER COLUMN product_price_cents DROP NOT NULL;

-- 记录本次核销所依据的权益到期日，看板据此显示"权益至 X月X日"
ALTER TABLE table_sessions ADD COLUMN card_expires_at DATE;

-- 回填历史用卡会话的到期日。
-- 这些记录产生于新字段加入之前，若不回填，下面的新约束会校验失败。
-- 取该会员当前的卡到期日作为近似值；若会员已退卡（无到期日），
-- 则以会话发生当天作为兜底，保证数据满足约束且不虚构未来权益。
UPDATE table_sessions ts
   SET card_expires_at = COALESCE(
         (SELECT m.card_expires_at FROM members m WHERE m.id = ts.member_id),
         ts.started_at::date
       )
 WHERE ts.used_card = true
   AND ts.card_expires_at IS NULL;

-- 约束调整：用卡时不需要套餐，但必须有会员与到期日
ALTER TABLE table_sessions DROP CONSTRAINT IF EXISTS chk_card_needs_member;
ALTER TABLE table_sessions ADD CONSTRAINT chk_card_needs_member CHECK (
  NOT used_card OR (member_id IS NOT NULL AND card_expires_at IS NOT NULL)
);

-- 非用卡会话必须有套餐
-- 先把历史上缺套餐的非用卡会话补一个占位名称，避免约束校验失败。
-- 正常情况下不会出现这种数据，这里属于防御性回填。
UPDATE table_sessions
   SET product_name = COALESCE(product_name, '未记录套餐'),
       product_price_cents = COALESCE(product_price_cents, 0)
 WHERE used_card = false
   AND (product_id IS NULL OR product_name IS NULL OR product_price_cents IS NULL);

ALTER TABLE table_sessions ADD CONSTRAINT chk_product_when_not_card CHECK (
  used_card OR (product_id IS NOT NULL AND product_name IS NOT NULL
                AND product_price_cents IS NOT NULL)
);

COMMENT ON COLUMN table_sessions.card_expires_at IS
  '用卡核销时该权益的到期日；当天可一直使用，不产生超时';
