// Rewriting where one repo's requirements come from in the text of config.yaml, for setting it
// on the dashboard: the repo's entry under `github.repos`, `gitlab.repos` or `backlog.repos`, and
// the body of the request that asks for it (PUT /api/repos/:id/source).
//
// The file is the user's as much as the dashboard's, so the edit leaves everything else as it is
// written: sections it does not touch stay byte for byte, and in those it touches the other
// entries and every comment stay. An entry edited where it already is keeps the comments of the
// lines that stay. Only the fields of the request are written, so the schema's defaults apply to
// the rest just as when the file is edited by hand.
//
// Saving loads the edited file as the Master would before it takes the place of config.yaml, and
// puts the result in use at once.

import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import {
  Document,
  isMap,
  isNode,
  isPair,
  isScalar,
  isSeq,
  type Node,
  Pair,
  parseDocument,
  YAMLMap,
} from 'yaml';
import { z } from 'zod';
import type { RepoSourceInput } from '../api/types.js';
import { join as joinList, t } from '../i18n.js';
import { errorMessage } from '../util.js';
import {
  backlogConfigKey,
  ConfigError,
  githubConfigKey,
  gitlabConfigKey,
  type LoadedConfig,
} from './load.js';
import {
  type AgentConfig,
  AutoAcceptSchema,
  GitHubRepoSchema,
  GitLabRepoSchema,
  ProposalSourceSchema,
  ScoutConfigSchema,
} from './schema.js';
import type { ConfigWatcher } from './watch.js';

// ---------------------------------------------------------------------------
// The request body
// ---------------------------------------------------------------------------

// The fields validate as in config.yaml, with the same messages; only the defaults are taken off,
// so that a field the request leaves out stays out of the file instead of being filled in.
const scout = ScoutConfigSchema.shape;
const ScoutInputSchema = z.strictObject({
  agent: scout.agent,
  auto: scout.auto.unwrap().optional(),
  interval_minutes: scout.interval_minutes.unwrap().optional(),
  max_proposals: scout.max_proposals.unwrap().optional(),
});

const autoAccept = AutoAcceptSchema.shape;
const AutoAcceptInputSchema = z.strictObject({
  max_risk: autoAccept.max_risk.unwrap().optional(),
  max_size: autoAccept.max_size.unwrap().optional(),
  max_per_day: autoAccept.max_per_day,
});

const source = ProposalSourceSchema.shape;
const sourceFields = {
  template: source.template,
  scout: ScoutInputSchema.nullable().optional(),
  auto_accept: AutoAcceptInputSchema.optional(),
  auto_merge: source.auto_merge.unwrap().optional(),
  max_run_attempts: source.max_run_attempts.unwrap().optional(),
  daily_budget_usd: source.daily_budget_usd,
};

const github = GitHubRepoSchema.shape;
const gitlab = GitLabRepoSchema.shape;

/**
 * Body of PUT /api/repos/:id/source (`RepoSourceInput`). Each platform takes only its own fields:
 * the local backlog has no issues_repo, push or deliver, `none` has nothing else, and deliver is
 * `pr` on GitHub and `mr` on GitLab only.
 */
export const RepoSourceInputSchema = z.discriminatedUnion('platform', [
  z.strictObject({
    platform: z.literal('github'),
    issues_repo: github.issues_repo,
    ...sourceFields,
    push: github.push.unwrap().optional(),
    deliver: github.deliver.unwrap().optional(),
  }),
  z.strictObject({
    platform: z.literal('gitlab'),
    issues_repo: gitlab.issues_repo,
    ...sourceFields,
    push: gitlab.push.unwrap().optional(),
    deliver: gitlab.deliver.unwrap().optional(),
  }),
  z.strictObject({ platform: z.literal('backlog'), ...sourceFields }),
  z.strictObject({ platform: z.literal('none') }),
]) satisfies z.ZodType<RepoSourceInput>;

// The dashboard writes the body by the type in src/api/types.ts; the other direction of the check
// above, so that neither has a field the other lacks.
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const _sameAsApiType: Same<z.infer<typeof RepoSourceInputSchema>, RepoSourceInput> = true;

