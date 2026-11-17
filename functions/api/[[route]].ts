import { handle } from 'hono/cloudflare-pages';
import { createApp } from '../../src/server/app';

const app = createApp();

export const onRequest = handle(app);
