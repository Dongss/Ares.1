import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { defaultWebDir } from '../src/api/static.js';
import { brandTitle } from '../src/brand.js';
import { type Harness, harness, tmpDir, writeFile } from './helpers.js';

let h: Harness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

const get = (path: string, method = 'GET') => (h as Harness).master.app.request(path, { method });

describe('dashboard serving', () => {
  it('serves the built files and falls back to index.html for app routes', async () => {
    const web = tmpDir('ares1-web-');
    writeFile(join(web, 'index.html'), '<div id="root"></div>');
    writeFile(join(web, 'assets', 'app-123.js'), 'console.log(1)');
    h = await harness({ webDir: web });

    const index = await get('/');
    expect(index.status).toBe(200);
    expect(index.headers.get('content-type')).toContain('text/html');
    expect(index.headers.get('cache-control')).toBe('no-cache');
    expect(await index.text()).toContain('root');

    const asset = await get('/assets/app-123.js');
    expect(asset.headers.get('content-type')).toContain('text/javascript');
    expect(asset.headers.get('cache-control')).toContain('immutable');

    expect(await (await get('/runs/abc')).text()).toContain('root');
    expect((await get('/missing.js')).status).toBe(404);
    expect((await get('/%2e%2e/package.json')).status).toBe(404);
    expect((await get('/', 'POST')).status).toBe(405);

    const api = await get('/api/nope');
    expect(api.status).toBe(404);
    expect(await api.json()).toEqual({ error: '接口不存在' });
  });

  it('explains how to build it when it is missing', async () => {
    h = await harness({ webDir: join(tmpDir(), 'none') });
    const res = await get('/');
    expect(res.status).toBe(503);
    const page = await res.text();
    expect(page).toContain('npm run build');
    expect(page).toContain('<title>战神一号 · 自举永动机</title>');
  });

  it('titles the page source with the name and slogan from brand.ts', () => {
    // index.html is static and cannot import brand.ts; keep the two in step.
    const html = readFileSync(join(process.cwd(), 'web', 'index.html'), 'utf8');
    expect(brandTitle()).toBe('战神一号 · 自举永动机');
    expect(html).toContain(`<title>${brandTitle()}</title>`);
  });

  it('finds dist/web under the package root', () => {
    const dir = defaultWebDir();
    expect(dir.endsWith(join('dist', 'web'))).toBe(true);
    expect(existsSync(join(dirname(dirname(dir)), 'package.json'))).toBe(true);
  });
});
