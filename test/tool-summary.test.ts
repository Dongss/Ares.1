import { describe, expect, it } from 'vitest';
import { summarizeToolInput } from '../src/adapters/tool-summary.js';

describe('summarizeToolInput', () => {
  it('takes the command first, whatever the order of the keys', () => {
    expect(summarizeToolInput({ command: 'ls -la', file_path: '/a' })).toBe('ls -la');
    expect(summarizeToolInput({ description: 'List files', command: 'ls' })).toBe('ls');
  });

  it('then the first string of file_path, path, pattern, url, description', () => {
    expect(summarizeToolInput({ path: '/b', file_path: '/a' })).toBe('/a');
    expect(summarizeToolInput({ pattern: 'foo', path: '/b' })).toBe('/b');
    expect(summarizeToolInput({ url: 'https://x.test', pattern: 'foo' })).toBe('foo');
    expect(summarizeToolInput({ description: 'Fetch', url: 'https://x.test' })).toBe(
      'https://x.test',
    );
    expect(summarizeToolInput({ description: 'Explore the code', prompt: 'Look' })).toBe(
      'Explore the code',
    );
  });

  it('skips keys that are not strings', () => {
    expect(summarizeToolInput({ command: ['ls'], path: '/p' })).toBe('/p');
    expect(summarizeToolInput({ file_path: 42, description: 'd' })).toBe('d');
  });

  it('cuts a field at 300 characters, without an ellipsis', () => {
    expect(summarizeToolInput({ command: 'a'.repeat(400) })).toBe('a'.repeat(300));
    expect(summarizeToolInput({ command: 'a'.repeat(300) })).toBe('a'.repeat(300));
  });

  it('falls back to JSON for objects without such a field', () => {
    expect(summarizeToolInput({ todos: [{ id: 1 }] })).toBe('{"todos":[{"id":1}]}');
    expect(summarizeToolInput({ command: 1 })).toBe('{"command":1}');
    expect(summarizeToolInput({})).toBe('{}');
    expect(summarizeToolInput(['a', 'b'])).toBe('["a","b"]');
  });

  it('gives JSON for anything that is not an object', () => {
    expect(summarizeToolInput('hello')).toBe('"hello"');
    expect(summarizeToolInput(42)).toBe('42');
    expect(summarizeToolInput(true)).toBe('true');
    expect(summarizeToolInput(null)).toBe('null');
    expect(summarizeToolInput(undefined)).toBe('');
  });

  it('cuts JSON longer than 300 characters and adds an ellipsis', () => {
    const long = summarizeToolInput({ content: 'x'.repeat(400) });
    expect(long).toBe(`${JSON.stringify({ content: 'x'.repeat(400) }).slice(0, 300)}…`);
    expect(long).toHaveLength(301);
    expect(summarizeToolInput('y'.repeat(400))).toBe(`"${'y'.repeat(299)}…`);
    // Exactly 300 characters: kept whole.
    const exact = 'z'.repeat(298);
    expect(summarizeToolInput(exact)).toBe(`"${exact}"`);
  });
});
