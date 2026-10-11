/**
 * 审计日志写入（只追加）
 */
import type pg from 'pg';

export async function writeAudit(
  client: pg.PoolClient,
  entry: {
    actorId: number | null;
    action: string;
    targetType: string;
    targetId: number | null;
    before?: unknown;
    after?: unknown;
    summary: string;
    ip?: string;
    userAgent?: string;
  }
): Promise<void> {
  let actorName = '';
  if (entry.actorId !== null) {
    const { rows } = await client.query('SELECT username FROM users WHERE id = $1', [entry.actorId]);
    actorName = (rows[0]?.username as string) ?? '';
  }
  await client.query(
    `INSERT INTO audit_logs
       (actor_id, actor_name, action, target_type, target_id, before_data, after_data,
        summary, ip, user_agent)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [
      entry.actorId, actorName, entry.action, entry.targetType, entry.targetId,
      entry.before === undefined ? null : JSON.stringify(entry.before),
      entry.after === undefined ? null : JSON.stringify(entry.after),
      entry.summary, entry.ip ?? null, entry.userAgent ?? null,
    ]
  );
}