// ---------------------------------------------------------------------------
// The edit
// ---------------------------------------------------------------------------

const SOURCES = ['github', 'gitlab', 'backlog'] as const;
type Source = (typeof SOURCES)[number];

/** The fields of a repo's entry, in the order they are written. */
const ENTRY_FIELDS = [
  'issues_repo',
  'template',
  'scout',
  'auto_accept',
  'auto_merge',
  'max_run_attempts',
  'daily_budget_usd',
  'push',
  'deliver',
] as const;

/** The fields of the entry's mappings, in the order they are written. */
const NESTED_FIELDS: Record<string, readonly string[]> = {
  scout: ['agent', 'auto', 'interval_minutes', 'max_proposals'],
  auto_accept: ['max_risk', 'max_size', 'max_per_day'],
};

type FieldValue = string | number | boolean | Fields;
interface Fields {
  [field: string]: FieldValue;
}

/** What the edit puts in the file: the source the repo goes under, and its entry there. */
interface Target {
  source: Source;
  fields: Fields;
}

/** Options of the text written: long values stay on one line, as they were. */
const STRINGIFY = { lineWidth: 0 } as const;

/**
 * config.yaml's text with `repo` taking its requirements from where `input` says: its entry
 * removed from the other sources' `repos`, and written under the chosen one's (the section, or
 * its `repos`, made when missing; a `repos` left empty stays, since the section may have other
 * settings). `none` removes it from all three. The entry gets the fields of `input` only, in a
 * fixed order; one already under the chosen source is edited where it is, so the comments of the
 * lines that stay are kept. Throws a ConfigError when the text is not valid YAML or a section it
 * needs to write into is not a mapping. The result is not validated: that is the caller's.
 */
export function editRepoSource(text: string, repo: string, input: RepoSourceInput): string {
  const target: Target | null =
    input.platform === 'none'
      ? null
      : { source: input.platform, fields: pick(input, ENTRY_FIELDS) };
  return spliced(text, repo, target) ?? rewritten(text, repo, target);
}

/** The fields given, in order; scout: null and an empty mapping are as good as left out. */
function pick(given: object, fields: readonly string[]): Fields {
  const picked: Fields = {};
  for (const field of fields) {
    const value: unknown = (given as Record<string, unknown>)[field];
    if (value === undefined || value === null) continue;
    const nested = NESTED_FIELDS[field];
    if (nested && typeof value === 'object') {
      const inner = pick(value, nested);
      if (Object.keys(inner).length > 0) picked[field] = inner;
    } else if (!nested) {
      picked[field] = value as FieldValue;
    }
  }
  return picked;
}

function parse(text: string): Document {
  const doc = parseDocument(text);
  const [error] = doc.errors;
  if (error) {
    throw new ConfigError(
      t({
        zh: `config.yaml 不是合法的 YAML：${error.message}`,
        en: `config.yaml is not valid YAML: ${error.message}`,
      }),
    );
  }
  return doc;
}

/** The whole document written anew: when the top level is not one that `spliced` can keep. */
function rewritten(text: string, repo: string, target: Target | null): string {
  const doc = parse(text);
  applyEdit(doc, repo, target);
  return doc.toString(STRINGIFY);
}

/** Where a top-level section is in the text, and the comment lines it ends with. */
interface Region {
  start: number;
  end: number;
  trailing: string;
}

/**
 * The edit with only the sections it touches written anew, and the rest of the text as it was:
 * the yaml package would otherwise realign the comments at the ends of lines everywhere, and
 * indent the comments that end a section (often a commented-out section after it) as if they
 * were inside it. The comment lines at the end of a touched section are kept as written too.
 * null when the top level is not a block mapping, or the result does not read back the same.
 */
