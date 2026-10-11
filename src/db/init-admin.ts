/**
 * 初始化管理员账号
 *
 * 用法（密码从环境变量读取，不写入任何文件、不出现在命令行历史里）：
 *   $env:ADMIN_PASSWORD = "你的密码"; npx tsx src/db/init-admin.ts
 *
 * 密码要求：至少 10 位，含大小写字母和数字。
 */
import { createUser, AuthError } from '../services/auth.js';
import { closePool } from '../lib/db.js';

const username = process.env.ADMIN_USERNAME ?? 'admin';
const password = process.env.ADMIN_PASSWORD;
const displayName = process.env.ADMIN_DISPLAY_NAME ?? '管理员';

if (!password) {
  console.error('错误：请先设置 ADMIN_PASSWORD 环境变量。');
  console.error('示例（PowerShell）：$env:ADMIN_PASSWORD = "你的密码"; npx tsx src/db/init-admin.ts');
  process.exit(1);
}

try {
  const id = await createUser({ username, password, displayName, role: 'admin' });
  console.log(`✓ 管理员已就绪`);
  console.log(`  用户名: ${username}`);
  console.log(`  显示名: ${displayName}`);
  console.log(`  ID: ${id}`);
  console.log(`\n密码已使用 Argon2id 哈希存储，明文未落盘。`);
} catch (err) {
  if (err instanceof AuthError) {
    console.error(`✗ ${err.message}`);
  } else {
    console.error('✗ 初始化失败:', err instanceof Error ? err.message : err);
  }
  process.exitCode = 1;
} finally {
  await closePool();
}
