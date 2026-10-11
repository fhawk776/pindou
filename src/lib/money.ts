/**
 * 金额计算工具
 *
 * 铁律：金额一律用整数"分"表示，禁止在任何地方使用浮点数参与金额运算。
 * JavaScript 的 Number 是双精度浮点，0.1 + 0.2 !== 0.3，用在钱上必然出账错。
 * 本文件是唯一允许做金额换算的地方。
 */

/** 分：整数，系统内金额的唯一表示 */
export type Cents = number;

/** 校验是否为合法的分值（非负整数，且在安全整数范围内） */
export function assertCents(value: unknown, field = 'amount'): Cents {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new MoneyError(`${field} 必须是整数分（收到: ${String(value)}）`);
  }
  if (value < 0) throw new MoneyError(`${field} 不能为负数`);
  return value;
}

export class MoneyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MoneyError';
  }
}

/**
 * 元 → 分。用于解析用户输入。
 * 只接受最多两位小数的字符串或数字，用字符串解析避免浮点误差。
 */
export function yuanToCents(input: string | number): Cents {
  const s = typeof input === 'number' ? input.toString() : input.trim();
  if (!/^-?\d+(\.\d{1,2})?$/.test(s)) {
    throw new MoneyError(`金额格式不正确（最多两位小数）: ${s}`);
  }
  const negative = s.startsWith('-');
  const [intPart = '0', decPart = ''] = s.replace('-', '').split('.');
  const cents = Number.parseInt(intPart, 10) * 100 + Number.parseInt(decPart.padEnd(2, '0') || '0', 10);
  return negative ? -cents : cents;
}

/** 分 → 元字符串，仅用于展示 */
export function centsToYuan(cents: Cents): string {
  const negative = cents < 0;
  const abs = Math.abs(cents);
  const yuan = Math.floor(abs / 100);
  const fen = abs % 100;
  return `${negative ? '-' : ''}${yuan}.${String(fen).padStart(2, '0')}`;
}

/**
 * 按万分比计算比例金额，向下取整。
 * 例：applyBp(10000, 9500) = 9500  （100元打95折 = 95元）
 */
export function applyBp(cents: Cents, bp: number): Cents {
  if (!Number.isSafeInteger(cents) || cents < 0) throw new MoneyError('金额必须是非负整数分');
  if (!Number.isSafeInteger(bp) || bp < 0) throw new MoneyError('比例必须是非负整数万分比');
  return Math.floor((cents * bp) / 10000);
}

/**
 * 计算订单应付总额。
 * 所有输入输出均为整数分，结果不会为负。
 */
export function computeOrderTotal(params: {
  subtotalCents: Cents;
  discountCents: Cents;
  pointsDeductCents: Cents;
}): Cents {
  const { subtotalCents, discountCents, pointsDeductCents } = params;
  const total = subtotalCents - discountCents - pointsDeductCents;
  return Math.max(0, total);
}

/**
 * 计算消费可获得的积分。
 * 规则：按实付金额（不含余额支付部分？—— 含，因为余额也是钱）计算。
 * 此处按"实收金额"计算，向下取整。
 */
export function computePointsEarned(params: {
  paidCents: Cents;          // 实际支付金额（余额+现金+其他）
  earnPerYuan: number;       // 每元得几分
  rateBp: number;            // 等级倍率万分比
}): number {
  const { paidCents, earnPerYuan, rateBp } = params;
  if (paidCents <= 0 || earnPerYuan <= 0) return 0;
  const base = Math.floor((paidCents / 100) * earnPerYuan);
  return Math.floor((base * rateBp) / 10000);
}

/**
 * 计算积分抵扣金额。
 * redeemRateBp：多少积分抵 1 分钱。默认 100 表示 100 积分 = 1 元（即 1 积分 = 1 分）。
 */
export function computePointsDeductCents(params: {
  pointsToUse: number;
  redeemRateBp: number;
  maxDeductCents: Cents;
}): Cents {
  const { pointsToUse, redeemRateBp, maxDeductCents } = params;
  if (pointsToUse <= 0 || redeemRateBp <= 0) return 0;
  const raw = Math.floor((pointsToUse * 10000) / redeemRateBp / 100);
  return Math.min(raw, maxDeductCents);
}
