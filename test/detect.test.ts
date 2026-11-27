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
  'yarn 1': project(['yarn.lock'], { 'package.json': PACKAGE_JSON }),
  'yarn 2 及以上（Berry）': project(['yarn.lock'], {
    'package.json': JSON.stringify({ ...JSON.parse(PACKAGE_JSON), packageManager: 'yarn@4.5.0' }),
  }),
  bun: project(['bun.lock'], { 'package.json': PACKAGE_JSON }),
  'Python（uv）': project(['uv.lock'], { 'pyproject.toml': PYPROJECT }),
  'Python（pip + venv）': project([], { 'pyproject.toml': PYPROJECT }),
  'Python（只有 requirements.txt）': project([], { 'requirements.txt': 'httpx\npytest\n' }),
  'Django（manage.py）': project(['manage.py'], { 'requirements.txt': 'django\npytest\n' }),
  Go: project(['go.mod', 'go.sum']),
  Rust: project(['Cargo.toml', 'Cargo.lock']),
  'Makefile（有 test 目标）': project([], { Makefile: MAKEFILE }),
};

interface TableRow {
  setup: string[];
  verify: string[];
  /** The start command; null for （无）. */
  serve: string | null;
}

/** The rows of the commands table in docs/examples/README.md: name, setup, verify, start. */
function tableRows(): Map<string, TableRow> {
  const readme = readFileSync(join(import.meta.dirname, '../docs/examples/README.md'), 'utf8');
  const rows = new Map<string, TableRow>();
  for (const line of readme.split('\n')) {
    const cells = /^\| (.+?) \| (.+?) \| (.+?) \| (.+?) \|$/.exec(line);
    if (!cells?.[1] || !(cells[1] in TABLE_PROJECTS)) continue;
    const commands = (cell: string) => [...cell.matchAll(/`([^`]+)`/g)].map((m) => m[1] as string);
    const serve = commands(cells[4] ?? '');
    expect(serve.length).toBeLessThanOrEqual(1);
    rows.set(cells[1], {
      setup: commands(cells[2] ?? ''),
      verify: commands(cells[3] ?? ''),
      serve: serve[0] ?? null,
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
      expect({
        name,
        setup: found.setup,
        verify: found.verify,
        serve: found.serve?.command ?? null,
      }).toEqual({ name, ...rows.get(name) });
      expect(found.serve?.readyPath ?? '/').toBe('/');
      // One line for the ecosystem, and one more saying why there is no start command.
      expect(found.basis).toHaveLength(found.serve ? 1 : 2);
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

  it('installs yarn 2 and later with --immutable, by the major version of packageManager', () => {
    const setup = (packageManager: string | undefined, files = ['yarn.lock']) =>
      detectProjectCommands(
        project(files, {
          'package.json': JSON.stringify({ packageManager, scripts: { test: 'jest' } }),
        }),
      ).setup;
    for (const version of ['yarn@2.4.3', 'yarn@3.6.4', 'yarn@4.5.0+sha512.abc123', 'yarn@10.0.0']) {
      expect({ version, setup: setup(version) }).toEqual({
        version,
        setup: ['yarn install --immutable'],
      });
    }
    // yarn 1, a field with no version and no field at all: yarn 1's flag.
    for (const version of ['yarn@1.22.22', 'yarn', 'yarn@latest', undefined]) {
      expect({ version, setup: setup(version) }).toEqual({
        version,
        setup: ['yarn install --frozen-lockfile'],
      });
    }
    // Without yarn's lock file, no frozen install of either kind.
    expect(setup('yarn@4.5.0', ['package-lock.json'])).toEqual(['yarn install']);
    // The version of another manager changes nothing.
    expect(setup('pnpm@9.1.0', ['pnpm-lock.yaml'])).toEqual(['pnpm install --frozen-lockfile']);
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

  it('says a symlinked package.json was not read rather than that it could not be parsed', () => {
    // Listed among the files with no content: a symlink, as committedRootFiles reports one.
    const found = detectProjectCommands({ files: ['package.json', 'yarn.lock'], contents: {} });
    expect(found).toMatchObject({
      setup: ['yarn install --frozen-lockfile'],
      verify: [],
      serve: null,
    });
    expect(found.basis).toEqual([
      'Node（yarn）：package.json，有 `yarn.lock`；package.json 是符号链接，没有读它的内容，没有生成检查命令',
      '没有建议启动命令：package.json 是符号链接，没有读它的 scripts；项目要起服务时请按实际情况填写',
    ]);
    expect(found.basis.join('\n')).not.toContain('解析不了');
    setLang('en');
    expect(detectProjectCommands({ files: ['package.json'], contents: {} }).basis).toEqual([
      'Node (npm): package.json, no lock file found, so npm; package.json is a symlink, whose content is not read, so no verify commands',
      'No start command suggested: package.json is a symlink whose scripts were not read; fill one in if the project has a service to start',
    ]);
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
    expect(basis).toEqual([
      'Makefile：Makefile 里有 test 目标',
      '没有建议启动命令：从 Makefile 看不出服务怎么起；项目要起服务时请按实际情况填写',
    ]);
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
      '没有建议启动命令',
    ]);
    expect(found.serve).toBeNull();
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
      // manage.py alone is not a Python project: nothing would install Django.
      project(['manage.py']),
    ]) {
      const found = detectProjectCommands(files);
      expect(found.setup).toEqual([]);
      expect(found.verify).toEqual([]);
      expect(found.serve).toBeNull();
      // The start command is in the one line saying nothing was recognised.
      expect(found.basis).toHaveLength(1);
      expect(found.basis[0]).toContain('没有认得出的项目文件');
      expect(found.basis[0]).toContain('启动命令');
    }
  });

  it('writes the basis in English with no Chinese left', () => {
    setLang('en');
    const cases = [
      project(['pnpm-lock.yaml'], { 'package.json': PACKAGE_JSON }),
      project([], { 'package.json': '{' }),
      project([], { 'package.json': JSON.stringify({ packageManager: 'bun@1.1.0' }) }),
      project([], { 'package.json': JSON.stringify({ scripts: { start: 'node .' } }) }),
      project(['package.json']),
      project(['uv.lock'], { 'pyproject.toml': PYPROJECT }),
      project([], { 'pyproject.toml': '[project]\nname = "x"\n' }),
      project([], { 'requirements.txt': 'pytest\n' }),
      project(['manage.py', 'uv.lock'], { 'pyproject.toml': PYPROJECT }),
      project(['manage.py'], { 'requirements.txt': 'django\n', 'package.json': PACKAGE_JSON }),
      project(['go.mod', 'Cargo.toml'], { Makefile: MAKEFILE }),
      project(['README.md']),
    ];
    for (const files of cases) {
      const found = detectProjectCommands(files);
      for (const line of [...found.basis, found.serve?.basis ?? '']) {
        expect(line).not.toMatch(/[一-鿿]/);
      }
    }
    expect(
      detectProjectCommands(project(['yarn.lock'], { 'package.json': PACKAGE_JSON })).basis,
    ).toEqual(['Node (yarn): package.json, `yarn.lock` is there; scripts has build, test, lint']);
    expect(detectProjectCommands(project(['go.mod', 'Cargo.toml'])).basis[2]).toBe(
      'No start command suggested: go.mod, Cargo.toml do not tell how the service starts; fill one in if the project has a service to start',
    );
  });
});

describe('the start command detectProjectCommands suggests', () => {
  const node = (scripts: Record<string, string> | undefined, files: string[] = []) =>
    detectProjectCommands(project(files, { 'package.json': JSON.stringify({ scripts }) }));

  it("runs package.json's dev script, else its start script, from the root", () => {
    expect(node({ dev: 'vite' }).serve).toEqual({
      command: 'npm run dev',
      readyPath: '/',
      basis: expect.stringContaining('scripts 里有 dev'),
    });
    expect(node({ start: 'node server.js' }).serve).toEqual({
      command: 'npm start',
      readyPath: '/',
      basis: expect.stringContaining('scripts 里没有 dev，有 start'),
    });
    expect(node({ start: 'node server.js', dev: 'nodemon server.js' }).serve?.command).toBe(
      'npm run dev',
    );
    // A blank dev script is no script.
    expect(node({ dev: ' ', start: 'node .' }).serve?.command).toBe('npm start');
    // The service has its own basis; the ecosystems' lines stay one each.
    expect(node({ dev: 'vite', test: 'vitest' }, ['package-lock.json']).basis).toEqual([
      'Node（npm）：package.json，有 `package-lock.json`；scripts 里有 test',
    ]);
  });

  it('says the script must listen on 127.0.0.1 at $PORT', () => {
    const basis = node({ dev: 'vite' }, ['pnpm-lock.yaml']).serve?.basis;
    expect(basis).toBe(
      'Node：package.json 的 scripts 里有 dev，用 pnpm 运行它；服务要在 127.0.0.1 上监听环境变量 PORT 给的端口，脚本不是这样时请改命令（比如 vite 要加 --host 127.0.0.1 --port $PORT）',
    );
  });

  it('runs the script with the package manager detected', () => {
    const managers: [string, string, string][] = [
      ['package-lock.json', 'npm run dev', 'npm start'],
      ['pnpm-lock.yaml', 'pnpm dev', 'pnpm start'],
      ['yarn.lock', 'yarn dev', 'yarn start'],
      ['bun.lock', 'bun run dev', 'bun run start'],
    ];
    for (const [lock, dev, start] of managers) {
      expect({ lock, dev: node({ dev: 'x' }, [lock]).serve?.command }).toEqual({ lock, dev });
      expect({ lock, start: node({ start: 'x' }, [lock]).serve?.command }).toEqual({
        lock,
        start,
      });
    }
    // The packageManager field decides, as for the other commands.
    const pkg = JSON.stringify({ packageManager: 'yarn@4.5.0', scripts: { dev: 'next dev' } });
    expect(
      detectProjectCommands(project(['package-lock.json'], { 'package.json': pkg })).serve?.command,
    ).toBe('yarn dev');
  });

  it('suggests none for a package.json without dev or start, and says why', () => {
    // What npm init writes.
    const init = {
      test: 'echo "Error: no test specified" && exit 1',
    };
    for (const scripts of [init, { build: 'tsc', serve: 'node .' }, undefined]) {
      const found = node(scripts, ['package-lock.json']);
      expect(found.serve).toBeNull();
      expect(found.basis[1]).toBe(
        '没有建议启动命令：package.json 的 scripts 里没有 dev、start；项目要起服务时请按实际情况填写',
      );
    }
  });

  it('suggests none for a package.json it cannot read or parse', () => {
    const symlink = detectProjectCommands(project(['package.json', 'pnpm-lock.yaml']));
    expect(symlink.serve).toBeNull();
    expect(symlink.basis[1]).toContain('package.json 是符号链接，没有读它的 scripts');
    // Not even a dev script mentioned in an unparsable text.
    const broken = detectProjectCommands(
      project([], { 'package.json': '{ "scripts": { "dev": "vite" }' }),
    );
    expect(broken.serve).toBeNull();
    expect(broken.basis[1]).toContain('package.json 解析不了');
    const array = detectProjectCommands(project([], { 'package.json': '["dev"]' }));
    expect(array.serve).toBeNull();
  });

  it("runs Django's manage.py with the Python the setup commands install", () => {
    const uv = detectProjectCommands(
      project(['manage.py', 'uv.lock'], { 'pyproject.toml': PYPROJECT }),
    );
    expect(uv.setup).toEqual(['uv sync']);
    expect(uv.serve).toEqual({
      command: 'uv run python manage.py runserver 127.0.0.1:$PORT',
      readyPath: '/',
      basis: expect.stringContaining('uv 的环境'),
    });
    expect(uv.basis).toHaveLength(1);
    const venvProjects: Record<string, string>[] = [
      { 'pyproject.toml': PYPROJECT },
      { 'requirements.txt': 'django\n' },
    ];
    for (const contents of venvProjects) {
      const venv = detectProjectCommands(project(['manage.py'], contents));
      expect(venv.setup[0]).toBe('python3 -m venv .venv');
      expect(venv.serve).toEqual({
        command: '.venv/bin/python manage.py runserver 127.0.0.1:$PORT',
        readyPath: '/',
        basis: expect.stringContaining('.venv'),
      });
    }
    // uv.lock without pyproject.toml is not uv, for the service as for the setup.
    expect(
      detectProjectCommands(project(['manage.py', 'uv.lock'], { 'requirements.txt': 'django\n' }))
        .serve?.command,
    ).toBe('.venv/bin/python manage.py runserver 127.0.0.1:$PORT');
    // Without manage.py, Python suggests none.
    const plain = detectProjectCommands(project(['uv.lock'], { 'pyproject.toml': PYPROJECT }));
    expect(plain.serve).toBeNull();
    expect(plain.basis[1]).toContain('根目录没有 Django 的 manage.py');
  });

  it("prefers manage.py to package.json's script and says why", () => {
    const found = detectProjectCommands(
      project(['manage.py', 'package-lock.json'], {
        'requirements.txt': 'django\n',
        'package.json': PACKAGE_JSON,
      }),
    );
    expect(found.serve?.command).toBe('.venv/bin/python manage.py runserver 127.0.0.1:$PORT');
    expect(found.serve?.basis).toContain('`npm run dev`');
    expect(found.serve?.basis).toContain('通常只用来构建前端资源');
    // Both setups and the ecosystems' lines are kept.
    expect(found.setup).toEqual([
      'npm ci',
      'python3 -m venv .venv',
      '.venv/bin/pip install -r requirements.txt',
    ]);
    expect(found.basis).toHaveLength(2);
    // Node's start command when Python has no manage.py.
    expect(
      detectProjectCommands(
        project(['package-lock.json'], {
          'requirements.txt': 'pytest\n',
          'package.json': PACKAGE_JSON,
        }),
      ).serve?.command,
    ).toBe('npm run dev');
  });

  it('suggests none for Go, Rust or a Makefile, naming their files together', () => {
    for (const [files, why] of [
      [project(['go.mod']), '从 go.mod 看不出服务怎么起'],
      [project(['Cargo.toml']), '从 Cargo.toml 看不出服务怎么起'],
      [project([], { Makefile: MAKEFILE }), '从 Makefile 看不出服务怎么起'],
      [project(['go.mod'], { Makefile: MAKEFILE }), '从 go.mod、Makefile 看不出服务怎么起'],
    ] as const) {
      const found = detectProjectCommands(files);
      expect(found.serve).toBeNull();
      expect(found.basis.at(-1)).toBe(`没有建议启动命令：${why}；项目要起服务时请按实际情况填写`);
    }
    // Every reason, Node's and Python's first.
    const mixed = detectProjectCommands(
      project(['go.mod'], { 'package.json': '{}', 'requirements.txt': 'x\n' }),
    );
    expect(mixed.basis.at(-1)).toBe(
      '没有建议启动命令：package.json 的 scripts 里没有 dev、start；根目录没有 Django 的 manage.py；从 go.mod 看不出服务怎么起；项目要起服务时请按实际情况填写',
    );
    // Go's or Rust's files do not stop Node's suggestion.
    expect(
      detectProjectCommands(project(['go.mod', 'Cargo.toml'], { 'package.json': PACKAGE_JSON }))
        .serve?.command,
    ).toBe('npm run dev');
  });
});
