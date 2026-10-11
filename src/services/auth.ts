/**
 * 认证与会话
 *
 * 安全设计：
 *   - 密码用 Argon2id 哈希，绝不明文存储、绝不写入日志
 *   - 会话 token 随机生成，数据库只存 SHA-256 哈希
 *     即使数据库泄露，攻击者也无法用哈希反推出可用的 Cookie
 *   - 双重超时：绝对超时（登录后最长 8 小时）+ 闲置超时（2 小时无操作）
 *   - 登录失败计数与账号锁定，防止暴力破解
 */
import { randomBytes, createHash } from 'node:crypto';
import argon2 from 'argon2';
import type pg from 'pg';
import { getPool, withTransaction } from '../lib/db.js';
import { config } from '../lib/config.js';

export class AuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuthError';
  }
}

export interface SessionUser {
  id: number;
  username: string;
  displayName: string;
  role: 'admin' | 'staff';
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** 创建管理员账号（初始化用） */
export async function createUser(params: {
  username: string;
  password: string;
  displayName?: string;
  role?: 'admin' | 'staff';
}): Promise<number> {
  const { username, password, displayName = '', role = 'admin' } = params;

  if (!/^[a-zA-Z0-9_]{3,32}$/.test(username)) {
    throw new AuthError('用户名只能包含字母、数字和下划线，长度 3-32');
  }
  assertPasswordStrength(password);

  const passwordHash = await argon2.hash(password, {
    type: argon2.argon2id,
    memoryCost: 19456, // 19 MiB，兼顾安全与低配服务器
    timeCost: 2,
    parallelism: 1,
  });

  const { rows } = await getPool().query(
    `INSERT INTO users (username, password_hash, display_name, role)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (username) DO UPDATE
       SET password_hash = EXCLUDED.password_hash,
           display_name = EXCLUDED.display_name,
           role = EXCLUDED.role,
           is_active = true,
           failed_count = 0,
           locked_until = NULL
     RETURNING id`,
    [username, passwordHash, displayName, role]
  );
  return Number(rows[0].id);
}

/** 密码强度：至少 10 位，含大小写字母和数字 */
export function assertPasswordStrength(password: string): void {
  if (password.length < 10) throw new AuthError('密码至少需要 10 位');
  if (!/[a-z]/.test(password)) throw new AuthError('密码需包含小写字母');
  if (!/[A-Z]/.test(password)) throw new AuthError('密码需包含大写字母');
  if (!/[0-9]/.test(password)) throw new AuthError('密码需包含数字');
}

export async function changePassword(params: {
  userId: number;
  oldPassword: string;
  newPassword: string;
}): Promise<void> {
  const { userId, oldPassword, newPassword } = params;
  assertPasswordStrength(newPassword);

  await withTransaction(async (client) => {
    const { rows } = await client.query('SELECT password_hash FROM users WHERE id = $1', [userId]);
    if (rows.length === 0) throw new AuthError('用户不存在');

    const ok = await argon2.verify(rows[0].password_hash as string, oldPassword);
    if (!ok) throw new AuthError('原密码不正确');

    const hash = await argon2.hash(newPassword, {
      type: argon2.argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1,
    });
    await client.query('UPDATE users SET password_hash = $1 WHERE id = $2', [hash, userId]);

    // 改密后吊销所有其他会话，强制重新登录
    await client.query(
      'UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL',
      [userId]
    );
  });
}

/**
 * 登录。成功返回会话 token（应写入 HttpOnly Cookie）。
 */
export async function login(params: {
  username: string;
  password: string;
  ip: string;
  userAgent?: string;
}): Promise<{ token: string; expiresAt: Date; user: SessionUser }> {
  const { username, password, ip, userAgent } = params;

  const result = await withTransaction(async (client) => {
    const { rows } = await client.query(
      `SELECT id, username, password_hash, display_name, role, is_active, failed_count, locked_until
         FROM users WHERE username = $1 FOR UPDATE`,
      [username]
    );

    // 记录尝试（无论成败，用于限速分析）
    const recordAttempt = async (success: boolean) => {
      await client.query(
        'INSERT INTO login_attempts (username, ip, success) VALUES ($1,$2,$3)',
        [username, ip, success]
      );
    };

    if (rows.length === 0) {
      // 即使用户不存在也执行一次哈希校验，避免通过响应时间探测用户名是否存在
      await argon2.hash('dummy-password-for-timing', { type: argon2.argon2id, memoryCost: 19456, timeCost: 2 });
      await recordAttempt(false);
      throw new AuthError('用户名或密码不正确');
    }

    const user = rows[0];

    if (!user.is_active) {
      await recordAttempt(false);
      throw new AuthError('账号已停用');
    }

    if (user.locked_until && new Date(user.locked_until) > new Date()) {
      await recordAttempt(false);
      const mins = Math.ceil((new Date(user.locked_until).getTime() - Date.now()) / 60000);
      throw new AuthError(`账号已锁定，请 ${mins} 分钟后再试`);
    }

    const passwordOk = await argon2.verify(user.password_hash as string, password);

    if (!passwordOk) {
      const newFailed = (user.failed_count as number) + 1;
      const shouldLock = newFailed >= config.security.maxLoginFailures;
      await client.query(
        `UPDATE users SET failed_count = $1, locked_until = $2 WHERE id = $3`,
        [
          newFailed,
          shouldLock ? new Date(Date.now() + config.security.lockoutMs) : null,
          user.id,
        ]
      );
      await recordAttempt(false);
      throw new AuthError(
        shouldLock
          ? `密码错误次数过多，账号已锁定 ${config.security.lockoutMs / 60000} 分钟`
          : '用户名或密码不正确'
      );
    }

    // 登录成功：清零失败计数
    await client.query(
      'UPDATE users SET failed_count = 0, locked_until = NULL, last_login_at = now() WHERE id = $1',
      [user.id]
    );
    await recordAttempt(true);

    // 创建会话
    const token = randomBytes(32).toString('base64url');
    const now = Date.now();
    const expiresAt = new Date(now + config.session.absoluteTtlMs);
    const idleExpiresAt = new Date(now + config.session.idleTtlMs);

    await client.query(
      `INSERT INTO sessions (user_id, token_hash, expires_at, idle_expires_at, ip, user_agent)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [user.id, hashToken(token), expiresAt, idleExpiresAt, ip, userAgent ?? null]
    );

    return {
      token,
      expiresAt,
      user: {
        id: Number(user.id),
        username: user.username as string,
        displayName: user.display_name as string,
        role: user.role as 'admin' | 'staff',
      },
    };
  });

  return result;
}

/** 校验会话 token，返回用户；无效则抛错 */
export async function verifySession(token: string): Promise<SessionUser> {
  const { rows } = await getPool().query(
    `SELECT s.id AS session_id, s.expires_at, s.idle_expires_at,
            u.id, u.username, u.display_name, u.role, u.is_active
       FROM sessions s
       JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = $1 AND s.revoked_at IS NULL`,
    [hashToken(token)]
  );

  if (rows.length === 0) throw new AuthError('会话无效');

  const s = rows[0];
  const now = new Date();

  if (new Date(s.expires_at) <= now) {
    await getPool().query('UPDATE sessions SET revoked_at = now() WHERE id = $1', [s.session_id]);
    throw new AuthError('会话已过期，请重新登录');
  }
  if (new Date(s.idle_expires_at) <= now) {
    await getPool().query('UPDATE sessions SET revoked_at = now() WHERE id = $1', [s.session_id]);
    throw new AuthError('长时间未操作，请重新登录');
  }
  if (!s.is_active) throw new AuthError('账号已停用');

  // 滑动续期：闲置超时顺延
  await getPool().query(
    'UPDATE sessions SET idle_expires_at = $1 WHERE id = $2',
    [new Date(Date.now() + config.session.idleTtlMs), s.session_id]
  );

  return {
    id: Number(s.id),
    username: s.username as string,
    displayName: s.display_name as string,
    role: s.role as 'admin' | 'staff',
  };
}

export async function logout(token: string): Promise<void> {
  await getPool().query(
    'UPDATE sessions SET revoked_at = now() WHERE token_hash = $1',
    [hashToken(token)]
  );
}

/** 清理过期会话（可定时调用） */
export async function cleanupSessions(): Promise<number> {
  const { rowCount } = await getPool().query(
    `DELETE FROM sessions WHERE expires_at < now() OR revoked_at < now() - interval '7 days'`
  );
  return rowCount ?? 0;
}
