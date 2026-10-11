-- ============================================================================
-- 清空业务数据，保留表结构与配置
--
-- 用途：把开发库恢复到"全新开店"状态，清掉测试过程中产生的
--       重复会员、异常开台、历史差额流水等问题数据。
--
-- 保留：
--   · 所有表结构与约束（迁移记录不动）
--   · products 价目表
--   · settings 配置
--   · tables 桌位
--   · users 登录账号
--
-- 清空：
--   · 会员及其权益、开台记录、订单、流水、审计日志
-- ============================================================================

BEGIN;

-- 顺序遵循外键依赖，从"引用方"删到"被引用方"
TRUNCATE TABLE
  revenue_ledger,      -- 引用 orders / members / table_sessions
  card_records,        -- 引用 orders / members
  order_items,         -- 引用 orders / products
  audit_logs,          -- 引用 users
  login_attempts,
  idempotency_keys,
  table_sessions,      -- 引用 tables / members / products
  orders,              -- 引用 members / table_sessions
  members
RESTART IDENTITY CASCADE;

-- sessions 保留表结构，清掉所有登录态（避免沿用旧会话）
TRUNCATE TABLE sessions RESTART IDENTITY CASCADE;

COMMIT;

-- 校验
SELECT 'members' AS 表, COUNT(*)::text AS 剩余 FROM members
UNION ALL SELECT 'table_sessions', COUNT(*)::text FROM table_sessions
UNION ALL SELECT 'orders', COUNT(*)::text FROM orders
UNION ALL SELECT 'revenue_ledger', COUNT(*)::text FROM revenue_ledger
UNION ALL SELECT 'card_records', COUNT(*)::text FROM card_records
UNION ALL SELECT 'products', COUNT(*)::text FROM products
UNION ALL SELECT 'tables', COUNT(*)::text FROM tables
UNION ALL SELECT 'users', COUNT(*)::text FROM users;
