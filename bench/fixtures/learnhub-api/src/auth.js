import { db } from './db.js';
import { HttpError } from './errors.js';

/** Authenticates `Authorization: Bearer <token>` and sets `req.user`. */
export async function requireAuth(req, res, next) {
  const [scheme, token] = (req.get('authorization') ?? '').split(' ');
  if (scheme !== 'Bearer' || !token) throw new HttpError(401, 'Authentication required');
  const session = await db.sessions.findOne({ token });
  if (!session) throw new HttpError(401, 'Invalid or expired token');
  const user = await db.users.findOne({ id: session.userId });
  if (!user) throw new HttpError(401, 'Invalid or expired token');
  req.user = user;
  next();
}

/** Allows the request only if `req.user` has one of the given roles. Use after requireAuth. */
export function requireRole(...roles) {
  return (req, res, next) => {
    if (!roles.includes(req.user.role)) throw new HttpError(403, 'Forbidden');
    next();
  };
}
