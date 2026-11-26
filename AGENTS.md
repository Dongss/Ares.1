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
.ares1/workflows/     this repo's own workflow templates, read from the target branch by the Master
                      developing it; self-dev.yaml is defaultSelfDevYaml() in Chinese, word for
                      word (a test keeps them the same: change both together)
src/
  cli.ts              start command: parses --home / --port and starts the Master
  master.ts           wires config, store, engine, GitHub bridge, notifications, upgrade and API
  i18n.ts             language in use and t({ zh, en }) (shared with the dashboard)
  brand.ts            display name and slogan in each language (shared with the dashboard)
  util.ts             ids, time and other small helpers
  config/
    schema.ts         formats of config.yaml, agents.yaml, workflows and Run overrides (zod)
    defaults.ts       default config and the self-dev template, written on first start
    load.ts           load and validate config (invalid agents and templates are only disabled)
    watch.ts          reload config when its files or the repos' own templates change
    repo-workflows.ts read each repo's .ares1/workflows/ as committed on its target branch, again
                      when the branch moves
    flow.ts           workflow, scout, redo and retention rules (shared by Master and dashboard)
    effort.ts         helpers for agent effort (shared with the dashboard)
  store/              SQLite store (node:sqlite): store.ts, migrations.ts, types.ts (entity types)
  adapters/           agent adapters: types.ts (interface), claude-code.ts, cursor-agent.ts, codex.ts,
                      fake.ts (tests), process.ts (processes, agents' env), rate-limit.ts,
                      tool-summary.ts
  engine/
    engine.ts         workflow engine: queue, state machine, checks, rework, agent errors, rollback,
                      approvals, merge, recovery after restart, removing Runs' worktrees
    prompts.ts        prompts for the assess, coding and review agents
    contracts.ts      agents' structured output: contract and validation
    discussion.ts     an assessment's conclusion and discussion (shared with the dashboard)
    times.ts          how a Run's time is split into parts (shared with the dashboard)
    plan.ts           which step of its round's plan a task is (shared with the dashboard)
  backlog/            where requirements come from, whatever the source (GitHub or local):
    scouting.ts       the AI scout's scheduling and runs, filing through a ProposalSource
    local.ts          the local backlog of repos without GitHub: polling, proposals, accepting
    guard.ts          the day's budget and auto-accept limits
    iterations.ts     iterations whatever the source: where their children stand, blocked or not,
                      turned down, a scout's change to the plan, cost and time, the summary once
                      done, the review suggestions the closing step goes through
  github/
    client.ts         GitHub through the gh CLI (FakeGitHub in tests)
    bridge.ts         polling, Runs from issues, progress on issues, auto-accept, push, auto-scout
    issues.ts         labels, issue texts, hidden comment markers, Run status ↔ issue (pure)
    pr-rework.ts      whether an open pull request needs rework (reviews, CI, conflict) and has the
                      reworked commits pushed, and the feedback for the coding agent (pure)
    redact.ts         text before it is published on GitHub: the user's home directory → ~
    scout.ts          the AI scout's prompt, output format and Run summary
  notify/
    notice.ts         which events notify people (shared by every channel and the dashboard)
    system.ts         system notification channel: sending on each platform, recording failures
    webhook.ts        webhook channel: sending, recording failures, waiting for sends on close, the
                      test notification, the curl config file for the scripts
    test-notice.ts    the dashboard's test notification through each enabled channel
  upgrade/
    upgrader.ts       self-upgrade: finds a new version, hands over to scripts/self-upgrade.sh,
                      records failed upgrades, restarts when its node is gone
    source.ts         which registered repo is the Master's own source
  logs/prune.ts       deletes raw agent output past retention; each round also sweeps worktrees
  workspace/git.ts    git: worktrees, commits, rollback, merge, fast-forward, committed files
  verify/commands.ts  run check and setup commands; tell a missing program from a failing command
  api/
    server.ts         HTTP API (Hono) and SSE
    types.ts          API data types, shared by Master and dashboard
    agents.ts, stats.ts, workspaces.ts, diff.ts   Agents, Stats and Workspaces page data, diffs
    cost.ts           whether a cost is unknown (shared with the dashboard)
    static.ts         serves the built dashboard
scripts/
  self-upgrade.sh     auto-upgrade: pull, build, restart, watch the new Master, roll back on failure
  keepalive.sh        run by a timer every minute: starts the Master when it does not answer
  find-node.sh        finds the node to run the Master with (sourced by the other scripts)
  webhook.sh          the scripts' webhook notification when the Master is down
web/                  dashboard (React + Vite)
  src/App.tsx         top bar (navigation, work, notification and language switches) and routing
  src/pages/          Home, RunDetail, Issues, Stats, Agents, Events, Workspaces, Repos, Config,
                      Guide
  src/components/     ui.tsx (common), AgentOutput, DiffPanel, FlowChart, Notifications, WorkSwitch
  src/lib/            API calls, SSE, routing, language choice, formatting, each page's pure logic
  src/styles.css      all styles
docs/                 documents for people besides the README (in Chinese)
  examples/           configuration examples laid out like a data directory
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
  - rollback targets, effective settings, auto-accepted proposals, the automatic scout's back-off
    and what it waits for, whether a stage round is split into tasks (`plansStage`; the size it
    goes by is `assessedSize` in `src/engine/discussion.ts`), which agents a stage may run with
    and which of them does a round by the requirement's difficulty (`stageAgentIds` /
    `chooseStageAgent`; the difficulty it goes by is `assessedDifficulty` in
    `src/engine/discussion.ts`), rate-limit waits of Runs and scouts,
    the redo wait (`redoDelayMs` / `redoDueAt`), raw log retention (`runRawLogsExpired` /
    `scoutRawLogExpired`), leftover worktrees (`leftoverWorkspaces`), which template a repo's
    Runs get by id, the home directory's or the repo's own (`resolveTemplate`), where a repo's
    requirements come from, GitHub or the local backlog (`requirementSource`), whether a repo
    delivers through pull requests (`deliversByPr`), the limit on Runs executing across repos
    and which queued Runs wait for it (`roomUnderMaxRuns` / `waitsForMaxRuns`), the paths a Run
    expects to change and whether two Runs' paths overlap (`normalizeTouches` /
    `touchesOverlap` / `conflictBlocker`), the rules of iterations: how many children one plans
    (`MAX_ITERATION_CHILDREN`), the kind auto-accept judges one by as a whole (`iterationKind`),
    which children a child waits for (`effectiveDependencies` / `unmetDependencies` /
    `childReady`), its progress and where it stands (`iterationProgress` / `iterationStatusOf`),
    and the like: `src/config/flow.ts`
  - notification rules: `src/notify/notice.ts`
  - assessment conclusion rules: `src/engine/discussion.ts`
  - how a Run's time is split, and the names and groups of the parts: `src/engine/times.ts`
  - which step of a stage round's plan a task is, and how many steps it has: `planSteps` in
    `src/engine/plan.ts`
  - how the scripts find the node to run the Master with: `scripts/find-node.sh`
  - how the scripts send to the webhook when the Master is down: `scripts/webhook.sh`, reading
    the curl config file `webhookCurlConfig` (`src/notify/webhook.ts`) writes
  - the display name and slogan: `brandName()` / `brandSlogan()` / `brandTitle()` in `src/brand.ts`. Never write them as literals elsewhere. The exception is the `<title>` of `web/index.html`, a static file that keeps the Chinese title; a test keeps the two in sync.
