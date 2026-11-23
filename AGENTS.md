# AGENTS.md

This file is for AI agents working in this repository (Claude Code, Codex, cursor-agent, ...); people can read it too.

## What this project is

Ares.1 (Chinese name 战神一号, slogan "self-bootstrapping perpetual motion machine") is a multi-agent orchestration system: a Master process schedules agent CLIs through workflow templates to get development work done, and checks the results itself. It is built to develop itself: requirements come in as GitHub issues on this repository (written by people or proposed by the AI scout), and Ares.1 schedules agents to implement, review and merge them, then upgrades itself to the result.

- **[`README.md`](README.md) holds every requirement of the project and is the basis for every decision.** Its goals are perpetual motion, self-bootstrapping, and being usable to build any project; any change or self-evolution that serves them is allowed. Judge proposals, assessments and reviews against it.
- This repository is only one of the projects Ares.1 builds. The Master must not assume the language, package manager, commands or layout of the repository it works on; those come from the repo's registration and the workflow templates.
- How to run, configure and upgrade it: [`docs/running.md`](docs/running.md).

The display name and slogan come from `src/brand.ts` in the language in use. The technical identifier is `ares1`: the `package.json` name and command, the data directory `~/.ares1`, the stable copy directory, issue labels `ares1:*`, hidden comment markers, branch names, worktree names, log file names and so on. Do not change these: existing data directories, issues, branches and a self-hosting Master that is already running all depend on them.

## Commands

```bash
npm install          # install dependencies (Node.js >= 24)
npm run build        # compile the Master to dist/, build the dashboard to dist/web/
npm test             # unit + end-to-end tests (fake agents and fake GitHub: free, offline)
npm run lint         # Biome check + TypeScript type check (Master and dashboard)
npm run format       # format and fix what can be fixed automatically
npm run dev          # start the Master from source with tsx (data dir ~/.ares1; no auto-upgrade)
npm run dev:web      # dashboard dev server (hot reload, port 4871); /api goes to the Master on 4870
npm start            # start the Master from the build (node dist/cli.js)
npm run test:real    # tests that call the real Claude Code and cursor-agent: costs money, manual only
```

**`npm run build`, `npm test` and `npm run lint` must all pass before any change is done.** They are also the check commands registered for this repository, so Ares.1 runs them when it checks a Run.

## Layout

