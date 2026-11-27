// Setup and verify commands suggested for a repo by the files at its root: which ecosystems it is
// (Node, Python, Go, Rust, a Makefile) and, for those, which package manager, scripts and tools.
// The rules follow the table of docs/examples/README.md ("在看板上登记仓库"), the one place they
// are written for people; change both together.
//
// Keep this file pure logic, importing no Node module (fs, child_process, path, ...) and nothing
// that does: the caller reads the files (`committedRootFiles` in src/workspace/git.ts), so the
// rules are tested on plain objects, and they stay free to be shared with the dashboard, which
// cannot bundle Node modules. The type the API returns, `DetectedCommands`, lives in
// src/api/types.ts, which the dashboard imports.

import type { DetectedCommands } from '../api/types.js';
import { join, t } from '../i18n.js';

/** The files at the root whose content the rules read, when they are there. */
export const DETECT_READ_FILES = [
  'package.json',
  'pyproject.toml',
  'requirements.txt',
  'GNUmakefile',
  'makefile',
  'Makefile',
] as const;

export interface ProjectFiles {
  /** Names of the files at the repo's root (directories left out), symlinks among them. */
  files: readonly string[];
  /**
   * Content of the files of `DETECT_READ_FILES` that are there as regular files, by name. A
   * symlink is in `files` but not here: its content is not read, since it may point anywhere.
   */
  contents: Readonly<Record<string, string>>;
}

/** What one ecosystem adds. */
interface Found {
  setup: string[];
  verify: string[];
  basis: string;
}

type NodeManager = 'npm' | 'pnpm' | 'yarn' | 'bun';

/** Lock files and the package manager each means, in the order looked for. */
const NODE_LOCKS: readonly (readonly [string, NodeManager])[] = [
  ['package-lock.json', 'npm'],
  ['npm-shrinkwrap.json', 'npm'],
  ['pnpm-lock.yaml', 'pnpm'],
  ['yarn.lock', 'yarn'],
  ['bun.lock', 'bun'],
  ['bun.lockb', 'bun'],
];

/** The package.json scripts made into verify commands, in this order. */
const NODE_SCRIPTS = ['build', 'test', 'lint'] as const;

/**
 * The setup and verify commands the files at a repo's root suggest, ecosystem after ecosystem
 * (Node, Python, Go, Rust, Makefile), with no command twice. Empty lists, and a basis telling so,
 * when no ecosystem is recognised.
 */
export function detectProjectCommands(project: ProjectFiles): DetectedCommands {
  const has = new Set(project.files);
  const found = [
    detectNode(has, project.contents),
    detectPython(has, project.contents),
    detectGo(has),
    detectRust(has),
    detectMake(has, project.contents),
  ].filter((f): f is Found => f !== undefined);
  if (found.length === 0) {
    return {
      setup: [],
      verify: [],
      basis: [
        t({
          zh: '根目录下没有认得出的项目文件（package.json、pyproject.toml、requirements.txt、go.mod、Cargo.toml、带 test 目标的 Makefile），请按项目实际情况填写',
          en: 'No project file recognised at the root (package.json, pyproject.toml, requirements.txt, go.mod, Cargo.toml, a Makefile with a test target); fill them in by hand',
        }),
      ],
    };
  }
  return {
    setup: unique(found.flatMap((f) => f.setup)),
    verify: unique(found.flatMap((f) => f.verify)),
    basis: found.map((f) => f.basis),
  };
}

function unique(commands: string[]): string[] {
  return [...new Set(commands)];
}

/** `name` in backquotes, for the basis. */
function code(name: string): string {
  return `\`${name}\``;
}

// ---- Node ------------------------------------------------------------------------------------

