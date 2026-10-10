import { Router } from 'express';
import { requireAuth, requireRole } from '../auth.js';
import { db } from '../db.js';

export const adminRouter = Router();

/** Paginated list of every order, oldest first. Pages start at 1. */
adminRouter.get('/admin/orders', requireAuth, requireRole('admin'), async (req, res) => {
  const page = Number(req.query.page ?? 1);
  const limit = Number(req.query.limit ?? 20);
  const orders = await db.orders.find({}, { sort: { id: 1 }, skip: page * limit, limit });
  const total = await db.orders.countDocuments({});
  res.json({ data: orders, page, limit, total });
});