```
src/
  cli.ts              start command: parses --home / --port and starts the Master; everything else
                      happens on the dashboard
  master.ts           wires config, store, engine, GitHub bridge, notifications, auto-upgrade and API;
                      records master.restarted when the last Master did not close
  i18n.ts             language in use and t({ zh, en }) (shared by Master and dashboard)
  brand.ts            display name and slogan in each language (shared by Master and dashboard)
  util.ts             ids, time and other small helpers
  config/
    schema.ts         formats of config.yaml / agents.yaml / workflows/*.yaml and Run overrides (zod)
    defaults.ts       default config and the self-dev template, written on first start
    load.ts           load and validate config; invalid agents and templates are only disabled
                      and reported; applies config.yaml's language
    watch.ts          reload config when its files change
    flow.ts           effective stage settings, check commands, rollback targets, budgets,
                      which proposals are accepted automatically, the automatic scout's
                      back-off, how many scouts in a row failed (when a human is notified),
                      how long a Run or a scout waits for an agent's quota (rate
                      limits), how long a failed Run of an issue waits before it is redone,
                      which Runs go on by themselves (redos to come included) and which only
                      wait for a human, how long raw agent logs are kept (`RAW_LOG_KEEP_DAYS`),
                      which worktrees of failed or cancelled Runs of issues are left over for the
                      Master to remove (`leftoverWorkspaces`)
                      (shared by engine, GitHub bridge, API and dashboard)
    effort.ts         helpers for agent effort (shared by engine and dashboard)
  store/              SQLite store (node:sqlite): store.ts, migrations.ts, types.ts (entity types)
  adapters/           agent adapters: types.ts (common interface), process.ts (child processes,
                      process groups and the environment of agents: no GitHub credentials),
                      claude-code.ts, cursor-agent.ts, fake.ts (fake agent for tests),
                      rate-limit.ts (a CLI's error text → out of quota / rate-limited, and the
                      reset time), tool-summary.ts
  engine/
    engine.ts         workflow engine: queue, state machine, checks, rework, agent errors (retry
                      with backoff, switching agents), rollback, approvals, merge, recovery after
                      restart, removing the worktrees of superseded, exhausted and goal-changed
                      Runs (and again later what was left over: `sweepLeftoverWorkspaces`)
    prompts.ts        prompts for the assess, coding and review agents
    contracts.ts      agents' structured output: contract and validation
    discussion.ts     how an assessment's conclusion and discussion are found and named
                      (shared by engine, GitHub bridge and dashboard)
    times.ts          a Run's time split into agent execution, queueing, waiting for approval,
                      stuck waiting for a human and paused, with the names and order of the parts
                      and the three groups used by the issue completion comment
                      (shared by scout summaries, issue completion comments and the Run page)
  github/
    client.ts         GitHub through the gh CLI (FakeGitHub in tests)
    bridge.ts         polling, Runs from issues (terminated when a human closes the issue, started
                      over when a human edits it before the merge), progress on issues,
                      auto-accept, push, auto-scout
    issues.ts         labels, issue texts (assessment questions and conclusions, hidden comment
                      markers), Run status ↔ issue (pure functions)
    redact.ts         text before it is published on GitHub: the user's home directory → ~
    scout.ts          the AI scout's prompt, output format and Run summary
  notify/
    notice.ts         which events notify people (shared by system notifications, the webhook
                      and dashboard)
    system.ts         system notifications sent by the Master: osascript on macOS, notify-send
                      (libnotify) on Linux, nothing elsewhere; which platforms are supported
    webhook.ts        notifications the Master POSTs to notify.webhook in config.yaml (JSON or
                      text, home directory as ~, 10 s timeout, no retry, a failure logged once
                      per address)
  upgrade/
    upgrader.ts       the Master upgrades itself: finds a new version, waits for the work in hand,
                      hands over to scripts/self-upgrade.sh, keeps the last failed upgrade, retries
                      a target that failed for the environment (no node or npm) after a wait;
                      restarts on the same commit when the node it runs on is gone
    source.ts         which registered repo is the Master's own source (from the install
                      directory's origin), whose scout is shown failed upgrades
  logs/prune.ts       deletes the raw agent output (CLI stream and stderr) of Runs and scouts past
                      retention, at start and daily; records logs.pruned; each round also starts
                      the engine's sweep of leftover worktrees (wired in master.ts)
  workspace/git.ts    git: worktrees, commits, rollback, merge, fast-forward
  verify/commands.ts  run check commands and setup commands; whether a failed one failed for the
                      environment (exit code 127, its first program not in PATH), and whether a
                      command can find its first program without running it
  api/
    server.ts         HTTP API (Hono) and SSE; GET /api/events lists the global events (those of
                      no Run: restarts, pruned logs, upgrades, GitHub errors, scouts...) newest
                      first, paged with ?before=<id>
    types.ts          API data types, shared by Master and dashboard
    agents.ts, stats.ts, workspaces.ts, diff.ts   data of the Agents, Stats and Workspaces pages
                      and diffs
    cost.ts           whether a cost is unknown (shared by Master and dashboard)
    static.ts         serves the built dashboard
scripts/
  self-upgrade.sh     auto-upgrade: pull, build, restart, watch the new version for a few minutes;
                      back to the old version on failure or when it crashes meanwhile, with the
                      node_modules from before the upgrade (moved aside, so nothing to download)
  keepalive.sh        called by a timer (launchd, systemd, cron) every minute: starts the Master
                      when it does not answer, unless an upgrade runs or a Master process of the
                      same home is there (hung or starting); logs to keepalive.log, notifies when
                      it cannot start it
  find-node.sh        the one place that finds the node to run the Master with (the given one,
                      PATH, nvm's default version, the usual places; engines.node checked),
                      sourced by self-upgrade.sh and keepalive.sh; the Master copies it next to
                      its copy of self-upgrade.sh
web/                  dashboard (React + Vite)
  src/App.tsx         top bar (navigation, work switch, notification switch, language switch)
                      and routing
  src/pages/          Home, RunDetail, Issues, Stats, Agents, Events, Workspaces, Repos, Config,
                      Guide
  src/components/     ui.tsx (common components), AgentOutput, DiffPanel, FlowChart,
                      Notifications, WorkSwitch
  src/lib/            API calls, SSE, routing, language choice, formatting and the pure logic of
                      each page (with *.test.ts next to them)
  src/styles.css      all styles
docs/                 documents for people besides the README (in Chinese)
  examples/           configuration examples laid out like a data directory: config.yaml,
                      agents.yaml, workflows/ (light, strict, with-e2e, cross-review) and a
                      README on copying them and on the repo registration per language;
                      loaded by test/examples.test.ts
test/
  helpers.ts          temp dirs and repos, a Master with fake agents (harness), FakeGitHub
  *.test.ts           tests run by npm test
  real/               tests that call the real CLIs (npm run test:real)
```

