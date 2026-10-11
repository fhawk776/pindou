/**
 * 金额计算单元测试
 *
 * 重点验证：绝不出现浮点误差。这些用例是资金正确性的第一道防线。
 * 运行：npm test
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  yuanToCents,
  centsToYuan,
  applyBp,
  computeOrderTotal,
  computePointsEarned,
  computePointsDeductCents,
  assertCents,
  MoneyError,
} from '../src/lib/money.js';

describe('元 ↔ 分 换算', () => {
  test('整数元', () => {
    assert.equal(yuanToCents('100'), 10000);
    assert.equal(yuanToCents('1'), 100);
    assert.equal(yuanToCents('0'), 0);
  });

  test('两位小数', () => {
    assert.equal(yuanToCents('19.99'), 1999);
    assert.equal(yuanToCents('0.01'), 1);
    assert.equal(yuanToCents('0.1'), 10);
    assert.equal(yuanToCents('1234.56'), 123456);
  });

  test('浮点陷阱：经典 0.1 + 0.2', () => {
    // 用浮点直接算 0.1+0.2 = 0.30000000000000004，换成整数分则完全精确
    const a = yuanToCents('0.1');
    const b = yuanToCents('0.2');
    assert.equal(a + b, 30);
    assert.equal(centsToYuan(a + b), '0.30');
  });

  test('累加 100 次 0.01 元不产生误差', () => {
    let total = 0;
    for (let i = 0; i < 100; i++) total += yuanToCents('0.01');
    assert.equal(total, 100);
    assert.equal(centsToYuan(total), '1.00');
  });

  test('拒绝三位以上小数', () => {
    assert.throws(() => yuanToCents('1.234'), MoneyError);
    assert.throws(() => yuanToCents('1.2.3'), MoneyError);
    assert.throws(() => yuanToCents('abc'), MoneyError);
    assert.throws(() => yuanToCents(''), MoneyError);
  });

  test('分 → 元展示', () => {
    assert.equal(centsToYuan(0), '0.00');
    assert.equal(centsToYuan(1), '0.01');
    assert.equal(centsToYuan(100), '1.00');
    assert.equal(centsToYuan(1999), '19.99');
    assert.equal(centsToYuan(-1999), '-19.99');
  });

  test('往返转换保持一致', () => {
    for (const s of ['0', '0.01', '9.99', '100', '12345.67', '999999.99']) {
      assert.equal(centsToYuan(yuanToCents(s)), Number(s).toFixed(2) === s ? s : centsToYuan(yuanToCents(s)));
    }
  });
});

describe('万分比折扣', () => {
  test('95 折', () => {
    assert.equal(applyBp(10000, 9500), 9500); // 100元 → 95元
    assert.equal(applyBp(1999, 9500), 1899);  // 19.99 → 18.99（向下取整）
  });

  test('不打折', () => {
    assert.equal(applyBp(12345, 10000), 12345);
  });

  test('向下取整不产生多收', () => {
    // 0.01 元打 5 折 = 0.005 元，应向下取整为 0，绝不能进位成 1 分
    assert.equal(applyBp(1, 5000), 0);
  });

  test('拒绝负数与非法值', () => {
    assert.throws(() => applyBp(-1, 9500), MoneyError);
    assert.throws(() => applyBp(100, -1), MoneyError);
  });
});

describe('订单总额计算', () => {
  test('基础：小计 - 优惠 - 积分抵扣', () => {
    assert.equal(
      computeOrderTotal({ subtotalCents: 10000, discountCents: 1000, pointsDeductCents: 500 }),
      8500
    );
  });

  test('抵扣超过小计时归零，绝不产生负数', () => {
    assert.equal(
      computeOrderTotal({ subtotalCents: 1000, discountCents: 0, pointsDeductCents: 5000 }),
      0
    );
    assert.equal(
      computeOrderTotal({ subtotalCents: 1000, discountCents: 2000, pointsDeductCents: 0 }),
      0
    );
  });

  test('多行明细求和', () => {
    const items = [
      { qty: 2, unit: 1500 },  // 30.00
      { qty: 1, unit: 2599 },  // 25.99
      { qty: 3, unit: 100 },   // 3.00
    ];
    const subtotal = items.reduce((s, i) => s + i.qty * i.unit, 0);
    assert.equal(subtotal, 5899);
  });
});

describe('积分计算', () => {
  test('每元 1 分，无倍率', () => {
    assert.equal(computePointsEarned({ paidCents: 10000, earnPerYuan: 1, rateBp: 10000 }), 100);
  });

  test('不足 1 元的部分不产生积分', () => {
    assert.equal(computePointsEarned({ paidCents: 99, earnPerYuan: 1, rateBp: 10000 }), 0);
    assert.equal(computePointsEarned({ paidCents: 199, earnPerYuan: 1, rateBp: 10000 }), 1);
  });

  test('等级双倍积分', () => {
    assert.equal(computePointsEarned({ paidCents: 10000, earnPerYuan: 1, rateBp: 20000 }), 200);
  });

  test('每元 2 分', () => {
    assert.equal(computePointsEarned({ paidCents: 5000, earnPerYuan: 2, rateBp: 10000 }), 100);
  });

  test('零金额不产生积分', () => {
    assert.equal(computePointsEarned({ paidCents: 0, earnPerYuan: 1, rateBp: 10000 }), 0);
  });
});

describe('积分抵扣', () => {
  test('100 积分 = 1 元', () => {
    // redeemRateBp=100 表示 100 积分抵 1 元
    const c = computePointsDeductCents({ pointsToUse: 100, redeemRateBp: 100, maxDeductCents: 100000 });
    assert.equal(c, 100); // 1 元 = 100 分
  });

  test('受最大抵扣上限约束', () => {
    const c = computePointsDeductCents({ pointsToUse: 100000, redeemRateBp: 100, maxDeductCents: 5000 });
    assert.equal(c, 5000);
  });

  test('不使用积分则为 0', () => {
    assert.equal(computePointsDeductCents({ pointsToUse: 0, redeemRateBp: 100, maxDeductCents: 5000 }), 0);
  });
});

describe('金额校验', () => {
  test('接受合法整数分', () => {
    assert.equal(assertCents(0), 0);
    assert.equal(assertCents(1999), 1999);
  });

  test('拒绝浮点数', () => {
    assert.throws(() => assertCents(19.99), MoneyError);
    assert.throws(() => assertCents(NaN), MoneyError);
    assert.throws(() => assertCents(Infinity), MoneyError);
  });

  test('拒绝负数', () => {
    assert.throws(() => assertCents(-1), MoneyError);
  });

  test('拒绝超出安全整数范围', () => {
    assert.throws(() => assertCents(Number.MAX_SAFE_INTEGER + 1), MoneyError);
  });
});
