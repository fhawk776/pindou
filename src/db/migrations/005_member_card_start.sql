-- ============================================================================
-- 迁移 005：会员卡增加生效日期
--
-- 背景：原先只记录 card_expires_at（到期日），无法展示"权益起止区间"。
--       会员列表与详情页需要显示 "10月10日 — 10月17日" 这样的区间。
--
-- 语义说明：
--   card_started_at  当前这段权益的最早生效日（首次办卡那天）。
--                    续卡时保持不变，因此显示的是"累计有效期"的起点。
--   card_expires_at  到期日，续卡时从原到期日顺延。
--   两者共同表达"这张卡总共从哪天管到哪天"。
-- ============================================================================

ALTER TABLE members ADD COLUMN card_started_at DATE;

-- 已有数据回填：用办卡订单的下单日期作为起始日，没有订单的用开卡日期兜底
UPDATE members m
   SET card_started_at = COALESCE(
         (SELECT o.completed_at::date FROM orders o WHERE o.id = m.card_order_id),
         m.joined_on
       )
 WHERE m.card_type IS NOT NULL
   AND m.card_started_at IS NULL;

-- 有起始日必须有到期日，反之亦然；与既有的 chk_card_pair 保持一致
ALTER TABLE members DROP CONSTRAINT IF EXISTS chk_card_pair;
ALTER TABLE members ADD CONSTRAINT chk_card_pair CHECK (
  (card_type IS NULL AND card_expires_at IS NULL AND card_started_at IS NULL)
  OR (card_type IS NOT NULL AND card_expires_at IS NOT NULL AND card_started_at IS NOT NULL)
);

COMMENT ON COLUMN members.card_started_at IS
  '当前权益的起始日；续卡时保持不变，用于展示累计有效期';
