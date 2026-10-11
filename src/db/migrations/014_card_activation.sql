-- ============================================================================
-- 迁移 014：权益模型调整 —— 首次用卡才起算，起始时间改为「本期起始日」
--
-- 【业务规则（店主确认）】
--   1. 办卡后权益处于「未激活」状态，天数从**首次用卡开台**那一刻才开始算。
--      顾客 10/1 办卡、10/5 才第一次来 → 有效期是 10/5 — 10/12，不是 10/1 起。
--   2. 未激活的卡**永久有效**，不设激活期限。
--   3. 未激活期间又办一张，天数**累加**（两张周卡 = 14 天），激活时一次写入。
--   4. card_started_at 语义由「首次办卡日（累计起点）」
--      改为「当前这一期的起始日」：续卡时改为原到期日。
--      界面因此显示"这一期"，而不是含糊的"累计区间"。
--
-- 【为什么改】
--   旧语义下，10/1 办卡 + 10/5 续卡 显示「10月1日 — 10月15日」，
--   看起来像一张 15 天的卡，实际是两张 7 天的卡；而且掩盖了
--   10/1–10/5 顾客没来、时间白流的事实。店员无法判断"这一期到哪天"。
--
-- 【数据回填】
--   已有权益的会员一律视为「已激活」：激活时间沿用原起始日，
--   待生效天数置 0。不会影响线上现有会员。
-- ============================================================================

-- 1. 未激活状态下累计的待生效天数
ALTER TABLE members
  ADD COLUMN IF NOT EXISTS card_pending_days INTEGER NOT NULL DEFAULT 0;

-- 2. 首次用卡开台（激活）的时间
ALTER TABLE members
  ADD COLUMN IF NOT EXISTS card_activated_at TIMESTAMPTZ;

-- 3. 天数非负
ALTER TABLE members DROP CONSTRAINT IF EXISTS chk_pending_days;
ALTER TABLE members ADD CONSTRAINT chk_pending_days CHECK (card_pending_days >= 0);

-- 4. 放宽 chk_card_pair：允许「已办卡但未激活」（只有卡种，起止待定）
ALTER TABLE members DROP CONSTRAINT IF EXISTS chk_card_pair;
ALTER TABLE members ADD CONSTRAINT chk_card_pair CHECK (
  -- 无卡
  (card_type IS NULL AND card_started_at IS NULL AND card_expires_at IS NULL)
  -- 已激活：起止齐全
  OR (card_type IS NOT NULL AND card_started_at IS NOT NULL AND card_expires_at IS NOT NULL)
  -- 未激活：只有卡种，起止待定，且有累计天数
  OR (card_type IS NOT NULL AND card_started_at IS NULL AND card_expires_at IS NULL AND card_pending_days > 0)
);

-- 5. 回填：现有的卡都按「已激活」处理
UPDATE members
   SET card_activated_at = COALESCE(card_started_at::timestamptz, joined_on::timestamptz),
       card_pending_days = 0
 WHERE card_type IS NOT NULL
   AND card_activated_at IS NULL;

-- 6. 会话记录权益起始日快照，让历史开台能还原"当时用的是哪一期"
ALTER TABLE table_sessions
  ADD COLUMN IF NOT EXISTS card_started_at DATE;

-- 7. 注释（写清新语义，避免日后又被误读成累计起点）
COMMENT ON COLUMN members.card_started_at IS
  '当前这一期权益的起始日。未激活时为 NULL；续卡时改为原到期日，故表示"本期"而非"累计"';
COMMENT ON COLUMN members.card_pending_days IS
  '未激活状态下累计的待生效天数。首次用卡开台时写入起止日期并清零';
COMMENT ON COLUMN members.card_activated_at IS
  '首次用卡开台（激活权益）的时间。未激活时为 NULL';
COMMENT ON COLUMN table_sessions.card_started_at IS
  '用卡开台时，该会员本期权益起始日的快照，用于历史追溯';
