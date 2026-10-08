import { Router } from 'express';
import { requireAuth } from '../auth.js';
import { db } from '../db.js';
import { HttpError } from '../errors.js';
import { publicUser } from '../serializers.js';
import { EMAIL_PATTERN, validate } from '../validate.js';

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

usersRouter.patch('/users/:id', requireAuth, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) throw new HttpError(400, 'Invalid user id');
  if (req.user.role !== 'admin' && req.user.id !== id) throw new HttpError(403, 'Forbidden');
  const input = validate(req.body, {
    name: { type: 'string', minLength: 1, maxLength: 100 },
    email: { type: 'string', maxLength: 254, pattern: EMAIL_PATTERN },
  });
  if (Object.keys(input).length === 0) throw new HttpError(400, 'Nothing to update');
  if (input.email) input.email = input.email.toLowerCase();
  try {
    const result = await db.users.updateOne({ id }, { $set: input });
    if (result.matchedCount === 0) throw new HttpError(404, 'User not found');
  } catch (err) {
    if (err.code === 11000) throw new HttpError(409, 'Email is already in use');
    throw err;
  }
  res.json({ data: publicUser(await db.users.findOne({ id })) });
});
