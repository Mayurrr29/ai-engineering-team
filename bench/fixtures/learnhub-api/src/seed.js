import { db } from './db.js';

export const TOKENS = {
  admin: 'tok-admin-7f3a91',
  ira: 'tok-ira-91c2d4',
  omar: 'tok-omar-5d8e2b',
  sam: 'tok-sam-2b6f0c',
  sara: 'tok-sara-c4a1e9',
};

const fakeHash = (seed) => `$2b$10$${Buffer.from(`learnhub:${seed}`).toString('base64').padEnd(53, 'x').slice(0, 53)}`;

/** Resets the database to a known state (used by the dev server and by tests). */
export function resetDb() {
  db.users.reset([
    { id: 1, name: 'Ada Admin', email: 'ada@learnhub.dev', role: 'admin', passwordHash: fakeHash('ada') },
    { id: 2, name: 'Ira Instructor', email: 'ira@learnhub.dev', role: 'instructor', passwordHash: fakeHash('ira') },
    { id: 3, name: 'Omar Instructor', email: 'omar@learnhub.dev', role: 'instructor', passwordHash: fakeHash('omar') },
    { id: 4, name: 'Sam Student', email: 'sam@learnhub.dev', role: 'student', passwordHash: fakeHash('sam') },
    { id: 5, name: 'Sara Student', email: 'sara@learnhub.dev', role: 'student', passwordHash: fakeHash('sara') },
    ...Array.from({ length: 150 }, (_, i) => ({
      id: 6 + i,
      name: `Learner ${String(i + 1).padStart(3, '0')}`,
      email: `learner${i + 1}@example.com`,
      role: 'student',
      passwordHash: fakeHash(`learner${i + 1}`),
    })),
  ]);
  db.sessions.reset([
    { id: 1, token: TOKENS.admin, userId: 1 },
    { id: 2, token: TOKENS.ira, userId: 2 },
    { id: 3, token: TOKENS.omar, userId: 3 },
    { id: 4, token: TOKENS.sam, userId: 4 },
    { id: 5, token: TOKENS.sara, userId: 5 },
  ]);
  db.courses.reset([
    { id: 1, title: 'Node.js Fundamentals', price: 5000, instructorId: 2, published: true },
    { id: 2, title: 'React in Depth', price: 8000, instructorId: 3, published: true },
    { id: 3, title: 'Advanced Node (draft)', price: 9000, instructorId: 2, published: false },
  ]);
  db.orders.reset([]);
}
