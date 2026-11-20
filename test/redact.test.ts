import { homedir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { redactForGitHub } from '../src/github/redact.js';

describe('redactForGitHub', () => {
  const home = '/Users/me';
  const r = (text: string, h = home) => redactForGitHub(text, h);

  it('turns the home directory at the start of a path into ~, everywhere in the text', () => {
    expect(
      r("ENOENT: no such file, open '/Users/me/.ares1/worktrees/run-1/src/a.ts'\nin /Users/me/x"),
    ).toBe("ENOENT: no such file, open '~/.ares1/worktrees/run-1/src/a.ts'\nin ~/x");
  });

  it('takes the home directory itself where the path ends with it', () => {
    expect(r('/Users/me')).toBe('~');
    expect(r('cd /Users/me; ls "/Users/me" (/Users/me), /Users/me: /Users/me.')).toBe(
      'cd ~; ls "~" (~), ~: ~.',
    );
    expect(r('/Users/me/')).toBe('~/');
  });

  it('leaves other directories alone, even when they start or end the same', () => {
    expect(r('/Users/meg/x /Users/me-2/x /Users/me_x /Users/me.old/x /Users/me3')).toBe(
      '/Users/meg/x /Users/me-2/x /Users/me_x /Users/me.old/x /Users/me3',
    );
    // Not under the home directory: inside another path, or relative.
    expect(r('/mnt/Users/me/x /mnt//Users/me/x ./Users/me/x Users/me/x')).toBe(
      '/mnt/Users/me/x /mnt//Users/me/x ./Users/me/x Users/me/x',
    );
    expect(r('/tmp/ares1-home-1/worktrees/run-1')).toBe('/tmp/ares1-home-1/worktrees/run-1');
  });

  it('accepts a home directory given with a trailing slash', () => {
    expect(r('/Users/me/x', '/Users/me/')).toBe('~/x');
  });

  it('escapes the home directory: its characters mean themselves', () => {
    expect(r('/home/a.b+c (1)/x /home/aXb+c (1)/x', '/home/a.b+c (1)')).toBe(
      '~/x /home/aXb+c (1)/x',
    );
  });

  it('changes nothing without a home directory, or when it is the root', () => {
    const text = '/Users/me/x /etc/hosts C:\\x';
    for (const h of ['', '/', '//', 'C:\\', 'C:', 'relative/dir']) expect(r(text, h)).toBe(text);
  });

  it('handles Windows paths: either separator, escaped backslashes, any case', () => {
    const win = 'C:\\Users\\Me';
    expect(r('at C:\\Users\\Me\\.ares1\\x.ts', win)).toBe('at ~\\.ares1\\x.ts');
    expect(r('c:/users/me/x', win)).toBe('~/x');
    expect(r('"C:\\\\Users\\\\Me\\\\x"', win)).toBe('"~\\\\x"');
    expect(r('C:\\Users\\Meg\\x D:\\Users\\Me\\x', win)).toBe('C:\\Users\\Meg\\x D:\\Users\\Me\\x');
  });

  it("uses this machine's home directory by default", () => {
    expect(redactForGitHub(`${homedir()}/.ares1/x`)).toBe('~/.ares1/x');
  });
});
