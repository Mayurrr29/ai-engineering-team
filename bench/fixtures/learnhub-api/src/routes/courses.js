import { Router } from 'express';
import { requireAuth, requireRole } from '../auth.js';
import { db } from '../db.js';
import { HttpError } from '../errors.js';
import { validate } from '../validate.js';

export const coursesRouter = Router();

coursesRouter.get('/courses', async (req, res) => {
  const courses = await db.courses.find({ published: true }, { sort: { id: 1 } });
  res.json({ data: courses });
});

coursesRouter.get('/courses/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) throw new HttpError(400, 'Invalid course id');
  const course = await db.courses.findOne({ id, published: true });
  if (!course) throw new HttpError(404, 'Course not found');
  res.json({ data: course });
});

coursesRouter.post('/courses', requireAuth, requireRole('instructor', 'admin'), async (req, res) => {
  const input = validate(req.body, {
    title: { type: 'string', required: true, minLength: 3, maxLength: 120 },
    price: { type: 'integer', required: true, min: 0, max: 1_000_000 },
    published: { type: 'boolean' },
  });
  const course = await db.courses.insertOne({ ...input, published: input.published ?? false, instructorId: req.user.id });
  res.status(201).json({ data: course });
});
