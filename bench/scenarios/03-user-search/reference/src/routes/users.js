import { Router } from 'express';
import { requireAuth, requireRole } from '../auth.js';
import { db } from '../db.js';
import { HttpError } from '../errors.js';
import { publicUser } from '../serializers.js';

export const usersRouter = Router();

const MAX_LIMIT = 100;

function positiveInt(value, fallback, name) {
  if (value === undefined) return fallback;
  const n = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : NaN;
  if (!Number.isSafeInteger(n) || n < 1) throw new HttpError(400, 'Validation failed', [`${name} must be a positive integer`]);
  return n;
}

const escapeRegex = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

usersRouter.get('/users', requireAuth, requireRole('admin'), async (req, res) => {
  const { search = '' } = req.query;
  if (typeof search !== 'string') throw new HttpError(400, 'Validation failed', ['search must be a single string']);
  const page = positiveInt(req.query.page, 1, 'page');
  const limit = Math.min(positiveInt(req.query.limit, 20, 'limit'), MAX_LIMIT);
  const term = escapeRegex(search.trim());
  const filter = term ? { $or: [{ name: { $regex: term, $options: 'i' } }, { email: { $regex: term, $options: 'i' } }] } : {};
  const [total, users] = await Promise.all([
    db.users.countDocuments(filter),
    db.users.find(filter, { sort: { id: 1 }, skip: (page - 1) * limit, limit }),
  ]);
  res.json({ data: users.map(publicUser), page, limit, total });
});

usersRouter.get('/users/me', requireAuth, (req, res) => {
  res.json({ data: publicUser(req.user) });
});

usersRouter.get('/users/:id', requireAuth, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) throw new HttpError(400, 'Invalid user id');
  if (req.user.role !== 'admin' && req.user.id !== id) throw new HttpError(403, 'Forbidden');
  const user = await db.users.findOne({ id });
  if (!user) throw new HttpError(404, 'User not found');
  res.json({ data: publicUser(user) });
});
