/**
 * 数据库连接池
 *
 * 生产环境为 2 vCPU / 2 GiB 的机器，可用内存紧张，连接池必须严格控制。
 * 每个 PostgreSQL 连接约占 5-10 MB 服务端内存，池上限 10 已是这台机器的合理上限。
 */
import pg from 'pg';
import { config } from './config.js';

const { Pool } = pg;

let pool: pg.Pool | undefined;

export function getPool(): pg.Pool {
  if (!pool) {
    pool = new Pool({
      host: config.db.host,
      port: config.db.port,
      database: config.db.database,
      user: config.db.user,
      password: config.db.password,
      max: config.db.poolMax,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
      // 金额一律以字符串读取 BIGINT，避免 JS Number 精度问题
      // （BIGINT 超过 2^53 时 Number 会丢精度，虽然实际金额不会那么大，
      //   但养成习惯更安全；需要数值时由应用层显式转换）
      application_name: 'pindou-api',
    });

    pool.on('error', (err) => {
      console.error('[db] 空闲连接异常:', err.message);
    });
  }
  return pool;
}

/**
 * 在一个事务中执行回调。回调抛错则自动回滚。
 * 所有涉及资金的写操作都必须走这里。
 */
export async function withTransaction<T>(
  fn: (client: pg.PoolClient) => Promise<T>
): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackErr) {
      console.error('[db] 回滚失败:', rollbackErr);
    }
    throw err;
  } finally {
    client.release();
  }
}

/** 在事务中锁定会员行，防止并发扣款导致余额错乱 */
export async function lockMember(
  client: pg.PoolClient,
  memberId: number
): Promise<{ id: number; balance_cents: string; gift_balance_cents: string; points_balance: number }> {
  const { rows } = await client.query(
    `SELECT id, balance_cents, gift_balance_cents, points_balance
       FROM members WHERE id = $1 FOR UPDATE`,
    [memberId]
  );
  if (rows.length === 0) throw new Error('会员不存在');
  return rows[0];
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = undefined;
  }
}
