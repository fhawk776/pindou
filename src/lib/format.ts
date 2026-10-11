/**
 * 展示格式化工具
 *
 * 注意：所有格式化只在"展示层"做，数据库和 API 内部一律传整数分。
 */

/** 分 → 元字符串，用于 API 之外的日志/文本 */
export function balanceTransactionsToCents(v: number): number {
  return Math.round(v);
}

/** 格式化金额为带千分位的元，如 1234567 → "12,345.67" */
export function formatCents(cents: number): string {
  const negative = cents < 0;
  const abs = Math.abs(cents);
  const yuan = Math.floor(abs / 100);
  const fen = abs % 100;
  const withComma = yuan.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${negative ? '-' : ''}${withComma}.${String(fen).padStart(2, '0')}`;
}