function spliced(text: string, repo: string, target: Target | null): string | null {
  const doc = parse(text);
  const top = doc.contents;
  if (top !== null && !(isMap(top) && !top.flow)) return null;
  const original = top ? [...top.items] : [];
  const regions = new Map<Pair, Region>();
  for (const pair of original) {
    if (!isScalar(pair.key) || !pair.key.range) return null;
    const value = isNode(pair.value) ? pair.value : null;
    const start = pair.key.range[0];
    const end = value?.range ? value.range[2] : pair.key.range[2];
    const trailing = isSection(pair) ? detachTrailing(text, value, end) : '';
    regions.set(pair, { start, end, trailing });
  }

  const touched = applyEdit(doc, repo, target);
  const indent = detectIndent(text, original);
  try {
    let out = '';
    let at = 0;
    for (const pair of original) {
      const region = regions.get(pair) as Region;
      out += text.slice(at, region.start);
      const written = text.slice(region.start, region.end);
      const changed = isSection(pair) && touched.has(keyName(pair));
      out += changed ? matchEnd(renderPair(pair, indent) + region.trailing, written) : written;
      at = region.end;
    }
    out += text.slice(at);
    const root = doc.contents;
    for (const pair of isMap(root) ? root.items : []) {
      if (!original.includes(pair)) out = separated(out) + renderPair(pair, indent);
    }

    const check = parseDocument(out);
    if (check.errors.length > 0 || !isDeepStrictEqual(check.toJS(), doc.toJS())) return null;
    return out;
  } catch {
    // An alias in a section to an anchor outside it, say: the whole document then.
    return null;
  }
}

/**
 * The comment lines a section ends with, as written, taken off the nodes they belong to so that
 * the section's new text does not have them twice: the comments after the last item of each
 * block collection on the way to the section's last value, and that value's own lines after it.
 */
function detachTrailing(text: string, value: Node | null, end: number): string {
  if (!value) return '';
  const path: Node[] = [value];
  for (let node: unknown = value; (isMap(node) || isSeq(node)) && !node.flow; ) {
    const last = node.items.at(-1);
    node = isPair(last) ? (last.value ?? last.key) : last;
    if (!isNode(node)) break;
    path.push(node);
  }
  const leaf = path.at(-1) as Node;
  if (!leaf.range) return '';
  for (const node of path.slice(0, -1)) node.comment = undefined;
  const lineEnd = text.indexOf('\n', leaf.range[1]);
  const sameLine = text.slice(leaf.range[1], lineEnd < 0 ? text.length : lineEnd);
  // A comment on the value's own line stays with it.
  if (leaf.comment) leaf.comment = sameLine.includes('#') ? leaf.comment.split('\n')[0] : undefined;
  return lineEnd < 0 || lineEnd + 1 >= end ? '' : text.slice(lineEnd + 1, end);
}

/** The new text of a section, ending in a line break only when the old one did. */
function matchEnd(rendered: string, written: string): string {
  return rendered.endsWith('\n') && !written.endsWith('\n') ? rendered.slice(0, -1) : rendered;
}

/** One top-level item on its own; the comments above it stay in the text before it. */
function renderPair(pair: Pair, indent: number): string {
  let key = pair.key;
  if (isScalar(pair.key)) {
    const clone = pair.key.clone();
    clone.commentBefore = undefined;
    clone.spaceBefore = undefined;
    key = clone;
  }
  const map = new YAMLMap();
  map.items = [new Pair(key, pair.value)];
  const single = new Document();
  single.contents = map;
  return single.toString({ ...STRINGIFY, indent });
}

/** The text with a blank line at its end, for a section added after it. */
function separated(text: string): string {
  if (text.trim() === '') return text;
  const ended = text.endsWith('\n') ? text : `${text}\n`;
  return ended.endsWith('\n\n') ? ended : `${ended}\n`;
}

/** How far the document indents a mapping in a top-level section; 2 when nothing says. */
function detectIndent(text: string, items: Pair[]): number {
  for (const pair of items) {
    const first = isMap(pair.value) && !pair.value.flow ? pair.value.items[0]?.key : undefined;
    if (!isNode(first) || !first.range) continue;
    const column = first.range[0] - (text.lastIndexOf('\n', first.range[0] - 1) + 1);
    if (column >= 1 && column <= 8) return column;
  }
  return 2;
}

