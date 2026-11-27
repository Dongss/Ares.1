import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { setLang } from '../src/i18n.js';
import { detectProjectCommands, type ProjectFiles } from '../src/workspace/detect.js';

afterEach(() => setLang('zh'));

const PACKAGE_JSON = JSON.stringify({
  name: 'demo',
  scripts: { lint: 'biome check .', test: 'vitest run', build: 'tsc', dev: 'vite' },
});

const PYPROJECT = `[project]
name = "demo"
dependencies = ["httpx"]

[project.optional-dependencies]
dev = ["pytest", "ruff"]

[tool.ruff]
line-length = 100
`;

const MAKEFILE = `.PHONY: build test
build:
\tgo build ./...

test: build
\tgo test ./...
`;

/** A project of these root files; `contents` for the ones the rules read. */
function project(files: string[], contents: Record<string, string> = {}): ProjectFiles {
  return { files: [...files, ...Object.keys(contents)], contents };
}

/** One project per row of the table in docs/examples/README.md, by its first cell. */
const TABLE_PROJECTS: Record<string, ProjectFiles> = {
  npm: project(['package-lock.json'], { 'package.json': PACKAGE_JSON }),
  pnpm: project(['pnpm-lock.yaml'], { 'package.json': PACKAGE_JSON }),
  yarn: project(['yarn.lock'], { 'package.json': PACKAGE_JSON }),
  bun: project(['bun.lock'], { 'package.json': PACKAGE_JSON }),
  'Python（uv）': project(['uv.lock'], { 'pyproject.toml': PYPROJECT }),
  'Python（pip + venv）': project([], { 'pyproject.toml': PYPROJECT }),
  'Python（只有 requirements.txt）': project([], { 'requirements.txt': 'httpx\npytest\n' }),
  Go: project(['go.mod', 'go.sum']),
  Rust: project(['Cargo.toml', 'Cargo.lock']),
  'Makefile（有 test 目标）': project([], { Makefile: MAKEFILE }),
};