- Every comment the Master posts on an issue goes through `markComment` (`src/github/issues.ts`), which adds the hidden marker that tells it apart from human replies.
- Every text the Master publishes on GitHub goes through `redactForGitHub` (`src/github/redact.ts`), which turns paths under the user's home directory into `~` so the system user name stays private: comments (in the bridge's `comment()`), the issues it creates, and the commit messages it makes (they may be pushed). The notifications it POSTs to a webhook (`src/notify/webhook.ts`) go through it too, and `scripts/webhook.sh` does the same in bash (`webhook_tilde`) for what the scripts send. Store the original text: the dashboard and logs keep the full paths.
- Anybody can write on a public repo. Text read from GitHub (issues, comments) goes into an agent's prompt only when `isTrusted` (`src/github/issues.ts`) trusts its author: the repo's owner, members and collaborators, and the account the Master acts as. A Run from an issue by anyone else waits for a human to confirm its goal (`untrusted_issue`).
- Agents and the commands run on their work (setup and verify commands) get no GitHub credentials, so they cannot read untrusted comments themselves or act as the accounts logged in on the machine. Start them only with `prepareAgentEnv` (`src/adapters/process.ts`), the one place that defines their environment; the Master's own GitHub and git calls keep the credentials.
- No natively compiled dependencies (e.g. better-sqlite3): keep `npm install` simple.
- Dashboard:
  - Import API data types from `src/api/types.ts` and `src/store/types.ts`; don't redefine them in `web/`. These two files hold type declarations only and must not import Node modules.
  - The dashboard also imports `src/i18n.ts`, `src/brand.ts`, `src/config/flow.ts`, `src/config/effort.ts`, `src/api/cost.ts`, `src/notify/notice.ts`, `src/engine/discussion.ts`, `src/engine/times.ts` and `src/engine/plan.ts`. They may contain only pure logic and type imports. Don't even import types from files that pull in Node modules, such as `src/store/store.ts`.
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
- A Layout entry says only what a file or directory is for, in one or two lines. Behavior and configuration details go in `docs/running.md` and in source comments (file headers, doc comments), not in the Layout: a new feature leaves the Layout alone unless it adds, removes or renames a file or changes what a file is responsible for.
- Other documents go in `docs/`, written in Chinese only; no English copies. `docs/running.md` covers running, configuring and upgrading; update it when behavior, configuration or the API changes.
- `docs/examples/` holds configuration examples people copy into their data directory, commented in Chinese only. Keep them in sync with the schema (`src/config/schema.ts`) and the loading rules (`src/config/load.ts`): `test/examples.test.ts` loads the directory as a Master home and fails on any error or warning, so a schema change that breaks an example also updates the example. When a new setting is worth showing, add it there too.

## Notes

- The Master's data directory (default `~/.ares1`) holds run state and configuration outside this repository. Don't read or write it while working.
- When Ares.1 schedules you for a task, don't `git commit`, `git push` or switch branches yourself; the Master makes the commits.
