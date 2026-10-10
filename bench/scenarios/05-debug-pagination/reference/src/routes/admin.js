import { Router } from 'express';
import { requireAuth, requireRole } from '../auth.js';
import { db } from '../db.js';
import { HttpError } from '../errors.js';

export const adminRouter = Router();

const MAX_LIMIT = 100;

function positiveInt(value, fallback, name) {
  if (value === undefined) return fallback;
  if (!/^\d+$/.test(String(value)) || Number(value) < 1) throw new HttpError(400, `${name} must be a positive integer`);
  return Number(value);
}

/** Paginated list of every order, oldest first. Pages start at 1. */
adminRouter.get('/admin/orders', requireAuth, requireRole('admin'), async (req, res) => {
  const page = positiveInt(req.query.page, 1, 'page');
  const limit = positiveInt(req.query.limit, 20, 'limit');
  if (limit > MAX_LIMIT) throw new HttpError(400, `limit must be at most ${MAX_LIMIT}`);
  const orders = await db.orders.find({}, { sort: { id: 1 }, skip: (page - 1) * limit, limit });
  const total = await db.orders.countDocuments({});
  res.json({ data: orders, page, limit, total });
});
