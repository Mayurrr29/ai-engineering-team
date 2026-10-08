import { Router } from 'express';
import { requireAuth } from '../auth.js';
import { db } from '../db.js';
import { HttpError } from '../errors.js';
import { publicUser } from '../serializers.js';

export const usersRouter = Router();

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
