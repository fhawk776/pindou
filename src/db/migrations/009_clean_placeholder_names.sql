-- ============================================================================
-- 迁移 009：清理测试过程中产生的占位会员
--
-- 背景：
--   早期调试时创建了若干昵称为「1」「2」这类无意义占位符的会员。
--   它们不是真实顾客，留在演示数据里会让界面看起来像未完成品。
--
-- 处理原则：
--   只删除"昵称是无意义占位符 且 没有任何订单与流水"的会员。
--   一旦有业务记录就保留，避免破坏历史账目。
-- ============================================================================

-- 先把这类会员身上的卡权益流水清掉（它们只来源于测试办卡）
DELETE FROM card_records
 WHERE member_id IN (
   SELECT m.id FROM members m
    WHERE m.nickname ~ '^[0-9]{1,2}$'
      AND NOT EXISTS (SELECT 1 FROM orders o WHERE o.member_id = m.id)
      AND NOT EXISTS (SELECT 1 FROM table_sessions ts WHERE ts.member_id = m.id)
 );

-- 再删这些会员本身
DELETE FROM members m
 WHERE m.nickname ~ '^[0-9]{1,2}$'
   AND NOT EXISTS (SELECT 1 FROM orders o WHERE o.member_id = m.id)
   AND NOT EXISTS (SELECT 1 FROM table_sessions ts WHERE ts.member_id = m.id)
   AND NOT EXISTS (SELECT 1 FROM revenue_ledger r WHERE r.member_id = m.id);

-- 仍有业务记录的占位会员改为可识别的名字，保留账目完整
UPDATE members
   SET nickname = '测试会员' || id
 WHERE nickname ~ '^[0-9]{1,2}$';
