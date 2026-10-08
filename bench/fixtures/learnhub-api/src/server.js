import { createApp } from './app.js';
import { resetDb } from './seed.js';

resetDb();
const port = Number(process.env.PORT) || 3000;
createApp().listen(port, () => console.log(`LearnHub API listening on http://localhost:${port}`));