/**
 * Removes `repo` from the other sources and writes it under the target. Returns the top-level
 * sources whose sections changed.
 */
function applyEdit(doc: Document, repo: string, target: Target | null): Set<string> {
  const touched = new Set<string>();
  for (const name of SOURCES) {
    if (name === target?.source) continue;
    const repos = reposOf(doc.contents, name);
    const index = repos ? indexOf(repos, repo) : -1;
    if (!repos || index < 0) continue;
    // The entry goes with what yaml counts as its own: the comments above it, on its lines and
    // inside it.
    repos.items.splice(index, 1);
    touched.add(name);
  }
  if (!target) return touched;

  const section = childMap(doc, rootMap(doc), target.source, target.source);
  const repos = childMap(doc, section, 'repos', `${target.source}.repos`);
  // A block mapping cannot go in a flow one.
  section.flow = false;
  repos.flow = false;
  const index = indexOf(repos, repo);
  const entry = repos.items[index];
  if (!entry) repos.items.push(doc.createPair(repo, target.fields));
  else if (isMap(entry.value)) syncMap(doc, entry.value, target.fields);
  else entry.value = replacing(entry.value, doc.createNode(target.fields));
  touched.add(target.source);
  return touched;
}

/**
 * Makes `map` hold exactly `fields`, keeping the nodes (and so the comments) of the fields it
 * already has: values change in place, fields not given are removed, new ones go after the
 * fields before them in the order of `fields`.
 */
function syncMap(doc: Document, map: YAMLMap, fields: Fields): void {
  map.items = map.items.filter((pair) => Object.hasOwn(fields, keyName(pair)));
  let at = 0;
  for (const [key, value] of Object.entries(fields)) {
    const index = indexOf(map, key);
    const pair = map.items[index];
    if (!pair) {
      map.items.splice(at, 0, doc.createPair(key, value));
      at += 1;
      continue;
    }
    if (typeof value === 'object' && isMap(pair.value)) syncMap(doc, pair.value, value);
    else if (typeof value !== 'object' && isScalar(pair.value)) pair.value.value = value;
    else pair.value = replacing(pair.value, doc.createNode(value));
    at = Math.max(at, index + 1);
  }
}

/** `node` in place of `old`, with the comments that were around `old`. */
function replacing(old: unknown, node: Node): Node {
  if (isNode(old)) {
    node.commentBefore = old.commentBefore;
    node.comment = old.comment;
    node.spaceBefore = old.spaceBefore;
  }
  return node;
}

/** The document's top-level mapping, made when the document has nothing but comments. */
function rootMap(doc: Document): YAMLMap {
  const top = doc.contents;
  if (isMap(top)) return top;
  if (isEmpty(top)) {
    const map = new YAMLMap();
    doc.contents = replacing(top, map);
    return map;
  }
  throw new ConfigError(
    t({
      zh: 'config.yaml 的顶层应为映射',
      en: 'config.yaml should be a mapping at the top level',
    }),
  );
}

/** The mapping under `key` of `parent`, made when it is missing or empty. */
function childMap(doc: Document, parent: YAMLMap, key: string, path: string): YAMLMap {
  const pair = parent.items[indexOf(parent, key)];
  if (pair && isMap(pair.value)) return pair.value;
  if (!pair || isEmpty(pair.value)) {
    const map = new YAMLMap();
    if (pair) pair.value = replacing(pair.value, map);
    else parent.items.push(doc.createPair(key, map));
    return map;
  }
  throw new ConfigError(
    t({
      zh: `config.yaml 的 ${path} 应为映射`,
      en: `${path} in config.yaml should be a mapping`,
    }),
  );
}

/** The `repos` mapping of a source's section, if the document has one. */
function reposOf(top: unknown, name: Source): YAMLMap | null {
  if (!isMap(top)) return null;
  const section = top.items[indexOf(top, name)]?.value;
  if (!isMap(section)) return null;
  const repos = section.items[indexOf(section, 'repos')]?.value;
  return isMap(repos) ? repos : null;
}

