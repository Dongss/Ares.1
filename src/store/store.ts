import { EventEmitter } from 'node:events';
import { copyFileSync, existsSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { t } from '../i18n.js';
import { errorMessage, newId, nowIso } from '../util.js';
import { MIGRATIONS } from './migrations.js';
import {
  type AgentAttemptTotals,
  type AgentLastError,
  type AgentScoutTotals,
  type Approval,
  type Artifact,
  type Attempt,
  type CheckResult,
  type EventRow,
  FINISHED_RUN_STATUSES,
  type Iteration,
  type IterationStatus,
  type Proposal,
  type ProposalStatus,
  type RedoState,
  type Repo,
  type Run,
  type RunIssue,
  type RunStatus,
  type Scout,
  type StageRun,
  type Task,
} from './types.js';

type Table =
  | 'repos'
  | 'runs'
  | 'stage_runs'
  | 'tasks'
  | 'attempts'
  | 'check_results'
  | 'approvals'
  | 'artifacts'
  | 'scouts'
  | 'proposals'
  | 'iterations';

/**
 * An issue as a Run records it (`RunIssue`): its repo and number on its code host, GitHub when it
 * names none. The same path and number may be an issue on GitHub and another on GitLab (a mirror,
 * say): the platform tells them apart.
 */
export type RunIssueKey = Pick<RunIssue, 'repo' | 'number' | 'platform'>;

/**
 * The condition on `runs` that picks the Runs of one issue, its parameters given by
 * `issueParams`. A Run of an issue on GitHub records no platform.
 */
const OF_ISSUE = `json_extract(issue, '$.repo') = ? AND json_extract(issue, '$.number') = ?
  AND COALESCE(json_extract(issue, '$.platform'), 'github') = ?`;

/** The parameters of `OF_ISSUE` for the issue. */
function issueParams(issue: RunIssueKey): SQLInputValue[] {
  return [issue.repo, issue.number, issue.platform ?? 'github'];
}

/** Columns stored as JSON text. */
const JSON_COLUMNS: Partial<Record<Table, readonly string[]>> = {
  repos: ['verify_commands', 'setup_commands'],
  runs: ['template', 'overrides', 'blocked', 'issue', 'discussion'],
  attempts: ['structured'],
  scouts: ['proposals', 'gaps'],
  proposals: ['evidence', 'acceptance', 'depends_on', 'failures'],
  iterations: ['criteria', 'out_of_scope', 'children', 'notes'],
};
const BOOL_COLUMNS: Partial<Record<Table, readonly string[]>> = {
  check_results: ['passed'],
  proposals: ['auto'],
  iterations: ['auto', 'summary_posted'],
};
/**
 * Object fields kept one key per column, by field: key `number` of field `pr` in column
 * `pr_number`. Null in every column is a null field.
 */
const SPLIT_COLUMNS: Partial<Record<Table, Record<string, readonly string[]>>> = {
  runs: { pr: ['number', 'url'] },
  iterations: { issue: ['number', 'url'] },
};

const toSnake = (key: string) => key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
const toCamel = (key: string) => key.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());

/**
 * A row of the events table that belongs to no Run. A type literal rather than an interface, so
 * that the rows node:sqlite returns can be cast to it.
 */
type GlobalEventRow = {
  id: number;
  ts: string;
  type: string;
  data: string;
};

const globalEvent = (r: GlobalEventRow): EventRow => ({
  id: r.id,
  runId: null,
  ts: r.ts,
  type: r.type,
  data: JSON.parse(r.data) as Record<string, unknown>,
});

export interface StoreEvents {
  event: [EventRow];
}

/** A database newer than this Master, replaced by the backup taken before it was migrated. */
export interface BackupRestore {
  /** The backup copied into place. */
  backup: string;
  /** Where the newer database went; its -wal and -shm, if any, carry the same suffixes. */
  movedTo: string;
  /** Version of the newer database. */
  fromVersion: number;
  /** Version of the backup: the one this Master supports. */
  toVersion: number;
}

/** SQLite's files beside a database, which belong to it. */
const SIDECARS = ['-wal', '-shm'] as const;

/** A time for file names; in name order these sort by time. */
const fileStamp = () => nowIso().replace(/[:.]/g, '-');

function openDatabase(file: string): DatabaseSync {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  return db;
}