/** The rows of the commands table in docs/examples/README.md: name, setup, verify. */
function tableRows(): Map<string, { setup: string[]; verify: string[] }> {
  const readme = readFileSync(join(import.meta.dirname, '../docs/examples/README.md'), 'utf8');
  const rows = new Map<string, { setup: string[]; verify: string[] }>();
  for (const line of readme.split('\n')) {
    const cells = /^\| (.+?) \| (.+?) \| (.+?) \|$/.exec(line);
    if (!cells?.[1] || !(cells[1] in TABLE_PROJECTS)) continue;
    const commands = (cell: string) => [...cell.matchAll(/`([^`]+)`/g)].map((m) => m[1]);
    rows.set(cells[1], {
      setup: commands(cells[2] ?? '') as string[],
      verify: commands(cells[3] ?? '') as string[],
    });
  }
  return rows;
}

describe('detectProjectCommands', () => {
  it('gives the commands of every row of the table in docs/examples/README.md', () => {
    const rows = tableRows();
    expect([...rows.keys()].sort()).toEqual(Object.keys(TABLE_PROJECTS).sort());
    for (const [name, files] of Object.entries(TABLE_PROJECTS)) {
      const found = detectProjectCommands(files);
      expect({ name, setup: found.setup, verify: found.verify }).toEqual({
        name,
        ...rows.get(name),
      });
      expect(found.basis).toHaveLength(1);
    }
  });

  it('chooses the Node package manager by lock file', () => {
    const pkg = { 'package.json': PACKAGE_JSON };
    expect(detectProjectCommands(project(['package-lock.json'], pkg))).toMatchObject({
      setup: ['npm ci'],
      verify: ['npm run build', 'npm test', 'npm run lint'],
    });
    expect(detectProjectCommands(project(['npm-shrinkwrap.json'], pkg)).setup).toEqual(['npm ci']);
    expect(detectProjectCommands(project(['pnpm-lock.yaml'], pkg))).toMatchObject({
      setup: ['pnpm install --frozen-lockfile'],
      verify: ['pnpm build', 'pnpm test', 'pnpm lint'],
    });
    expect(detectProjectCommands(project(['yarn.lock'], pkg))).toMatchObject({
      setup: ['yarn install --frozen-lockfile'],
      verify: ['yarn build', 'yarn test', 'yarn lint'],
    });
    for (const lock of ['bun.lock', 'bun.lockb']) {
      expect(detectProjectCommands(project([lock], pkg))).toMatchObject({
        setup: ['bun install'],
        verify: ['bun run build', 'bun run test', 'bun run lint'],
      });
    }
    const basis = detectProjectCommands(project(['pnpm-lock.yaml'], pkg)).basis;
    expect(basis).toEqual([
      'Node（pnpm）：package.json，有 `pnpm-lock.yaml`；scripts 里有 build、test、lint',
    ]);
  });

  it('takes npm without a lock file and says so', () => {
    const found = detectProjectCommands(project([], { 'package.json': PACKAGE_JSON }));
    expect(found.setup).toEqual(['npm install']);
    expect(found.verify).toEqual(['npm run build', 'npm test', 'npm run lint']);
    expect(found.basis[0]).toContain('没找到锁文件');
  });

  it('prefers the packageManager field to the lock files', () => {
    const pkg = JSON.stringify({ packageManager: 'pnpm@9.1.0', scripts: { test: 'vitest' } });
    const locked = detectProjectCommands(
      project(['pnpm-lock.yaml', 'package-lock.json'], { 'package.json': pkg }),
    );
    expect(locked).toMatchObject({
      setup: ['pnpm install --frozen-lockfile'],
      verify: ['pnpm test'],
    });
    expect(locked.basis[0]).toContain('pnpm@9.1.0');
    // The lock file there is another manager's: no frozen install.
    const yarn = JSON.stringify({ packageManager: 'yarn@1.22.0', scripts: { build: 'tsc' } });
    expect(
      detectProjectCommands(project(['package-lock.json'], { 'package.json': yarn })),
    ).toMatchObject({ setup: ['yarn install'], verify: ['yarn build'] });
    // An unknown manager falls back to the lock files.
    const other = JSON.stringify({ packageManager: 'deno@2', scripts: { test: 'x' } });
    expect(detectProjectCommands(project(['yarn.lock'], { 'package.json': other })).setup).toEqual([
      'yarn install --frozen-lockfile',
    ]);
  });

  it('makes verify commands only of the scripts there, build, test, lint in that order', () => {
    const pkg = (scripts: Record<string, string>) => ({
      'package.json': JSON.stringify({ scripts }),
    });
    expect(
      detectProjectCommands(project(['package-lock.json'], pkg({ lint: 'eslint', test: 'jest' })))
        .verify,
    ).toEqual(['npm test', 'npm run lint']);
    // npm init's placeholder test fails on purpose; a blank script does nothing.
    expect(
      detectProjectCommands(
        project(
          ['package-lock.json'],
          pkg({ test: 'echo "Error: no test specified" && exit 1', build: ' ' }),
        ),
      ),
    ).toMatchObject({ setup: ['npm ci'], verify: [] });
    const none = detectProjectCommands(project(['package-lock.json'], pkg({ start: 'node .' })));
    expect(none.verify).toEqual([]);
    expect(none.basis[0]).toContain('scripts 里没有 build、test、lint');
  });

  it('still installs when package.json cannot be parsed', () => {
    const found = detectProjectCommands(project(['pnpm-lock.yaml'], { 'package.json': '{ oops' }));
    expect(found).toMatchObject({ setup: ['pnpm install --frozen-lockfile'], verify: [] });
    expect(found.basis[0]).toContain('解析不了');
  });

  it('adds ruff to Python only when the project sets it up', () => {
    const bare = '[project]\nname = "demo"\n';
    expect(detectProjectCommands(project(['uv.lock'], { 'pyproject.toml': bare }))).toMatchObject({
      setup: ['uv sync'],
      verify: ['uv run pytest'],
    });
    const ruffVerify = ['uv run ruff check .', 'uv run ruff format --check .', 'uv run pytest'];
    // Configured in pyproject.toml, its own file, or among the dependencies.
    for (const files of [
      project(['uv.lock'], { 'pyproject.toml': `${bare}\n[tool.ruff.lint]\nselect = ["E"]\n` }),
      project(['uv.lock', 'ruff.toml'], { 'pyproject.toml': bare }),
      project(['uv.lock', '.ruff.toml'], { 'pyproject.toml': bare }),
      project(['uv.lock'], {
        'pyproject.toml': `${bare}\n[dependency-groups]\ndev = ["pytest>=8", "ruff>=0.6"]\n`,
      }),
    ]) {
      expect(detectProjectCommands(files).verify).toEqual(ruffVerify);
    }
    // Another package whose name starts with ruff is not ruff.
    expect(
      detectProjectCommands(
        project(['uv.lock'], { 'pyproject.toml': `${bare}dependencies = ["ruff-lsp"]\n` }),
      ).verify,
    ).toEqual(['uv run pytest']);
    expect(
      detectProjectCommands(project([], { 'requirements.txt': 'pytest\nruff==0.6.0\n' })).verify,
    ).toEqual(['.venv/bin/ruff check .', '.venv/bin/ruff format --check .', '.venv/bin/pytest']);
  });

  it('installs a pyproject.toml project with pip, and says when it has no dev extra', () => {
    const withDev = detectProjectCommands(project([], { 'pyproject.toml': PYPROJECT }));
    expect(withDev.setup).toEqual(['python3 -m venv .venv', ".venv/bin/pip install -e '.[dev]'"]);
    expect(withDev.basis[0]).not.toContain('dev 可选依赖');
    const noDev = detectProjectCommands(
      project([], { 'pyproject.toml': '[project]\nname = "x"\n' }),
    );
    expect(noDev.setup).toEqual(['python3 -m venv .venv', ".venv/bin/pip install -e '.[dev]'"]);
    expect(noDev.verify).toEqual(['.venv/bin/pytest']);
    expect(noDev.basis[0]).toContain('dev 可选依赖');
    // pyproject.toml wins over requirements.txt; uv.lock without pyproject.toml is not uv.
    expect(
      detectProjectCommands(
        project([], { 'pyproject.toml': PYPROJECT, 'requirements.txt': 'pytest\n' }),
      ).setup,
    ).toEqual(['python3 -m venv .venv', ".venv/bin/pip install -e '.[dev]'"]);
    expect(
      detectProjectCommands(project(['uv.lock'], { 'requirements.txt': 'pytest\n' })).setup,
    ).toEqual(['python3 -m venv .venv', '.venv/bin/pip install -r requirements.txt']);
  });

  it('adds make test only for a makefile with a test target', () => {
    const make = (text: string, file = 'Makefile') =>
      detectProjectCommands(project([], { [file]: text }));
    expect(make('test:\n\tpytest\n').verify).toEqual(['make test']);
    expect(make('unit test: deps\n\tx\n').verify).toEqual(['make test']);
    expect(make('test::\n\tx\n').verify).toEqual(['make test']);
    expect(make('check:\n\tx\n', 'makefile').verify).toEqual([]);
    // Not targets: variables, recipe lines, comments, prerequisites, .PHONY's list.
    for (const text of [
      'test := 1\nall:\n\techo\n',
      'test ::= 1\n',
      'all:\n\ttest: x\n',
      '# test: x\n',
      'all: test\n',
      '.PHONY: test\n',
    ]) {
      expect(make(text)).toMatchObject({ setup: [], verify: [] });
    }
    // make reads GNUmakefile before Makefile.
    const both = detectProjectCommands(
      project([], { GNUmakefile: 'all:\n\tx\n', Makefile: 'test:\n\tx\n' }),
    );
    expect(both.verify).toEqual([]);
    const basis = make('test:\n\tx\n').basis;
    expect(basis).toEqual(['Makefile：Makefile 里有 test 目标']);
  });

  it('puts the ecosystems of a mixed project together in a fixed order, no command twice', () => {
    const found = detectProjectCommands(
      project(['Cargo.toml', 'go.mod', 'uv.lock', 'pnpm-lock.yaml'], {
        Makefile: MAKEFILE,
        'pyproject.toml': '[project]\nname = "x"\n',
        'package.json': JSON.stringify({ scripts: { test: 'make test' } }),
      }),
    );
    expect(found.setup).toEqual([
      'pnpm install --frozen-lockfile',
      'uv sync',
      'go mod download',
      'cargo fetch',
    ]);
    expect(found.verify).toEqual([
      'pnpm test',
      'uv run pytest',
      'go build ./...',
      'go vet ./...',
      'go test ./...',
      'cargo build --all-targets',
      'cargo clippy --all-targets -- -D warnings',
      'cargo test',
      'cargo fmt --check',
      'make test',
    ]);
    expect(found.basis.map((line) => line.split('：')[0])).toEqual([
      'Node（pnpm）',
      'Python（uv）',
      'Go',
      'Rust',
      'Makefile',
    ]);
  });

  it('keeps a command the ecosystems share once', () => {
    const found = detectProjectCommands({
      files: ['package.json', 'package-lock.json', 'Makefile'],
      contents: {
        'package.json': JSON.stringify({ scripts: { test: 'make test' } }),
        Makefile: 'test:\n\tnpm test\n',
      },
    });
    expect(found.verify).toEqual(['npm test', 'make test']);
    const twice = detectProjectCommands(project(['go.mod', 'go.mod']));
    expect(twice.verify).toEqual(['go build ./...', 'go vet ./...', 'go test ./...']);
  });

  it('suggests nothing when it recognises nothing, and says so', () => {
    for (const files of [
      project([]),
      project(['README.md', 'main.c', 'CMakeLists.txt']),
      project([], { Makefile: 'all:\n\tcc main.c\n' }),
    ]) {
      const found = detectProjectCommands(files);
      expect(found.setup).toEqual([]);
      expect(found.verify).toEqual([]);
      expect(found.basis).toHaveLength(1);
      expect(found.basis[0]).toContain('没有认得出的项目文件');
    }
  });

  it('writes the basis in English with no Chinese left', () => {
    setLang('en');
    const cases = [
      project(['pnpm-lock.yaml'], { 'package.json': PACKAGE_JSON }),
      project([], { 'package.json': '{' }),
      project([], { 'package.json': JSON.stringify({ packageManager: 'bun@1.1.0' }) }),
      project(['uv.lock'], { 'pyproject.toml': PYPROJECT }),
      project([], { 'pyproject.toml': '[project]\nname = "x"\n' }),
      project([], { 'requirements.txt': 'pytest\n' }),
      project(['go.mod', 'Cargo.toml'], { Makefile: MAKEFILE }),
      project(['README.md']),
    ];
    for (const files of cases) {
      for (const line of detectProjectCommands(files).basis) {
        expect(line).not.toMatch(/[一-鿿]/);
      }
    }
    expect(
      detectProjectCommands(project(['yarn.lock'], { 'package.json': PACKAGE_JSON })).basis,
    ).toEqual(['Node (yarn): package.json, `yarn.lock` is there; scripts has build, test, lint']);
  });
});