function isSection(pair: Pair): boolean {
  return (SOURCES as readonly string[]).includes(keyName(pair));
}

/** A key as the parsed object has it, so a repo named 1.0 or 123 is found too. */
function keyName(pair: Pair): string {
  return isScalar(pair.key) ? String(pair.key.value) : '';
}

/** Index of the item with key `key` (not a path: dots in a repo name are part of it), or -1. */
function indexOf(map: YAMLMap, key: string): number {
  return map.items.findIndex((pair) => isScalar(pair.key) && keyName(pair) === key);
}

function isEmpty(node: unknown): boolean {
  return node === null || node === undefined || (isScalar(node) && node.value === null);
}

// ---------------------------------------------------------------------------
// Saving
// ---------------------------------------------------------------------------

/** What saving needs of the configuration in use, as `watcherDeps` takes it from the watcher. */
export interface SourceEditDeps {
  /** config.yaml's path (a symlink is written through, to the file it points to). */
  configFile: string;
  /** Why the configuration failed to load the last time it was loaded again; null if it loaded. */
  reloadError: string | null;
  /** CLIs that can run an agent read-only, as the scout does. */
  readOnlyClis: readonly string[];
  /**
   * The configuration as it would load with `configFile` as config.yaml, put to no use; it
   * applies that file's `language` to the whole Master all the same (see `saveRepoSource`).
   */
  loadCandidate(configFile: string): LoadedConfig;
  /** Loads the configuration again and puts it in use; whether it loaded. */
  reload(): boolean;
}

/** What saving needs of `watcher`, as it is now: made for one save. */
export function watcherDeps(watcher: ConfigWatcher, configFile: string): SourceEditDeps {
  return {
    configFile,
    reloadError: watcher.status().reloadError?.message ?? null,
    readOnlyClis: watcher.readOnlyClis,
    loadCandidate: (file) => watcher.loadCandidate(file),
    reload: () => watcher.reload(),
  };
}

/** The configuration does not load as it is, so nothing could be checked or written (409). */
export class SourceEditConflict extends Error {}

/** The settings asked for have problems, listed one by one; config.yaml was left as it was (400). */
export class SourceEditInvalid extends Error {
  constructor(readonly problems: readonly string[]) {
    super(
      t({
        zh: '设置有问题，config.yaml 没有改动：\n',
        en: 'The settings have problems; config.yaml was left as it was:\n',
      }) + problems.join('\n'),
    );
  }
}

/**
 * Writes config.yaml with `repo` taking its requirements from where `input` says
 * (`editRepoSource`), and loads the configuration again. Throws a SourceEditConflict, touching
 * nothing, when the configuration does not load as it is (the last reload failed, or config.yaml
 * cannot be read or loaded now); a missing config.yaml counts as an empty one. The edited text is
 * loaded first as the Master would load it, from a file beside config.yaml; a SourceEditInvalid
 * lists what is wrong with it, with config.yaml left as it was: an invalid config.yaml, the
 * repo's problems as the loading rules find them (a missing template, a scout agent that is
 * missing or disabled, deliver without push, ...), and a scout agent that cannot run read-only.
 * Problems elsewhere, there before, do not stop it. Otherwise the file takes config.yaml's place
 * in one rename, so nothing ever reads it half written. Returns whether the reload put the new
 * configuration in use.
 *
 * Every step is synchronous, so two saves never interleave.
 *
 * `deps.loadCandidate` applies the candidate's `language` to the whole Master, as loading does
 * (`setLang`). The edit never touches `language`, so the language stays what it was; a save that
 * could change it would switch the language as soon as the candidate is checked, even when the
 * candidate is then refused, and would have to restore it.
 */
