#!/usr/bin/env node
/**
 * 数据库集成测试运行器
 *
 * 作用：自动准备好测试库所需的环境变量，再交给 Node 的测试运行器。
 *
 * 为什么需要它：
 *   如果测试连不上数据库，集成测试会全部跳过，而测试运行器仍返回成功 ——
 *   表现为"npm test 绿了，其实什么都没测"。这是最危险的假通过。
 *   本脚本确保测试始终指向测试库，连不上就直接以失败退出。
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// 测试库连接参数。可通过环境变量覆盖，但 PGDATABASE 必须以 _test 结尾。
const env = {
  ...process.env,
  PGHOST: process.env.PGHOST ?? '127.0.0.1',
  PGPORT: process.env.PGPORT ?? '5432',
  PGUSER: process.env.PGUSER ?? 'postgres',
  PGPASSWORD: process.env.PGPASSWORD ?? '',
  PGDATABASE: process.env.PGDATABASE ?? 'pindou_test',
  NODE_ENV: 'test',
};

if (!/_test$/.test(env.PGDATABASE)) {
  console.error('');
  console.error(`拒绝运行：PGDATABASE="${env.PGDATABASE}" 不是测试库。`);
  console.error('集成测试会清理数据，只允许对以 _test 结尾的库运行。');
  console.error('');
  process.exit(1);
}

// 预检：数据库驱动是否装好
if (!existsSync(join(ROOT, 'node_modules', 'pg'))) {
  console.error('');
  console.error('依赖未安装，请先执行：npm install');
  console.error('');
  process.exit(1);
}

const args = [
  '--test',
  '--test-concurrency=1',
  '--import',
  'tsx',
  'test/money.test.ts',
  'test/table.test.ts',
  'test/card-session.test.ts',
];

console.log(`测试库: ${env.PGUSER}@${env.PGHOST}:${env.PGPORT}/${env.PGDATABASE}`);
console.log('');

const child = spawn(process.execPath, args, {
  cwd: ROOT,
  env,
  stdio: 'inherit',
  shell: false,
});

child.on('exit', (code) => process.exit(code ?? 1));
child.on('error', (err) => {
  console.error('启动测试失败:', err.message);
  process.exit(1);
});
