import { Router } from 'express';
import { requireAuth, requireRole } from '../auth.js';
import { db } from '../db.js';
import { HttpError } from '../errors.js';
import { validate } from '../validate.js';

export const ordersRouter = Router();

ordersRouter.post('/orders', requireAuth, requireRole('student'), async (req, res) => {
  const { courseId } = validate(req.body, {
    courseId: { type: 'integer', required: true, min: 1 },
  });
  const course = await db.courses.findOne({ id: courseId, published: true });
  if (!course) throw new HttpError(404, 'Course not found');
  const existing = await db.orders.findOne({ userId: req.user.id, courseId });
  if (existing) throw new HttpError(409, 'You already own this course');
  const order = await db.orders.insertOne({
    userId: req.user.id,
    courseId,
    amount: course.price,
    createdAt: new Date().toISOString(),
  });
  res.status(201).json({ data: order });
});

ordersRouter.get('/orders', requireAuth, async (req, res) => {
  const orders = await db.orders.find({ userId: req.user.id }, { sort: { id: 1 } });
  res.json({ data: orders });
});
