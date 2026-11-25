/**
 * Schema migrations. Index i upgrades user_version i → i + 1.
 * Never edit a migration that has shipped; append a new one instead.
 */
export const MIGRATIONS: readonly string[] = [
  `
  CREATE TABLE repos (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    path TEXT NOT NULL,
    target_branch TEXT NOT NULL,
    verify_commands TEXT NOT NULL DEFAULT '[]',
    setup_commands TEXT NOT NULL DEFAULT '[]',
    merge_mode TEXT NOT NULL DEFAULT 'direct',
    created_at TEXT NOT NULL
  );

  CREATE TABLE runs (
    id TEXT PRIMARY KEY,
    repo_id TEXT NOT NULL REFERENCES repos(id),
    template_id TEXT NOT NULL,
    template TEXT NOT NULL,
    goal TEXT NOT NULL,
    overrides TEXT NOT NULL DEFAULT '{}',
    status TEXT NOT NULL,
    queue_pos REAL,
    current_stage_run_id TEXT,
    branch TEXT,
    worktree_path TEXT,
    base_commit TEXT,
    blocked TEXT,
    extra_loops INTEGER NOT NULL DEFAULT 0,
    error TEXT,
    cost_usd REAL NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    finished_at TEXT
  );
  CREATE INDEX runs_status ON runs(status, queue_pos);

  CREATE TABLE stage_runs (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES runs(id),
    stage_id TEXT NOT NULL,
    round INTEGER NOT NULL,
    status TEXT NOT NULL,
    feedback TEXT,
    fail_reason TEXT,
    fail_feedback TEXT,
    started_at TEXT NOT NULL,
    ended_at TEXT
  );
  CREATE INDEX stage_runs_run ON stage_runs(run_id);

  CREATE TABLE tasks (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES runs(id),
    stage_run_id TEXT NOT NULL REFERENCES stage_runs(id),
    seq INTEGER NOT NULL,
    title TEXT NOT NULL,
    instructions TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    status TEXT NOT NULL,
    retries INTEGER NOT NULL DEFAULT 0,
    base_commit TEXT,
    commit_sha TEXT,
    session_id TEXT,
    session_agent_id TEXT,
    pending_feedback TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX tasks_stage_run ON tasks(stage_run_id);

  CREATE TABLE attempts (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES tasks(id),
    run_id TEXT NOT NULL REFERENCES runs(id),
    seq INTEGER NOT NULL,
    agent_id TEXT NOT NULL,
    session_id TEXT,
    status TEXT NOT NULL,
    outcome TEXT,
    prompt TEXT NOT NULL,
    final_message TEXT,
    structured TEXT,
    input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    cached_tokens INTEGER NOT NULL DEFAULT 0,
    cost_usd REAL,
    log_path TEXT NOT NULL,
    pid INTEGER,
    command TEXT,
    error TEXT,
    started_at TEXT NOT NULL,
    ended_at TEXT
  );
  CREATE INDEX attempts_task ON attempts(task_id);

  CREATE TABLE check_results (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES runs(id),
    stage_run_id TEXT,
    attempt_id TEXT,
    kind TEXT NOT NULL,
    name TEXT NOT NULL,
    passed INTEGER NOT NULL,
    detail TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX check_results_run ON check_results(run_id);

  CREATE TABLE approvals (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES runs(id),
    stage_run_id TEXT NOT NULL REFERENCES stage_runs(id),
    status TEXT NOT NULL,
    comment TEXT,
    created_at TEXT NOT NULL,
    decided_at TEXT
  );
  CREATE INDEX approvals_run ON approvals(run_id);

  CREATE TABLE artifacts (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES runs(id),
    stage_run_id TEXT,
    name TEXT NOT NULL,
    kind TEXT NOT NULL,
    path TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX artifacts_run ON artifacts(run_id);

  CREATE TABLE events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT,
    ts TEXT NOT NULL,
    type TEXT NOT NULL,
    data TEXT NOT NULL DEFAULT '{}'
  );
  CREATE INDEX events_run ON events(run_id, id);
  `,
  // v2: model and effort of each attempt, as they were when it ran.
  `
  ALTER TABLE attempts ADD COLUMN model TEXT;
  ALTER TABLE attempts ADD COLUMN actual_model TEXT;
  ALTER TABLE attempts ADD COLUMN effort TEXT;
  `,
  // v3: the last commit of a Run's worktree that the Master accepted.
  `
  ALTER TABLE runs ADD COLUMN head_commit TEXT;
  `,
  // v4: GitHub issues as the backlog: the issue a Run comes from, and AI scouts.
  `
  ALTER TABLE runs ADD COLUMN issue TEXT;
  ALTER TABLE runs ADD COLUMN issue_synced TEXT;

  CREATE TABLE scouts (
    id TEXT PRIMARY KEY,
    repo_id TEXT NOT NULL REFERENCES repos(id),
    issues_repo TEXT NOT NULL,
    trigger TEXT NOT NULL,
    status TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    model TEXT,
    proposals TEXT NOT NULL DEFAULT '[]',
    cost_usd REAL,
    error TEXT,
    log_path TEXT NOT NULL,
    started_at TEXT NOT NULL,
    ended_at TEXT
  );
  CREATE INDEX scouts_started ON scouts(started_at);
  `,
  // v5: Master-wide settings changed on the dashboard, e.g. the work switch.
  `
  CREATE TABLE settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  CREATE INDEX events_type ON events(type, ts);
  `,
  // v6: the requirement assessment's discussion, and how much of it is on the issue.
  `
  ALTER TABLE runs ADD COLUMN discussion TEXT NOT NULL DEFAULT '[]';
  ALTER TABLE runs ADD COLUMN issue_discussion_synced INTEGER NOT NULL DEFAULT 0;
  `,
  // v7: the scout's gap analysis against the README's goals; null for the scouts before it.
  `
  ALTER TABLE scouts ADD COLUMN gaps TEXT;
  `,
  // v8: what a task is: work (executed, checked and committed) or a stage's plan (planning: llm).
  `
  ALTER TABLE tasks ADD COLUMN kind TEXT NOT NULL DEFAULT 'work';
  `,
  // v9: the commit from GitHub a Run merges into its target branch; null for every other Run.
  `
  ALTER TABLE runs ADD COLUMN merge_remote TEXT;
  `,
  // v10: the pull request a Run's work goes through (deliver: pr); null for every other Run.
  `
  ALTER TABLE runs ADD COLUMN pr_number INTEGER;
  ALTER TABLE runs ADD COLUMN pr_url TEXT;
  `,
  // v11: the local backlog of the repos without GitHub (backlog.repos): what scouts proposed,
  // and what became of it. scouts.issues_repo stays NOT NULL; their scouts store ''.
  `
  CREATE TABLE proposals (
    id TEXT PRIMARY KEY,
    repo_id TEXT NOT NULL REFERENCES repos(id),
    scout_id TEXT,
    title TEXT NOT NULL,
    category TEXT NOT NULL,
    size TEXT NOT NULL,
    risk TEXT NOT NULL,
    why TEXT NOT NULL,
    evidence TEXT NOT NULL DEFAULT '[]',
    what TEXT NOT NULL,
    acceptance TEXT NOT NULL DEFAULT '[]',
    status TEXT NOT NULL DEFAULT 'pending',
    reject_reason TEXT,
    auto INTEGER NOT NULL DEFAULT 0,
    run_id TEXT,
    created_at TEXT NOT NULL,
    decided_at TEXT
  );
  CREATE INDEX proposals_repo_status ON proposals(repo_id, status);
  `,
];