function detectNode(has: Set<string>, contents: ProjectFiles['contents']): Found | undefined {
  if (!has.has('package.json')) return undefined;
  // There but not read: a symlink.
  const text = contents['package.json'];
  const pkg = text === undefined ? undefined : parsePackageJson(text);

  const lock = NODE_LOCKS.find(([file]) => has.has(file));
  const declared = declaredManager(pkg?.packageManager);
  const manager: NodeManager = declared?.name ?? lock?.[1] ?? 'npm';
  // The lock file of the manager used: a frozen install needs it.
  const ownLock = NODE_LOCKS.find(([file, m]) => m === manager && has.has(file))?.[0];
  // Yarn 2 and later (Berry) replaced --frozen-lockfile with --immutable. Without the field
  // nothing tells the versions apart, and yarn 1 is the one to install by default.
  const berry = manager === 'yarn' && (declared?.major ?? 1) >= 2;
  const setup = [nodeInstall(manager, ownLock !== undefined, berry)];

  const scripts =
    pkg?.scripts && typeof pkg.scripts === 'object' && !Array.isArray(pkg.scripts)
      ? (pkg.scripts as Record<string, unknown>)
      : {};
  const present = NODE_SCRIPTS.filter((name) => {
    const script = scripts[name];
    if (typeof script !== 'string' || script.trim() === '') return false;
    // The placeholder `npm init` writes fails on purpose.
    return !(name === 'test' && script.includes('no test specified'));
  });
  const verify = present.map((name) => nodeRun(manager, name));

  const why =
    declared !== undefined
      ? t({
          zh: `packageManager 字段是 ${code(String(pkg?.packageManager))}`,
          en: `the packageManager field is ${code(String(pkg?.packageManager))}`,
        })
      : lock
        ? t({ zh: `有 ${code(lock[0])}`, en: `${code(lock[0])} is there` })
        : t({ zh: '没找到锁文件，按 npm 处理', en: 'no lock file found, so npm' });
  const what =
    text === undefined
      ? t({
          zh: 'package.json 是符号链接，没有读它的内容，没有生成检查命令',
          en: 'package.json is a symlink, whose content is not read, so no verify commands',
        })
      : pkg === undefined
        ? t({
            zh: 'package.json 解析不了，没有生成检查命令',
            en: 'package.json could not be parsed, so no verify commands',
          })
        : present.length > 0
          ? t({
              zh: `scripts 里有 ${join(present)}`,
              en: `scripts has ${join(present)}`,
            })
          : t({
              zh: 'scripts 里没有 build、test、lint，没有生成检查命令',
              en: 'scripts has no build, test or lint, so no verify commands',
            });
  return {
    setup,
    verify,
    basis: t({
      zh: `Node（${manager}）：package.json，${why}；${what}`,
      en: `Node (${manager}): package.json, ${why}; ${what}`,
    }),
  };
}

