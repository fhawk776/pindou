/**
 * 极简数据库迁移执行器
 *
 * 设计取舍：不引入 node-pg-migrate 等依赖，因为需求简单且需要完全掌控事务边界。
 * 每个迁移文件在一个事务内执行，失败自动回滚，保证不会留下半截状态。
 *
 * 用法：
 *   npm run migrate          # 执行全部未应用的迁移
 *   npm run migrate:status   # 查看状态
 *   npm run migrate:down     # 回滚最后一个迁移（需要对应的 .down.sql）
 */
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { getPool, closePool } from '../lib/db.js';

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), 'migrations');

interface Migration {
  version: string;
  name: string;
  sql: string;
  checksum: string;
}

async function ensureMigrationsTable(): Promise<void> {
  const pool = getPool();
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version     TEXT PRIMARY KEY,
      name        TEXT NOT NULL,
      checksum    TEXT NOT NULL,
      applied_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      duration_ms INTEGER
    )
  `);
}

async function loadMigrations(): Promise<Migration[]> {
  const files = (await readdir(MIGRATIONS_DIR))
    .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
    .sort();

  const migrations: Migration[] = [];
  for (const file of files) {
    const match = /^(\d+)_(.+)\.sql$/.exec(file);
    if (!match) throw new Error(`迁移文件名不合规（应为 NNN_name.sql）: ${file}`);
    const sql = await readFile(join(MIGRATIONS_DIR, file), 'utf8');
    migrations.push({
      version: match[1]!,
      name: match[2]!,
      sql,
      checksum: createHash('sha256').update(sql).digest('hex'),
    });
  }
  return migrations;
}

async function appliedVersions(): Promise<Map<string, string>> {
  const pool = getPool();
  const { rows } = await pool.query<{ version: string; checksum: string }>(
    'SELECT version, checksum FROM schema_migrations'
  );
  return new Map(rows.map((r) => [r.version, r.checksum]));
}

async function up(): Promise<void> {
  await ensureMigrationsTable();
  const migrations = await loadMigrations();
  const applied = await appliedVersions();

  let count = 0;
  for (const m of migrations) {
    const existing = applied.get(m.version);

    // 已应用的迁移内容被改动过 —— 这是危险信号，必须人工介入
    if (existing && existing !== m.checksum) {
      throw new Error(
        `迁移 ${m.version}_${m.name} 已应用，但文件内容已被修改。\n` +
          `这会导致本地与线上结构不一致。请新增一个迁移文件，而不是修改历史迁移。`
      );
    }
    if (existing) continue;

    const pool = getPool();
    const client = await pool.connect();
    const started = Date.now();
    try {
      await client.query('BEGIN');
      await client.query(m.sql);
      await client.query(
        `INSERT INTO schema_migrations (version, name, checksum, duration_ms)
         VALUES ($1, $2, $3, $4)`,
        [m.version, m.name, m.checksum, Date.now() - started]
      );
      await client.query('COMMIT');
      console.log(`  ✔ ${m.version}_${m.name} (${Date.now() - started}ms)`);
      count++;
    } catch (err) {
      await client.query('ROLLBACK');
      console.error(`  ✘ ${m.version}_${m.name} 失败，已回滚`);
      throw err;
    } finally {
      client.release();
    }
  }

  console.log(count === 0 ? '数据库已是最新，无需迁移。' : `完成 ${count} 个迁移。`);
}

async function down(): Promise<void> {
  await ensureMigrationsTable();
  const pool = getPool();
  const { rows } = await pool.query<{ version: string; name: string }>(
    'SELECT version, name FROM schema_migrations ORDER BY version DESC LIMIT 1'
  );
  const last = rows[0];
  if (!last) {
    console.log('没有可回滚的迁移。');
    return;
  }

  const downFile = join(MIGRATIONS_DIR, `${last.version}_${last.name}.down.sql`);
  let sql: string;
  try {
    sql = await readFile(downFile, 'utf8');
  } catch {
    throw new Error(`找不到回滚脚本: ${downFile}\n请手动编写该文件后再回滚。`);
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(sql);
    await client.query('DELETE FROM schema_migrations WHERE version = $1', [last.version]);
    await client.query('COMMIT');
    console.log(`  ✔ 已回滚 ${last.version}_${last.name}`);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function status(): Promise<void> {
  await ensureMigrationsTable();
  const migrations = await loadMigrations();
  const applied = await appliedVersions();

  console.log('\n迁移状态：\n');
  for (const m of migrations) {
    const existing = applied.get(m.version);
    const mark = !existing ? '待执行' : existing === m.checksum ? '已应用' : '内容已变更⚠';
    console.log(`  [${mark}] ${m.version}_${m.name}`);
  }
  console.log();
}

const command = process.argv[2] ?? 'up';
try {
  if (command === 'up') await up();
  else if (command === 'down') await down();
  else if (command === 'status') await status();
  else {
    console.error(`未知命令: ${command}（可用: up / down / status）`);
    process.exit(1);
  }
} catch (err) {
  console.error('\n迁移失败：', err instanceof Error ? err.message : err);
  process.exitCode = 1;
} finally {
  await closePool();
}
