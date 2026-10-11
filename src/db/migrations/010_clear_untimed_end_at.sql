-- ============================================================================
-- 迁移 010：清理不限时套餐会话上残留的预计结束时间
--
-- 【问题】
--   board（限板）与 day（日卡）类套餐本身不限时，开台时 expected_end_at 应为空。
--   但历史数据里存在带 expected_end_at 的限板会话，导致看板错误地显示
--   "即将到时"甚至"已超时"。
--
--   成因有二：
--     1. 早期实现曾要求所有会话都选限时套餐，被改动后残留了旧字段；
--     2. 构造演示数据时直接改写了 expected_end_at，没有按套餐类型校验。
--
-- 【处理】
--   把现存活跃会话中，套餐类型为 board/day 或已用卡核销的，
--   一律清空 expected_end_at 与超时相关字段。
--   已结账的历史会话不动 —— 那是既成事实，改动会破坏账目一致性。
-- ============================================================================

UPDATE table_sessions ts
   SET expected_end_at = NULL,
       overtime_units = 0,
       overtime_fee_cents = 0
 WHERE ts.status = 'active'
   AND (
     -- 用卡核销：卡是全天不限时的通行权益
     ts.used_card = true
     -- 限板 / 日卡：按套餐类型判断不限时
     OR EXISTS (
       SELECT 1 FROM products p
        WHERE p.id = ts.product_id
          AND p.category IN ('board', 'day')
     )
   )
   AND (ts.expected_end_at IS NOT NULL
        OR ts.overtime_units <> 0
        OR ts.overtime_fee_cents <> 0);

-- 校验：活跃会话中不应再有不限时套餐带结束时间的情况
DO $$
DECLARE
  bad_count integer;
BEGIN
  SELECT COUNT(*) INTO bad_count
    FROM table_sessions ts
    LEFT JOIN products p ON p.id = ts.product_id
   WHERE ts.status = 'active'
     AND ts.expected_end_at IS NOT NULL
     AND (ts.used_card = true OR p.category IN ('board', 'day'));

  IF bad_count > 0 THEN
    RAISE EXCEPTION '仍有 % 条不限时会话带预计结束时间，迁移未达成目标', bad_count;
  END IF;
END $$;
