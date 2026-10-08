import express from 'express';
import { errorHandler, notFound } from './errors.js';
import { coursesRouter } from './routes/courses.js';
import { ordersRouter } from './routes/orders.js';
import { usersRouter } from './routes/users.js';

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '100kb' }));

  app.use(usersRouter);
  app.use(coursesRouter);
  app.use(ordersRouter);

  app.use(notFound);
  app.use(errorHandler);
  return app;
}
