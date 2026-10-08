import { Router } from 'express';
import { requireAuth, requireRole } from '../auth.js';
import { db } from '../db.js';
import { HttpError } from '../errors.js';
import { validate } from '../validate.js';
import { redeemCoupon } from './coupons.js';

export const ordersRouter = Router();

ordersRouter.post('/orders', requireAuth, requireRole('student'), async (req, res) => {
  const { courseId, couponCode } = validate(req.body, {
    courseId: { type: 'integer', required: true, min: 1 },
    couponCode: { type: 'string', minLength: 1, maxLength: 32 },
  });
  const course = await db.courses.findOne({ id: courseId, published: true });
  if (!course) throw new HttpError(404, 'Course not found');
  const existing = await db.orders.findOne({ userId: req.user.id, courseId });
  if (existing) throw new HttpError(409, 'You already own this course');

  let amount = course.price;
  if (couponCode) {
    const coupon = await redeemCoupon(courseId, couponCode);
    amount = Math.round(course.price * (1 - coupon.percentOff / 100));
  }
  const order = await db.orders.insertOne({ userId: req.user.id, courseId, amount, createdAt: new Date().toISOString() });
  res.status(201).json({ data: order });
});

ordersRouter.get('/orders', requireAuth, async (req, res) => {
  const orders = await db.orders.find({ userId: req.user.id }, { sort: { id: 1 } });
  res.json({ data: orders });
});
