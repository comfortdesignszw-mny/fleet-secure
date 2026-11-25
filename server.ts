import dotenv from 'dotenv';
import express from 'express';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { createServer as createViteServer } from 'vite';
import { createApp } from './src/server/app';
import { createLocalDatabase } from './src/server/local-d1';
import type { AppEnv } from './src/server/types';

dotenv.config();

async function startServer() {
  const PORT = 3000;
  const expressApp = express();
  const httpServer = http.createServer(expressApp);
  const db = createLocalDatabase();
  const honoApp = createApp();

  const appEnv: AppEnv = {
    DB: db,
    SESSION_SECRET: process.env.SESSION_SECRET,
    INITIAL_ADMIN_USERNAME: process.env.INITIAL_ADMIN_USERNAME,
    INITIAL_ADMIN_PIN: process.env.INITIAL_ADMIN_PIN,
    INITIAL_ADMIN_NAME: process.env.INITIAL_ADMIN_NAME,
    APP_URL: process.env.APP_URL,
    RESEND_API_KEY: process.env.RESEND_API_KEY,
    EMAIL_FROM: process.env.EMAIL_FROM,
    ALLOW_PREVIEW_SIGNUP: process.env.ALLOW_PREVIEW_SIGNUP ?? 'true',
  };

  // Mount /api/* onto the shared Hono router using Web Standard Request/Response
  expressApp.use('/api', async (req, res) => {
    try {
      const rawProto = req.headers['x-forwarded-proto'];
      const protocol =
        (Array.isArray(rawProto) ? rawProto[0] : rawProto)?.split(',')[0]?.trim() ||
        req.protocol ||
        'http';
      const rawForwardedHost = req.headers['x-forwarded-host'];
      const forwardedHost = (Array.isArray(rawForwardedHost) ? rawForwardedHost[0] : rawForwardedHost)
        ?.split(',')[0]
        ?.trim();
      const host = forwardedHost || req.headers.host || `localhost:${PORT}`;
      const url = `${protocol}://${host}${req.originalUrl}`;

      const headers = new Headers();
      for (const [key, value] of Object.entries(req.headers)) {
        if (value === undefined) continue;
        if (Array.isArray(value)) {
          for (const v of value) headers.append(key, v);
        } else {
          headers.set(key, value);
        }
      }

      const method = req.method.toUpperCase();
      let body: BodyInit | undefined;
      if (method !== 'GET' && method !== 'HEAD') {
        const chunks: Buffer[] = [];
        for await (const chunk of req) {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        }
        if (chunks.length > 0) {
          body = Buffer.concat(chunks);
        }
      }

      const webRequest = new Request(url, {
        method,
        headers,
        body,
      });

      const webResponse = await honoApp.fetch(webRequest, appEnv);

      res.status(webResponse.status);
      webResponse.headers.forEach((value, key) => {
        if (key.toLowerCase() === 'set-cookie') {
          res.append('Set-Cookie', value);
        } else {
          res.setHeader(key, value);
        }
      });

      const buf = Buffer.from(await webResponse.arrayBuffer());
      res.send(buf);
    } catch (err) {
      console.error('API Error:', err);
      res.status(500).json({ error: 'Something went wrong on the server. Please try again.' });
    }
  });

  if (process.env.NODE_ENV === 'production') {
    const distDir = path.resolve(process.cwd(), 'dist');
    expressApp.use(express.static(distDir));
    expressApp.get('*', (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  } else {
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        ws: { server: httpServer },
        allowedHosts: true,
      },
      appType: 'spa',
    });
    expressApp.use(vite.middlewares);

    // Fallback SPA index.html
    expressApp.use('*', async (req, res, next) => {
      if (req.originalUrl.startsWith('/api')) return next();
      try {
        let template = fs.readFileSync(path.resolve(process.cwd(), 'index.html'), 'utf-8');
        template = await vite.transformIndexHtml(req.originalUrl, template);
        res.status(200).set({ 'Content-Type': 'text/html' }).end(template);
      } catch (e) {
        next(e);
      }
    });
  }

  httpServer.listen(PORT, '0.0.0.0', () => {
    console.log(`Fleet Secure running on http://0.0.0.0:${PORT}`);
  });

  // Run overdue hire & vehicle service-due alerts periodically in local server mode (mirrors Cloudflare Cron Trigger)
  const { checkAndNotifyOverdueHires, checkAndNotifyVehicleServiceDues } = await import(
    './src/server/notifications'
  );
  setInterval(() => {
    void checkAndNotifyOverdueHires(db, { env: appEnv });
    void checkAndNotifyVehicleServiceDues(db, { env: appEnv });
  }, 15 * 60_000);
}

startServer();