/** package.json's fields the rules read; undefined when the text is not a JSON object. */
function parsePackageJson(
  text: string,
): { packageManager?: unknown; scripts?: unknown } | undefined {
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The manager the packageManager field ("pnpm@9.1.0", "yarn@4.1.0+sha512.…") names, if one
 * known, and the major version it gives, if it gives one.
 */
function declaredManager(field: unknown): { name: NodeManager; major?: number } | undefined {
  if (typeof field !== 'string') return undefined;
  const [rawName, version = ''] = field.split('@');
  const name = rawName?.trim();
  if (name !== 'npm' && name !== 'pnpm' && name !== 'yarn' && name !== 'bun') return undefined;
  const major = /^\s*v?(\d+)/.exec(version)?.[1];
  return major === undefined ? { name } : { name, major: Number(major) };
}

/** `berry`: yarn 2 or later, whose frozen install is `--immutable`. */
function nodeInstall(manager: NodeManager, locked: boolean, berry: boolean): string {
  switch (manager) {
    case 'npm':
      return locked ? 'npm ci' : 'npm install';
    case 'pnpm':
      return locked ? 'pnpm install --frozen-lockfile' : 'pnpm install';
    case 'yarn':
      if (!locked) return 'yarn install';
      return berry ? 'yarn install --immutable' : 'yarn install --frozen-lockfile';
    case 'bun':
      return 'bun install';
  }
}

function nodeRun(manager: NodeManager, script: (typeof NODE_SCRIPTS)[number]): string {
  switch (manager) {
    case 'npm':
      return script === 'test' ? 'npm test' : `npm run ${script}`;
    case 'pnpm':
      return `pnpm ${script}`;
    case 'yarn':
      return `yarn ${script}`;
    case 'bun':
      // `bun test` is bun's own test runner, not the script.
      return `bun run ${script}`;
  }
}

// ---- Python ----------------------------------------------------------------------------------

function detectPython(has: Set<string>, contents: ProjectFiles['contents']): Found | undefined {
  const pyproject = has.has('pyproject.toml') ? (contents['pyproject.toml'] ?? '') : undefined;
  const requirements = has.has('requirements.txt')
    ? (contents['requirements.txt'] ?? '')
    : undefined;
  if (pyproject === undefined && requirements === undefined) return undefined;
  const ruff =
    has.has('ruff.toml') ||
    has.has('.ruff.toml') ||
    (pyproject !== undefined && pyprojectUsesRuff(pyproject)) ||
    (requirements !== undefined && requirementsListRuff(requirements));
  const ruffWhy = ruff
    ? t({ zh: '项目里配置了 ruff', en: 'the project sets up ruff' })
    : t({
        zh: '没看到 ruff 的配置或依赖，不加 ruff 的检查',
        en: 'no ruff setup or dependency seen, so no ruff checks',
      });

  if (pyproject !== undefined && has.has('uv.lock')) {
    return {
      setup: ['uv sync'],
      verify: [
        ...(ruff ? ['uv run ruff check .', 'uv run ruff format --check .'] : []),
        'uv run pytest',
      ],
      basis: t({
        zh: `Python（uv）：pyproject.toml 和 uv.lock；${ruffWhy}`,
        en: `Python (uv): pyproject.toml and uv.lock; ${ruffWhy}`,
      }),
    };
  }
  const verify = [
    ...(ruff ? ['.venv/bin/ruff check .', '.venv/bin/ruff format --check .'] : []),
    '.venv/bin/pytest',
  ];
  if (pyproject !== undefined) {
    const dev = hasDevExtra(pyproject)
      ? ''
      : t({
          zh: '；pyproject.toml 里没看到 dev 可选依赖，`.[dev]` 请按项目实际情况改',
          en: '; no dev optional dependencies seen in pyproject.toml, so adjust `.[dev]` to the project',
        });
    return {
      setup: ['python3 -m venv .venv', ".venv/bin/pip install -e '.[dev]'"],
      verify,
      basis: t({
        zh: `Python（pip + venv）：pyproject.toml，没有 uv.lock；${ruffWhy}${dev}`,
        en: `Python (pip + venv): pyproject.toml without uv.lock; ${ruffWhy}${dev}`,
      }),
    };
  }
  return {
    setup: ['python3 -m venv .venv', '.venv/bin/pip install -r requirements.txt'],
    verify,
    basis: t({
      zh: `Python（pip + venv）：只有 requirements.txt；${ruffWhy}`,
      en: `Python (pip + venv): only requirements.txt; ${ruffWhy}`,
    }),
  };
}

/** The `[section]` headers of a TOML text and the lines under each, by header. */
function tomlSections(text: string): Map<string, string[]> {
  const sections = new Map<string, string[]>();
  let lines: string[] = [];
  sections.set('', lines);
  for (const line of text.split(/\r?\n/)) {
    const header = /^\s*\[\[?\s*([^\]]+?)\s*\]\]?\s*(#.*)?$/.exec(line);
    if (header?.[1]) {
      const name = header[1].replace(/\s*\.\s*/g, '.').replace(/["']/g, '');
      lines = sections.get(name) ?? [];
      sections.set(name, lines);
      continue;
    }
    lines.push(line);
  }
  return sections;
}

/** ruff configured (`[tool.ruff]`) or named among the dependencies, as `"ruff…"`. */
function pyprojectUsesRuff(text: string): boolean {
  for (const name of tomlSections(text).keys()) {
    if (name === 'tool.ruff' || name.startsWith('tool.ruff.')) return true;
  }
  return /["']ruff(?![\w.-])/.test(text);
}

/** A requirements line that installs ruff. */
function requirementsListRuff(text: string): boolean {
  return /^\s*ruff(?![\w.-])/im.test(text);
}

/** `[project.optional-dependencies]` has a `dev` entry. */
function hasDevExtra(text: string): boolean {
  const lines = tomlSections(text).get('project.optional-dependencies') ?? [];
  return lines.some((line) => /^\s*["']?dev["']?\s*=/.test(line));
}

// ---- Go and Rust -----------------------------------------------------------------------------

function detectGo(has: Set<string>): Found | undefined {
  if (!has.has('go.mod')) return undefined;
  return {
    setup: ['go mod download'],
    verify: ['go build ./...', 'go vet ./...', 'go test ./...'],
    basis: t({ zh: 'Go：go.mod', en: 'Go: go.mod' }),
  };
}

function detectRust(has: Set<string>): Found | undefined {
  if (!has.has('Cargo.toml')) return undefined;
  return {
    setup: ['cargo fetch'],
    verify: [
      'cargo build --all-targets',
      'cargo clippy --all-targets -- -D warnings',
      'cargo test',
      'cargo fmt --check',
    ],
    basis: t({ zh: 'Rust：Cargo.toml', en: 'Rust: Cargo.toml' }),
  };
}

// ---- Makefile --------------------------------------------------------------------------------

/** The makefiles make reads, in the order it looks for them. */
const MAKEFILES = ['GNUmakefile', 'makefile', 'Makefile'] as const;

function detectMake(has: Set<string>, contents: ProjectFiles['contents']): Found | undefined {
  const file = MAKEFILES.find((name) => has.has(name));
  if (file === undefined || !makeTargets(contents[file] ?? '').has('test')) return undefined;
  return {
    setup: [],
    verify: ['make test'],
    basis: t({
      zh: `Makefile：${file} 里有 test 目标`,
      en: `Makefile: ${file} has a test target`,
    }),
  };
}

/**
 * The targets a makefile's rules name: `name …:` at the start of a line, not a recipe line
 * (tab), a comment, or a variable assignment (`:=`, `::=`).
 */
function makeTargets(text: string): Set<string> {
  const targets = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    const rule = /^([^:=#\s][^:=#]*?)\s*::?(?![:=])/.exec(line);
    if (!rule?.[1]) continue;
    for (const target of rule[1].split(/\s+/)) targets.add(target);
  }
  return targets;
}
