import { Router } from 'express';
import { requireAuth, requireRole } from '../auth.js';
import { db } from '../db.js';
import { HttpError } from '../errors.js';
import { validate } from '../validate.js';

export const couponsRouter = Router();

couponsRouter.post('/courses/:id/coupons', requireAuth, requireRole('instructor', 'admin'), async (req, res) => {
  const courseId = Number(req.params.id);
  if (!Number.isInteger(courseId)) throw new HttpError(400, 'Invalid course id');
  const course = await db.courses.findOne({ id: courseId });
  if (!course) throw new HttpError(404, 'Course not found');
  if (req.user.role !== 'admin' && course.instructorId !== req.user.id) throw new HttpError(403, 'Forbidden');

  const input = validate(req.body, {
    code: { type: 'string', required: true, minLength: 3, maxLength: 32, pattern: /^[A-Za-z0-9_-]+$/ },
    percentOff: { type: 'integer', required: true, min: 1, max: 100 },
    expiresAt: { type: 'string' },
    maxRedemptions: { type: 'integer', min: 1 },
  });
  let expiresAt = null;
  if (input.expiresAt !== undefined) {
    const time = Date.parse(input.expiresAt);
    if (Number.isNaN(time)) throw new HttpError(400, 'Validation failed', ['expiresAt must be a date']);
    expiresAt = new Date(time).toISOString();
  }
  const code = input.code.toUpperCase();
  if (await db.coupons.findOne({ courseId, code })) throw new HttpError(409, 'Coupon code already exists for this course');

  const coupon = await db.coupons.insertOne({
    courseId,
    code,
    percentOff: input.percentOff,
    expiresAt,
    remaining: input.maxRedemptions ?? null,
  });
  res.status(201).json({ data: coupon });
});

/** Atomically reserves one redemption of a coupon for a course. Throws if it can't be applied. */
export async function redeemCoupon(courseId, rawCode) {
  const coupon = await db.coupons.findOne({ courseId, code: rawCode.toUpperCase() });
  if (!coupon) throw new HttpError(400, 'Invalid coupon code');
  if (coupon.expiresAt && coupon.expiresAt <= new Date().toISOString()) throw new HttpError(400, 'Coupon has expired');
  if (coupon.remaining !== null) {
    const reserved = await db.coupons.findOneAndUpdate({ id: coupon.id, remaining: { $gt: 0 } }, { $inc: { remaining: -1 } });
    if (!reserved) throw new HttpError(409, 'Coupon has been fully redeemed');
  }
  return coupon;
}
