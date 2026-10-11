/**
 * 日期工具（统一时区口径）
 *
 * 【为什么单独放一层】
 *   办卡（members）和开台（tables）都要算权益起止日期。
 *   如果各自实现一份，迟早会出现「同一个产品在不同入口算出不同到期日」。
 *   这里集中实现，两边共用。
 *
 * 【时区约定】
 *   门店在上海。所有"今天"都按 Asia/Shanghai 计算，
 *   绝不使用 toISOString() 取日期 —— 那是 UTC，会差 8 小时导致日期错一天。
 */

const TZ = 'Asia/Shanghai';

/** 把一个 Date 或字符串格式化成 YYYY-MM-DD（按门店时区） */
export function toDateString(value: unknown, timeZone = TZ): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value.slice(0, 10);
  if (value instanceof Date) {
    // 用 DateTimeFormat 而非 toISOString()，避免时区偏移导致日期前移一天
    return new Intl.DateTimeFormat('en-CA', {
      timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(value);
  }
  return null;
}

/** 店里今天的日期（YYYY-MM-DD） */
export function shopToday(timeZone = TZ): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}

/**
 * 日期字符串加减天数，返回 YYYY-MM-DD。
 *
 * 【必须用 Date.UTC 做纯日历运算】
 *   若写成 `new Date(\`${from}T00:00:00+08:00\`).getTime() + n*86400000`
 *   再 `.toISOString().slice(0,10)`，取到的是 **UTC 日期**：
 *   北京时间 10/18 00:00 的 UTC 表示是 10/17T16:00Z，到期日会少一天。
 *   用 Date.UTC 构造再取 UTC 日期，等于纯日历加减，与时区无关。
 */
export function addDaysStr(from: string, n: number): string {
  const [y = 1970, m = 1, d = 1] = from.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

/**
 * 由起始日与天数算出到期日。
 * 语义：7 天卡 = 覆盖 7 个日历日，即「10/11 起，10/17 止」。
 * 因此到期日 = 起始日 + (天数 - 1)。
 */
export function cardExpiryFrom(start: string, days: number): string {
  return addDaysStr(start, Math.max(0, days - 1));
}

/**
 * 判断会员卡是否已过期。
 * card_expires_at 的语义是"该日结束前有效"，因此当天不算过期。
 *
 * 注意：未激活的卡（card_expires_at 为 NULL）不走本函数判断，
 * 调用方应先用 card_started_at 是否为 NULL 区分「未激活」与「已激活」。
 */
export function isCardExpired(cardExpiresAt: unknown, timeZone = TZ): boolean {
  const expires = toDateString(cardExpiresAt, timeZone);
  if (!expires) return true;
  // 同为 YYYY-MM-DD，字符串比较即日期先后比较
  return expires < shopToday(timeZone);
}
