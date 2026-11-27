import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, api } from './api.js';

afterEach(() => vi.unstubAllGlobals());

/** fetch answering every request with `body` as JSON and `status`, recording what it was sent. */
function answer(status: number, body: unknown) {
  const sent: { url: string; init: RequestInit }[] = [];
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    sent.push({ url, init });
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  });
  return sent;
}

async function thrown(promise: Promise<unknown>): Promise<ApiError> {
  try {
    await promise;
  } catch (err) {
    if (err instanceof ApiError) return err;
    throw err;
  }
  throw new Error('expected an ApiError');
}

describe('setting where a repo gets its requirements', () => {
  it('PUTs the body to the repo', async () => {
    const sent = answer(200, { language: 'zh' });
    const view = await api.setRepoSource('repo 1', { platform: 'backlog', template: 'dev' });
    expect(view).toEqual({ language: 'zh' });
    expect(sent).toHaveLength(1);
    expect(sent[0]?.url).toBe('/api/repos/repo%201/source');
    expect(sent[0]?.init.method).toBe('PUT');
    expect(JSON.parse(String(sent[0]?.init.body))).toEqual({
      platform: 'backlog',
      template: 'dev',
    });
  });

  it("carries a 400's problems one by one", async () => {
    answer(400, { error: '设置有问题：a；b', problems: ['a', 'b', 3] });
    const err = await thrown(api.setRepoSource('r', { platform: 'none' }));
    expect(err).toMatchObject({ message: '设置有问题：a；b', status: 400, problems: ['a', 'b'] });
  });

  it('has no problems when the answer lists none', async () => {
    answer(409, { error: '配置现在加载不了' });
    const err = await thrown(api.setRepoSource('r', { platform: 'none' }));
    expect(err).toMatchObject({ message: '配置现在加载不了', status: 409, problems: [] });
  });
});