function userVersion(db: DatabaseSync): number {
  return (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
}

function removeDatabase(file: string): void {
  for (const suffix of ['', ...SIDECARS]) rmSync(file + suffix, { force: true });
}

/** Name prefix of the backups taken before migrating a database of `version`. */
function backupPrefix(file: string, version: number): string {
  // The dash after the number keeps v1 from matching v10.
  return `${basename(file)}.bak-v${version}-`;
}

/**
 * How many backups taken before migrations to keep. A Master rolled back after an upgrade needs
 * only the newest; a few more are enough to look into or recover from several bad upgrades in a
 * row. Each is a full copy of the database, and a self-developing Master can upgrade a dozen times
 * a day, so keeping every one would fill the disk.
 */
export const KEEP_BACKUPS = 5;

const byCodeUnits = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** Matches exactly the names of the backups of `file`; group 1 is the time in the name. */
function backupPattern(file: string): RegExp {
  const name = basename(file).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^${name}\\.bak-v\\d+-(\\d{4}-\\d\\d-\\d\\dT\\d\\d-\\d\\d-\\d\\d-\\d{3}Z)$`);
}

/**
 * Deletes the backups of `file` but the newest KEEP_BACKUPS, `fresh` (the one just taken) always
 * among those kept. Anything else beside the database stays: sidecars, renamed databases, copies
 * people made. Failing to delete is only a warning: the database itself is fine.
 */
function pruneBackups(file: string, fresh: string): void {
  const dir = dirname(file);
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch (err) {
    console.warn(
      t({
        zh: `[数据库] 读取 ${dir} 失败，没有清理旧的迁移前备份：${errorMessage(err)}`,
        en: `[database] Could not read ${dir} to delete old backups taken before migrations: ${errorMessage(err)}`,
      }),
    );
    return;
  }
  const pattern = backupPattern(file);
  const freshName = basename(fresh);
  const older = names
    .filter((name) => name !== freshName)
    .flatMap((name) => {
      const stamp = pattern.exec(name)?.[1];
      return stamp === undefined ? [] : [{ name, stamp }];
    })
    // Newest first by the time in the name: modification times change when files are copied, and
    // in name order v10 comes before v9.
    .sort((a, b) => byCodeUnits(b.stamp, a.stamp) || byCodeUnits(b.name, a.name));
  for (const { name } of older.slice(KEEP_BACKUPS - 1)) {
    const path = join(dir, name);
    try {
      rmSync(path);
    } catch (err) {
      console.warn(
        t({
          zh: `[数据库] 删除旧的迁移前备份 ${path} 失败：${errorMessage(err)}`,
          en: `[database] Could not delete ${path}, an old backup taken before a migration: ${errorMessage(err)}`,
        }),
      );
    }
  }
}

/** The newest backup of `file` taken before migrating it from exactly `version`, or null. */
function findBackup(file: string, version: number): string | null {
  const dir = dirname(file);
  const prefix = backupPrefix(file, version);
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return null;
  }
  const last = names
    .filter((n) => n.startsWith(prefix) && !SIDECARS.some((s) => n.endsWith(s)))
    .sort()
    .at(-1);
  return last === undefined ? null : join(dir, last);
}

function newerError(file: string, version: number): Error {
  const supported = MIGRATIONS.length;
  const dir = dirname(file);
  const name = basename(file);
  const pattern = `${backupPrefix(file, supported)}*`;
  return new Error(
    t({
      zh: `数据库版本（${version}）比当前 Master 支持的（${supported}）更新，${dir} 里也没有升到更新版本之前的备份（${pattern}）可以自动恢复。请升级 Master，或者从 ${dir} 里形如 ${name}.bak-v<版本>-<时间> 的备份中挑一份版本不超过 ${supported} 的，把 ${name} 及其 -wal、-shm 移开后，复制成 ${name}`,
      en: `The database version (${version}) is newer than this Master supports (${supported}), and ${dir} has no backup taken before it was migrated past that (${pattern}) to restore automatically. Upgrade the Master, or pick a backup of version ${supported} or older among the ${name}.bak-v<version>-<time> files in ${dir}, move ${name} and its -wal and -shm files away, and copy the backup to ${name}`,
    }),
  );
}

/**
 * The database is newer than this Master: an upgrade was rolled back after the new version had
 * migrated it, or an older version was started by hand. Puts back the newest backup taken right
 * before it was migrated past this version, and keeps the newer database beside it, renamed, to
 * be recovered after upgrading again. Without such a backup, throws and leaves every file as it was.
 */
function restoreBackup(file: string, version: number): BackupRestore {
  const toVersion = MIGRATIONS.length;
  const backup = findBackup(file, toVersion);
  if (!backup) throw newerError(file, version);
  const stamp = fileStamp();
  const failed = (err: unknown) =>
    new Error(
      t({
        zh: `数据库版本（${version}）比当前 Master 支持的（${toVersion}）更新，恢复备份 ${backup} 失败：${errorMessage(err)}`,
        en: `The database version (${version}) is newer than this Master supports (${toVersion}), and restoring the backup ${backup} failed: ${errorMessage(err)}`,
      }),
    );
  // Copy and check the backup before anything moves, so that a bad one changes nothing.
  const copy = `${file}.restoring-${stamp}`;
  try {
    copyFileSync(backup, copy);
    const db = new DatabaseSync(copy);
    let got: number;
    try {
      got = userVersion(db);
    } finally {
      db.close();
    }
    if (got !== toVersion) {
      throw new Error(
        t({
          zh: `备份的版本是 ${got}，不是 ${toVersion}`,
          en: `the backup is version ${got}, not ${toVersion}`,
        }),
      );
    }
  } catch (err) {
    removeDatabase(copy);
    throw failed(err);
  }
  const movedTo = `${file}.newer-v${version}-${stamp}`;
  const moved: string[] = [];
  try {
    for (const suffix of ['', ...SIDECARS]) {
      if (!existsSync(file + suffix)) continue;
      renameSync(file + suffix, movedTo + suffix);
      moved.push(suffix);
    }
    renameSync(copy, file);
  } catch (err) {
    // Without its database the next start would begin from an empty one: put it back.
    for (const suffix of moved) renameSync(movedTo + suffix, file + suffix);
    removeDatabase(copy);
    throw failed(err);
  }
  return { backup, movedTo, fromVersion: version, toVersion };
}

/** The line the Master prints when it put a backup back. */
export function backupRestoredNotice(r: BackupRestore): string {
  return t({
    zh: `[数据库] 数据库版本（${r.fromVersion}）比当前 Master 支持的（${r.toVersion}）更新，多半是升级回退到了旧版本：已恢复迁移前的备份 ${r.backup}，较新的数据库移到了 ${r.movedTo}，以后再升级时可以从那里找回`,
    en: `[database] The database (version ${r.fromVersion}) is newer than this Master supports (version ${r.toVersion}), most likely because an upgrade was rolled back: restored the backup taken before the migration, ${r.backup}; the newer database was moved to ${r.movedTo}, where it can be recovered after upgrading again`,
  });
}

/**
 * Persistent state. Synchronous on purpose: node:sqlite is synchronous and the
 * Master is a single process, so every method is atomic with respect to the event loop.
 */
export class Store {
  readonly db: DatabaseSync;
  /** Emits every appended event, for live views. */
  readonly bus = new EventEmitter<StoreEvents>();
  /** Set when the database was newer than this Master and the backup from before was put back. */
  readonly restoredBackup: BackupRestore | null = null;

  constructor(file: string) {
    const isNew = file === ':memory:' || !existsSync(file);
    this.db = openDatabase(file);
    const version = userVersion(this.db);
    if (version > MIGRATIONS.length) {
      this.db.close();
      this.restoredBackup = restoreBackup(file, version);
      this.db = openDatabase(file);
    }
    this.migrate(file, isNew);
    if (this.restoredBackup) this.event(null, 'store.backup_restored', { ...this.restoredBackup });
  }

  /** Apply pending migrations; back the database up first unless it is brand new. */
  private migrate(file: string, isNew: boolean): void {
    const current = userVersion(this.db);
    if (current > MIGRATIONS.length) throw newerError(file, current);
    if (current === MIGRATIONS.length) return;
    let backup: string | null = null;
    if (!isNew && current > 0) {
      // A Master rolled back to this version finds it here; see restoreBackup.
      backup = `${file}.bak-v${current}-${fileStamp()}`;
      this.db.exec(`VACUUM INTO '${backup.replace(/'/g, "''")}'`);
    }
    for (let v = current; v < MIGRATIONS.length; v++) {
      this.tx(() => {
        this.db.exec(MIGRATIONS[v] as string);
        this.db.exec(`PRAGMA user_version = ${v + 1}`);
      });
    }
    // Only once the migrations went through: starts failing halfway would each take a backup of
    // the half-migrated database and could push out the one a rolled-back Master needs.
    if (backup) pruneBackups(file, backup);
  }

  close(): void {
    this.db.close();
  }

  /** Run `fn` in a transaction. Nested calls join the outer transaction. */
  tx<T>(fn: () => T): T {
    if (this.db.isTransaction) return fn();
    this.db.exec('BEGIN');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  // ---- generic helpers ---------------------------------------------------

  private toRow(table: Table, obj: Record<string, unknown>): Record<string, SQLInputValue> {
    const json = JSON_COLUMNS[table] ?? [];
    const bool = BOOL_COLUMNS[table] ?? [];
    const split = SPLIT_COLUMNS[table] ?? {};
    const row: Record<string, SQLInputValue> = {};
    for (const [key, value] of Object.entries(obj)) {
      if (value === undefined) continue;
      const col = toSnake(key);
      const parts = split[key];
      if (parts) {
        const fields = value as Record<string, SQLInputValue> | null;
        for (const part of parts) row[`${col}_${toSnake(part)}`] = fields?.[part] ?? null;
      } else if (json.includes(col)) row[col] = value === null ? null : JSON.stringify(value);
      else if (bool.includes(col)) row[col] = value ? 1 : 0;
      else row[col] = value as SQLInputValue;
    }
    return row;
  }

  private fromRow<T>(table: Table, row: Record<string, unknown> | undefined): T | undefined {
    if (!row) return undefined;
    const json = JSON_COLUMNS[table] ?? [];
    const bool = BOOL_COLUMNS[table] ?? [];
    const obj: Record<string, unknown> = {};
    for (const [col, value] of Object.entries(row)) {
      let v = value;
      if (json.includes(col)) v = typeof value === 'string' ? JSON.parse(value) : null;
      else if (bool.includes(col)) v = value === 1;
      obj[toCamel(col)] = v;
    }
    for (const [field, parts] of Object.entries(SPLIT_COLUMNS[table] ?? {})) {
      const cols = parts.map((part) => `${toSnake(field)}_${toSnake(part)}`);
      if (!cols.some((col) => col in row)) continue;
      for (const col of cols) delete obj[toCamel(col)];
      obj[field] = cols.every((col) => row[col] === null || row[col] === undefined)
        ? null
        : Object.fromEntries(parts.map((part, i) => [part, row[cols[i] as string]]));
    }
    return obj as T;
  }

  private insert(table: Table, obj: object): void {
    const row = this.toRow(table, obj as Record<string, unknown>);
    const cols = Object.keys(row);
    const sql = `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`;
    this.db.prepare(sql).run(...cols.map((c) => row[c] as SQLInputValue));
  }

  private patch(table: Table, id: string, patch: object): void {
    const row = this.toRow(table, patch as Record<string, unknown>);
    const cols = Object.keys(row);
    if (cols.length === 0) return;
    const sql = `UPDATE ${table} SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`;
    const result = this.db.prepare(sql).run(...cols.map((c) => row[c] as SQLInputValue), id);
    if (result.changes === 0) {
      throw new Error(t({ zh: `${table} ${id} 不存在`, en: `${table} ${id} not found` }));
    }
  }

  private one<T>(table: Table, sql: string, ...params: SQLInputValue[]): T | undefined {
    return this.fromRow<T>(
      table,
      this.db.prepare(sql).get(...params) as Record<string, unknown> | undefined,
    );
  }

  private many<T>(table: Table, sql: string, ...params: SQLInputValue[]): T[] {
    return (this.db.prepare(sql).all(...params) as Record<string, unknown>[]).map(
      (r) => this.fromRow<T>(table, r) as T,
    );
  }

  private must<T>(value: T | undefined, what: string): T {
    if (value === undefined) {
      throw new NotFoundError(t({ zh: `${what} 不存在`, en: `${what} not found` }));
    }
    return value;
  }

  // ---- events --------------------------------------------------------------

  /** Append an event. Events are never modified. */
  event(runId: string | null, type: string, data: Record<string, unknown> = {}): EventRow {
    const ts = nowIso();
    const result = this.db
      .prepare('INSERT INTO events (run_id, ts, type, data) VALUES (?, ?, ?, ?)')
      .run(runId, ts, type, JSON.stringify(data));
    const row: EventRow = { id: Number(result.lastInsertRowid), runId, ts, type, data };
    this.bus.emit('event', row);
    return row;
  }

  /** Events of one type since `since` (ISO time), oldest first. */
  listEventsOfType(type: string, since: string): EventRow[] {
    return (
      this.db
        .prepare('SELECT * FROM events WHERE type = ? AND ts >= ? ORDER BY id')
        .all(type, since) as {
        id: number;
        run_id: string | null;
        ts: string;
        type: string;
        data: string;
      }[]
    ).map((r) => ({
      id: r.id,
      runId: r.run_id,
      ts: r.ts,
      type: r.type,
      data: JSON.parse(r.data) as Record<string, unknown>,
    }));
  }

  // ---- settings ----------------------------------------------------

  getSetting(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
      | { value: string }
      | undefined;
    return row ? row.value : null;
  }

  /** null deletes the setting. */
  setSetting(key: string, value: string | null): void {
    if (value === null) {
      this.db.prepare('DELETE FROM settings WHERE key = ?').run(key);
      return;
    }
    this.db
      .prepare(
        'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      )
      .run(key, value);
  }

  /**
   * The work switch: when off, the Master starts no Run, takes no issue and scouts on its own
   * no more; what is executing finishes. On by default.
   */
  get working(): boolean {
    return this.getSetting('working') !== 'false';
  }

  setWorking(on: boolean): void {
    this.tx(() => {
      this.setSetting('working', String(on));
      this.event(null, 'master.working', { on });
    });
  }

  listEvents(runId: string, afterId = 0): EventRow[] {
    const rows = this.db
      .prepare('SELECT * FROM events WHERE run_id = ? AND id > ? ORDER BY id')
      .all(runId, afterId) as {
      id: number;
      run_id: string;
      ts: string;
      type: string;
      data: string;
    }[];
    return rows.map((r) => ({
      id: r.id,
      runId: r.run_id,
      ts: r.ts,
      type: r.type,
      data: JSON.parse(r.data),
    }));
  }

  /**
   * Events that belong to no Run (restarts, pruned logs, upgrades, GitHub errors, scouts...),
   * newest first; `beforeId` pages back to older ones.
   */
  listGlobalEvents(opts: { beforeId?: number; limit?: number } = {}): EventRow[] {
    const limit = opts.limit ?? 200;
    const rows = (
      opts.beforeId === undefined
        ? this.db
            .prepare('SELECT * FROM events WHERE run_id IS NULL ORDER BY id DESC LIMIT ?')
            .all(limit)
        : this.db
            .prepare(
              'SELECT * FROM events WHERE run_id IS NULL AND id < ? ORDER BY id DESC LIMIT ?',
            )
            .all(opts.beforeId, limit)
    ) as GlobalEventRow[];
    return rows.map(globalEvent);
  }

  /**
   * Every event of the type that belongs to no Run, in the order they were recorded (such as the
   * work switch's `master.working`, to tell how long work was switched off).
   */
  listGlobalEventsOfType(type: string): EventRow[] {
    const rows = this.db
      .prepare('SELECT * FROM events WHERE run_id IS NULL AND type = ? ORDER BY id')
      .all(type) as GlobalEventRow[];
    return rows.map(globalEvent);
  }

  // ---- repos ---------------------------------------------------------------

  createRepo(input: Omit<Repo, 'id' | 'createdAt'>): Repo {
    const repo: Repo = { ...input, id: newId('repo'), createdAt: nowIso() };
    this.insert('repos', repo);
    return repo;
  }

  getRepo(id: string): Repo {
    return this.must(this.findRepo(id), t({ zh: `仓库 ${id}`, en: `Repo ${id}` }));
  }

  /** Find by id or by name. */
  findRepo(idOrName: string): Repo | undefined {
    return this.one<Repo>(
      'repos',
      'SELECT * FROM repos WHERE id = ? OR name = ?',
      idOrName,
      idOrName,
    );
  }

  listRepos(): Repo[] {
    return this.many<Repo>('repos', 'SELECT * FROM repos ORDER BY name');
  }

  updateRepo(
    id: string,
    patch: Partial<Pick<Repo, 'targetBranch' | 'verifyCommands' | 'setupCommands'>>,
  ): Repo {
    this.patch('repos', id, patch);
    return this.getRepo(id);
  }

  deleteRepo(id: string): void {
    const used = this.db.prepare('SELECT COUNT(*) AS n FROM runs WHERE repo_id = ?').get(id) as {
      n: number;
    };
    if (used.n > 0) {
      throw new ConflictError(
        t({
          zh: '仓库下还有 Run，不能移除',
          en: 'The repo still has Runs and cannot be removed',
        }),
      );
    }
    this.tx(() => {
      this.db.prepare('DELETE FROM iterations WHERE repo_id = ?').run(id);
      this.db.prepare('DELETE FROM proposals WHERE repo_id = ?').run(id);
      this.db.prepare('DELETE FROM scouts WHERE repo_id = ?').run(id);
      this.db.prepare('DELETE FROM repos WHERE id = ?').run(id);
    });
  }

  // ---- runs ----------------------------------------------------------------

  createRun(
    input: Pick<Run, 'repoId' | 'templateId' | 'template' | 'goal' | 'overrides'> & {
      issue?: RunIssue | null;
      mergeRemote?: string | null;
    },
  ): Run {
    const now = nowIso();
    const run: Run = {
      ...input,
      issue: input.issue ?? null,
      mergeRemote: input.mergeRemote ?? null,
      pr: null,
      issueSynced: null,
      discussion: [],
      issueDiscussionSynced: 0,
      id: newId('run'),
      status: 'queued',
      queuePos: this.queueTail(),
      currentStageRunId: null,
      branch: null,
      worktreePath: null,
      baseCommit: null,
      headCommit: null,
      blocked: null,
      extraLoops: 0,
      error: null,
      costUsd: 0,
      createdAt: now,
      updatedAt: now,
      finishedAt: null,
    };
    this.insert('runs', run);
    return run;
  }

  getRun(id: string): Run {
    return this.must(this.one<Run>('runs', 'SELECT * FROM runs WHERE id = ?', id), `Run ${id}`);
  }

  listRuns(filter: { status?: RunStatus; repoId?: string } = {}): Run[] {
    const where: string[] = [];
    const params: SQLInputValue[] = [];
    if (filter.status) {
      where.push('status = ?');
      params.push(filter.status);
    }
    if (filter.repoId) {
      where.push('repo_id = ?');
      params.push(filter.repoId);
    }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    return this.many<Run>(
      'runs',
      `SELECT * FROM runs ${clause} ORDER BY created_at DESC`,
      ...params,
    );
  }

  updateRun(id: string, patch: Partial<Run>): Run {
    this.patch('runs', id, { ...patch, updatedAt: nowIso() });
    return this.getRun(id);
  }

  /** The newest Run created from this issue that has not finished, if any. */
  unfinishedRunForIssue(issue: RunIssueKey): Run | undefined {
    return this.one<Run>(
      'runs',
      `SELECT * FROM runs WHERE ${OF_ISSUE}
         AND status NOT IN (${FINISHED_RUN_STATUSES.map(() => '?').join(', ')})
         ORDER BY created_at DESC LIMIT 1`,
      ...issueParams(issue),
      ...FINISHED_RUN_STATUSES,
    );
  }

  /**
   * The newest Run of the repo that the Master created to merge GitHub's commit `remote` into
   * the target branch (`mergeRemote`), finished or not.
   */
  runMergingRemote(repoId: string, remote: string): Run | undefined {
    return this.one<Run>(
      'runs',
      `SELECT * FROM runs WHERE repo_id = ? AND merge_remote = ?
         ORDER BY created_at DESC, rowid DESC LIMIT 1`,
      repoId,
      remote,
    );
  }

  /**
   * The Runs of the repo that the Master created to merge a commit of GitHub into the target
   * branch (`mergeRemote`) and that have not finished, whichever commit they merge; newest first.
   */
  unfinishedMergeRemoteRuns(repoId: string): Run[] {
    return this.many<Run>(
      'runs',
      `SELECT * FROM runs WHERE repo_id = ? AND merge_remote IS NOT NULL
         AND status NOT IN (${FINISHED_RUN_STATUSES.map(() => '?').join(', ')})
         ORDER BY created_at DESC, rowid DESC`,
      repoId,
      ...FINISHED_RUN_STATUSES,
    );
  }

  /** The newest Run created from this issue, finished or not. */
  latestRunForIssue(issue: RunIssueKey): Run | undefined {
    return this.one<Run>(
      'runs',
      `SELECT * FROM runs WHERE ${OF_ISSUE} ORDER BY created_at DESC, rowid DESC LIMIT 1`,
      ...issueParams(issue),
    );
  }

  /** The Runs created from this issue that have the given status, oldest first. */
  issueRunsWithStatus(issue: RunIssueKey, status: RunStatus): Run[] {
    return this.many<Run>(
      'runs',
      `SELECT * FROM runs WHERE ${OF_ISSUE} AND status = ? ORDER BY created_at, rowid`,
      ...issueParams(issue),
      status,
    );
  }

  /** Every Run created from this issue, finished or not, oldest first. */
  runsForIssue(issue: RunIssueKey): Run[] {
    return this.many<Run>(
      'runs',
      `SELECT * FROM runs WHERE ${OF_ISSUE} ORDER BY created_at, rowid`,
      ...issueParams(issue),
    );
  }

  /** Every Run created from an issue, oldest first. */
  issueRuns(): Run[] {
    return this.many<Run>(
      'runs',
      'SELECT * FROM runs WHERE issue IS NOT NULL ORDER BY created_at, rowid',
    );
  }

  /** Failed Runs of the repo whose issue waits for them to be redone, oldest first. */
  runsAwaitingRedo(repoId: string): Run[] {
    return this.many<Run>(
      'runs',
      `SELECT * FROM runs WHERE repo_id = ? AND json_extract(issue, '$.redo') = 'pending'
         ORDER BY created_at, rowid`,
      repoId,
    );
  }

  /**
   * Runs of the repo that ended without completing (failed, cancelled or dropped) with a pull
   * request recorded, and that have no event of the types `settled`; oldest first.
   */
  endedRunsWithPullRequest(repoId: string, settled: readonly string[]): Run[] {
    const ended: RunStatus[] = FINISHED_RUN_STATUSES.filter((s) => s !== 'completed');
    return this.many<Run>(
      'runs',
      `SELECT * FROM runs WHERE repo_id = ? AND pr_number IS NOT NULL
         AND status IN (${ended.map(() => '?').join(', ')})
         AND NOT EXISTS (SELECT 1 FROM events WHERE events.run_id = runs.id
           AND events.type IN (${settled.map(() => '?').join(', ')}))
         ORDER BY created_at, rowid`,
      repoId,
      ...ended,
      ...settled,
    );
  }

  /** Record what became of the issue after the Run failed (leaves updated_at alone). */
  setIssueRedo(id: string, redo: RedoState): void {
    this.db
      .prepare(
        "UPDATE runs SET issue = json_set(issue, '$.redo', ?) WHERE id = ? AND issue IS NOT NULL",
      )
      .run(redo, id);
  }

  /**
   * Record the Run status last reported on its issue (leaves updated_at alone); null: none, so
   * the issue is caught up with whatever the Run's status is next.
   */
  setIssueSynced(id: string, status: RunStatus | null): void {
    this.db.prepare('UPDATE runs SET issue_synced = ? WHERE id = ?').run(status, id);
  }

  /** Record how many discussion entries are handled on the issue (leaves updated_at alone). */
  setIssueDiscussionSynced(id: string, count: number): void {
    this.db.prepare('UPDATE runs SET issue_discussion_synced = ? WHERE id = ?').run(count, id);
  }

  /** Runs from issues whose issue has not caught up with the Run status or discussion yet. */
  runsWithIssueBehind(): Run[] {
    return this.many<Run>(
      'runs',
      `SELECT * FROM runs WHERE issue IS NOT NULL AND (issue_synced IS NULL OR issue_synced != status
         OR issue_discussion_synced < json_array_length(discussion))
         ORDER BY created_at`,
    );
  }

  /** Runs created from issues since `since` (ISO time). */
  issueRunsSince(since: string): Run[] {
    return this.many<Run>(
      'runs',
      'SELECT * FROM runs WHERE issue IS NOT NULL AND created_at >= ? ORDER BY created_at',
      since,
    );
  }

  /**
   * Runs of the repo created since `since` (ISO time) from local proposals (backlog.repos) that
   * the Master started by itself: every Run of a proposal accepted without a human, and every
   * automatic redo of a failed Run (attempt 2 on), whoever accepted the proposal. A proposal's
   * latest Run is its `run_id`, the failed ones before it are in its `failures`.
   */
  automaticProposalRunsSince(repoId: string, since: string): Run[] {
    return this.many<Run>(
      'runs',
      `SELECT * FROM runs WHERE created_at >= ? AND id IN (
         SELECT run_id FROM proposals
           WHERE repo_id = ? AND run_id IS NOT NULL AND (auto = 1 OR attempt > 1)
         UNION
         SELECT json_extract(f.value, '$.runId') FROM proposals p, json_each(p.failures) f
           WHERE p.repo_id = ? AND (p.auto = 1 OR json_extract(f.value, '$.attempt') > 1)
       )
       ORDER BY created_at`,
      since,
      repoId,
      repoId,
    );
  }

  /** The next Run to execute: queued, lowest queue position first. */
  nextQueuedRun(): Run | undefined {
    return this.one<Run>(
      'runs',
      "SELECT * FROM runs WHERE status = 'queued' ORDER BY queue_pos, created_at LIMIT 1",
    );
  }

  /** Queued Runs in the order they execute, as `nextQueuedRun` picks them. */
  queuedRuns(): Run[] {
    return this.many<Run>(
      'runs',
      "SELECT * FROM runs WHERE status = 'queued' ORDER BY queue_pos, created_at",
    );
  }

  queueHead(): number {
    const row = this.db
      .prepare("SELECT MIN(queue_pos) AS p FROM runs WHERE status = 'queued'")
      .get() as {
      p: number | null;
    };
    return (row.p ?? 0) - 1;
  }

  queueTail(): number {
    const row = this.db
      .prepare("SELECT MAX(queue_pos) AS p FROM runs WHERE status = 'queued'")
      .get() as {
      p: number | null;
    };
    return (row.p ?? 0) + 1;
  }

  // ---- stage runs ----------------------------------------------------------

  createStageRun(runId: string, stageId: string, feedback: string | null): StageRun {
    const prev = this.db
      .prepare('SELECT MAX(round) AS r FROM stage_runs WHERE run_id = ? AND stage_id = ?')
      .get(runId, stageId) as { r: number | null };
    const sr: StageRun = {
      id: newId('stage'),
      runId,
      stageId,
      round: (prev.r ?? 0) + 1,
      status: 'pending',
      feedback,
      failReason: null,
      failFeedback: null,
      startedAt: nowIso(),
      endedAt: null,
    };
    this.insert('stage_runs', sr);
    return sr;
  }

  getStageRun(id: string): StageRun {
    return this.must(
      this.one<StageRun>('stage_runs', 'SELECT * FROM stage_runs WHERE id = ?', id),
      t({ zh: `阶段执行 ${id}`, en: `Stage run ${id}` }),
    );
  }

  /**
   * Name of the stage the Run is in, or ended in, as its template names it (its id without a
   * name); undefined before any stage started.
   */
  currentStageName(run: Pick<Run, 'currentStageRunId' | 'template'>): string | undefined {
    if (!run.currentStageRunId) return undefined;
    const sr = this.getStageRun(run.currentStageRunId);
    return run.template.stages.find((s) => s.id === sr.stageId)?.name ?? sr.stageId;
  }

  listStageRuns(runId: string): StageRun[] {
    return this.many<StageRun>(
      'stage_runs',
      'SELECT * FROM stage_runs WHERE run_id = ? ORDER BY started_at, rowid',
      runId,
    );
  }

  countStageRounds(runId: string, stageId: string): number {
    const row = this.db
      .prepare('SELECT COUNT(*) AS n FROM stage_runs WHERE run_id = ? AND stage_id = ?')
      .get(runId, stageId) as { n: number };
    return row.n;
  }

  updateStageRun(id: string, patch: Partial<StageRun>): StageRun {
    this.patch('stage_runs', id, patch);
    return this.getStageRun(id);
  }

  // ---- tasks ---------------------------------------------------------------

  /** A task of the stage round, after its existing ones; a work task unless `kind` says so. */
  createTask(
    input: Pick<Task, 'runId' | 'stageRunId' | 'title' | 'instructions' | 'agentId'> &
      Partial<Pick<Task, 'kind'>>,
  ): Task {
    const seq = this.db
      .prepare('SELECT COUNT(*) AS n FROM tasks WHERE stage_run_id = ?')
      .get(input.stageRunId) as { n: number };
    const now = nowIso();
    const task: Task = {
      ...input,
      kind: input.kind ?? 'work',
      id: newId('task'),
      seq: seq.n + 1,
      status: 'pending',
      retries: 0,
      baseCommit: null,
      commitSha: null,
      sessionId: null,
      sessionAgentId: null,
      pendingFeedback: null,
      createdAt: now,
      updatedAt: now,
    };
    this.insert('tasks', task);
    return task;
  }

  getTask(id: string): Task {
    return this.must(this.one<Task>('tasks', 'SELECT * FROM tasks WHERE id = ?', id), `Task ${id}`);
  }

  listTasks(stageRunId: string): Task[] {
    return this.many<Task>(
      'tasks',
      'SELECT * FROM tasks WHERE stage_run_id = ? ORDER BY seq',
      stageRunId,
    );
  }

  listRunTasks(runId: string): Task[] {
    return this.many<Task>(
      'tasks',
      'SELECT * FROM tasks WHERE run_id = ? ORDER BY created_at, seq',
      runId,
    );
  }

  updateTask(id: string, patch: Partial<Task>): Task {
    this.patch('tasks', id, { ...patch, updatedAt: nowIso() });
    return this.getTask(id);
  }

  // ---- attempts ------------------------------------------------------------

  createAttempt(
    input: Pick<
      Attempt,
      'id' | 'taskId' | 'runId' | 'agentId' | 'prompt' | 'logPath' | 'sessionId'
    > &
      Partial<Pick<Attempt, 'model' | 'effort'>>,
  ): Attempt {
    const seq = this.db
      .prepare('SELECT COUNT(*) AS n FROM attempts WHERE task_id = ?')
      .get(input.taskId) as { n: number };
    const attempt: Attempt = {
      model: null,
      effort: null,
      ...input,
      actualModel: null,
      seq: seq.n + 1,
      status: 'running',
      outcome: null,
      finalMessage: null,
      structured: null,
      inputTokens: 0,
      outputTokens: 0,
      cachedTokens: 0,
      costUsd: null,
      pid: null,
      command: null,
      error: null,
      startedAt: nowIso(),
      endedAt: null,
    };
    this.insert('attempts', attempt);
    return attempt;
  }

  getAttempt(id: string): Attempt {
    return this.must(
      this.one<Attempt>('attempts', 'SELECT * FROM attempts WHERE id = ?', id),
      t({ zh: `执行记录 ${id}`, en: `Execution ${id}` }),
    );
  }

  listAttempts(taskId: string): Attempt[] {
    return this.many<Attempt>(
      'attempts',
      'SELECT * FROM attempts WHERE task_id = ? ORDER BY seq',
      taskId,
    );
  }

  listRunAttempts(runId: string, status?: Attempt['status']): Attempt[] {
    if (status) {
      return this.many<Attempt>(
        'attempts',
        'SELECT * FROM attempts WHERE run_id = ? AND status = ? ORDER BY started_at, rowid',
        runId,
        status,
      );
    }
    return this.many<Attempt>(
      'attempts',
      'SELECT * FROM attempts WHERE run_id = ? ORDER BY started_at, rowid',
      runId,
    );
  }

  updateAttempt(id: string, patch: Partial<Attempt>): Attempt {
    this.patch('attempts', id, patch);
    return this.getAttempt(id);
  }

  /**
   * Executions in Runs per agent, over everything on record, by agent id.
   * Read-only. Unknown costs follow `isCostUnknown` (src/api/cost.ts): no cost and not running.
   */
  agentAttemptTotals(): AgentAttemptTotals[] {
    const rows = this.db
      .prepare(
        `SELECT agent_id, COUNT(*) AS n,
           COUNT(*) FILTER (WHERE outcome = 'passed') AS passed,
           COUNT(*) FILTER (WHERE outcome = 'rework') AS rework,
           COUNT(*) FILTER (WHERE outcome = 'agent_error') AS agent_error,
           COUNT(*) FILTER (WHERE status IN ('stopped', 'interrupted')) AS stopped,
           TOTAL(cost_usd) AS cost,
           COUNT(*) FILTER (WHERE cost_usd IS NULL AND status != 'running') AS unknown,
           MAX(started_at) AS last_at
         FROM attempts GROUP BY agent_id ORDER BY agent_id`,
      )
      .all() as {
      agent_id: string;
      n: number;
      passed: number;
      rework: number;
      agent_error: number;
      stopped: number;
      cost: number;
      unknown: number;
      last_at: string | null;
    }[];
    // The latest attempt with an error, per agent. Stopped and interrupted attempts are left
    // out: a human or a Master restart ended those, not a problem of the agent.
    const errors = this.db
      .prepare(
        `SELECT agent_id, id, run_id, error, COALESCE(ended_at, started_at) AS at FROM (
           SELECT a.*, ROW_NUMBER() OVER (
             PARTITION BY agent_id ORDER BY started_at DESC, rowid DESC
           ) AS latest
           FROM attempts a
           WHERE TRIM(error, ' ' || char(9, 10, 13)) != '' AND status NOT IN ('stopped', 'interrupted')
         ) WHERE latest = 1`,
      )
      .all() as { agent_id: string; id: string; run_id: string; error: string; at: string }[];
    const lastErrors = new Map<string, AgentLastError>();
    for (const e of errors) {
      const chars = Array.from(e.error.trim());
      lastErrors.set(e.agent_id, {
        attemptId: e.id,
        runId: e.run_id,
        at: e.at,
        message: chars.slice(0, LAST_ERROR_CHARS).join(''),
        truncated: chars.length > LAST_ERROR_CHARS,
      });
    }
    return rows.map((r) => ({
      agentId: r.agent_id,
      attempts: r.n,
      passed: r.passed,
      rework: r.rework,
      agentError: r.agent_error,
      stopped: r.stopped,
      costUsd: roundUsd(r.cost),
      costUnknown: r.unknown,
      lastAt: r.last_at,
      lastError: lastErrors.get(r.agent_id) ?? null,
    }));
  }

  // ---- checks, approvals, artifacts ---------------------------------------

  addCheck(input: Omit<CheckResult, 'id' | 'createdAt'>): CheckResult {
    const check: CheckResult = { ...input, id: newId('chk'), createdAt: nowIso() };
    this.insert('check_results', check);
    return check;
  }

  listChecks(runId: string): CheckResult[] {
    return this.many<CheckResult>(
      'check_results',
      'SELECT * FROM check_results WHERE run_id = ? ORDER BY created_at, rowid',
      runId,
    );
  }

  createApproval(runId: string, stageRunId: string): Approval {
    const approval: Approval = {
      id: newId('apr'),
      runId,
      stageRunId,
      status: 'pending',
      comment: null,
      createdAt: nowIso(),
      decidedAt: null,
    };
    this.insert('approvals', approval);
    return approval;
  }

  pendingApproval(runId: string): Approval | undefined {
    return this.one<Approval>(
      'approvals',
      "SELECT * FROM approvals WHERE run_id = ? AND status = 'pending' ORDER BY created_at DESC LIMIT 1",
      runId,
    );
  }

  latestApproval(stageRunId: string): Approval | undefined {
    return this.one<Approval>(
      'approvals',
      'SELECT * FROM approvals WHERE stage_run_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1',
      stageRunId,
    );
  }

  listApprovals(runId: string): Approval[] {
    return this.many<Approval>(
      'approvals',
      'SELECT * FROM approvals WHERE run_id = ? ORDER BY created_at',
      runId,
    );
  }

  updateApproval(id: string, patch: Partial<Approval>): void {
    this.patch('approvals', id, patch);
  }

  addArtifact(input: Omit<Artifact, 'id' | 'createdAt'>): Artifact {
    const artifact: Artifact = { ...input, id: newId('art'), createdAt: nowIso() };
    this.insert('artifacts', artifact);
    return artifact;
  }

  listArtifacts(runId: string): Artifact[] {
    return this.many<Artifact>(
      'artifacts',
      'SELECT * FROM artifacts WHERE run_id = ? ORDER BY created_at, rowid',
      runId,
    );
  }

  /** The most recent artifact with this name in the Run. */
  latestArtifact(runId: string, name: string): Artifact | undefined {
    return this.one<Artifact>(
      'artifacts',
      'SELECT * FROM artifacts WHERE run_id = ? AND name = ? ORDER BY created_at DESC, rowid DESC LIMIT 1',
      runId,
      name,
    );
  }

  // ---- scouts -------------------------------------------------------

  /** A running scout; without `goal` it has no direction from a human. */
  createScout(
    input: Omit<
      Scout,
      | 'id'
      | 'goal'
      | 'status'
      | 'proposals'
      | 'gaps'
      | 'costUsd'
      | 'error'
      | 'startedAt'
      | 'endedAt'
    > & { goal?: string | null },
  ): Scout {
    const scout: Scout = {
      ...input,
      goal: input.goal ?? null,
      id: newId('scout'),
      status: 'running',
      proposals: [],
      gaps: null,
      costUsd: null,
      error: null,
      startedAt: nowIso(),
      endedAt: null,
    };
    this.insert('scouts', scout);
    return scout;
  }

  getScout(id: string): Scout {
    return this.must(
      this.one<Scout>('scouts', 'SELECT * FROM scouts WHERE id = ?', id),
      t({ zh: `侦察 ${id}`, en: `Scout ${id}` }),
    );
  }

  updateScout(id: string, patch: Partial<Scout>): Scout {
    this.patch('scouts', id, patch);
    return this.getScout(id);
  }

  /**
   * Newest first; `since` (ISO time) limits to scouts started from then on. At most `limit`
   * (default 50); null = all of them.
   */
  listScouts(filter: { repoId?: string; since?: string; limit?: number | null } = {}): Scout[] {
    const where: string[] = [];
    const params: SQLInputValue[] = [];
    if (filter.repoId) {
      where.push('repo_id = ?');
      params.push(filter.repoId);
    }
    if (filter.since) {
      where.push('started_at >= ?');
      params.push(filter.since);
    }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    return this.many<Scout>(
      'scouts',
      `SELECT * FROM scouts ${clause} ORDER BY started_at DESC, rowid DESC LIMIT ?`,
      ...params,
      // SQLite takes a negative limit as none.
      filter.limit === null ? -1 : (filter.limit ?? 50),
    );
  }

  /**
   * Scouts per agent, over everything on record, by agent id. Read-only. As on the statistics
   * page, a cost is unknown only for a scout that completed without one.
   */
  agentScoutTotals(): AgentScoutTotals[] {
    const rows = this.db
      .prepare(
        `SELECT agent_id, COUNT(*) AS n, TOTAL(cost_usd) AS cost,
           COUNT(*) FILTER (WHERE cost_usd IS NULL AND status = 'completed') AS unknown,
           MAX(started_at) AS last_at
         FROM scouts GROUP BY agent_id ORDER BY agent_id`,
      )
      .all() as {
      agent_id: string;
      n: number;
      cost: number;
      unknown: number;
      last_at: string | null;
    }[];
    return rows.map((r) => ({
      agentId: r.agent_id,
      scouts: r.n,
      costUsd: roundUsd(r.cost),
      costUnknown: r.unknown,
      lastAt: r.last_at,
    }));
  }

  // ---- proposals of the local backlog ----------------------------------

  /**
   * A new pending proposal. Takes only the proposal's own fields, so a ScoutProposal can be
   * passed as it is: its `issue`, `local` and `error` are not columns. Without `iterationId` it
   * belongs to no iteration, without `dependsOn` it depends on nothing, without `author` a scout
   * wrote it.
   */
  createProposal(
    input: Pick<Proposal, ProposalInputKey> &
      Partial<Pick<Proposal, 'iterationId' | 'dependsOn' | 'author'>>,
  ): Proposal {
    const proposal: Proposal = {
      id: newId('proposal'),
      repoId: input.repoId,
      scoutId: input.scoutId,
      author: input.author ?? 'scout',
      title: input.title,
      category: input.category,
      size: input.size,
      risk: input.risk,
      why: input.why,
      evidence: input.evidence,
      what: input.what,
      acceptance: input.acceptance,
      status: 'pending',
      rejectReason: null,
      auto: false,
      runId: null,
      attempt: 1,
      failures: [],
      redo: null,
      iterationId: input.iterationId ?? null,
      dependsOn: input.dependsOn ?? [],
      createdAt: nowIso(),
      decidedAt: null,
      editedAt: null,
    };
    this.insert('proposals', proposal);
    return proposal;
  }

  getProposal(id: string): Proposal {
    return this.must(
      this.one<Proposal>('proposals', 'SELECT * FROM proposals WHERE id = ?', id),
      t({ zh: `提案 ${id}`, en: `Proposal ${id}` }),
    );
  }

  /** Throws NotFoundError when there is no such proposal. */
  updateProposal(
    id: string,
    patch: Partial<Omit<Proposal, 'id' | 'repoId' | 'createdAt'>>,
  ): Proposal {
    this.getProposal(id);
    this.patch('proposals', id, patch);
    return this.getProposal(id);
  }

  /**
   * The repo's accepted proposals, of their own or steps of iterations, whose latest Run failed
   * and that were not given up: the failure not recorded yet (`redo` null), or waiting to be
   * redone (`redo` pending). Whether a step's iteration still wants it is the caller's to judge
   * (`proposalRedoAllowed` in src/config/flow.ts). Oldest first.
   */
  proposalsWithFailedRun(repoId: string): Proposal[] {
    return this.many<Proposal>(
      'proposals',
      `SELECT proposals.* FROM proposals JOIN runs ON runs.id = proposals.run_id
         WHERE proposals.repo_id = ? AND proposals.status = 'accepted' AND runs.status = 'failed'
           AND (proposals.redo IS NULL OR proposals.redo = 'pending')
         ORDER BY proposals.created_at, proposals.rowid`,
      repoId,
    );
  }

  /** Newest first. `status` may list several; no `limit` = all of them. */
  listProposals(
    filter: {
      repoId?: string;
      status?: ProposalStatus | readonly ProposalStatus[];
      limit?: number;
    } = {},
  ): Proposal[] {
    const where: string[] = [];
    const params: SQLInputValue[] = [];
    if (filter.repoId) {
      where.push('repo_id = ?');
      params.push(filter.repoId);
    }
    if (filter.status !== undefined) {
      const statuses: readonly ProposalStatus[] =
        typeof filter.status === 'string' ? [filter.status] : filter.status;
      // No status at all matches nothing, rather than everything.
      where.push(statuses.length === 0 ? '0' : `status IN (${statuses.map(() => '?').join(', ')})`);
      params.push(...statuses);
    }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    return this.many<Proposal>(
      'proposals',
      `SELECT * FROM proposals ${clause} ORDER BY created_at DESC, rowid DESC LIMIT ?`,
      ...params,
      // SQLite takes a negative limit as none.
      filter.limit ?? -1,
    );
  }

  // ---- iterations ----------------------------------------------------------

  /**
   * A new iteration, pending unless `status` says otherwise, with no issue, notes, summary or
   * decision yet unless given.
   */
  createIteration(
    input: Pick<Iteration, IterationInputKey> &
      Partial<Pick<Iteration, 'issue' | 'notes' | 'status' | 'auto' | 'decidedAt'>>,
  ): Iteration {
    const iteration: Iteration = {
      id: newId('iteration'),
      repoId: input.repoId,
      scoutId: input.scoutId,
      source: input.source,
      issuesRepo: input.issuesRepo,
      issue: input.issue ?? null,
      title: input.title,
      goal: input.goal,
      readmeGoal: input.readmeGoal,
      criteria: input.criteria,
      outOfScope: input.outOfScope,
      children: input.children,
      notes: input.notes ?? [],
      status: input.status ?? 'pending',
      auto: input.auto ?? false,
      summaryPosted: false,
      summary: null,
      createdAt: nowIso(),
      decidedAt: input.decidedAt ?? null,
      endedAt: null,
    };
    this.insert('iterations', iteration);
    return iteration;
  }

  getIteration(id: string): Iteration {
    return this.must(
      this.one<Iteration>('iterations', 'SELECT * FROM iterations WHERE id = ?', id),
      t({ zh: `迭代 ${id}`, en: `Iteration ${id}` }),
    );
  }

  /** Throws NotFoundError when there is no such iteration. */
  updateIteration(
    id: string,
    patch: Partial<Omit<Iteration, 'id' | 'repoId' | 'createdAt'>>,
  ): Iteration {
    this.getIteration(id);
    this.patch('iterations', id, patch);
    return this.getIteration(id);
  }

  /**
   * Forget an iteration that was never written out (its issue could not be created), so that it
   * does not hold the repo as the iteration under way. Nothing else refers to it then.
   */
  deleteIteration(id: string): void {
    this.db.prepare('DELETE FROM iterations WHERE id = ?').run(id);
  }

  /** Newest first. `status` may list several; no `limit` = all of them. */
  listIterations(
    filter: {
      repoId?: string;
      status?: IterationStatus | readonly IterationStatus[];
      scoutId?: string;
      limit?: number;
    } = {},
  ): Iteration[] {
    const where: string[] = [];
    const params: SQLInputValue[] = [];
    if (filter.repoId) {
      where.push('repo_id = ?');
      params.push(filter.repoId);
    }
    if (filter.status !== undefined) {
      const statuses: readonly IterationStatus[] =
        typeof filter.status === 'string' ? [filter.status] : filter.status;
      // No status at all matches nothing, rather than everything.
      where.push(statuses.length === 0 ? '0' : `status IN (${statuses.map(() => '?').join(', ')})`);
      params.push(...statuses);
    }
    if (filter.scoutId) {
      where.push('scout_id = ?');
      params.push(filter.scoutId);
    }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    return this.many<Iteration>(
      'iterations',
      `SELECT * FROM iterations ${clause} ORDER BY created_at DESC, rowid DESC LIMIT ?`,
      ...params,
      // SQLite takes a negative limit as none.
      filter.limit ?? -1,
    );
  }
}

/** What a new iteration is made of; the rest is set when it is created, decided or ends. */
type IterationInputKey =
  | 'repoId'
  | 'scoutId'
  | 'source'
  | 'issuesRepo'
  | 'title'
  | 'goal'
  | 'readmeGoal'
  | 'criteria'
  | 'outOfScope'
  | 'children';

/** What a new proposal is made of; the rest is set when it is created or decided. */
type ProposalInputKey =
  | 'repoId'
  | 'scoutId'
  | 'title'
  | 'category'
  | 'size'
  | 'risk'
  | 'why'
  | 'evidence'
  | 'what'
  | 'acceptance';

/** How much of an agent's latest error `agentAttemptTotals()` keeps. */
const LAST_ERROR_CHARS = 200;

/** Sums of costs: floating point noise trimmed, well below what the dashboard shows. */
const roundUsd = (usd: number): number => Math.round(usd * 1e8) / 1e8;

export class NotFoundError extends Error {}
export class ConflictError extends Error {}