export function saveRepoSource(
  deps: SourceEditDeps,
  repo: string,
  input: RepoSourceInput,
): boolean {
  const text = currentText(deps);
  let edited: string;
  try {
    edited = editRepoSource(text, repo, input);
  } catch (err) {
    throw new SourceEditConflict(unloadable(errorMessage(err)));
  }

  const target = resolvedPath(deps.configFile);
  // Not named config.yaml, so that watching the directory takes no notice of it.
  const temp = join(dirname(target), `.config.yaml.${randomBytes(6).toString('hex')}.tmp`);
  const mode = modeOf(target);
  writeFileSync(temp, edited, { flag: 'wx' });
  let renamed = false;
  try {
    if (mode !== undefined) chmodSync(temp, mode);
    const problems = candidateProblems(deps, temp, repo, input);
    if (problems.length > 0) throw new SourceEditInvalid(problems);
    renameSync(temp, target);
    renamed = true;
  } finally {
    if (!renamed) rmSync(temp, { force: true });
  }
  return deps.reload();
}

/** config.yaml's text, once the configuration is known to load as it is. */
function currentText(deps: SourceEditDeps): string {
  if (deps.reloadError !== null) throw new SourceEditConflict(unloadable(deps.reloadError));
  let text = '';
  try {
    text = readFileSync(deps.configFile, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw new SourceEditConflict(unloadable(errorMessage(err)));
    }
  }
  try {
    deps.loadCandidate(deps.configFile);
  } catch (err) {
    throw new SourceEditConflict(unloadable(errorMessage(err)));
  }
  return text;
}

/** What is wrong with `repo`'s settings once `file` is loaded as config.yaml. */
function candidateProblems(
  deps: SourceEditDeps,
  file: string,
  repo: string,
  input: RepoSourceInput,
): string[] {
  let candidate: LoadedConfig;
  try {
    candidate = deps.loadCandidate(file);
  } catch (err) {
    return err instanceof ConfigError ? [...err.problems] : [errorMessage(err)];
  }
  const keys = [githubConfigKey(repo), gitlabConfigKey(repo), backlogConfigKey(repo)];
  const problems = keys.flatMap((key) => candidate.errors[key] ?? []);
  if (input.platform === 'none') return problems;
  // The loading rules only ask that the scout's agent be enabled; scouting refuses it later if
  // its CLI cannot run read-only, and the dashboard tells that now.
  const scout = candidate.master[input.platform]?.repos[repo]?.scout;
  const agent = scout ? candidate.agents.get(scout.agent) : undefined;
  if (agent && !deps.readOnlyClis.includes(agent.cli)) {
    problems.push(scoutNotReadOnly(agent, deps.readOnlyClis));
  }
  return problems;
}

function scoutNotReadOnly(agent: AgentConfig, readOnlyClis: readonly string[]): string {
  const readOnly = joinList(readOnlyClis);
  return readOnly
    ? t({
        zh: `侦察要以只读方式运行，Agent ${agent.id} 的 CLI ${agent.cli} 不支持，请换用 ${readOnly} 的 Agent`,
        en: `The scout runs read-only, which the CLI ${agent.cli} of agent ${agent.id} does not support; use an agent of ${readOnly}`,
      })
    : t({
        zh: `侦察要以只读方式运行，Agent ${agent.id} 的 CLI ${agent.cli} 不支持，请换用支持只读的 CLI 的 Agent`,
        en: `The scout runs read-only, which the CLI ${agent.cli} of agent ${agent.id} does not support; use an agent of a CLI that supports read-only`,
      });
}

function unloadable(reason: string): string {
  return t({
    zh: `配置现在加载不了，改好之后才能在看板上设置需求来源：${reason}`,
    en: `The configuration does not load as it is now; fix it before setting a requirements source on the dashboard: ${reason}`,
  });
}

/** The file a symlink points to, so that writing keeps the link; the path itself when missing. */
function resolvedPath(file: string): string {
  try {
    return realpathSync(file);
  } catch {
    return file;
  }
}

/** The permissions of an existing file, for the file that takes its place to keep them. */
function modeOf(file: string): number | undefined {
  try {
    return statSync(file).mode & 0o777;
  } catch {
    return undefined;
  }
}
