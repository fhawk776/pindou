-- ============================================================================
-- 迁移 017：card_records 支持「激活」事件
--
-- 【问题】
--   迁移 014 之后，办卡时权益是「未激活」，起止日期为空，
--   于是 card_records 里 issue 那条的 started_at / expires_at 都是 NULL。
--   等顾客首次用卡开台、真正激活时，只更新了 members 表，
--   **没有补记流水** —— 结果翻权益记录时看不到"这张卡实际从哪天管到哪天"，
--   追溯链条断了。
--
-- 【修法】
--   action 增加 'activate'。首次用卡开台时追加一条记录，
--   写入此刻确定下来的本期起止日期。
--   只追加、不修改历史（与 card_records 的既有原则一致）。
--
-- 【完整链条】
--   issue        买了卡（可能未激活，日期为空）
--   activate     首次用卡开台，日期在此确定
--   renew        续卡 / 未激活时再加一张
--   refund       退卡
--   freeze/unfreeze  冻结 / 解冻
-- ============================================================================

ALTER TABLE card_records DROP CONSTRAINT IF EXISTS card_records_action_check;

ALTER TABLE card_records ADD CONSTRAINT card_records_action_check
  CHECK (action IN ('issue', 'activate', 'renew', 'refund', 'freeze', 'unfreeze'));

COMMENT ON COLUMN card_records.action IS
  'issue 办卡 / activate 首次用卡激活 / renew 续卡或累加 / refund 退卡 / freeze 冻结 / unfreeze 解冻';