## Code conventions

- TypeScript + ESM, strict mode. Relative imports end in `.js` (`import { x } from './y.js'`).
- Biome owns formatting: 2-space indent, single quotes, line width 100. Don't format by hand; run `npm run format`.
- Code comments are in English. Say the reason directly; don't cite document sections or decision numbers.
- Validate all external input (config files, HTTP requests, agents' structured output) with zod.
- Languages: everything shown to people or sent to agents exists in Chinese and English.
  - Write both texts where they are used, with `t({ zh: '…', en: '…' })` from `src/i18n.ts`. English should read naturally rather than word for word, including plurals.
  - Never call `t` at module top level; a constant would keep the language of import time. Use a function, or compute at render. Label tables that callers index (status badges, risks, filters) keep their shape and make each label a getter (`get label() { return t(...) }`), so the text is picked when it is read.
  - Join lists with `join()` from `src/i18n.ts`: Chinese uses 、, English uses ", ".
  - Protocol stays the same in every language: labels `ares1:*`, hidden comment markers, branch names, config keys, CLI flags, event types, status values, and the field names and enum values of agents' structured output.
  - The Master's language is config.yaml's `language` (default `zh`; on first start the CLI writes the system's). The dashboard uses the language chosen in the browser and falls back to the Master's.
  - Text the Master produces (config problems, error messages, scout waiting reasons) arrives in the Master's language even when the dashboard uses another. Don't make code depend on such wording; when the dashboard needs to tell cases apart, give the API a structured field.
  - Agent prompts follow the language and ask the agent to answer in it.
- Database:
  - Schema changes only **append** a new migration at the end of `src/store/migrations.ts`; never edit an existing one, because already-upgraded databases will not run it again.
  - A state change and its event (`store.event`) go in the same transaction (`store.tx`).
  - Prefer structured event data over rendered text, so that the dashboard can show events in its own language.
- In the engine, after every `await`, if the Run may have been paused or cancelled meanwhile, call `checkAbort(signal)` before changing state.
- Each rule lives in one place, shared by engine and dashboard:
  - rollback targets, effective settings, which proposals are accepted automatically, the
    automatic scout's back-off, the waits for an agent's quota (rate limits) of Runs and scouts,
    the wait before a failed Run of an issue is redone (`redoDelayMs` / `redoDueAt`), which
    unfinished Runs and redos the scout waits for, which raw agent logs are past retention
    (`runRawLogsExpired` / `scoutRawLogExpired`), which worktrees of failed or cancelled Runs
    are left over for the Master to remove (`leftoverWorkspaces`) and the like:
    `src/config/flow.ts`
  - notification rules: `src/notify/notice.ts`
  - assessment conclusion rules: `src/engine/discussion.ts`
  - how a Run's time is split, and the names and groups of the parts: `src/engine/times.ts`
  - how the scripts find the node to run the Master with: `scripts/find-node.sh`
  - the display name and slogan: `brandName()` / `brandSlogan()` / `brandTitle()` in `src/brand.ts`. Never write them as literals elsewhere. The exception is the `<title>` of `web/index.html`, a static file that keeps the Chinese title; a test keeps the two in sync.
- Every comment the Master posts on an issue goes through `markComment` (`src/github/issues.ts`), which adds the hidden marker that tells it apart from human replies.
- Every text the Master publishes on GitHub goes through `redactForGitHub` (`src/github/redact.ts`), which turns paths under the user's home directory into `~` so the system user name stays private: comments (in the bridge's `comment()`), the issues it creates, and the commit messages it makes (they may be pushed). The notifications it POSTs to a webhook (`src/notify/webhook.ts`) go through it too. Store the original text: the dashboard and logs keep the full paths.
- Anybody can write on a public repo. Text read from GitHub (issues, comments) goes into an agent's prompt only when `isTrusted` (`src/github/issues.ts`) trusts its author: the repo's owner, members and collaborators, and the account the Master acts as. A Run from an issue by anyone else waits for a human to confirm its goal (`untrusted_issue`).
- Agents and the commands run on their work (setup and verify commands) get no GitHub credentials, so they cannot read untrusted comments themselves or act as the accounts logged in on the machine. Start them only with `prepareAgentEnv` (`src/adapters/process.ts`), the one place that defines their environment; the Master's own GitHub and git calls keep the credentials.
- No natively compiled dependencies (e.g. better-sqlite3): keep `npm install` simple.
- Dashboard:
  - Import API data types from `src/api/types.ts` and `src/store/types.ts`; don't redefine them in `web/`. These two files hold type declarations only and must not import Node modules.
  - The dashboard also imports `src/i18n.ts`, `src/brand.ts`, `src/config/flow.ts`, `src/config/effort.ts`, `src/api/cost.ts`, `src/notify/notice.ts`, `src/engine/discussion.ts` and `src/engine/times.ts`. They may contain only pure logic and type imports. Don't even import types from files that pull in Node modules, such as `src/store/store.ts`.
  - Hash routing (`#/runs/<id>`); no router or UI component library. Styles go in `web/src/styles.css`, and colors use its CSS variables, which adapt to dark mode.
  - No browser `alert` / `confirm`; dangerous actions use `ConfirmButton` to confirm.
  - Load page data with `useResource` and refresh it on relevant events with `useReloadOn`.

## Test conventions

- New features and bug fixes come with tests. Engine behavior goes in `test/engine.e2e.test.ts` where possible, using `harness()` and fake agent scripts.
- `npm test` must not call real agent CLIs or network services; GitHub uses `FakeGitHub` from `test/helpers.ts`. Tests of real CLI behavior go under `test/real/`.
- Pure dashboard logic (`web/src/lib/`) has a `*.test.ts` next to it. API changes are tested in `test/api.test.ts`.
- Tests run in Chinese by default. To test English, call `setLang('en')` and reset it with `afterEach(() => setLang('zh'))`. Check that English output has no Chinese characters left.
- Temporary directories go in the system temp directory (`tmpDir()`), never in the repository.
- `test/cli.smoke.test.ts` starts the Master as a separate process through the CLI (`dist/cli.js` when built, otherwise `src/cli.ts` through tsx) on an empty home, checks `/api/health` and the dashboard, and expects exit code 0 after SIGTERM. It is the safety net before automatic upgrades: the other tests open the Master in-process, so keep it passing whenever startup or shutdown changes.

## Documents

- `README.md` (Chinese) holds the requirements and goals. Do not change the goals.
- This file is for agents: layout, commands and conventions. Keep it in English, and update it when the layout, commands or conventions change.
- Other documents go in `docs/`, written in Chinese only; no English copies. `docs/running.md` covers running, configuring and upgrading; update it when behavior, configuration or the API changes.
- `docs/examples/` holds configuration examples people copy into their data directory, commented in Chinese only. Keep them in sync with the schema (`src/config/schema.ts`) and the loading rules (`src/config/load.ts`): `test/examples.test.ts` loads the directory as a Master home and fails on any error or warning, so a schema change that breaks an example also updates the example. When a new setting is worth showing, add it there too.

## Notes

- The Master's data directory (default `~/.ares1`) holds run state and configuration outside this repository. Don't read or write it while working.
- When Ares.1 schedules you for a task, don't `git commit`, `git push` or switch branches yourself; the Master makes the commits.
