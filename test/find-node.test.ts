import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { tmpDir } from './helpers.js';

// scripts/find-node.sh, sourced by self-upgrade.sh and keepalive.sh, run on its own: use_node
// against stand-in nodes (scripts printing a version) in PATH, in a stand-in nvm directory and in
// the usual places. PATH holds only the stand-ins and the few tools the script uses, so that no
// real node on the machine gets in the way.

const script = join(process.cwd(), 'scripts', 'find-node.sh');
const bash = execFileSync('bash', ['-c', 'command -v bash'], { encoding: 'utf8' }).trim();

/** A directory with the tools find-node.sh calls, and nothing else. */
function toolsDir(): string {
  const dir = tmpDir('ares1-tools-');
  for (const tool of ['head', 'tr', 'sed', 'dirname']) {
    const path = execFileSync('bash', ['-c', `command -v ${tool}`], { encoding: 'utf8' }).trim();
    symlinkSync(path, join(dir, tool));
  }
  return dir;
}

/** A stand-in node at `dir/node` that prints `version` for --version. */
function fakeNode(dir: string, version: string): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'node');
  writeFileSync(path, `#!/bin/sh\n[ "$1" = --version ] && echo ${version}\nexit 0\n`);
  chmodSync(path, 0o755);
  return path;
}

/** An nvm directory with `versions` installed and `aliases` (name → content) under alias/. */
function nvmDir(versions: string[], aliases: Record<string, string>): string {
  const nvm = tmpDir('ares1-nvm-');
  for (const v of versions) fakeNode(join(nvm, 'versions', 'node', v, 'bin'), v);
  for (const [name, content] of Object.entries(aliases)) {
    mkdirSync(join(nvm, 'alias', name, '..'), { recursive: true });
    writeFileSync(join(nvm, 'alias', name), `${content}\n`);
  }
  return nvm;
}

/** A package.json asking for `range` in engines.node (none without it), as npm writes it. */
function packageJson(range?: string): string {
  const file = join(tmpDir('ares1-pkg-'), 'package.json');
  const pkg = range ? { name: 'x', engines: { node: range } } : { name: 'x' };
  writeFileSync(file, `${JSON.stringify(pkg, null, 2)}\n`);
  return file;
}

interface Found {
  ok: boolean;
  node: string;
  /** PATH's first directory afterwards. */
  first: string;
  wanted: string;
  /** What use_node logged. */
  log: string[];
}

/** Sources find-node.sh and calls use_node <given> <package.json>. */
function useNode(
  given: string,
  pkg: string,
  opts: { path: string[]; nvm?: string; dirs?: string[]; lang?: 'zh' | 'en' },
): Found {
  const out = join(tmpDir('ares1-out-'), 'out');
  const lang = opts.lang ?? 'en';
  const code = [
    `log() { printf '%s\\n' "$1" >> "$OUT.log"; }`,
    `pick() { if [ "${lang}" = en ]; then printf '%s' "$2"; else printf '%s' "$1"; fi; }`,
    '. "$SCRIPT"',
    'node="$GIVEN"',
    'if use_node "$GIVEN" "$PKG"; then ok=yes; else ok=no; fi',
    `printf '%s\\n' "$ok" "$node" "\${PATH%%:*}" "$node_wanted" > "$OUT"`,
  ].join('\n');
  execFileSync(bash, ['-c', code], {
    env: {
      HOME: tmpDir('ares1-home-'), // no ~/.nvm of the machine
      PATH: [...opts.path, toolsDir()].join(':'),
      ...(opts.nvm ? { NVM_DIR: opts.nvm } : {}),
      ARES1_NODE_DIRS: (opts.dirs ?? []).join(':'),
      SCRIPT: script,
      GIVEN: given,
      PKG: pkg,
      OUT: out,
    },
  });
  const [ok, node, first, wanted] = readFileSync(out, 'utf8').split('\n');
  let log: string[] = [];
  try {
    log = readFileSync(`${out}.log`, 'utf8').trim().split('\n');
  } catch {}
  return { ok: ok === 'yes', node: node ?? '', first: first ?? '', wanted: wanted ?? '', log };
}

