import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Hono } from 'hono';
import { brandTitle } from '../brand.js';
import { localeTag, t } from '../i18n.js';

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

/** The page served while the dashboard is not built, in the language in use. */
function notBuiltPage(): string {
  const body = t({
    zh: `<h1>看板还没有构建</h1>
<p>在 ares1 目录运行 <code>npm run build</code>，然后刷新本页。</p>
<p>开发看板时可以运行 <code>npm run dev:web</code>，用它打印的地址访问。</p>`,
    en: `<h1>The dashboard is not built yet</h1>
<p>Run <code>npm run build</code> in the ares1 directory, then reload this page.</p>
<p>While developing the dashboard, run <code>npm run dev:web</code> and open the address it prints.</p>`,
  });
  return `<!doctype html>
<html lang="${localeTag()}"><head><meta charset="utf-8"><title>${brandTitle()}</title></head>
<body style="font-family: system-ui, sans-serif; max-width: 40rem; margin: 4rem auto; line-height: 1.6">
${body}
</body></html>`;
}

/** `<package root>/dist/web`, where `vite build` puts the dashboard; works from src/ and dist/. */
export function defaultWebDir(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  while (!existsSync(join(dir, 'package.json'))) {
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return join(dir, 'dist', 'web');
}

/**
 * Serve the built dashboard (a single-page app) for every non-API path. Must be mounted after
 * the API routes. Unknown /api paths get a JSON 404.
 */
export function mountDashboard(app: Hono, webDir: string | undefined): void {
  app.all('*', (c) => {
    const path = c.req.path;
    if (path === '/api' || path.startsWith('/api/'))
      return c.json({ error: t({ zh: '接口不存在', en: 'No such endpoint' }) }, 404);
    if (c.req.method !== 'GET' && c.req.method !== 'HEAD') return c.text('Method Not Allowed', 405);
    if (!webDir || !existsSync(join(webDir, 'index.html'))) return c.html(notBuiltPage(), 503);

    const root = resolve(webDir);
    let file: string;
    try {
      file = resolve(root, `.${decodeURIComponent(path)}`);
    } catch {
      return c.text('Bad Request', 400);
    }
    if (file !== root && !file.startsWith(root + sep)) return c.text('Not Found', 404);

    const isFile = existsSync(file) && statSync(file).isFile();
    if (!isFile && extname(path) !== '') return c.text('Not Found', 404);
    const target = isFile ? file : join(root, 'index.html');
    const type = CONTENT_TYPES[extname(target)] ?? 'application/octet-stream';
    // Vite puts content-hashed files under assets/; everything else must be revalidated.
    const cache = target.includes(`${sep}assets${sep}`)
      ? 'public, max-age=31536000, immutable'
      : 'no-cache';
    return c.body(new Uint8Array(readFileSync(target)), 200, {
      'content-type': type,
      'cache-control': cache,
    });
  });
}
