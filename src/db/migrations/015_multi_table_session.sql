-- ============================================================================
-- 迁移 015：一次开台可占用多个桌位（双人套餐开两个台）
--
-- 【业务场景】
--   店里是单人工位。顾客买「双人套餐」时，两个人要各坐一张桌子，
--   但他们买的是**一个套餐、一个价格、一次结账**。
--   因此要把「开台」与「桌位」的关系从 1:1 改成 1:N。
--
-- 【规则（店主确认）】
--   · 开台时由店员选占几个台，默认取套餐的 people_count
--   · 双人套餐的价格已包含两个人 → 整组一次结账
--   · 超时费整组只收一次
--   · 一个人先走不影响计时，最后一起结
--
--   注意：后三条**天然满足** —— 因为仍然是一个 table_session
--   （一套计时、一个订单、一次超时费），改的只是"占几张桌子"。
--
-- 【为什么用关联表而不是 table_id 数组】
--   数组无法建外键、无法做唯一约束、聚合查询也别扭。
--   关联表是标准做法，还能保留「这一台当时属于哪个会话」的历史。
--
-- 【并发安全】
--   开台时对目标桌位做 FOR UPDATE，再检查是否存在活跃会话占用。
--   两个事务同时抢同一桌位时，后到者会等锁，拿到锁后能看见前者的会话，从而拒绝。
-- ============================================================================

CREATE TABLE IF NOT EXISTS session_tables (
  session_id  BIGINT      NOT NULL REFERENCES table_sessions(id) ON DELETE CASCADE,
  table_id    BIGINT      NOT NULL REFERENCES tables(id) ON DELETE RESTRICT,
  -- 主台：换套餐、看板带出顾客信息以它为准
  is_primary  BOOLEAN     NOT NULL DEFAULT false,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (session_id, table_id)
);

CREATE INDEX IF NOT EXISTS idx_session_tables_table ON session_tables(table_id);

-- 一个会话最多一个主台
CREATE UNIQUE INDEX IF NOT EXISTS uq_session_tables_primary
  ON session_tables(session_id) WHERE is_primary;

COMMENT ON TABLE session_tables IS
  '开台占用的桌位。一个会话可占多台（双人套餐开两个台）；一个台同时只能有一个活跃会话';
COMMENT ON COLUMN session_tables.is_primary IS
  '主台（一般是第一个选的桌位）。换套餐与看板展示以它为准';

-- 回填：已有会话按原来的 table_id 建立对应关系（含历史已结束的，便于追溯）
INSERT INTO session_tables (session_id, table_id, is_primary)
SELECT id, table_id, true FROM table_sessions
ON CONFLICT DO NOTHING;