describe('find-node.sh', () => {
  it('parses, and braces every variable (bash misreads $name followed by Chinese text)', () => {
    execFileSync('bash', ['-n', script]);
    const source = readFileSync(script, 'utf8');
    expect(source.match(/\$[A-Za-z_][A-Za-z0-9_]*/g) ?? []).toEqual([]);
  });

  it('keeps the node given while it runs, saying nothing', () => {
    const dir = tmpDir('ares1-node-');
    const given = fakeNode(join(dir, 'given'), 'v24.22.1');
    fakeNode(join(dir, 'other'), 'v26.0.0');
    const found = useNode(given, packageJson('>=24'), { path: [join(dir, 'other')] });
    expect(found).toEqual({
      ok: true,
      node: given,
      first: join(dir, 'given'),
      wanted: '>=24',
      log: [],
    });
  });

  it('takes the node in PATH when the one given is gone, and logs the switch', () => {
    const dir = tmpDir('ares1-node-');
    const inPath = fakeNode(join(dir, 'v24.22.3', 'bin'), 'v24.22.3');
    const gone = join(dir, 'v24.22.1', 'bin', 'node');
    const found = useNode(gone, packageJson('>=24'), { path: [join(dir, 'v24.22.3', 'bin')] });
    expect(found).toMatchObject({ ok: true, node: inPath, first: join(dir, 'v24.22.3', 'bin') });
    expect(found.log).toEqual([
      `node ${gone} cannot be used (missing, not executable or not >=24); using ${inPath} (v24.22.3) instead`,
    ]);
    // In Chinese too.
    const zh = useNode(gone, packageJson('>=24'), {
      path: [join(dir, 'v24.22.3', 'bin')],
      lang: 'zh',
    });
    expect(zh.log).toEqual([
      `node ${gone} 用不了（不存在、不能执行或版本不满足 >=24），改用 ${inPath}（v24.22.3）`,
    ]);
  });

  it("falls back to nvm's default version, following aliases to the highest installed match", () => {
    const dir = tmpDir('ares1-node-');
    // PATH's node is too old for engines.node.
    fakeNode(join(dir, 'old'), 'v22.11.0');
    const nvm = nvmDir(['v22.11.0', 'v24.1.0', 'v24.22.3', 'v26.1.0'], {
      default: 'lts/*',
      'lts/*': 'lts/krypton',
      'lts/krypton': 'v24',
    });
    const pkg = packageJson('>=24');
    const gone = join(dir, 'gone', 'node');
    const at = (v: string) => join(nvm, 'versions', 'node', v, 'bin', 'node');
    expect(useNode(gone, pkg, { path: [join(dir, 'old')], nvm })).toMatchObject({
      ok: true,
      node: at('v24.22.3'),
      first: join(nvm, 'versions', 'node', 'v24.22.3', 'bin'),
    });
    const withDefault = (value: string) => {
      writeFileSync(join(nvm, 'alias', 'default'), `${value}\n`);
      return useNode(gone, pkg, { path: [join(dir, 'old')], nvm }).node;
    };
    expect(withDefault('v26')).toBe(at('v26.1.0'));
    expect(withDefault('26')).toBe(at('v26.1.0'));
    expect(withDefault('24.1')).toBe(at('v24.1.0'));
    expect(withDefault('node')).toBe(at('v26.1.0'));
    // nvm's default is too old as well: not taken.
    expect(withDefault('22')).toBe(gone);
  });

  it('looks in the usual places last', () => {
    const dir = tmpDir('ares1-node-');
    const usual = fakeNode(join(dir, 'usual'), 'v24.0.0');
    const found = useNode(join(dir, 'gone', 'node'), packageJson('>=24.0.0'), {
      path: [],
      dirs: [join(dir, 'missing'), join(dir, 'usual')],
    });
    expect(found).toMatchObject({ ok: true, node: usual });
  });

  it('fails, leaving the node as it was, when no node has a version engines.node allows', () => {
    const dir = tmpDir('ares1-node-');
    fakeNode(join(dir, 'path'), 'v22.11.0');
    fakeNode(join(dir, 'usual'), 'v20.0.0');
    const nvm = nvmDir(['v23.9.9'], { default: '23' });
    const gone = join(dir, 'gone', 'node');
    const found = useNode(gone, packageJson('>=24'), {
      path: [join(dir, 'path')],
      nvm,
      dirs: [join(dir, 'usual')],
    });
    expect(found).toEqual({
      ok: false,
      node: gone,
      first: join(dir, 'path'),
      wanted: '>=24',
      log: [],
    });
  });

  it('only asks for an executable without a range it understands', () => {
    const dir = tmpDir('ares1-node-');
    // Prints no version at all, like the stand-ins of other tests.
    const quiet = join(dir, 'node');
    writeFileSync(quiet, '#!/bin/sh\nexit 0\n');
    chmodSync(quiet, 0o755);
    expect(useNode(quiet, packageJson(), { path: [] })).toMatchObject({ ok: true, node: quiet });
    expect(useNode(quiet, packageJson('^24 || ^26'), { path: [] })).toMatchObject({
      ok: true,
      node: quiet,
    });
    expect(useNode(quiet, join(dir, 'missing.json'), { path: [] })).toMatchObject({ ok: true });
    expect(useNode(quiet, packageJson('>=24'), { path: [] })).toMatchObject({ ok: false });
  });
});
