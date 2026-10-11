/**
 * 测试环境守卫
 *
 * 背景：
 *   数据库相关的测试在连不上库时会 t.skip()，而 Node 的测试运行器
 *   对"全部跳过"仍返回成功。这会造成"npm test 绿了但什么都没测"的假通过，
 *   是比测试失败更危险的情况。
 *
 * 因此所有集成测试在启动阶段调用本模块：
 *   · 连不上数据库 → 直接抛错，整个测试文件失败
 *   · 连上了但不是测试库 → 拒绝运行，防止误清开发库或正式库的数据
 */
import { getPool } from '../../src/lib/db.js';

/** 允许作为测试目标的数据库名 */
const ALLOWED_DB_PATTERNS = [
  /^pindou_test$/,
  /^pindou_test_/,
  /_test$/,
];

let checked = false;

/**
 * 校验测试环境。在 describe 的 before 钩子里调用。
 * 不满足条件时抛出异常，让测试文件以失败告终，而不是静默跳过。
 */
export async function assertTestDatabase(): Promise<void> {
  if (checked) return;

  const dbName = process.env.PGDATABASE ?? '';

  if (!dbName) {
    throw new Error(
      '\n' +
      '╭──────────────────────────────────────────────────────────────╮\n' +
      '│ 未指定测试数据库，拒绝运行集成测试                            │\n' +
      '├──────────────────────────────────────────────────────────────┤\n' +
      '│ 集成测试会写入并清理数据，必须显式指向测试库。                │\n' +
      '│                                                              │\n' +
      '│ 请执行：                                                     │\n' +
      '│   $env:PGDATABASE = \'pindou_test\'                            │\n' +
      '│   npm run test:db                                            │\n' +
      '╰──────────────────────────────────────────────────────────────╯\n'
    );
  }

  if (!ALLOWED_DB_PATTERNS.some((p) => p.test(dbName))) {
    throw new Error(
      `\n拒绝运行：目标数据库 "${dbName}" 看起来不是测试库。\n` +
      `集成测试会清理数据，只允许对名称以 _test 结尾的库运行。\n`
    );
  }

  // 真正连一次，确认可达
  try {
    const { rows } = await getPool().query('SELECT current_database() AS db');
    const actual = rows[0]?.db as string;
    if (!ALLOWED_DB_PATTERNS.some((p) => p.test(actual))) {
      throw new Error(`实际连接的数据库是 "${actual}"，不是测试库`);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `\n无法连接测试数据库 "${dbName}"：${msg}\n` +
      `请先启动 PostgreSQL 并确认库已创建：\n` +
      `  .\\scripts\\pg.ps1 start\n` +
      `  .\\scripts\\pg.ps1 createdb\n`
    );
  }

  checked = true;
}
