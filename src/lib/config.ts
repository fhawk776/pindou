/**
 * 配置读取
 *
 * 安全约定：数据库密码、会话密钥等只从环境变量读取，
 * 绝不硬编码在代码里，也绝不写入日志输出。
 */
function required(name: string): string {
  const v = process.env[name];
  if (!v || v.trim() === '') {
    throw new Error(`缺少必需的环境变量: ${name}`);
  }
  return v;
}

function optional(name: string, fallback: string): string {
  const v = process.env[name];
  return v && v.trim() !== '' ? v : fallback;
}

function int(name: string, fallback: number): number {
  const v = process.env[name];
  if (!v) return fallback;
  const n = Number.parseInt(v, 10);
  if (Number.isNaN(n)) throw new Error(`环境变量 ${name} 必须是整数`);
  return n;
}

const isProd = process.env.NODE_ENV === 'production';

export const config = {
  env: optional('NODE_ENV', 'development'),
  isProd,
  port: int('PORT', 3100),
  host: optional('HOST', '127.0.0.1'),

  db: {
    host: optional('PGHOST', '127.0.0.1'),
    port: int('PGPORT', 5432),
    database: optional('PGDATABASE', 'pindou'),
    user: optional('PGUSER', 'pindou_app'),
    // 允许测试环境不设密码（本地 trust 认证）
    password: process.env.PGPASSWORD ?? '',
    poolMax: int('PG_POOL_MAX', 5),
  },

  session: {
    // 生产环境必须显式提供，否则拒绝启动
    secret: isProd ? required('SESSION_SECRET') : optional('SESSION_SECRET', 'dev-only-not-for-production'),
    // 绝对超时：登录后最长有效期
    absoluteTtlMs: int('SESSION_ABSOLUTE_TTL_MS', 8 * 60 * 60 * 1000),
    // 闲置超时：多久无操作自动退出
    idleTtlMs: int('SESSION_IDLE_TTL_MS', 2 * 60 * 60 * 1000),
    cookieName: optional('SESSION_COOKIE_NAME', 'pindou_sid'),
  },

  security: {
    // 登录失败锁定
    maxLoginFailures: int('MAX_LOGIN_FAILURES', 5),
    lockoutMs: int('LOCKOUT_MS', 15 * 60 * 1000),
    // 登录接口限速
    loginRateMax: int('LOGIN_RATE_MAX', 10),
    loginRateWindowMs: int('LOGIN_RATE_WINDOW_MS', 60_000),
    // 生产环境要求 HTTPS Cookie
    cookieSecure: optional('COOKIE_SECURE', isProd ? 'true' : 'false') === 'true',
  },

  shop: {
    timezone: optional('SHOP_TIMEZONE', 'Asia/Shanghai'),
    memberNoPrefix: optional('MEMBER_NO_PREFIX', 'PD'),
  },

  logLevel: optional('LOG_LEVEL', isProd ? 'info' : 'debug'),
} as const;

export type Config = typeof config;
