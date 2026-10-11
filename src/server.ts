/**
 * 拼豆店会员管理系统 - API 服务入口
 *
 * 部署形态：单进程 Fastify，监听 127.0.0.1:3100，由 Nginx 反向代理。
 * 资源约束：目标常驻内存 90-130 MiB，容器上限 320 MiB。
 */
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { config } from './lib/config.js';
import { closePool, getPool } from './lib/db.js';
import { AuthError, verifySession, type SessionUser } from './services/auth.js';
import { registerRoutes } from './routes/index.js';

declare module 'fastify' {
  interface FastifyRequest {
    user?: SessionUser;
  }
}

/** 判断可选的日志美化依赖是否可用 */
function canResolvePinoPretty(): boolean {
  try {
    // 仅探测是否存在，不使用其导出
    import.meta.resolve?.('pino-pretty');
    return true;
  } catch {
    return false;
  }
}

export async function buildServer() {
  // 开发模式下用 pino-pretty 美化日志，但它不是运行必需依赖。
  // 若无此包则退化为标准 JSON 日志，避免因缺少可选依赖而启动失败。
  const usePretty = !config.isProd && canResolvePinoPretty();

  const app = Fastify({
    logger: {
      level: config.logLevel,
      // 敏感字段一律脱敏，绝不写进日志
      redact: {
        paths: [
          'req.headers.cookie',
          'req.headers.authorization',
          'req.body.password',
          'req.body.newPassword',
          'req.body.oldPassword',
          'res.headers["set-cookie"]',
        ],
        censor: '[已脱敏]',
      },
      ...(usePretty
        ? { transport: { target: 'pino-pretty', options: { translateTime: 'HH:MM:ss', ignore: 'pid,hostname' } } }
        : {}),
    },
    // 反向代理后需要信任 Nginx 传来的真实 IP
    trustProxy: true,
    bodyLimit: 1024 * 1024, // 1 MiB，防止超大请求体打爆内存
  });

  await app.register(cookie, {
    secret: config.session.secret,
    hook: 'onRequest',
  });

  await app.register(helmet, {
    // 前端使用内联事件处理器（onclick），因此关闭严格 CSP。
    // 生产环境由 Nginx 下发更合适的策略，或改为事件委托后再收紧。
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
    // 允许同源资源加载
    crossOriginResourcePolicy: { policy: 'same-origin' },
  });

  await app.register(rateLimit, {
    global: false, // 只对特定路由启用
    max: 100,
    timeWindow: '1 minute',
  });

  // ---- 认证钩子：解析会话 ----
  app.addHook('onRequest', async (req) => {
    const token = req.cookies[config.session.cookieName];
    if (!token) return;
    try {
      req.user = await verifySession(token);
    } catch {
      // 会话无效就清掉 Cookie，让前端跳登录
      req.user = undefined;
    }
  });

  // ---- 统一错误处理 ----
  app.setErrorHandler((error: unknown, req, reply) => {
    const err = error as Error & { statusCode?: number; code?: string; name?: string };

    // 业务校验类错误应当以 4xx 返回并保留原始消息，
    // 否则前端只会看到"服务器内部错误"，无法知道哪里填错了。
    const BUSINESS_ERRORS = new Set([
      'MemberError', 'TableError', 'LedgerError', 'AuthError',
      'MoneyError', 'BalanceError', 'PointsError', 'OrderError',
    ]);
    const isBusinessError = err.name !== undefined && BUSINESS_ERRORS.has(err.name);

    const status =
      err instanceof AuthError ? 401
      : err.statusCode && err.statusCode >= 400 ? err.statusCode
      : isBusinessError ? 400
      : 500;

    // 只有真正的服务端故障才记录完整堆栈
    if (status >= 500) {
      req.log.error({ err: error }, '服务器内部错误');
    } else {
      req.log.info({ msg: err.message, code: err.code }, '请求被拒绝');
    }

    // 不把内部错误细节暴露给客户端；业务错误则原样返回，便于店员知道原因
    const message = status >= 500 ? '服务器内部错误' : err.message;
    reply.status(status).send({
      error: {
        code: err.code ?? (status >= 500 ? 'INTERNAL_ERROR' : 'BUSINESS_ERROR'),
        message,
      },
    });
  });

  // ---- 健康检查（给 Nginx / 监控用，不暴露内部信息） ----
  app.get('/healthz', async (_req, reply) => {
    try {
      await getPool().query('SELECT 1');
      return reply.send({ status: 'ok' });
    } catch {
      return reply.status(503).send({ status: 'db_unavailable' });
    }
  });

  await registerRoutes(app);

  // ---- 前端静态文件 ----
  // 生产环境由 Nginx 直接提供静态文件，此处用于开发与单机部署。
  // 依次尝试几个可能的位置，兼容 tsx 直跑与编译后运行两种情况。
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(here, '..', 'web'),       // src/server.ts  → <root>/web
    join(here, '..', '..', 'web'), // dist/server.js → <root>/web
    join(process.cwd(), 'web'),
  ];
  const webRoot = candidates.find((p) => existsSync(join(p, 'index.html')));

  if (webRoot) {
    app.log.info(`静态文件目录: ${webRoot}`);
    await app.register(fastifyStatic, {
      root: webRoot,
      prefix: '/',
      // @fastify/static v10 起，setHeaders 的第一个参数是 FastifyReply（不再是原生 res）
      setHeaders(reply, path) {
        // HTML 不缓存，避免更新后用户拿到旧页面
        if (path.endsWith('.html')) reply.header('Cache-Control', 'no-cache');
        else reply.header('Cache-Control', 'public, max-age=300');
      },
      // 安全加固：白名单，只放行前端真正用到的文件。
      // 静态文件组件历史上出现过路径遍历漏洞（GHSA-pr96-94w5-mx2h 等），
      // 白名单保证即使组件出问题，也无法触及这几个文件之外的任何内容
      // —— 包括同目录上级的 .env（内含数据库密码）。
      allowedPath(pathName) {
        // 注意要放行 '/'（根路径，由 index 选项解析为 index.html）
        return ['/', '/index.html', '/app.js', '/app.css', '/favicon.ico'].includes(pathName);
      },
      dotfiles: 'deny',     // 显式拒绝 .env、.git 等隐藏文件
      list: false,          // 禁止目录列表
      index: ['index.html'],
    });
  } else {
    app.log.warn('未找到前端静态文件目录，仅提供 API');
  }

  // 单页应用：未匹配的非 API 路径回落到 index.html
  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith('/api/') || !webRoot) {
      reply.status(404).send({ error: { code: 'NOT_FOUND', message: '接口不存在' } });
      return;
    }
    reply.type('text/html').sendFile('index.html');
  });

  return app;
}

async function main() {
  const app = await buildServer();

  const shutdown = async (signal: string) => {
    app.log.info(`收到 ${signal}，正在优雅关闭...`);
    try {
      await app.close();
      await closePool();
      process.exit(0);
    } catch (err) {
      app.log.error(err);
      process.exit(1);
    }
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  try {
    await app.listen({ port: config.port, host: config.host });
    app.log.info(`拼豆店 API 已启动: http://${config.host}:${config.port}`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

// 仅在直接运行时启动（被测试 import 时不启动）
const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop() ?? '');
if (isMain || process.env.START_SERVER === '1') {
  void main();
}
