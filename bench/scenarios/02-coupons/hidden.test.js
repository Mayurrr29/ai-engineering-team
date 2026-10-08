import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import { assertNot500, assertStatusIn, startApi, TOKENS, unique } from './_api.js';

let api;
before(async () => (api = await startApi()));
beforeEach(() => api.resetDb());
after(() => api.close());

async function createCoupon(overrides = {}, { token = TOKENS.ira, courseId = 1 } = {}) {
  const body = { code: unique('SAVE'), percentOff: 20, ...overrides };
  const res = await api.request('POST', `/courses/${courseId}/coupons`, { token, body });
  return { res, code: body.code };
}

const order = (courseId, couponCode, token = TOKENS.sam) =>
  api.request('POST', '/orders', { token, body: couponCode === undefined ? { courseId } : { courseId, couponCode } });

function assertNoDiscount(res, fullPrice) {
  assertNot500(res);
  if (res.status >= 200 && res.status < 300) assert.equal(res.body?.data?.amount, fullPrice, 'discount must not be applied');
}

test('instructor creates a coupon for their own course', async () => {
  const { res, code } = await createCoupon();
  assertStatusIn(res, [201]);
  assert.equal(res.body?.data?.code, code);
});

test('instructor cannot create a coupon for another instructor’s course', async () => {
  const { res } = await createCoupon({}, { token: TOKENS.omar, courseId: 1 });
  assertStatusIn(res, [403, 404]);
});

test('students and anonymous users cannot create coupons', async () => {
  assertStatusIn((await createCoupon({}, { token: TOKENS.sam })).res, [403]);
  const anon = await api.request('POST', '/courses/1/coupons', { body: { code: unique('X'), percentOff: 10 } });
  assertStatusIn(anon, [401]);
});

test('percentOff is validated', async () => {
  for (const percentOff of [101, -5, 'abc', 150]) {
    const { res } = await createCoupon({ percentOff });
    assertStatusIn(res, [400, 422], `percentOff=${JSON.stringify(percentOff)}`);
  }
});

test('duplicate coupon codes on the same course are rejected', async () => {
  const { code } = await createCoupon();
  const { res } = await createCoupon({ code });
  assertStatusIn(res, [400, 409, 422]);
});

test('a valid coupon discounts the order', async () => {
  const { code } = await createCoupon({ percentOff: 20 });
  const res = await order(1, code);
  assertStatusIn(res, [201]);
  assert.equal(res.body?.data?.amount, 4000);
});

test('orders without a coupon are still full price', async () => {
  const res = await order(2);
  assertStatusIn(res, [201]);
  assert.equal(res.body?.data?.amount, 8000);
});

test('a coupon cannot be used on a different course', async () => {
  const { code } = await createCoupon({ percentOff: 50 }, { courseId: 1 });
  assertNoDiscount(await order(2, code), 8000);
});

test('an expired coupon is not applied', async () => {
  const { res: created, code } = await createCoupon({ percentOff: 30, expiresAt: new Date(Date.now() + 1500).toISOString() });
  assertStatusIn(created, [201]);
  await new Promise((resolve) => setTimeout(resolve, 2000));
  assertNoDiscount(await order(1, code), 5000);
});

test('maxRedemptions is enforced', async () => {
  const { code } = await createCoupon({ percentOff: 20, maxRedemptions: 1 });
  const first = await order(1, code, TOKENS.sam);
  assert.equal(first.body?.data?.amount, 4000);
  assertNoDiscount(await order(1, code, TOKENS.sara), 5000);
});

test('maxRedemptions holds under concurrent orders', async () => {
  const { code } = await createCoupon({ percentOff: 20, maxRedemptions: 1 });
  const results = await Promise.all([order(1, code, TOKENS.sam), order(1, code, TOKENS.sara)]);
  results.forEach(assertNot500);
  const discounted = results.filter((r) => r.status === 201 && r.body?.data?.amount === 4000);
  assert.ok(discounted.length <= 1, `coupon with maxRedemptions=1 was redeemed ${discounted.length} times`);
});

test('unknown coupon codes never discount and never crash', async () => {
  assertNoDiscount(await order(1, 'DOES-NOT-EXIST'), 5000);
});

test('couponCode must be a string (NoSQL operator injection)', async () => {
  await createCoupon({ percentOff: 90 });
  assertNoDiscount(await order(1, { $ne: null }), 5000);
});
