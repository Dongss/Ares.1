# 运行和升级

## 安装和启动

需要 Node.js >= 24 和 git。要用的 Agent CLI（Claude Code 的 `claude`、`cursor-agent`、Codex CLI 的 `codex`）需要先装好并登录，各自的用法见下面的「Agent 用的 CLI」。

```bash
npm install
npm run build
node dist/cli.js      # 数据目录 ~/.ares1（或 $ARES1_HOME），端口 4870
```

启动后打开 <http://127.0.0.1:4870> 进入看板。`--home <目录>` 可以换数据目录，`--port <端口>` 可以换端口。Master 只监听 127.0.0.1。

第一次启动时，Master 会在数据目录写入默认配置：`config.yaml`、`agents.yaml` 和 `workflows/self-dev.yaml`。`config.yaml` 的 `language` 会按系统语言写成 `zh` 或 `en`，它决定 issue 评论、通知和给 Agent 的提示词用哪种语言，也是看板的默认语言。看板顶栏可以单独切换语言，选择保存在浏览器里。

## 数据目录

| 路径 | 内容 |
|---|---|
| `config.yaml` | 全局配置：语言、端口、同时执行几个 Run、GitHub、本地提案池、通知、自动升级 |
| `agents.yaml` | Agent 定义（CLI + 模型 + 运行参数） |
| `workflows/` | 流程模板（仓库也可以自带，见「仓库自带的流程模板」） |
| `data/ares1.db` | 运行状态（SQLite），升级迁移前自动备份成 `ares1.db.bak-v<版本>-<时间>`，只保留最近 5 份，更早的在迁移成功后自动删掉；旧版本遇到比自己新的库时恢复备份，较新的库改名成 `ares1.db.newer-v<版本>-<时间>` 留着（见「稳定副本和自动升级」） |
| `data/logs/` | 执行日志：`<Run id>/` 下每次 Agent 执行的原始输出（`<执行 id>.jsonl` 和 `.jsonl.stderr`）、看板展示用的精简事件（`.events.jsonl`）、检查命令的输出（`.verify.log`），以及 `setup.log`、`command-*.log`、`merge-*.log`；`scouts/` 下是侦察的原始输出。原始输出在 Run 或侦察结束 30 天后自动删掉，其余一直保留（见下面「原始日志的保留期」） |
| `data/artifacts/` | 评审意见等产物 |
| `data/agent-gh-config/` | 给 Agent 用的空 gh 配置目录，每次用之前清空（见「Agent 拿不到 GitHub 和 GitLab 凭据」） |
| `worktrees/` | 每个 Run 的工作目录 |
| `data/master-running.json` | Master 运行时的标记，正常停止时删掉（见「保活」） |
| `data/self-upgrade.sh`、`data/find-node.sh`、`data/webhook.sh` | 自动升级时从安装目录复制过来的升级脚本、找 node 的脚本和发 webhook 通知的脚本（见「稳定副本和自动升级」） |
| `master.out`、`upgrade.log`、`keepalive.log` | 后台运行时的输出、自动升级的日志、保活脚本的日志 |
| `webhook.curl` | 配置了 `notify.webhook` 时，Master 留给保活脚本和升级脚本的 webhook 设置，权限 0600（见「通知」的「webhook」） |

配置文件改动后会自动重新加载，仓库自带的模板跟着目标分支重新加载。改端口或 CLI 路径（`bins`）需要重启 Master。

### 原始日志的保留期

Agent CLI 的原始输出（stream-json）带着工具调用的完整结果：读到的文件内容、测试输出等等，Master 一直运转就会一直变大。看板展示 Agent 输出用的是另存的精简事件（`.events.jsonl`），原始输出只用于下载排查，所以 Master 只保留 30 天：

- Master 启动时清理一次，之后每天一次。
- Run 结束（完成、失败、取消或评估后不做）超过 30 天，删掉它每次 Agent 执行的原始输出 `<执行 id>.jsonl` 和 `<执行 id>.jsonl.stderr`。执行中、排队、等审批、卡住、暂停的 Run 不论多旧都不碰；失败后等着重做的 Run 也不碰。时间按 Run 的结束时间算，没有结束时间的不碰。
- 侦察结束超过 30 天，删掉它的 `scouts/<侦察 id>.jsonl` 和 `.stderr`。正在进行的侦察不碰。
- 一直保留：`.events.jsonl`（看板上照常能看历史 Run 的 Agent 输出）、`.verify.log`、`setup.log`、`command-*.log`、`merge-*.log` 和 `data/artifacts/` 里的产物，以及数据库里的全部记录（统计、侦察提示词都不受影响）。Master 按数据库里每次执行记下的路径逐个删除，不按目录或通配符删。
- 有文件被删掉时，事件列表里记一条全局事件 `logs.pruned`（看板「事件」页能看到，写明删了几个文件、多大、涉及几个 Run 和几次侦察；见下面的「全局事件」），数据是 `{ runs, scouts, files, bytes }`：涉及的 Run 数、侦察数、删掉的文件数和它们删除前的总字节数。什么都没删时不记，所以重复清理不会重复记事件。文件已经不在不算错误；删不掉的文件在 Master 的输出（`master.out`）里记一行原因（每个文件只记一次），不影响别的文件，下一轮再试。
- 原始输出被删掉后，Run 详情页每次执行下面的「原始日志」「下载」换成「原始日志已超过保留期（Run 结束 30 天后）被删除」，Agent 输出照常从事件展示。API `GET /api/attempts/:id/log` 这时返回 404，数据是 `{ "error": "…", "pruned": true }`；原始输出因为别的原因不在时也是 404，但 `pruned` 为 `false`。

### 全局事件

Master 把不属于任何 Run 的事记成全局事件（事件的 Run 为空）：上一个 Master 异常退出（`master.restarted`）、清理原始日志（`logs.pruned`）、恢复数据库备份（`store.backup_restored`）、node 不见了（`master.node_missing`）、打开或关闭工作开关（`master.working`）、配置重新加载（`config.reloaded`、`config.reload_failed`）、访问 GitHub 出错（`github.error`，同一串连续失败里同一个错误只记一次，见「通知」）、webhook 通知发送失败（`notify.webhook_failed`）、系统通知发送失败（`notify.system_failed`）、推送目标分支（`github.pushed`）、从 GitHub 拉取目标分支（`github.pulled`、`github.merged_remote`、`github.diverged`、`github.diverged_run`、`github.pull_blocked`，见「拉取 GitHub 上的新提交」）、自动采纳提案（`issue.auto_accepted`）、本地提案的采纳、拒绝、失败后的重做和重新开始（`proposal.auto_accepted`、`proposal.accepted`、`proposal.rejected`、`proposal.redo_scheduled`、`proposal.redone`、`proposal.failed`、`proposal.restarted`，见「不用 GitHub 时」）、迭代（`iteration.auto_accepted`、`iteration.accepted`、`iteration.child_status`、`iteration.blocked`、`iteration.unblocked`、`iteration.adjusted`、`iteration.completed`、`iteration.cancelled`，见「迭代」）、侦察（`scout.started`、`scout.completed`、`scout.failed`、`scout.rate_limited`、`scout.update_dropped`）和升级（`upgrade.started`、`upgrade.done`、`upgrade.failed`）。这篇文档里说「事件列表里记一条」这些事件的地方，都指这里。

Master 大部分时间没人看着，人回来时在看板的「事件」页查这段时间发生过什么：

- 最新的在前，每页 200 条，底部「加载更早的」往前翻；有新的全局事件时自动刷新。
- 每条有时间、类型和一句说明：比如删了几个原始日志、多大，上一个 Master 的 pid 和启动时间，恢复了哪个备份、较新的库移到了哪里。出错的（`github.error`、`notify.webhook_failed`、`notify.system_failed`、`config.reload_failed`、`upgrade.failed`、`scout.failed`，以及多次失败后放弃的本地提案 `proposal.failed`）标成红色，值得留意的（`master.restarted`、`master.node_missing`、`store.backup_restored`、`github.diverged`、`github.pull_blocked`、`iteration.blocked`、`scout.update_dropped`，有无效配置项的 `config.reloaded`）标成橙色，其余的（包括建了合并 Run 的 `github.diverged_run`：要留意的分叉由同时记的 `github.diverged` 标出）不标颜色。分叉交给 Run 处理时，`github.diverged` 的说明写「已交给 Run <id> 处理」，不再要你手动合并。升级失败带着脚本输出末尾时可以展开看。鼠标悬停在说明上能看到原始数据。
- 迭代的事件带着去这个迭代的页面（`#/iterations/<id>`）的链接；侦察、自动采纳和拒绝本地提案的事件带着去「需求」页的链接；交给 Run 的 `github.diverged` 和 `github.diverged_run`，以及采纳本地提案建出了 Run 的 `proposal.accepted`、`proposal.auto_accepted`，重做本地提案建出了新 Run 的 `proposal.redone` 和重新开始本地提案建出了新 Run 的 `proposal.restarted` 带着去这个 Run 的链接。
- 看板还不认识的事件类型（以后新加的）照样列出，显示类型名和原始数据。
- 每个 Run 自己的事件不在这里，在 Run 详情页。

API 是 `GET /api/events`，按 id 从新到旧返回 Run 为空的事件，格式和 `GET /api/runs/:id/events` 的一样（`id`、`runId`、`ts`、`type`、`data`）。参数 `limit` 是 1–500 的整数，默认 200；`before=<id>` 只返回比这个 id 更早的，用上一页最后一条的 id 往前翻。参数不合法时返回 400。

默认配置只有给 Ares.1 开发自己用的 `self-dev` 模板。给别的项目配置时，可以参考 [`docs/examples/`](examples/README.md)：一组完整的 `config.yaml`、`agents.yaml` 和几种场景的流程模板（轻量、严格、带 E2E、交叉评审），每一项都有注释，目录结构和数据目录一样，可以直接复制过来改；那里还写了 npm、pnpm、Python、Go、Rust 项目登记仓库时检查命令和准备命令怎么填。流程模板也可以放在仓库自己的 `.ares1/workflows/` 里，跟着代码一起演进，见下面的「仓库自带的流程模板」。

## 仓库自带的流程模板

流程模板除了放在数据目录的 `workflows/` 里，也可以放在登记的仓库里，和代码一起提交、一起评审、跟着代码演进，就像 CI 配置放在仓库里一样：检查命令、E2E 阶段、评审要求改了，流程跟着改，不用再到每台机器的数据目录里手动同步。

Ares.1 自己的仓库就带着 [`.ares1/workflows/self-dev.yaml`](../.ares1/workflows/self-dev.yaml)。它和第一次启动时写进数据目录的默认 `self-dev.yaml`（中文版）一字不差，有测试守着；改默认模板时两边一起改。这样改进自举流程的需求合并之后，正在运行的 Master 就用上了改进后的流程。

- **放在哪**：仓库目标分支上的 `.ares1/workflows/*.yaml`（`.yml` 也行），格式和数据目录里的模板完全一样，id 是文件里写的 `id`。只看这个目录里的文件，不看子目录和符号链接。
- **只读已提交的**：Master 读目标分支所在的那个提交里的文件（`git ls-tree`、`git cat-file`），不碰工作目录。目标分支检出的目录里没提交的改动、别的分支上的改动都不算。目标分支指 Master 在本地合并 Run 用的那个分支（看板「仓库」页登记的）。
- **什么时候重新读**：Master 启动时（在恢复 Run 和检查 GitHub 之前）；Run 合并进目标分支之后；从 GitHub 拉取到新提交（`github.pulled`、`github.merged_remote`）之后；每轮检查 GitHub（每 `github.poll_minutes` 分钟）或本地提案池（每 `backlog.poll_minutes` 分钟）开始时，人直接提交到本地目标分支的改动在这时读到；在看板「仓库」页增加、修改或删除仓库之后。目标分支还在同一个提交时不重新读。文件内容变了时，配置重新加载，事件列表里记一条 `config.reloaded`；只是提交变了、文件没变时只更新记下的提交，不记事件。目标分支读不出来（目录或分支没了、git 出错）时，沿用之前从同一路径、同一分支读到的文件，在 Master 的输出（`master.out`）里记一行原因，同样的错误连着出现只记一次。
- **怎么找**：`config.yaml` 里 `github.repos.<仓库>.template`（或 `backlog.repos.<仓库>.template`）写的 id，先在数据目录的 `workflows/` 里找，找不到再在这个仓库自带的模板里找。数据目录里的算这台机器的覆盖，由在这台机器上的人说了算。两边有同一个 id 时用数据目录那份，看板「配置」页在仓库那个文件（键是 `<仓库名>:.ares1/workflows/<文件>`）的警告里写明仓库里这份没有生效、数据目录里是哪个文件，以及想改用仓库里的就删掉数据目录里那个文件。两边都没有时，和以前一样在 `config.yaml` 下报「模板不存在或无效」，不建 Run。
- **只对本仓库可见**：仓库自带的模板只给这个仓库的 Run 用，别的仓库写同一个 id 也找不到它。它们的 id 只和同一个仓库里的其他文件比，不和数据目录、别的仓库比。
- **坏了会怎样**：目标分支上的模板改坏了（YAML 不合法、不符合格式、引用了不存在或没启用的 Agent 等），仓库也不会停转：继续用这个文件上次加载成功的版本，「配置」页在这个文件的警告里写明这次为什么失败、在用的是哪个提交上的版本。上次成功的版本只记在内存里，所以 Master 重启时目标分支上的文件还是坏的，就没有能用的版本：这个文件记为错误，按模板不存在处理，用它的仓库不建新的 Run。改好并提交到目标分支，下次重新读时就恢复。已经建好的 Run 用的是建 Run 时存下的模板，都不受影响。
- **合并前先试加载**：Run 的分支改了 `.ares1/workflows/`（和合入后的目标分支不一样）时，合并阶段在合入目标分支的最新代码之后、重跑检查命令之前，用当前配置里的 Agent，把 Run 分支上已提交的这些文件试加载一遍；这里没有「上次成功的版本」兜底。有文件加载失败就不合并，和检查命令没通过一样：合并阶段标为没通过，合并阶段的检查里记一条「流程模板（.ares1/workflows/）」，回退到合并阶段 `on_fail` 指向的阶段（默认是它前面最近的 Agent 阶段，通常是编码）返工，反馈里逐个列出文件和加载错误，要求改好或撤回这些改动；和别的回退一样受 `max_loops` 限制，用完后按 `on_exhausted` 处理（默认 Run 结束、标为失败）。所以坏模板进不了目标分支。Run 没动这个目录时不试加载。
- **看板**：「配置」页按仓库列出各仓库自带的模板文件，标明有效、无效、被数据目录覆盖、正在用旧版本，并写明原因；「仓库」页每个仓库有一行「自带的流程模板」；「需求」页写明仓库的 Run 用的模板来自数据目录还是仓库。API `GET /api/config` 的 `repoTemplates` 按仓库名列出有这些文件的仓库：读的分支（`branch`）和提交（`sha`）、在用的模板（`templates`），以及每个文件（`files`；`lastGood` 是正在代替坏文件的旧版本和它的提交，`shadowed` 表示数据目录里有同 id 的模板）。
- **改 `.ares1/` 就是改这个仓库自己的开发流程**，所以侦察给这类提案标 `high` 风险（见「侦察提什么」），开了自动采纳也要 `max_risk` 是 `high` 才会自动采纳。

### 从数据目录的模板切换到仓库自带的

已经装好的 Master，数据目录里有第一次启动时写的 `workflows/self-dev.yaml`，它会一直盖住仓库里同 id 的模板，「配置」页在 `<仓库名>:.ares1/workflows/self-dev.yaml` 下警告仓库里这份没有生效。想改用仓库里的、让流程跟着代码更新：

1. 先对比两份。数据目录里那份有想保留的修改，就先改进仓库的 `.ares1/workflows/self-dev.yaml`，提交到目标分支（自己提交，或者建个 issue 让 Ares.1 做），等它进了目标分支。
2. 删掉数据目录里的 `workflows/self-dev.yaml`。Master 自动重新加载，警告消失，之后新建的 Run 用仓库里的模板，「需求」页的模板来源变成仓库。已经建好的 Run 仍按建 Run 时的模板走。

Master 只在数据目录里还没有 `workflows/` 目录时（第一次启动）写默认模板；`workflows/` 删空了也不会再写，删掉的模板重启后不会回来。想在这台机器上临时换一个流程，就反过来在数据目录里放一个同 id 的模板，删掉它就回到仓库里的。

## 接入 GitHub

接了 GitHub 的仓库（`github.repos`），Run 从 GitHub issue 来。例外只有一种：目标分支和 GitHub 上的分叉、Master 自己合并不了时，它自动建一个不关联 issue 的 Run 来合并（见「交给 Run 合并」）。不接 GitHub 的仓库从本地提案池建 Run，见下面的「不用 GitHub 时」。

1. 安装并登录 [gh](https://cli.github.com/)。登录了多个账号时，在 `config.yaml` 的 `github.account` 里指定用哪个。
2. 在看板的「仓库」页登记本地仓库：填仓库名、绝对路径、目标分支和检查命令。常见语言的项目怎么填检查命令和准备命令，见 [`docs/examples/`](examples/README.md#在看板上登记仓库)。
3. 在 `config.yaml` 里打开 `github`，把登记的仓库名写进 `repos`：

   ```yaml
   github:
     account: my-account
     repos:
       my-repo:
         template: self-dev
   ```

4. 给要做的 issue 加上 `ares1:ready` 标签。Master 每 `poll_minutes` 分钟（默认 5）检查一次，把它建成 Run，进展回写到 issue 上。每个仓库同一时间默认只执行一个 Run，可以用 `concurrency.per_repo` 调大（见下面的「同时执行几个 Run」）；不同仓库的 Run 可以同时执行，登记到同一路径的仓库（比如同一个 git 仓库按不同目标分支登记了两次）共用一个上限，所有仓库合计的上限用 `concurrency.max_runs` 设置（默认不限）。`/api/health` 的 `activeRuns` 按开始执行的先后列出正在执行的 Run 的 id，`activeRun` 是其中第一个（没有时为 `null`），为兼容旧的调用方保留。

Master 第一次访问仓库时会自动创建这些标签：

| 标签 | 含义 |
|---|---|
| `ares1:proposal` | AI 侦察提出的需求，等你决定。采纳就加 `ares1:ready`，不做就关闭为 not planned 并写一句理由 |
| `ares1:ready` | 可以开工。你自己写的 issue 加上它也会被做 |
| `ares1:running` | 正在做 |
| `ares1:needs-you` | 等你处理：审批、卡住、需求待讨论（在 issue 下回复即可）、在看板上确认非仓库成员写的需求，或在 GitHub 上审 PR、合并（`deliver: pr`） |
| `ares1:failed` | 被终止，或失败次数达到上限后不再自动重做。重新加 `ares1:ready` 会再做一次 |
| `ares1:auto` | 按 `auto_accept` 的设置自动采纳的 |
| `ares1:iteration` | AI 侦察规划的迭代：一个大目标和按依赖排好的子 issue。给它加 `ares1:ready` 就整批采纳，关掉它就整批不做（见「迭代」）；它自己从不建 Run |

AI 侦察、自动采纳、自动合并、推送和每日预算的设置写在 `config.yaml` 的注释里；[`docs/examples/config.yaml`](examples/config.yaml) 有登记了多个仓库、各用不同设置的完整示例。

`github.repos.<name>.deliver` 决定 Run 的代码怎么交到 GitHub 上：

- `push`（默认）：合并阶段把 Run 合并进本地目标分支，`push: true` 时之后推送目标分支。不写时就是这样。
- `pr`：给目标分支受保护、只能走 PR 或要过 CI 的仓库用。合并阶段照常先把目标分支的新提交合进 Run 分支、跑检查，但不动本地目标分支，而是推送 Run 分支、开一个以目标分支为 base 的 PR，PR 在 GitHub 上合并后 Run 才完成；Master 不直接推送这个仓库的目标分支。`pr` 要求 `push: true`（推送 Run 分支、PR 合并后拉取目标分支都靠它），不满足时这个仓库停用，看板「配置」页在 `config.yaml#github.repos.<name>` 下写明原因；这期间它的 Run 检查通过后也不在本地合并，停在合并阶段等配置改好。`GET /api/github` 里每个仓库的 `deliver` 是这个设置。
  - 检查通过后记 `merge.pr_pending` 事件（数据是 `{ target, head }`：目标分支和 Run 分支上检查通过的提交），Run 进入「等 PR 合并」：状态是 `blocked`，`blocked.kind` 为 `pr_open`，合并阶段保持执行中，不占执行名额，也不发通知；Master 重启后仍然等着，不会重跑合并，由每轮检查接着开 PR、跟踪 PR。这种卡住不能在看板上重试（`POST /api/runs/:id/retry` 返回 409），只看 GitHub 上的 PR：合并了（merge、squash、rebase 都算），合并阶段通过、记 `merge.done` 事件，Run 完成；没合并就被关掉，Run 结束为失败（工作目录和分支保留），记 `github.pr_closed` 事件并按失败的 Run 通知，从 issue 来的按重做规则处理；受信任的人要求修改、CI 检查没过或和目标分支冲突时，Run 带着这些反馈回去返工，改好后推送到同一个 PR（见下面的「跟踪 PR」）。
  - 开 PR：Run 一进入「等 PR 合并」，大约 1 秒后（之后每轮检查也会看一遍）Master 把 Run 分支推送到目标分支推送去的那个 GitHub 仓库（强制推送，只用于 `ares1/` 开头的 Run 分支，因为回滚可能改写过它的历史；所以人直接推到 GitHub 上 Run 分支的提交，会在 Master 下次推送这个分支时被覆盖，要改 PR 请在 PR 上评审、要求修改，让 Run 返工），再开一个从 Run 分支到目标分支的 PR。这个分支上已经有开着、合并到目标分支的 PR 时（比如开完 PR 还没记下 Master 就重启了）直接用它，不会开第二个。PR 标题是目标的第一行，正文是 Run 摘要（目标的前几行、Run id、费用、看板链接）；从 issue 来的 Run 在正文末尾写 `Closes #N`（issue 在别的仓库时写 `Closes owner/name#N`），PR 合并后 GitHub 会关闭 issue；Master 自己建的 Run（合并远端提交）不关联 issue。标题和正文里用户主目录的路径换成 `~`，正文不带 Master 评论的隐藏标记。开好后 Run 记下 PR、记 `github.pr_opened` 事件，issue 上发一条带 PR 链接的评论，标签换成 `ares1:needs-you`（不发「Run 卡住了」的评论）。推送或开 PR 失败时记 `github.error`，Run 保持原样，下一轮再试。仓库从 `pr` 改回 `push` 后，之前已经在等的 Run 只要还是 `push: true` 也照样开 PR，否则没有别的办法交付它们。
  - 跟踪 PR：每轮检查（Run 状态变化后的同步也会）Master 向 GitHub 查一遍已经开了 PR 的 Run，以 GitHub 返回的状态为准：
    - 已合并（merge、squash、rebase 都算）：先把本地目标分支快进到 GitHub 上的提交（和平时拉取一样，记 `github.pulled`），再记 `github.pr_merged` 事件（带合并提交）和 `merge.done`，合并阶段通过，Run 完成，工作目录和分支随之删除。本地目标分支暂时快进不了时（检出的地方有未提交的改动，记 `github.pull_blocked` 并通知；或者这个仓库另一个 Run 正在合并），Run 接着等，下一轮再试。issue 上发一条「PR #N 已合并到 `<目标分支>`（合并提交）」的评论，带费用和用时；issue 多半已经被 PR 里的 `Closes` 关掉，Master 不再重复关闭，还开着时由 Master 按 completed 关闭。
    - 没合并就被关掉：Run 结束为失败（见上），从 issue 来的按「Run 失败后自动重做」处理：还没用完 `max_run_attempts` 时等一会儿重做，用完了 issue 关闭为 not planned。重做是一个新的 Run，用它自己的分支开新的 PR，新 Run 的 `pr` 是新 PR；被关掉的 PR 保持关闭。
    - 还开着：看它要不要返工。只看 PR 当前的 head 提交上的结果，而且这个提交要等于 Run 记下的 `headCommit`（也就是 Run 推送上去的那个）：旧提交上的评审和检查已经由之后的提交回应过，不再算；head 不是 Run 推送的，也不归 Run 判断。下面三种情况任何一种出现都要返工，一轮里出现几种时只返工一次，反馈里每种都写上：
      - 评审要求修改：每个评审人只看他最新的一条表明态度的评审（APPROVED、CHANGES_REQUESTED、DISMISSED；只写评论的 COMMENTED 不改变态度），这一条是 CHANGES_REQUESTED，并且落在当前 head 上。GitHub 的 `reviewDecision` 已经是 APPROVED 或 REVIEW_REQUIRED（有人批准了，或者要求修改的评审被 dismiss 了）时不触发。评审人要受信任（见下面的「只信任仓库成员写的内容」）。反馈里有每条这样的评审的正文，以及受信任的人在当前 head 上写的行内评论（`文件:行`）。
      - CI 没过：PR 的检查（GitHub Actions 的 check run 和 commit status 都算）全部结束，并且至少一个的结论是 FAILURE、TIMED_OUT、CANCELLED、ACTION_REQUIRED、STARTUP_FAILURE 或 ERROR。还有检查在跑时等下一轮再看；一个检查都没有时不触发。GitHub 在 `statusCheckRollup` 里新加的、Master 不认识的条目类型（`__typename` 不是 `CheckRun` 或 `StatusContext`）直接跳过：既不算检查，也不让整个 PR 读不出来，PR 合并了照样认得出，别的检查失败了照样返工。反馈里有每个失败检查的名称、结论和链接，打不开日志时让 Agent 在工作目录里运行相应的命令复现。
      - 和目标分支冲突：以 GitHub 的 `mergeable` 为准，是 CONFLICTING 才算；GitHub 还没算出来（UNKNOWN）时等下一轮再看。
    - 信任：要求修改的评审只认受信任的人写的（仓库所有者、成员、协作者和 Master 用的账号）。其他人的评审不触发返工，正文和行内评论都不进任何提示词，只记一条 `github.pr_review_ignored` 事件，写明是谁、和仓库是什么关系（不含正文）；同一个 head 上同一个人只记一次。
    - 返工：在同一个事务里把合并阶段这一轮记为没通过（加一条 `merge` 检查，写明「PR #N 需要返工」和原因），记 `github.pr_rework` 事件，Run 放回队首，和合并阶段检查没通过一样回到合并阶段 `on_fail` 指向的阶段（默认是编码），反馈里写明 PR 链接、评审正文和行内评论、失败检查的名称和链接。有冲突、而回到的又是 Agent 阶段时，那一轮先合并目标分支、解决冲突（和合并时冲突一样，见下面的「合并冲突」），其他几种的反馈一起交给它。每次返工都和别的回退一样计入 `max_loops`，用完后按 `on_exhausted` 处理（见下面的「返工或回退用完时」）。
    - 去重：同一个 head 提交上的同一类问题（评审、CI、冲突各算一类）只返工一次，依据是 `github.pr_rework` 事件里记下的 head 和 `kinds`，存在数据库里，所以 Master 重启后也不会重复返工。人在 GitHub 上把评审改成 APPROVED 或 dismiss 之后不再触发。
    - 推送到同一个 PR：返工期间 Run 的 `pr` 不变。Run 改完、再次走到合并阶段并等 PR 合并时，Master 把 Run 分支强制推送上去（人在 GitHub 上往 Run 分支追加的提交会被覆盖），同一个 PR 随之更新，不开第二个 PR；记 `github.pr_updated` 事件，issue 上评论「返工后的提交已推送到 PR #N」。推送之前 GitHub 上还是返工前的提交，这期间不判断返工。返工期间 PR 在 GitHub 上被关掉或合并了的，Run 再次等 PR 合并时不推送，也不开新的 PR，按 PR 的状态处理：被关掉的 Run 结束为失败（见上）；已合并的 Run 完成，返工后的提交不在合进去的内容里。
    - issue：返工时 issue 上评论「PR #N 需要返工：原因」（原因写冲突、失败检查的名称和要求修改的人），说明 Run 带着这些反馈回去修改、计入回退上限、改好后推送到同一个 PR；Run 回到队列后，issue 的标签由 `ares1:needs-you` 换回 `ares1:running`。评论和 Master 别的评论一样带隐藏标记，用户主目录的路径换成 `~`。返工不发通知；回退用完后停下来等人或失败时，照常按「Run 卡住了」或「Run 失败了」通知。
    - 等 PR 合并的 Run，issue 被关掉时，Master 先查 PR：已经合并的（多半就是 PR 里的 `Closes` 关的）照常完成，不会因为 issue 关了被终止；PR 没合并的，和别的 Run 一样被终止，之后 Master 关掉这个 PR（见下面的「Run 没做完就结束时」）。
    - 查 PR 失败时记 `github.error`，Run 保持原样（issue 被关掉也不终止），下一轮再试；Master 重启后照常跟踪。没有 `push: true` 时拉取不了目标分支，这些 Run 一直等到配置改好。
  - Run 没做完就结束时：记着 PR 的 Run 失败（比如 PR 返工次数用完、按 `on_exhausted: fail` 结束）、被终止（在看板上终止，issue 被关掉，或 issue 的标题、正文改了而重新开始）或被需求评估放弃后，没人再跟踪这个 PR；重做的 Run 又会开一个写着 `Closes #N` 的新 PR，旧的留着的话同一个 issue 会挂着好几个 PR，有人合并了旧的，Master 也不会跟进。所以 Master 在下一轮检查 GitHub 时（Run 状态变化后的同步也会）关掉它：
    - 先向 GitHub 查这个 PR。还开着的，用 `gh pr close --comment` 关掉，评论说明原因（Run 失败了、被终止了、issue 被关掉或改了），从 issue 来的 Run 失败时还说明重做时新的 Run 会开新的 PR；评论带 Master 评论的隐藏标记，用户主目录的路径换成 `~`。记 `github.pr_closed_by_master` 事件。issue 上不另发评论，issue 被人关掉的保持原样。
    - 已经在 GitHub 上合并或关掉的不动（不会关掉已经合并的 PR），记 `github.pr_found_closed` 事件。Run 等 PR 合并期间 PR 被合并或关掉的（`github.pr_merged`、`github.pr_closed`）本来就处理过了，不再去查。PR 已经合并、issue 被它的 `Closes` 关掉的 Run 照常完成（见上），不会被终止，也不会走到这里。
    - 这一步在每轮为新 Run 开 PR 之前，失败 Run 的 PR 先关掉，重做的 Run 才开自己的 PR，同一时刻一个 issue 只有一个开着的 PR。
    - 关 PR 或查 PR 失败时记 `github.error`（同一种错误在一连串失败里只通知一次），下一轮再试；记下上面两种事件之一后，这个 Run 不再查。Master 重启后照常接着关，升级前就已经结束、PR 还开着的 Run 也一样会被关掉。
    - 不发通知：失败的 Run 已经按「Run 失败了」通知过。
  - 事件：`merge.pr_pending`（检查通过，等开 PR）、`github.pr_opened`（数据是 `{ number, url, head, base }`）、`github.pr_merged`（`{ number, url, mergeCommit }`，GitHub 没给合并提交时为 `null`）、`github.pr_closed`（`{ number, url }`）、`github.pr_rework`（`{ number, url, head, kinds, reviewers, checks }`：`head` 是判断时的 head 提交，`kinds` 是这次返工的种类，由 `conflict`、`ci`、`review` 按这个顺序组成，`reviewers` 是要求修改的受信任评审人的账号，`checks` 是失败的检查 `{ name, url }`，`url` 没有时为 `null`）、`github.pr_updated`（`{ number, url, head }`：返工后推送到同一个 PR 的提交）、`github.pr_review_ignored`（`{ number, url, head, reviewer, association }`：不受信任的人要求修改的评审，`reviewer` 是账号，已删除的账号为 `null`，`association` 是 GitHub 给的和仓库的关系，比如 `NONE`）、`github.pr_closed_by_master`（`{ number, url, reason }`：Run 没做完就结束后 Master 关掉的 PR，`reason` 是 `failed`、`cancelled`、`issue_closed`、`restarted` 或 `dropped`）、`github.pr_found_closed`（`{ number, url, state }`：Run 没做完就结束后，PR 在 GitHub 上已经 `merged` 或 `closed`，Master 没动它），都是结构化数据，看板按自己的语言显示成文字。
  - Run 数据里的 `pr` 是它的 PR（`{ number, url }`），开 PR 之前和 `deliver: push` 的仓库都是 `null`；返工期间不变。
  - 看板：首页把等 PR 合并的 Run 列在「待我处理」里，标成「等 PR 合并」而不是「卡住」，写「等 PR 合并 #N」并链接到 PR（还没开时写明下次检查 GitHub 时开）；Run 详情页给它一个面板，写明 PR 链接、在 GitHub 上合并、要求修改（或 CI 没过、冲突）、关掉后会怎样，不显示重试，返工过的 PR 还写明返工过几次、最近一次的原因和时间；有 PR 的 Run（包括已经完成的）在概要里显示 PR 链接，返工期间（Run 有 PR，既不在等 PR 合并，也没结束）后面写「（返工中：原因）」，原因取自最近一次 `github.pr_rework` 事件。事件列表把 `github.pr_rework`、`github.pr_updated` 和 `github.pr_review_ignored` 按看板的语言显示成文字：返工的种类、要求修改的人、失败的检查，以及 Run 回到合并阶段 `on_fail` 指向的阶段；`github.pr_closed_by_master` 和 `github.pr_found_closed` 也显示成文字，写明 Run 是怎么结束的、PR 是被 Master 关掉还是已经合并或关掉。「需求」页每个仓库的「交付方式」写明是推送还是 PR。

自动采纳（`auto_accept`）按侦察给提案标的风险和大小决定采纳哪些：风险不超过 `max_risk`（`none` / `low` / `mid` / `high`，默认 `none`）、大小也不超过 `max_size`（`S` / `M` / `L`，默认 `L`）的提案，Master 不等人，直接加上 `ares1:ready` 和 `ares1:auto`。`max_risk` 为 `none` 时不自动采纳任何提案，不管 `max_size` 是什么。`max_size` 默认是 `L`，因为编码阶段设了 `planning: auto` 或 `llm` 的模板（默认的 self-dev 就是）会先把 L 的需求拆成几步，在一个 Run 里一步一步做完；想让大需求先经过人，就设成 `M`。开了自动采纳、`max_size` 是 `L`（包括不写），而仓库用的模板里没有一个 Agent 阶段是 `planning: auto` 或 `llm` 时，L 的需求会整个交给一个 Run 一次做完，容易超时或返工，看板「配置」页会在 `config.yaml` 的警告里写明是哪个仓库、哪个模板，建议给编码阶段设 `planning: auto`，或把 `max_size` 调成 `M`。这只是提醒，仓库照常工作；模板不存在时那里已经报错，不再另外提醒。`max_per_day` 限制每天最多自动采纳几条，不写就不限。每轮检查时，还在等人的提案落在采纳范围内的（比如刚放宽了设置），也会被自动采纳。迭代按整体判断：取子项里最高的风险和最大的大小，采纳时迭代和全部子 issue 一起加上这两个标签，在 `max_per_day` 里只算一次（见下面的「迭代」）。

流程里有需求评估阶段（`kind: assess`）时，评估有疑问会在 issue 上提问，等你在 issue 下（或 Run 详情页）回复，回复后带着讨论重新评估。为了没人在场时系统也不停转，等待有上限，由评估阶段的 `reply_timeout_hours` 决定：

```yaml
stages:
  - id: assess
    kind: assess
    agent: claude-reviewer
    reply_timeout_hours: 24   # 不写也是 24
```

- 超过这个时间没人回复，Master 在 issue 和讨论记录里写明「没人回复，由评估自己决定」，再跑一轮评估。这一轮只能给出两种结论：写明做了哪些假设后开工（假设会交给编码和评审），或者写明理由后不做（issue 关闭为 not planned）。它再提问会被打回重做。
- 写 `0` 表示不等人：评估提出疑问后马上自己决定，Run 不会卡住等回复。写 `null` 表示一直等到有人回复。
- 超时前有人回复，和不设超时时一样，以人的回复为准。工作开关关着时不会超时，打开后再检查。
- 时间从评估提出疑问的那一刻算起；Master 没在运行的时间也算在内，重启后已经超时的会马上继续。

仓库有会自己往下走的 Run 时，Master 不自动侦察，等它们做完再找新活：排队的、执行中的，等你回复评估的疑问、但设了超时（`reply_timeout_hours` 不是 `null`）的 Run，以及因为目标分支有未提交的改动而停下、改动清掉后会自动接着合并的 Run。失败后在等自动重做的 issue 也算（见下面的「Run 失败后自动重做」），因为重做的结果会改变接下来值得做什么，看板上写明「有 1 个 issue 在等重做」；它不算卡住的 Run，不计入下面的 `scout.max_proposals`。只等人的 Run（见下面的「Run 什么时候停下来等人」）不会挡住侦察，否则没人在场时只要有一个 Run 卡住，这个仓库就再也不会有新需求。

为了不堆积没人看的工作，等你处理的提案和只等人的 Run 合计达到 `scout.max_proposals` 时，Master 不再自动侦察，看板上写明两部分各有几个，比如「有 2 条提案、1 个卡住的 Run 等你处理」。`auto_accept.max_risk` 为 `none` 时，所有没处理的提案都算；开了自动采纳时，只算在采纳范围内、因为当天的自动采纳数（`max_per_day`）已满还没采纳的提案，以及找不到侦察记录的提案。超出范围的提案（风险超过 `max_risk`，或大小超过 `max_size`）照样等你决定，但不会让侦察停下。等人采纳的迭代整个算一条，按子项里最高的风险和最大的大小判断，它的子 issue 不另算（见「迭代」）。卡住的 Run 对应的 issue 还开着，侦察能在提示词里看到它们，不会重复提案。

侦察没找到需求或失败后，自动侦察会退避，免得仓库没变时每轮检查都花钱重新侦察一遍。从最近一次侦察往回数，连续 k 次没有建出 issue（包括提案全部重复、没建成 issue 的）或失败，下次自动侦察就要等到最近那次侦察结束后 `poll_minutes × 2^(k-1)` 分钟，最长 6 小时；手动触发的侦察也算在内，被 Master 停止打断的不算。有侦察建出了 issue（建出了迭代 issue 也算，哪怕迭代之外一条提案都没有），或者目标分支的最新提交（按提交者时间）晚于最近那次侦察的开始时间，退避马上解除，目标分支更新之前的侦察不再计数。退避和 `scout.interval_minutes`（两次自动侦察至少间隔几分钟，默认 0 即不限，可以写小数）同时生效，取较晚的时间；看板上能看到退避的原因和下次侦察的时间。在看板上手动触发侦察不受退避限制。偶尔失败一次只退避，不通知；连续失败 3 次时会发一条「侦察连续失败」的通知（见下面的「通知」），免得侦察一直坏着、新需求悄悄断掉。

侦察的 Agent 额度用尽或被限流（怎么识别见下面的「Agent 出错时」）不算失败，和 Run 遇到限流的处理一致（见下面的「Agent 出错时」）：侦察记为「额度用尽/限流」（`rate_limited`），`error` 里写明预计什么时候恢复额度（CLI 给了重置时间时），费用照常记录，事件列表里记一条 `scout.rate_limited`（看板「事件」页能看到；数据里有 `scoutId`、`repo`，CLI 给了重置时间时还有 `retryAt`），不发系统通知。这样的侦察既不计入上面的连续次数，也不打断已有的连续计数，也不占用 `interval_minutes` 的间隔（间隔从最近一次没被限流的侦察开始时间算起）。最近一次侦察（被 Master 停止打断的不算）被限流时，自动侦察先等额度恢复：CLI 给了额度重置时间就等到那时再多等 1 分钟，没给就从那次侦察结束时起，按连续被限流的侦察次数等 5、10、20、40 分钟，之后每次 1 小时。到时间后的下一轮检查就会侦察。这个等待和退避、`interval_minutes` 同时生效，取最晚的时间，看板上写明「侦察遇到额度用尽或限流，等额度恢复」和预计时间。重置时间从那次侦察的 `scout.rate_limited` 事件里取，所以 Master 重启（自动升级、保活脚本拉起、崩溃）后照样等到重置时间再多等 1 分钟；只取最近那次被限流的侦察的，更早的侦察给过的重置时间不算。在看板上手动触发侦察不受这个等待限制；手动侦察正常结束或失败后，等待就解除了。

### 侦察提什么

侦察只读代码和文档，按仓库 README.md 里的目标找接下来最值得做的事。为了让它推进能力，而不是围着最近的改动一修再修，提示词这样要求：

- **先做差距分析**：提案之前，先按 README.md 的原文列出它写的目标，再对照每个目标，在能力层面列出这个项目还做不到什么，比如能对接哪些工具和服务、能做多大的任务、能不能并行、能服务什么样的用户和需求来源、出了问题能不能自己恢复。结果里的 `gaps` 是必填字段，每一项有：
  - `goal`：缺口挡住的是 README 里的哪个目标，一字不差地照抄 README 里这个目标的原文，同一个目标在每个缺口里写法相同。每个仓库的目标都不一样，所以不是固定的几个值；
  - `gap`：缺什么能力；
  - `evidence`：限制这个能力的代码位置，或 README、文档里的段落，至少一条。

  最重要的缺口在前，找不到缺口时是空列表。缺少 `gaps`，或者某一项少了字段、没有证据，和其他字段一样按「侦察结果不符合约定」算侦察失败。差距分析记在侦察记录里；看板「需求」页的侦察记录下可以展开「差距分析」，按目标分组列出缺口和证据，人能看出侦察判断的方向。分组时只忽略空白（包括全角空格）和末尾的中英文标点，写法只差这些的目标归入同一组，组名用这组第一个缺口的写法；大小写、近义的写法（比如「永动」和「永动机」）不合并。没找到缺口的显示「没有找到能力缺口」；失败的侦察，以及有这一项之前的侦察记录，不显示差距分析。
- **线索的顺序**：
  1. 让系统停转或空耗的问题：卡住、失败、反复返工的 Run，要优先修复的 Master 自动升级失败（因为运行环境失败的不算，见「稳定副本和自动升级」），以及受阻的迭代（见下面的「迭代」）；
  2. 差距分析里最重要的能力缺口：规划成一个迭代，不单独提案；
  3. 明显的缺陷和测试缺口，文档和代码不一致的地方，代码里的 TODO；
  4. 评审通过时给的建议和对最近改动的修饰：不单独提案，由迭代最后的「收尾」子项统一整理（见下面「迭代」的「收尾」）。
- **产出**：结果里除了 `gaps`，还有 `iteration`（新规划的迭代）、`iterationUpdate`（对进行中迭代的计划调整）和 `proposals`（迭代之外的提案，每条用 `lead` 写明属于哪类线索：`problem` 是第 1 类，`gap` 是第 2 类，`defect` 是第 3 类）。按仓库有没有进行中的迭代（等采纳、进行中或受阻的；一个仓库同时最多一个），要求不同：
  - 没有时：主要产出是一个新迭代，围绕差距分析里最重要的缺口一次规划好（见下面的「迭代」）；差距分析里没有值得规划成迭代的缺口时 `iteration` 为 `null`。迭代之外的提案只放第 1 类问题和第 3 类明显的缺陷，最多 `max_proposals` 条，第 1 类优先；迭代的子项不算在 `max_proposals` 里。这时没有能调整的计划，`iterationUpdate` 被丢掉（这是规则，不记事件）。
  - 有时：不规划新迭代，不提迭代之外的能力需求，只做两件事：把第 1 类问题写成提案（最多 `max_proposals` 条），判断迭代的计划要不要调整（见下面「迭代」的「迭代进行中的侦察」）。差距分析照常做，留给下一个迭代。

  Master 按侦察开始时仓库有没有进行中的迭代取结果，侦察写了别的也不会建出来：没有的话只留 `lead` 为 `problem` 或 `defect` 的提案（`gap` 的缺口该规划进迭代，不单独建），再取前 `max_proposals` 条；有的话丢掉 `iteration` 和 `lead` 不是 `problem` 的提案，再取前 `max_proposals` 条。有进行中的迭代时，`iterationUpdate` 不合计划的规则（见「迭代进行中的侦察」）只丢掉这份调整，不算侦察失败：侦察照常记为完成，问题提案照常建出来，事件列表里记一条 `scout.update_dropped`（看板「事件」页标成橙色，点开是「需求」页；数据里有 `scoutId`、`repo` 和 `problems`：调整哪里不合规，用 Master 的语言写成，看板原样显示），不发通知。
- **证据**：补能力的子项不需要有出错的 Run，README 的目标加上限制这个能力的代码位置就是证据。
- **风险**：`low` 只涉及文档、测试、看板展示或不改变行为的重构；`mid` 改变行为，但影响范围清楚；`high` 涉及数据库迁移、合并或回滚等 git 操作、Agent 权限、配置格式、对外发布，或者改动 `.ares1/` 下的文件（仓库自己的开发流程，见「仓库自带的流程模板」）。`auto_accept.max_risk` 按它决定自动采纳哪些。
- **子项多大**：提示词写明这个仓库用的模板能不能拆分大需求（有没有一个 Agent 阶段是 `planning: auto` 或 `llm`；模板找不到时当作不能），以及有 L 子项的迭代会不会被自动采纳（迭代按整体采纳，取子项里最高的风险和最大的大小：`max_risk` 不是 `none`、`max_size` 是 `L` 时，风险在范围内的也会被自动采纳；否则如实写明有一个子项是 L，整个迭代就要等人采纳）。按模板能不能拆分，要求不同：
  - 能拆分时：L 的需求在编码阶段会先拆成几步，在一个 Run 里一步一步做完。一个 Run 这样能做完的，作为一个子项、大小标 L，不拆成几个子项，免得多出几轮评估、评审、合并和升级。
  - 不能拆分时：每个子项整个交给一个 Run 一次做完，大小尽量是 S 或 M；一个 Run 做不完的拆成有先后的几个子项。

  每个子项都能单独合并，合并后系统照常可用，并且确实推进了这个迭代，不是空壳（比如只加了配置项、类型或接口，却没有实际行为）。迭代之外的提案也要能独立完成、独立合并，一个 Run 做完。
- **以前留下的后续步骤**：以前侦察把一个大能力拆成一串 issue 时，在「要做什么」末尾单独一行写「后续步骤：」（英文是 `Next steps:`），列出剩下的几步。侦察看到的已有 issue 里，未关闭的和最近完成的 issue 正文里有「后续步骤」时，那一行下面附上这一节。中英文两种写法都认，可以是标题，也可以是单独一行（加粗或带冒号都行），截到下一个标题或正文末尾，最多 600 字；提案的页脚不算。提示词要求侦察：已完成的 issue 的后续步骤是规划迭代的素材，把剩下的步骤作为一个迭代重新设计，不再提「接着 #X」式的单条提案；还没关闭的 issue 列着的后续步骤要等它合并后才能做，不拿来规划。缺口已经有未关闭的 issue 在做时换一个缺口；只有那个 issue 覆盖面很大、没有拆过、还在等人采纳时，才可以围绕它规划迭代，在相关子项的 why 里注明对应哪条 issue，不算重复。和其他 issue 内容一样，只有受信任的人或 Master 建的 issue 才会列出（见「只信任仓库成员写的内容」）。

### 迭代

一个大能力只拆成一串「接着 #X」的小 issue 时，人看不出一轮做成了什么。迭代把它们放在一起：围绕一个完整的大目标，一次规划好、整批采纳、按依赖开工、做完发总结的一组 issue。这一节说接了 GitHub 的仓库；本地提案池里的对应做法见「不用 GitHub 时」的「本地提案池里的迭代」，看板见「迭代的看板和 API」。

**规划**：仓库没有进行中的迭代时，侦察的主要产出是一个迭代，写在结果的 `iteration` 里：

- 从差距分析里选最重要的一个缺口，一次把整个迭代设计好。
- `title` 一句话说迭代做成什么；`goal` 用用户能感知的话写做完之后用户能做到以前做不到的什么事，`readmeGoal` 一字不差地照抄它推进的 README 目标；`criteria` 是完成标准，一条一条写，最好每条都能演示；`outOfScope` 是有意不做的事，划清范围。
- `children` 是计划：按依赖排好的子项，数量按需要来，不受 `max_proposals` 限制，但最多 8 个；需要更多就缩小目标，剩下的留给下一个迭代。每个子项像一条提案那样写（标题、类别、大小、风险、为什么、证据、要做什么、验收标准），另外写明推进第几条完成标准（`criteria`）和依赖哪几个子项（`dependsOn`）。子项按在计划里的位置从 1 编号，只能依赖排在它前面的，所以计划里不会有环。没有依赖关系的子项会同时开工，所以只写真正的依赖。
- 最后一个子项是「收尾」（`closeout: true`），依赖其余全部子项（直接或经过别的子项都算），用来整理本迭代各 Run 评审通过时留下的建议（见下面的「收尾」）。其余子项都不是收尾；除了收尾，迭代至少还要有一个子项。
- 违反这些规则（依赖了排在后面的子项、引用了不存在的完成标准、超过 8 个子项、有几个收尾、收尾不在最后或没有依赖其余全部子项等），和其他字段不对一样，按「侦察结果不符合约定」算侦察失败。

**写成 issue**：Master 先在数据库里记下迭代，再建迭代 issue，然后按计划顺序给每个子项建一个 issue，最后把任务列表写进迭代 issue，标题和正文里的用户目录都换成 `~`。中途 Master 停了或 GitHub 出错时，下一轮检查接着写完；连迭代 issue 都没建成的，记录删掉，错误记 `github.error`。

- 迭代 issue 带 `ares1:iteration` 和 `ares1:proposal` 标签，正文分四节：
  - **目标**，附上对应的 README 目标；
  - **完成标准**，编了号：侦察给每个子项记下它推进第几条，完成后的总结和看板的迭代页按编号对照；
  - **计划**，按计划顺序的任务列表 `- [ ] #N 标题（依赖 #A、#B）`；
  - **不做**。

  页脚写明共几个子 issue、整体大小和整体风险，以及怎样采纳、怎样不做。
- 子 issue 是普通的需求 issue，带 `ares1:proposal`（迭代已经采纳时另加 `ares1:ready`，自动采纳的再加 `ares1:auto`），正文和侦察的单条提案一样。页脚有一行给人看的「所属迭代：#N · 依赖：#A、#B」（跟着语言），和 Master 认的两个隐藏标记：

  ```
  <!-- ares1:iteration #N -->
  <!-- ares1:depends-on #A #B -->
  ```

  没有依赖时写 `<!-- ares1:depends-on -->`。标签和标记属于协议，中英文相同。Master 只认页脚（`<!-- ares1:footer -->` 之后）里的隐藏标记，不认那一行可见文字：那一行随语言变化，人也可能改；正文是需求本身，人或 Agent 写在正文里的同样的文字也不算标记。页脚不进 Run 的目标。
- 建出了迭代的侦察算找到了需求，自动侦察的退避随之解除。`scout.completed` 事件带着这个迭代（`iteration: { id, auto }`）。

**采纳**：迭代整体采纳，子 issue 不单独采纳。

- 自动采纳：取全部子项里最高的风险和最大的大小，和 `auto_accept` 比较（规则和单条提案的一样，见上面的「自动采纳」）。在范围内，当天的自动采纳条数（`max_per_day`）和自动花费（`daily_budget_usd`）也都没到上限时，建好就采纳：迭代 issue 和全部子 issue 加上 `ares1:ready` 和 `ares1:auto`，事件列表里记一条 `iteration.auto_accepted`。整个迭代在 `max_per_day` 里只算一次。当时不满足的，以及之后放宽了设置才落进范围的，之后每轮检查（工作开关开着时）补上采纳，迭代 issue 上发一条评论说明是按自动采纳的设置整批采纳的。工作开关关着时，已经采纳的子 issue 也要等开关打开后才建 Run。
- 人工采纳：给迭代 issue 加 `ares1:ready`。Master 下一轮检查时把 `ares1:ready` 传给还开着、还没决定的子 issue，记一条 `iteration.accepted`。迭代 issue 本身从不建 Run，采纳后它的标签换成 `ares1:running`。
- 不做：把迭代 issue 关闭为 not planned，并留一句理由，子 issue 随之关成不做（见下面的「人关掉迭代」）。
- 等人采纳的迭代整个算一条等你处理的提案：挡不挡自动侦察按整体的风险和大小判断（见上面的 `scout.max_proposals`），子 issue 不另算；侦察结束时有迭代等人采纳，`scout.completed` 的 `pending` 也多算一条，按「有提案等你决定」通知。

**依赖门**：每轮检查领取带 `ares1:ready` 的 issue 时，先看它页脚的 `<!-- ares1:depends-on … -->`：列出的 issue 都已经以完成（completed）关闭，才为它建 Run。有一个还开着、或者以别的方式关闭，就不建，`ares1:ready` 留着，之后哪一轮依赖都完成了就自动开工；所以前面的子 issue 完成后，下一轮检查就为后面的建 Run。没有依赖关系的子 issue 按「同时执行几个 Run」的规则并行。依赖的 issue 读不出来时，这个子 issue 这一轮不开工，其余照常，错误记 `github.error`。

**跟踪进度**：每轮检查（工作开关关着时也做）Master 看每个没结束的迭代的子 issue：以完成关闭的算完成，在迭代 issue 的任务列表里勾上（`- [x] #N`，只改这一项，人写的其他内容保留）；有 Run 在做的（包括失败后等重做的）算进行中；其余按依赖完成没有，算在等或可以开工。每个子项的状态变化都在事件列表里记一条 `iteration.child_status`。

**完成**：全部子 issue 都以完成关闭后（被替换的不算，见下面），Master 在迭代 issue 上发一条总结评论，然后以完成（completed）关闭它、去掉状态标签，记一条 `iteration.completed`，不通知。总结由 Master 按各 Run 的记录整理，不另外调用 Agent：

- 做成了什么：迭代的目标和完成的全部子 issue；
- 对照完成标准逐条说明：每条完成标准下面列出推进它的子 issue、完成它的 Run，以及这个 Run 最后一轮评审通过时的结论；
- 用了哪些 Run：每个子 issue 的每个 Run（失败的尝试和被替换的子项也在内），带状态和费用；
- 总费用和用时：所有 Run 的费用合计、从采纳到完成的时间，以及其中 Agent 执行的时间。

总结带隐藏标记 `<!-- ares1:iteration-summary -->`，只发一次：发完 Master 停了或 GitHub 出错，下一轮看到已经有这条评论就不再发。总结也存在迭代上，看板的迭代页能看到。

**受阻**：子 issue 用完 `max_run_attempts` 后以失败关闭，或者没完成就被人关掉（关成不做），又没有别的子 issue 替换它时，依赖它的子 issue 开不了工，迭代进入「受阻」（`blocked`），事件列表里记一条 `iteration.blocked`，并通知「迭代受阻」（见「通知」）。不依赖它的子 issue 照常开工。之后：

- 侦察把它当作第 1 类问题，换个做法补一个子 issue 替换它（见下面的「迭代进行中的侦察」）；
- 也可以修好原因后重新打开它、加上 `ares1:ready` 重做；
- 那个子 issue 被重新打开、或者被替换后，迭代回到进行中（`iteration.unblocked`）；之后再受阻会再通知；
- 不想做剩下的，就关掉迭代 issue。

**人关掉迭代**：迭代 issue 在没做完时被人关掉（关成 not planned 或别的方式都算；Master 自己只在全部完成后关它），说明剩下的没人要了。Master 下一轮检查时，对每个还没完成、没失败、没被替换的子 issue：

- 终止它还没结束的 Run，Run 的事件里记 `run.iteration_closed`：不算失败，也不当作人在看板上终止的，issue 不打 `ares1:failed`，侦察也不会把它当成失败；
- 子 issue 还开着的，留一条评论，说明迭代被关了、终止了哪个 Run，并引用人在迭代 issue 上最后一条受信任的评论作为理由（侦察之后读到的就是这个理由），然后去掉状态标签，关成 not planned。

然后迭代标为「已终止」（`cancelled`），记一条 `iteration.cancelled`。迭代 issue 保持人留下的样子。还在等采纳的迭代被关掉也一样，子 issue 一起关成不做。

**迭代进行中的侦察**：仓库有等采纳、进行中或受阻的迭代时，提示词里附上它的摘要（目标、完成标准、各子项的状态、在等哪几步、做过它的 Run 和失败原因、以前的计划调整）。侦察不规划新迭代，不提迭代之外的能力需求，也不单独提明显的缺陷、评审建议和修饰，只做两件事：

- 第 1 类问题（让系统停转或空耗的）照旧写成提案；子项的失败暴露出系统本身的问题时，也为它提一条。
- 根据已经做完的子项和它们的 Run，判断计划要不要调整；不用调整就写 `null`，不为调整而调整。要调整就写在结果的 `iterationUpdate` 里：`note` 是为什么调整，`add` 是要加的子项，写法和规划时一样，接在计划里现有的最大序号后面编号。
  - 受阻时，换个做法重新安排失败或被关掉的那一步：新子项的 `replaces` 写被换掉的子项的序号，新做法要针对失败原因（拆小、先补上缺的能力、换一种做法），在 why 里说明和上次的不同。
  - 做完的子项暴露出计划漏掉的一步时，补上它，`replaces` 写 `null`。
  - 新子项只能依赖排在它前面、不是收尾的子项；只能替换失败或被关掉、还没被替换过的子项，不能替换收尾子项；加上新子项、去掉被换掉的之后，计划里最多 8 个子项。不合这些规则的，Master 丢掉整份调整，计划不变，事件列表里记一条 `scout.update_dropped` 写明原因；侦察不算失败，它提的问题照常建出来（见上面「侦察」的「产出」）。

Master 收到调整后：

- 记下新子项。被替换的子项标上被哪一步替换，不再计入进度，也不再挡着迭代；依赖它的子项改为等替换它的那一步；收尾子项还没开工时，也等新加的子项做完。侦察运行期间计划变了（比如要替换的那一步已经被重新打开，或者计划已经满 8 个），对不上的子项不加。侦察结束时迭代已经结束了的，调整不生效。事件列表里记一条 `iteration.adjusted`。
- 在 GitHub 上给新子项建 issue（迭代已采纳时直接带 `ares1:ready`），依赖变了的子 issue 改写页脚的依赖标记和那一行文字，迭代 issue 的任务列表补上新的子 issue、被替换的标上「已被 #N 替换」（人写的其他内容保留）；然后在迭代 issue 上发一条「计划调整」评论，写明理由、补了哪几步、替换了哪一步，以及没能加上的和原因。GitHub 中途出错时，下一轮检查接着写完。
- 替换了让迭代受阻的那一步后，迭代回到进行中，新的子 issue 按依赖开工。

**收尾**：迭代里各个 Run 评审通过时留下的建议，不再单独成 issue，也不再由侦察单独提案，而是在收尾子 issue 第一次建 Run 之前，由 Master 汇总进它的正文：在「要做什么」等需求内容之后、页脚之前加一节「本迭代评审留下的建议」，页脚末尾加上隐藏标记 `<!-- ares1:review-suggestions -->`，所以只加一次，之后重做时不再加。

- 只算迭代里其他子项已完成的 Run（失败的 Run 的代码没进目标分支），每个评审阶段取它最后一轮通过的评审；目标没经过人确认的陌生人 issue 的 Run 不算（评审读过它的目标，建议里可能带着其中的文字）。
- 每条建议带文件名，最多 800 字；最多列 40 条，多出的只计数；一条都没有时写明没有。
- 收尾的编码 Agent 逐条判断：值得做的就做，不值得或已经不适用的在结果里说明理由。
- Run 的目标就是加了建议之后的正文，所以 Master 改的这次正文不会被当成人改了 issue 而重来（见「Run 期间改了 issue」）。

迭代的事件都是全局事件，数据里都有 `repo`、`iterationId` 和迭代 issue 的编号 `issue`（本地提案池的迭代没有 `issue`，另有 `backlog: true`）：

- `iteration.auto_accepted`、`iteration.accepted`：整批自动采纳、人工采纳；
- `iteration.child_status`：一个子项的状态变了，另有 `position`（计划里的序号）、`child`（子 issue）或 `proposalId`（本地提案）、`status` 和之前的 `previous`（`planned` 等采纳、`waiting` 在等依赖、`ready` 可以开工、`running` 有 Run 在做、`done`、`failed`、`dropped`）；
- `iteration.blocked`：另有让它受阻的那一步 `position`、`child` 或 `proposalId`，和原因 `reason`（`failed` 是用完重做次数后失败，本地提案池里还包括 Run 被人终止、需求评估结论为不做；`dropped` 是被人关掉）；`iteration.unblocked`：不再受阻；
- `iteration.adjusted`：另有 `scoutId`，新加的子项序号 `added`，替换关系 `replaced`（`[{ position, by }]`：第 `position` 步被第 `by` 步替换），没能加上的条数 `leftOut`；
- `iteration.completed`：另有所有 Run 的费用合计 `costUsd` 和 Run 数 `runs`；
- `iteration.cancelled`：另有随之不做的步骤序号 `dropped`，`pending`（还在等采纳时被关掉或拒绝），本地提案池里拒绝时还有理由 `reason`。

Run 自己的事件里，`run.iteration_closed`（`{ repo, issue, iteration }`：子 issue 和迭代 issue 的编号）表示 Run 因为迭代 issue 被人关掉而终止，`run.iteration_cancelled`（`{ repo, iterationId }`）表示本地提案池的迭代被人在看板上终止。看板「事件」页把这些事件按看板的语言显示成文字，带去迭代页的链接，`iteration.blocked` 标成橙色。

### 拉取 GitHub 上的新提交

`push: true` 的仓库，人和 Ares.1 可以一起往同一个目标分支提交。Master 每轮检查（每 `poll_minutes` 分钟一次，工作开关关着时也做）先从 GitHub 拉取目标分支，再做这一轮的其他事，所以这一轮领取的 issue 建出的 Run 以 GitHub 上的最新代码为基础。拉取和推送一样用 gh 的登录作 git 的凭据（`git fetch https://github.com/<仓库>.git refs/heads/<目标分支>`），只把提交取到本地仓库，不动任何分支；本地仓库的 `origin` 就是这个 GitHub 仓库时，顺带把 `origin/<目标分支>` 更新到 GitHub 上的提交，`git status` 能看出两边的差别。`push: false` 的仓库不拉取：那时 GitHub 仓库可能只用来放 issue，代码不在上面。

拉取后按 GitHub 上的提交和本地目标分支的关系处理：

- 两边一样，或者本地领先（有合并了、还没推送的提交）：什么都不改，照常推送。
- GitHub 上还没有这个分支（新建的空仓库，或者分支被人删了）：按本地领先处理，不记 `github.error`、不通知，同一轮随后的推送在 GitHub 上建出这个分支（记 `github.pushed`）。拉取失败后 Master 再用 `git ls-remote --heads` 问一次 GitHub 有没有这个分支，问得到、回答没有才算这种情况；不看 git 的报错文字，它可能随系统语言变化。
- 本地落后（本地目标分支是 GitHub 上那个提交的祖先）：把本地目标分支快进过去，事件列表里记一条 `github.pulled`（数据里有 `repo`、`branch`，快进前的提交 `from` 和快进后的 `to`），不通知。目标分支没在任何工作目录里检出时直接移动分支（比较并交换：分支在这期间被移动过就不动它，按一次普通的出错记录，下一轮再试）；检出在干净的工作目录里时在那里 `git merge --ff-only`，工作目录里的文件跟着更新。GitHub 上已经有这些提交，不会再推送一次。已经在执行的 Run 不受影响，它们合并时照常先合并目标分支的最新代码，有冲突走「合并冲突」的流程。
- 本地落后，但目标分支检出在有未提交改动（只看已跟踪的文件）的工作目录里：不快进，事件列表里记一条 `github.pull_blocked`（数据里有 `repo`、`branch`、原因 `reason`（目前只有 `dirty`）、检出它的工作目录 `worktree`，以及 `git status --porcelain` 列出的改动 `status`），并通知「没能拉取 GitHub 上的新提交」。同一种原因在连续受阻的几轮里只记一次、只通知一次；快进成功、或者有一轮不再受阻后重新开始。提交或丢弃这些改动后，下一轮检查自动拉取。这期间也不推送：GitHub 上已经有本地的提交，推送只会因为不能快进被拒绝。
- 两边分叉（各有对方没有的提交，比如有人在 GitHub 上直接提交，同时 Master 合并了 Run）：Master 先自己把 GitHub 上的提交合并进来，详见下面的「分叉时自动合并」。合并成功时本地目标分支快进到合并提交，同一轮随后推送到 GitHub。合并有冲突或者合并后检查没通过时，本地目标分支不变、不推送，Master 建一个合并 GitHub 上那个提交的 Run（这个仓库已经有还没结束的合并 Run 时交给它，不另建），由编码 Agent 解决，评审并合并后下一轮推送，见下面的「交给 Run 合并」；建不了 Run，或者这个 Run 被终止、失败了，才等你手动合并。

#### 分叉时自动合并

1. 在系统临时目录里建一个临时工作目录（`ares1-merge-*`，detached HEAD，不建分支），以本地目标分支的提交为起点，`git merge --no-ff` 合并拉取到的 GitHub 提交。合并提交的两个父提交依次是原来的本地提交和 GitHub 上的提交，提交信息按 Master 的语言写「合并 GitHub 上 <目标分支> 的新提交」（英文 `Merge new commits from <branch> on GitHub`），和 Master 发到 GitHub 的其他文字一样把用户主目录换成 `~`。
2. 没有冲突时，在临时工作目录里依次运行仓库登记的准备命令和检查命令，和 Run 的检查一样：环境不带 GitHub 和 GitLab 凭据（同 Agent），每条命令的超时是 `defaults.command_timeout_minutes`，有一条失败就停。输出写在数据目录的 `data/logs/github-merge-<仓库名>.log`，每次合并重新写。没有登记任何命令时直接算通过。
3. 检查全部通过后，再看一次有没有 Run 开始合并这个仓库：有就这一轮不动，下一轮直接用这个已经检查过的合并提交，不再跑一遍检查。没有就像「本地落后」一样把本地目标分支快进到合并提交（比较并交换；检出在有未提交改动的工作目录里时记 `github.pull_blocked`，改动清掉后下一轮接着快进，同样不重跑检查），事件列表里记一条 `github.merged_remote`（数据里有 `repo`、`branch`，两边的提交 `local`、`remote` 和合并提交 `merge`），不通知。同一轮随后照常推送，记 `github.pushed`；之后已完成 Run 的 issue 照常关闭。
4. 不管结果如何，临时工作目录都会删掉；合并提交本身留在仓库里，供快进用。Master 在检查途中被强行结束、没来得及删的，下次启动时删掉（登记的仓库里、系统临时目录下名字以 `ares1-merge-` 开头的工作目录）。

没能自动合并时，本地目标分支不变，事件列表里记一条 `github.diverged`（数据里有 `repo`、`branch`，两边的提交 `local`、`remote`；交给 Run 处理时还有这个 Run 的 `runId`），并通知一次「没能拉取 GitHub 上的新提交」，正文写明原因：

- 合并有冲突：中止合并，不运行任何命令，数据里有 `conflict: true` 和有冲突的文件 `files`。交给一个 Run 合并（见下面的「交给 Run 合并」），通知说已交给这个 Run 处理；建不了 Run 时通知要你手动合并。
- 合并后有命令没通过：数据里有 `failed`（命令 `command`、种类 `kind`（`setup` 准备命令或 `verify` 检查命令）、退出码 `exitCode`、是否超时 `timedOut`、输出末尾 `output`）和日志路径 `log`。和冲突一样交给 Run；建不了 Run 时通知要你手动处理后合并。
- 有条命令要启动的程序在运行环境里找不到（比如没有 `npm`，和 Run 的「运行环境缺少命令」一样判断，能事先看出来的在合并前就判断，不建临时工作目录）：数据里的 `failed` 有命令、种类和找不到的程序 `missing`。这不怪代码，所以不建 Run，这一对提交之后每轮都再试；同一对只记一次。通知说装好后下一轮会自动再合并。
- Master 运行的 node 不见了（见「换 Node 版本时」）：这一轮不合并，也不记录，等 node 回来后下一轮再试。Master 停止时正在运行的命令会被中止，下次启动后再试。

冲突和命令失败的那一对提交（本地和 GitHub 上各自的提交）不再重试，免得每轮都跑一遍检查命令。分叉期间不推送（推送每轮都会被拒绝），所以也不会每轮报推送失败。分叉期间本地或 GitHub 上又有了新提交（比如又有 Run 合并了），就是新的一对，重新尝试合并；还是失败就再记一条 `github.diverged`。同一次分叉里，下面每种情况只通知一次，之后同样的记录带 `repeated: true`，不再通知：交给同一个 Run（交给另一个 Run 时再通知一次）；要你手动合并；找不到程序（之前已经交给 Run 或要你手动合并时，找不到程序不再通知）。分叉消失后（自动合并成功、合并 Run 合并了，或你手动合并了），下一轮照常推送；之后再分叉会重新记录、重新通知。

- 分叉期间完成的 Run，代码合并进了本地目标分支，但还没推到 GitHub 上，所以它的 issue 保持打开，标签不变。分叉消失后，下一轮检查推送上去，issue 随之关闭，评论里写明已推送到 GitHub。
- 手动合并的做法：在登记的仓库里 `git fetch`，再 `git merge origin/<目标分支>`，解决冲突后提交。推送可以自己做，也可以留给 Master 下一轮做。

有 Run 正在执行合并阶段时，这个仓库这一轮不拉取，也不自动合并，免得和合并抢目标分支；等审批合并的 Run 不算。拉取失败（网络不通、gh 没登录、没有权限等；GitHub 上没有这个分支不算，见上面）和其他访问 GitHub 的失败一样记 `github.error`，按「一串连续失败」去重（见「通知」），这一轮的其他步骤照常进行；git 连合并都开始不了（不是冲突）时也这样记，下一轮再试。自动合并要跑检查命令时，这一轮后面的步骤（领取 issue、同步 issue 等）等它跑完再做，每对提交最多跑一次。分叉和受阻的状态只记在 Master 的内存里：Master 重启后第一轮重新判断，还在分叉时会再尝试一次自动合并，失败会再记一条、再通知一次。交给哪个 Run 不靠内存，而是按仓库里还没结束的合并 Run 和 Run 上记的提交查（见下面），所以重启后不会另建 Run。

#### 交给 Run 合并

Master 自己合并有冲突或者合并后检查没通过时，建一个 Run，让编码 Agent 把 GitHub 上的那个提交合并进来：

- **建什么样的 Run**：模板用这个仓库在 `github.repos.<name>.template` 里配的（和它的 issue 的 Run 一样，数据目录的优先，没有就用仓库自带的），遵守 `auto_merge`（打开时合并不等审批），不关联 issue。Run 上记着要合并的提交 `mergeRemote`（`GET /api/runs/:id` 返回的 `run` 和 Run 的 `run.created` 事件里都有；只有 Master 自己会设它）。目标按 Master 的语言写，写得完整，需求评估不用再问：合并 GitHub 上 <目标分支> 的提交 <短 hash>，两边的完整提交，冲突时两边的改动都要保留、删掉所有冲突标记，合并后仓库的检查命令要能通过，只做这次合并需要的改动；最后附上 Master 自己合并时遇到的情况：冲突的文件，或者没通过的命令、退出码或超时、日志路径和输出的最后部分（最多 2000 字）。
- **编码阶段怎么合并**：第一个会改代码的 Agent 阶段（通常是编码；需求评估、评审和拆分计划不算）的 Task 启动 Agent 之前，Master 在 Run 的工作目录里执行 `git merge --no-ff --no-commit <这个提交>`，把冲突标记留在文件里，Run 的事件里记 `merge.started`（`source` 为 `remote`，`targetHead` 是这个提交）。之后和「合并冲突」一样：提示词说明有一个未完成的合并、列出冲突的文件，要求两边的改动都保留；Agent 完成后先检查冲突文件里还有没有冲突标记，有就带着文件名返工；再运行检查命令，通过后由 Master 提交，这个 Task 的提交就是以这个 GitHub 提交为父提交之一的合并提交。没有冲突、只是合并后检查没通过时也这样合并，Agent 修好检查就行。阶段拆成几步时只有第一步合并；之后的步骤、返工、后面的阶段和轮次看到这个提交已经在 HEAD 里，就不再合并。合并进来的 GitHub 提交算这个 Run 的改动，评审时一起看。中途暂停、Master 重启或 Task 最终失败时，工作目录回到合并之前，下次执行重新合并。这个提交在仓库里找不到（比如被垃圾回收了）时，Run 直接结束、标为失败，`error` 写明原因。
- **合并之后**：Run 照常评审，经合并阶段合并进本地目标分支，本地目标分支就包含了 GitHub 上的那个提交。下一轮检查看到本地领先，不再记 `github.diverged`，照常推送（`github.pushed`），分叉期间完成的 Run 的 issue 随之关闭。
- **一个仓库同时只有一个合并 Run**：这个仓库已经有一个还没结束（排队、执行中、等审批、卡住、暂停）的合并 Run 时，不管它是为 GitHub 上哪个提交建的，之后没能自动合并的分叉都交给它，不另建：再记的 `github.diverged` 都带着它的 `runId`，同一个 Run 只通知一次。分叉期间本地又有了新提交（比如别的 Run 合并了），或者 GitHub 上又推了新提交、Master 自己还是合并不了，都是这样。这个 Run 只合并它建的时候记下的那个提交；它合并后本地目标分支变了，下一轮按新的一对提交重新处理：先由 Master 自己合并，还是不行才为 GitHub 上的新提交另建一个 Run。这样不会有两个 Agent 同时合并 GitHub 上的提交、后合并的那个又遇到冲突。查的是 Run 上记的 `mergeRemote`，存在数据库里，Master 重启后照样有效。本地目标分支已经包含其提交的合并 Run 不算在内：它没什么要合并的了，接着执行时直接完成（见下面「目标分支已经有这个提交时」）；这时为新的提交另建 Run，免得它在等审批或卡住时把新的分叉也拖住。
- **一个提交只建一个 Run**：为同一个 GitHub 提交建过的 Run 已经结束时，不再为它建 Run（见下一条），Master 重启后也一样。
- **Run 结束而没合并时**：分叉交给的那个 Run 被终止（比如你在看板上终止）或失败后，下一轮记一条不带 `runId` 的 `github.diverged`，通知一次要你手动合并，回到没有这个 Run 时的做法；分叉交给的是为更早的提交建的 Run 时也一样。同一个 GitHub 提交之后不再自动建 Run，Master 重启后也一样；它不来自 issue，失败后也不会自动重做。
- **目标分支已经有这个提交时**：合并 Run 排队、等审批或者正在执行时，Master 自己合并了后来的分叉（`github.merged_remote`），或者别的 Run、人把 GitHub 上的这个提交合进了本地目标分支，这个 Run 就没什么要合并的了。Master 在这些时候看本地目标分支是否已经包含它的 `mergeRemote`：建工作目录之前；每个 Agent 阶段里每个 Task 启动 Agent 之前（需求评估、拆分任务、编码、评审都算，Agent 做完、只剩检查的 Task 也算）；合并阶段开始时（通过 PR 交付时也是，在开 PR 之前）。已经包含时不再启动 Agent，也不合并、不开 PR：没做完的 Task 标为取消，停下时所在的那一轮阶段标为通过并记上结束时间（不另记 `stage.passed`，看板的流程图和用时不会再把它显示成还在执行），Run 以完成状态结束，Run 的事件里记一条 `run.merge_remote_obsolete`（数据里有 GitHub 上的提交 `remote`、目标分支 `target`、目标分支当时的提交 `targetHead`，以及本来要开始的阶段 `stageId`，建工作目录之前为空），不通知；然后删掉它的工作目录和分支（记 `workspace.removed`），里面最多是它自己对同一个提交的合并，已经没用了。Run 自己合并进去的不算：它的合并阶段已经通过，或者它分支上的提交（包含这个 GitHub 提交）已经在目标分支里。但工作目录的起点就已经包含这个提交时（建工作目录之前的检查刚过，Master 就把它合并进了目标分支），这个提交不是 Run 合并的，照样直接完成。这个提交在仓库里找不到时，照旧按上面说的结束为失败。正在跑的 Agent 不会被打断，做完之后下一个 Agent 不再启动。
- **不建 Run 的情况**：缺程序（见上面，装好后 Master 自己再合并）；仓库关了 `push`（这时根本不拉取、不检查分叉）；模板找不到、没有 Agent 阶段，或者建 Run 出错。后两种要你手动合并。
- **事件**：建 Run 时，在同一个事务里记 `github.diverged`（带 `runId`）和 `github.diverged_run`（数据里有 `repo`、`branch`、两边的提交 `local`、`remote` 和 `runId`）。`github.diverged_run` 本身不通知，通知由同时记的 `github.diverged` 发：正文说已交给 Run <id> 处理、编码 Agent 合并两边、评审并合并后自动推送，点开是这个 Run。

### Run 期间改了 issue

Run 的目标是建 Run 时从 issue 读的标题和正文。Run 还没进入合并阶段时你改了 issue 的标题或正文，Master 在下一轮检查时发现内容变了，就自动按新内容重来。你只需要改 issue，不用手动终止再重新加 `ares1:ready`，没人在场时旧 Run 也不会按过时的需求一路合并进去：

- 旧 Run 被终止，事件列表里记一条 `run.goal_changed`（数据里有 `repo`、`issue` 和新 Run 的 id `newRun`）。这不算失败，也不算人终止的：issue 不会打上 `ares1:failed`，也没有「Run 已终止」的评论，标签保持 `ares1:running`。
- 按新内容新建一个 Run，模板和 `auto_merge` 的设置和加 `ares1:ready` 时一样，从头开始（流程里有需求评估的话重新评估）。它沿用旧 Run 是第几次尝试和之前几次失败的原因，不多算一次，不占 `max_run_attempts`。
- issue 上发一条评论，写明内容改了、终止了哪个旧 Run、按新内容开始了哪个 Run，附上看板链接。
- 旧 Run 的工作目录和分支马上自动删掉，Run 的记录、日志和产物都保留。删掉时在旧 Run 上记一条 `workspace.removed`（数据里有路径、分支、`reason: goal_changed` 和 `newRun`）；删不掉时记一条 `workspace.cleanup_failed`（数据里有 `reason`、`newRun` 和 `error`），新 Run 不受影响。删不掉的、或者 Master 还没来得及删就停了的，之后会再补删（见下面的「补删遗留的工作目录」）。
- 只比较标题和正文：正文首尾的空白和侦察提案的页脚不算，改标签、写评论都不会重来。需求评估改写过的目标只记在讨论记录里，不影响比较。
- 暂停的、卡住等人的、等需求评估回复的 Run 也会重来：等回复时改 issue，往往就是在回答问题。

这几种情况不重来，和以前一样：

- Run 已经进入合并阶段：正在合并，或在等合并前的审批。issue 的改动也不会追加到这个 Run 上。在等合并审批时驳回，Run 回到编码等阶段后，下一轮检查就会按新内容重来；也可以终止它，再给 issue 重新加 `ares1:ready`。
- issue 的作者不受信任（见下面的「只信任仓库成员写的内容」）：目标仍然固定在建 Run 的那一刻，由人确认。
- 工作开关关着：不重来，打开后的下一轮检查再处理。

### Run 失败后自动重做

从 issue 来的 Run 失败后（`failed`，比如 Agent 出错且重试、换 Agent 都用完，返工或回退次数用完，超出 Run 预算（默认），准备命令失败，Master 内部错误，合并时 git 因冲突以外的原因失败，合并冲突但没有 Agent 阶段能解决，工作目录与记录不一致；不包括被终止的），Master 不等人，自动再开一个 Run 重做。次数上限是 `github.repos.<name>.max_run_attempts`：

```yaml
github:
  repos:
    my-repo:
      template: self-dev
      max_run_attempts: 3   # 一个 issue 最多跑几次 Run，含第一次；不写也是 3；1 = 不重做
```

- 失败时，issue 上的评论写明失败原因和「第 n/N 次尝试」，标签保持 `ares1:running`。新 Run 的目标仍然从 issue 读（期间改过 issue 就用改过的），之前每次失败的原因和失败的阶段会写进需求评估和编码的提示词，提醒 Agent 避开同样的问题。
- 重做不是马上开始，两次尝试之间先等一会儿：第 n 次失败后等 `poll_minutes × 2^(n-1)` 分钟，最长 2 小时，从失败的 Run 结束时算起（`poll_minutes` 为 5 时依次等 5、10、20 分钟……）。Agent 的 API 宕机、过载或本机断网时，重试和换 Agent 会一起失败（默认的几个 Agent 都是 Claude Code），不等的话几分钟就会用完 `max_run_attempts`、把 issue 关掉；等一会儿，几十分钟以内的故障就不会消耗掉需求。代码本身每次都会失败的需求只是晚一点关闭，尝试次数和花费不变。
  - 失败评论里写明预计什么时候重做：「约 N 分钟后（HH:mm UTC+08:00 左右）开始第 n/N 次尝试」，时间是 Master 所在时区，带上时差，方便别的时区的人看。事件列表里记一条 `issue.redo_scheduled`（数据里有 `repo`、`issue`、下一次的 `attempt`、`maxAttempts` 和 `redoAt`）。Run 详情页写明「预计 HH:mm 自动重做，开始第 n 次尝试」，API（`GET /api/runs/:id`）的 `redoAt` 字段给出这个时间（ISO），不在等重做时为 `null`。
  - 时间只从 Run 的记录算，不另外保存，Master 重启后照样成立，到时间时已经过了的会在下一轮检查时重做。Master 在最早到期的时间自己同步一次，不用等下一轮检查。等待不算用掉一次，多个 issue 各等各的，互不阻挡。
- 自动重做的 Run 计入当天的自动花费（`daily_budget_usd`）。花费已达上限时先不重做，issue 上会说明，第二天预算恢复后再做；等待不算用掉一次。工作开关关着时也不重做，打开后再做。这两种等待和上面的等待同时生效，取较晚的时间。
- 用完 `max_run_attempts` 次后不再重做：评论列出每次失败的原因，issue 打上 `ares1:failed`，关闭为 not planned。这不等于不要这个需求：侦察读到这类 issue 时知道它不是人拒绝的，可以换个思路重新提案。要按原样再做，重新打开 issue 并加上 `ares1:ready`。工作目录和分支只保留最后一次尝试的，更早几次的自动删掉（见下面）。
- 人加 `ares1:ready` 开始的 Run 是第 1 次；之后重新加 `ares1:ready`，次数从头算。等待重做期间关闭 issue，到时间后就不再重做（事件列表里记一条 `issue.redo_abandoned`），issue 保持你留下的样子。
- 被终止的 Run（人在看板上终止，或者关闭了 issue）不重做，issue 打上 `ares1:failed`，等你决定。
- 重做成功合并后（同一 issue 的 Run 完成时），这个 issue 之前失败的 Run 的工作目录和分支会自动删掉：失败原因已经记在 Run 的 `error` 和 issue 评论里，代码以完成的那次为准，留着只会占磁盘（每个工作目录都带着准备命令装的依赖）。Run 的记录、日志和产物都保留。每删掉一个，就在那个 Run 的事件列表里记一条 `workspace.removed`，数据里有路径、分支、`reason: superseded` 和完成的 Run 的 id（`supersededBy`）。删不掉时（比如分支在别处检出）在那个 Run 上记一条 `workspace.cleanup_failed`（数据里有 `reason`、`supersededBy` 和 `error`），接着删下一个，完成的 Run 不受影响，删不掉的之后再补删（见下面的「补删遗留的工作目录」）。
- issue 用完 `max_run_attempts` 被关闭后，只保留最后一次失败的 Run 的工作目录和分支，留给人看现场；更早几次失败的 Run 的工作目录和分支自动删掉：最后一次已经带上了前几次的失败原因，前几次的原因也记在各自 Run 的 `error` 和 issue 评论里。这样每个失败关闭的 issue 只占一份磁盘。Run 的记录、日志和产物都保留。每删掉一个，就在那个 Run 的事件列表里记一条 `workspace.removed`，数据里有路径、分支、`reason: retries_exhausted` 和保留的最后一次 Run 的 id（`keptRun`）。删不掉时在那个 Run 上记一条 `workspace.cleanup_failed`（数据里有 `reason`、`keptRun` 和 `error`），接着删下一个，issue 的关闭和评论不受影响、不会重复，删不掉的之后再补删（见下面的「补删遗留的工作目录」）。
- 被终止的 Run（因为 issue 改过而自动终止的除外，见上面的「Run 期间改了 issue」）、不是从 issue 来的 Run 和最终失败关闭的 issue 最后一次尝试的 Run 仍然保留，要在看板上手动清理（「工作区」页或 Run 详情页）。

### 补删遗留的工作目录

上面三处自动删除（重做成功后删之前失败的尝试，重做次数用完后只留最后一次，issue 改过后删旧 Run 的）都只在那一刻做一次。Master 在那之前崩溃、被升级重启或正在关闭，或者那次 git 删除失败，工作目录和分支就会留下来；没人照看时它们会越积越多（每个都带着依赖），所以 Master 会再补删：

- 时机：Master 启动、恢复完上次没做完的 Run 之后补删一次，之后每天和原始日志的清理（见上面的「原始日志的保留期」）一起补删一次。补删不和合并排队（见「同时执行几个 Run」），有 Run 正在执行或合并时照样进行，只动下面这些失败或终止的 Run 自己的工作目录和分支。Master 关闭时做完手上这一个就停，剩下的下次再补。
- 补删哪些：工作目录或分支还在，而且满足下面任一条的 Run，删除原因和当时那次一样：
  - 失败的 Run，同一 issue 之后有 Run 完成了：`reason: superseded`，`supersededBy` 是它之后第一个完成的 Run。
  - 失败的 Run，同一 issue 最新的 Run 也失败了，并且次数已经用完（`issue.redo` 为 `exhausted`，或者记过 `issue.retries_exhausted`）：除最新的这个外都删，`reason: retries_exhausted`，`keptRun` 是最新的这个。
  - 失败的 Run，出现在另一个 Run 的 `issue.retries_exhausted` 的 `runIds` 里（不是记这条事件的 Run 自己）：`reason: retries_exhausted`，`keptRun` 是记这条事件的 Run。issue 用完次数后被人重新加 `ares1:ready`、新的 Run 还在做时，也照样删掉这些更早的尝试。
  - 因为 issue 改过而被终止的 Run（记过 `run.goal_changed`）：`reason: goal_changed`，`newRun` 取那条事件里的。
- 不碰：人在看板上终止的 Run、关闭 issue 终止的 Run、还没结束的 Run（排队、执行中、等审批、卡住、暂停）、失败后还要重做的 Run、每个 issue 最后一次失败的 Run，以及不是从 issue 来的 Run。
- 记录：删掉时照旧在那个 Run 上记一条 `workspace.removed`（数据和当时那次一样：路径、分支、`reason` 和对应的 Run id）。已经记过 `workspace.cleanup_failed` 的 Run 照样再试，还是删不掉就再记一条 `workspace.cleanup_failed`，接着删下一个，不影响 Master。已经删掉或者本来就不在的不再处理，所以重复补删不会重复记事件。补删整体出错（比如读数据库失败）只在 Master 的输出里打一行警告，下一轮再试。

### 只信任仓库成员写的内容

公开仓库里任何人都能发 issue、写评论，而编码 Agent 会在运行 Master 的机器上执行命令，所以从 GitHub 读进 Agent 提示词的内容只认这些人写的：

- GitHub 的 `authorAssociation` 为 `OWNER`、`MEMBER`、`COLLABORATOR` 的人，也就是仓库所有者、所属组织的成员和协作者；
- Master 自己用的账号：`github.account`，没配时是 gh 当前登录的账号（启动后第一次需要时查一次）。

其余的人一律不信任，包括提过 PR 的 `CONTRIBUTOR`、`FIRST_TIME_CONTRIBUTOR` 和 `NONE`。Master 自己的评论仍然靠隐藏标记识别，但只认受信任的人写的：别人照抄标记也不算 Master 的。具体是：

- **需求评估的回复**：只把受信任的人的评论当作回复。陌生人的评论不交给 Agent，只在看板的讨论记录里记下「issue 上有 N 条非仓库成员的评论，没有当作回复」。只有陌生人回复时，就当作还没人回复，照常等待或按 `reply_timeout_hours` 超时。
- **侦察**：提示词里列出未关闭的 issue（最多 100 条）和最近关闭的 30 条（未关闭的和完成的只列标题，正文里写着「后续步骤」时再附上这一节，见上面的「侦察提什么」）；在这 30 条之外，更早被关闭为不做（not planned）的 issue 也连同理由列在单独一节「更早被关闭为不做的」里（最多 300 条），不管多早被拒绝的需求，侦察都看得到理由，不会换个说法再提。这份列表靠 GitHub 的搜索接口取得，它有单独的限流和索引延迟；搜索失败时侦察不会因此失败，只用最近关闭的 30 条继续（最近的「不做」issue 本来就在里面），提示词里写明更早被关闭为不做的 issue 这次没能取到、提案要多加小心，Master 记一条 `github.error` 事件，写明搜索失败的原因（看板「事件」页能看到）。这条 `github.error` 只在侦察继续进行时记录，和其他 `github.error` 一样按「一串连续失败」去重（见「通知」）。取未关闭和最近关闭 issue 的请求失败时，侦察照旧失败；这时即使搜索也失败了，也只按侦察失败处理（偶尔失败一次只退避，连续失败 3 次才通知），不另记搜索失败。这些都只列受信任的人或 Master 建的 issue；「不做」的理由只取受信任的人写的最后一条评论，没有就不写理由；「多次失败后关闭」也只认受信任的人写的标记。陌生人建的 issue 完全不出现，代价是侦察可能提出和它重复的提案，你在采纳时能发现。最近的 Run 里，来自陌生人 issue、还没人确认过的 Run 只列 issue 编号，不列内容；被终止的 Run 多一行「终止」，写明原因：issue 被人关闭（已完成，或关闭为不做）、issue 改过后已按新内容重开（写出新 Run），还是人在看板上终止，或者所属的迭代被人关掉，侦察据此分清是需求被拒、已经由别的途径做完，还是人改了方向。评审未通过的轮次列出必须修改的问题（每轮最多 5 条），建议只计数；评审通过的轮次有建议时，列出评审通过时给的建议（每轮最多 3 条，带文件名，多出的只计数）。这些建议是评审有意留到以后的改进，侦察不为它们单独提案，由迭代的收尾子项统一整理（见「迭代」的「收尾」，那里同样不收陌生人 issue 的 Run 的建议）。陌生人 issue、还没人确认过的 Run 不列建议：评审读过它的目标，建议里可能带着其中的文字。
- **从 issue 建 Run**：只有有 triage 及以上权限的人能加 `ares1:ready`，所以标签可信，但 issue 可能是陌生人写的，加标签之后也还能改。这时 Master 照常建 Run，目标是建 Run 那一刻 issue 的内容，之后再改 issue 不影响它；Run 一建好就停在「issue 作者不是仓库成员，等你确认需求」，在 issue 上说明原因，打上 `ares1:needs-you`。在这之前没有任何 Agent（包括只读的需求评估）读到它。你在 Run 详情页读过目标后点「确认并开始」，Run 才从头开始，之后照常按模板和 `auto_merge` 的设置走；这一步不管怎么设置都要人来做。不想做就终止 Run 或关闭 issue。Run 页上一直标着 issue 作者和确认的时间。
- **自动重做**：重做时目标从 issue 重新读。作者不受信任时，内容和上次确认过的一样就直接重做，改过就要重新确认。

### Agent 拿不到 GitHub 和 GitLab 凭据

只把陌生人写的内容挡在提示词外面还不够：Agent 能执行命令，要是继承了本机 gh 的登录，它自己跑一下 `gh issue view 12 --comments`，陌生人的评论就又进来了；它还能以本机登录的所有 GitHub 账号读写这些账号能访问的所有仓库。本机装了 glab 或设置了 GitLab token 时，GitLab 上也是一样。Master 读 issue、发评论、推送都是自己做的，Agent 用不着这些托管平台的凭据，所以 Agent（编码、评审、需求评估、侦察）和准备命令、检查命令（包括命令阶段的命令，以及分叉时 Master 自动合并后运行的命令）都在去掉了 GitHub 和 GitLab 凭据的环境里运行：

- 去掉 `GH_TOKEN`、`GITHUB_TOKEN`、`GH_ENTERPRISE_TOKEN`、`GITHUB_ENTERPRISE_TOKEN`，再把 `GH_TOKEN` 设成一个无效的值 `ares1-agent-no-github-access`。gh 优先用 `GH_TOKEN`，GitHub 会拒绝它，gh 也就不会退回去用存在配置文件或 macOS 钥匙串里的登录。
- `GH_CONFIG_DIR` 指向数据目录下的空目录 `data/agent-gh-config/`，gh 在里面是未登录状态。每次启动 Agent、运行命令之前都会把它清空，Agent 往里面写的东西留不到下一次。
- 去掉 `GITLAB_TOKEN`、`GITLAB_ACCESS_TOKEN`、`OAUTH_TOKEN`、`GLAB_TOKEN`、`CI_JOB_TOKEN`、`GITLAB_PRIVATE_TOKEN`、`GITLAB_OAUTH_TOKEN`（glab 和 python-gitlab 等工具从这些变量读 token），再把 `GITLAB_TOKEN` 设成一个无效的值 `ares1-agent-no-gitlab-access`。glab 优先用 `GITLAB_TOKEN`，GitLab 会拒绝它，glab 也就不会退回去用存在 `~/.config/glab-cli` 里的登录。`GITLAB_HOST` 这类只说明连哪个 GitLab 的变量不是凭据，照常保留。
- git 的凭据助手（钥匙串、gh 等）全部清掉，去掉 `GIT_ASKPASS`、`SSH_ASKPASS`，并设置 `GIT_TERMINAL_PROMPT=0`：通过 https 访问需要登录的仓库（GitHub、GitLab 都一样）会直接失败，不会弹出要密码的提示。
- 其他环境变量原样保留，包括 `PATH`、`HOME`，以及 Claude Code、cursor-agent 和 Codex CLI 自己的登录信息（比如 `CODEX_HOME`、`OPENAI_API_KEY`）。
- 给 Agent 的提示词也写明：需求、讨论和 issue 的内容都已经在提示词里，不要自己去 GitHub 读。

副作用：准备命令和检查命令里需要 GitHub 或 GitLab 凭据的操作会失败，比如通过 https 安装 GitHub、GitLab 上的私有依赖，在测试里调用需要登录的 GitHub 或 GitLab API。

剩下的边界：Agent 和 Master 以同一个系统用户运行，用户目录里的东西 Agent 仍然读得到、用得上，包括 SSH 密钥（可以用 SSH 推送）、gh 和 glab 自己的配置目录、钥匙串（可以直接调用 `security` 命令读出 gh 存的 token）和其他文件。上面这些做法只能防止 Agent 无意中用到这些权限，挡不住它有意为之。被构建的是公开仓库、或者需求不完全受信时，建议让 Master 以单独的系统用户运行（这个用户只有这个项目需要的权限，比如单个仓库的 deploy key 或权限最小的 token），或者放在单独的机器上跑。

### 发到 GitHub 的文字不带用户目录

错误输出和 Agent 写的总结常带着本机的绝对路径，比如 `/Users/<用户名>/.ares1/worktrees/run-…`，发到公开仓库就会把系统用户名和目录结构公开出去。所以 Master 发到 GitHub 的文字（issue 评论、侦察提案 issue 的标题和正文、Master 提交的提交信息）里，以用户目录开头的路径都换成 `~`，比如 `~/.ares1/worktrees/run-…`；不在用户目录下的路径保持原样。看板和本地日志照旧显示完整路径，方便排查。提交信息是提交时就替换好的，所以看板上看到的提交信息也是 `~`。

## 不用 GitHub 时

不是每个仓库都能接 GitHub：只在本机的仓库、没有 GitHub 账号的环境，以及托管在 GitLab 或内网的项目，都没有 GitHub issue 可用。这些仓库写在 `config.yaml` 的 `backlog.repos` 里，需求来自 Master 自己保存的本地提案池：AI 侦察的提案存在 Master 的数据库里，在自动采纳范围内的直接建成 Run，其余的等人在看板上采纳，或者填上理由拒绝。整个过程不调用 GitHub，也不需要装 gh，仓库照样能自己侦察、自己采纳、自己建 Run，一直转下去。

### 配置

```yaml
backlog:
  poll_minutes: 5              # 多久检查一次本地提案池，默认 5，可以写小数
  repos:
    my-local-repo:             # 看板「仓库」页登记的仓库名
      template: self-dev       # 采纳的提案建 Run 用的模板
      scout:                   # 不写 = 不侦察，这个仓库就没有提案、不会有 Run
        agent: claude-reviewer # 以只读方式运行，要用支持只读的 CLI（claude-code、codex）的 Agent
        auto: true             # 默认 true：仓库没有会自己往下走的 Run 时自动侦察；false = 只在看板上手动触发
        interval_minutes: 120  # 两次自动侦察至少间隔几分钟，默认 0（不限）
        max_proposals: 3       # 一次最多提几条，默认 5（1 到 20）
      auto_accept:
        max_risk: low          # 自动采纳到哪个风险等级：none（默认，都由人采纳）/ low / mid / high
        max_size: M            # 自动采纳到哪个大小：S / M / L（默认）
        max_per_day: 5         # 每天最多自动采纳几条；不写 = 不限
      auto_merge: false        # true = 采纳的提案建出的 Run 合并前不等人审批（模板里其他阶段的审批照旧）；默认 false
      daily_budget_usd: 10     # 当天侦察、自动采纳的 Run 和自动重做的 Run 一共花到这么多（美元）后停止这些自动行为，第二天恢复；不写 = 不限
      max_run_attempts: 3      # 一条提案最多跑几次 Run（含第一次），失败后自动重做；不写也是 3；1 = 不重做
```

- `repos` 的键是看板「仓库」页登记的仓库名，必须和那里的一模一样。写在这里但没登记的仓库什么都不做，看板上写明「没有在看板上登记」。
- `template`、`scout`、`auto_accept`、`auto_merge`、`daily_budget_usd`、`max_run_attempts` 的含义、默认值和校验都和 `github.repos` 里的同名字段一样（两边用同一份格式定义），模板也一样先在数据目录的 `workflows/` 里找，再在仓库自带的 `.ares1/workflows/` 里找（见「仓库自带的流程模板」）。`max_run_attempts` 在这里管的是一条提案最多跑几次 Run，见下面的「本地提案失败后自动重做」。`issues_repo`、`push`、`deliver` 是 GitHub 才有的，写在这里和写错的键一样，`config.yaml` 校验不通过。
- 一个仓库只能选一种需求来源：同一个仓库名同时写在 `github.repos` 和 `backlog.repos` 里是配置错误，看板「配置」页在 `config.yaml#backlog.repos.<仓库名>` 下写明原因。这时 `backlog.repos` 里的设置不生效，GitHub 一侧照常工作，手动侦察也按 GitHub 侦察。
- 某个仓库配置有误（比如模板不存在、侦察用的 Agent 不存在或没启用）时只停用这个仓库，看板「配置」页同样在 `config.yaml#backlog.repos.<仓库名>` 下写明原因，别的仓库照常工作。
- 和 `github` 一样，改了保存后自动生效，不用重启。不写 `backlog` 就不用本地提案池。
- 合并只合进本地的目标分支，Master 不推送；要推送到 GitLab 或内网的服务器，自己 `git push`。

[`docs/examples/config.yaml`](examples/config.yaml) 里也有一个用本地提案池的仓库（`my-intranet-tool`）。

### 侦察怎么调度

本地提案池有自己的定时器，不管配没配 `github` 都会转：Master 启动约 2 秒后检查一次，之后每 `backlog.poll_minutes` 分钟一次；打开工作开关时马上检查一次。每一轮先重新读各仓库自带的模板（目标分支动了的话），再逐个仓库：

1. 配置有误或没在看板上登记的仓库跳过，原因记下来显示在看板上。
2. 记下提案（包括迭代的子项）的 Run 失败（还有次数就等着重做，用完了就把提案标为失败）；工作开关开着时，重做等待时间已到的（见下面的「本地提案失败后自动重做」）。
3. 跟踪这个仓库的迭代（见下面的「本地提案池里的迭代」）：按子项的 Run 更新每一步的状态，全部完成的写总结；工作开关开着时，为依赖都完成了的子项建 Run。
4. 工作开关关着时其余的都不自动做，看板上写明「工作开关已关闭」。
5. 把还没处理、在自动采纳范围内的提案和迭代按从早到晚自动采纳（见下面的「自动采纳」）。
6. 看能不能自动侦察，能就开始一次侦察。

自动侦察等什么，和 GitHub 仓库的规则完全一样（同一套代码，见「接入 GitHub」）：

- `scout.auto` 为 `false` 时只在看板上手动触发；这个仓库正在侦察时不再开始。
- 仓库有会自己往下走的 Run（排队的、执行中的、等回复但设了超时的、因为目标分支有未提交的改动而停下的）时，等它们做完。Run 失败后在等自动重做的提案也算（见下面的「本地提案失败后自动重做」），看板上写明「有 1 条提案在等重做」。只等人的 Run 不挡侦察。Master 等着自动升级时也不侦察。
- 当天的自动花费达到 `daily_budget_usd` 时不侦察，第二天恢复。
- 离上次侦察不到 `scout.interval_minutes`。
- 退避：从最近一次侦察往回数，连续 k 次一条提案都没写进提案池或失败时，下次自动侦察要等 `poll_minutes × 2^(k-1)` 分钟，最长 6 小时。有侦察写进了提案或迭代，或者目标分支有了比最近那次侦察更新的提交，退避马上解除。
- 侦察的 Agent 额度用尽或被限流时，等额度恢复。
- 等你处理的提案加上卡住的 Run 达到 `scout.max_proposals` 时不再侦察，免得堆积没人看的工作。`auto_accept.max_risk` 为 `none` 时所有待处理的提案都算；开了自动采纳时只算在采纳范围内、因为当天条数或预算用完还没采纳的，超出范围、等你决定的提案不会让侦察停下（否则没人在场时仓库就停转了），侦察在提示词里看得到它们，不会重复提。等采纳的迭代整个算一条，按子项里最高的风险和最大的大小判断，它的子项不另算。

间隔、退避和等额度同时生效，取最晚的时间。看板「需求」页每个仓库的「侦察」一行写明现在为什么没有自动侦察，有时间的写到几点之后。在看板上点「让 AI 找活」手动侦察不受这些等待限制（正在侦察或仓库配置有误时不能点），但它的结果照样计入退避和连续失败的计数。侦察连续失败 3 次时通知一次（见「通知」）。

侦察的提示词、输出格式和 GitHub 仓库的一样（包括迭代：没有进行中的迭代时主要产出一个新迭代，有的话只提第 1 类问题、判断计划要不要调整，见「侦察提什么」和「迭代」），只是「已有的 issue」换成这个仓库的本地提案，分三节，有多次失败后放弃的提案时再加一节：

- 等人决定的（最多列 100 条）；
- 已采纳的（最多 50 条），带最近一次建出的 Run 和它现在的状态、是第几次尝试（重做过的）、是不是在等自动重做、是不是自动采纳的；Run 失败了写失败原因，需求评估结论为不做的写不做的理由；属于已经结束的迭代的，写明那个迭代已完成或已被人终止；
- 被拒绝的，连同拒绝的理由，作为不要再提的反例。不管多早被拒绝都列出（最多 300 条），侦察不会换个说法再提同一件事。整个被拒绝的迭代只算一条：迭代的标题、它各步的标题和拒绝的理由；
- 多次失败后放弃的（「多次失败后放弃（不是人拒绝的）」，最多 50 条）：失败了几次、是不是自动采纳的，属于已经结束的迭代的写明那个迭代已完成或已被人终止，以及每次尝试的 Run、失败在哪个阶段和原因。侦察知道它们不是人拒绝的，可以根据失败原因换个思路重新提案，但不要原样再提；还在等自动重做的提案也不要再提。

进行中的迭代的子项不在这三节里，由提示词里「进行中的迭代」一节列出。待处理和已采纳的提案在「要做什么」里写了后续步骤时，后续步骤也一起列出：Run 已完成的提案的后续步骤是规划迭代的素材，还没做完的要等它合并后才能做。侦察照旧以只读方式运行，拿不到 GitHub 和 GitLab 凭据（见「Agent 拿不到 GitHub 和 GitLab 凭据」）。

### 提案怎样写进提案池

侦察结束后，它提的每条提案（最多 `max_proposals` 条）都写成提案池里的一条记录：标题、类别、大小、风险、为什么、证据、要做什么、验收标准、来自哪次侦察，状态为「待处理」（`pending`）。在自动采纳范围内的马上采纳（见下面），其余的留着等人。看板「需求」页的侦察记录里，这些提案标着「已写入本地提案」，自动采纳的另有「已自动采纳」。事件列表里记一条 `scout.completed`，数据里有 `created`（写进了几条）、`auto`（其中自动采纳了几条）、`pending`（留着等人的几条；等人采纳的迭代也算一条）和 `backlog: true`，侦察规划了迭代时还有 `iteration: { id, auto }`，看板「事件」页写成「侦察 <仓库> 完成，写入了 N 条本地提案……」。侦察规划的迭代怎样写进提案池，见下面的「本地提案池里的迭代」。

提案池的记录存在数据库的 `proposals` 表里，不会过期；在看板「仓库」页删掉仓库时，它的提案一起删掉。

### 自动采纳

判断范围的规则和 GitHub 仓库的是同一条：侦察给提案标的风险不超过 `max_risk`、大小也不超过 `max_size` 时自动采纳；`max_risk` 为 `none` 时一条都不自动采纳。另外还要同时满足：

- 工作开关开着；
- 当天这个仓库自动采纳的条数（按 `proposal.auto_accepted` 和 `iteration.auto_accepted` 事件数）还没到 `max_per_day`；
- 当天的自动花费还没到 `daily_budget_usd`。自动花费算的是这个仓库今天的侦察，加上今天从自动采纳的提案建出的 Run，以及今天自动重做建出的 Run（不管提案当初是不是人采纳的）；你在看板上手动采纳时建出的第一个 Run 不算。

满足时，侦察写进提案时就马上采纳；当时不满足的（工作开关关着、条数或预算用完），以及之后放宽了设置才落进范围的，留在「待处理」，之后每一轮检查按从早到晚补上采纳，直到条数或预算再次用完。迭代按整体判断：取子项里最高的风险和最大的大小，整批采纳，在 `max_per_day` 里只算一次；它的子项不单独采纳（见下面的「本地提案池里的迭代」）。

采纳（不管是自动的还是人手动的）就是用提案正文建一个 Run：模板是这个仓库的 `template`，目标是提案的标题，后面依次是「为什么」「证据」「要做什么」「验收标准」，和侦察在 GitHub 上建的 issue 正文一样；`auto_merge: true` 时这个 Run 合并前不等人审批，模板里其他阶段的审批照旧。之后的需求评估、编码、评审、合并都和别的 Run 一样。建 Run 和把提案标成「已采纳」（`accepted`，记下 Run 的 id 和是不是自动采纳的）在一起完成，事件列表里记一条 `proposal.auto_accepted`（自动采纳）或 `proposal.accepted`（人在看板上采纳），数据是 `{ repo, proposalId, runId }`。建 Run 失败时（比如模板这时不存在了），提案保持「待处理」，原因显示在看板「本地提案」最上面的卡片里，下一轮再试。

### 本地提案失败后自动重做

提案（单独的提案，以及迭代的子项）建出的 Run 失败后（`failed`，原因和 GitHub 仓库的一样，见「Run 失败后自动重做」；不包括被终止的），Master 不等人，自动再建一个 Run 重做，规则和 GitHub 仓库的 issue 一样，次数上限是 `backlog.repos.<name>.max_run_attempts`（默认 3，含第一次；1 = 不重做）：

- **记下失败**：每轮检查（工作开关关着时也做）发现提案最近一次的 Run 失败了，就在提案上记下这次失败（`failures` 里加一项：Run 的 id、第几次尝试、失败在哪个阶段、原因），并在这时决定之后怎么办，决定了就不再改：
  - 还有次数：提案的 `redo` 记为 `pending`，等着重做。事件列表里记一条 `proposal.redo_scheduled`，数据是 `{ repo, proposalId, runId, attempt, maxAttempts, redoAt }`：失败的 Run、下一次是第几次、上限和预计什么时候重做。
  - 次数用完：提案标成「已失败」（`failed`），`redo` 记为 `exhausted`，同一个事务里在事件列表里记一条 `proposal.failed`，数据是 `{ repo, proposalId, runId, attempts, maxAttempts, failures }`，`failures` 是每次尝试的 `runId`、`attempt`、`stage` 和 `error`。之后不再重做，也不能再采纳或拒绝。这不等于不要这个需求：之后的侦察在「多次失败后放弃」一节里看到它和每次失败的原因，可以换个思路重新提案。
- **等一会儿再做**：等待时间和 GitHub 仓库的重做一样（同一份规则）：第 n 次失败后等 `poll_minutes × 2^(n-1)` 分钟，最长 2 小时，从失败的 Run 结束时算起，这里的 `poll_minutes` 是 `backlog.poll_minutes`。等待时间只从记录算，Master 重启后照样成立；到时间后在下一轮检查时重做（不另设定时器，最多晚一轮）。
- **重做**：到时间后，工作开关开着、当天的自动花费没到 `daily_budget_usd` 时，用提案正文再建一个 Run，模板和 `auto_merge` 的设置和采纳时一样。新 Run 的目标是提案正文后面加一节「之前的尝试」：之前每次尝试的 Run、失败在哪个阶段和原因（每次最多 2000 字），并要求先想清楚失败的原因、换个做法，和 GitHub 重做时告诉 Agent 的一样；需求评估、编码和评审都读得到。建 Run 和更新提案（`runId` 换成新的 Run，`attempt` 加一，`redo` 清空）在一起完成，事件列表里记一条 `proposal.redone`，数据是 `{ repo, proposalId, runId, failedRunId, attempt, maxAttempts }`。建 Run 失败时什么都不记，下一轮再试。
- 花费已达上限时先不重做，第二天预算恢复后再做；工作开关关着时也不重做，打开后马上检查一轮。这些等待都不算用掉一次，多条提案各等各的。自动重做建出的 Run 计入当天的自动花费，不管提案当初是不是人采纳的。
- 被终止的 Run（人在看板上终止）不重做，提案也不标成失败，保持「已采纳」，等你决定。
- **重新开始**：用完次数、标成「已失败」的提案，修好原因后可以在看板上点「重新开始」再给一次机会（`POST /api/proposals/:id/restart`），相当于 GitHub 仓库里给失败的 issue 重新加 `ares1:ready`：次数从头算（`attempt` 回到 1，之后失败了照样按 `max_run_attempts` 自动重做），马上用提案正文建一个新 Run，目标后面照样加上「之前的尝试」：之前每次失败的原因都在（`failures` 保留着，看板上重新开始之后的那几次写成「第 2 轮第 1 次」）。提案改回「已采纳」，`runId` 换成新的 Run，`redo` 清空；这些和事件列表里的一条 `proposal.restarted`（数据是 `{ repo, proposalId, runId, failedRunId, attempts, maxAttempts }`，`attempts` 是之前用掉的次数，`maxAttempts` 是这一轮的上限，迭代的子项另有 `iterationId`）在同一个事务里记下。这是人的决定，和手动采纳一样不受当天的自动采纳条数和预算限制，也不发通知；提案当初是不是自动采纳的保持不变（自动采纳的提案的 Run 照旧计入当天的自动花费），之后的自动重做照常计入。建 Run 失败时什么都不记。建好 Run 之后、记下这些之前，Master 在同一个事务里再读一次提案和所属迭代，确认仍然能重新开始；已经不能了（比如迭代刚好结束），或者这时记录出错，就什么都不记，把刚建的 Run 终止（它没有提案指向，留着只会白白干活），再返回错误。
  - 只有「已失败」的提案能重新开始。待处理、已采纳（包括在等重做的，和 Run 被人终止的）、已拒绝的提案，以及仓库已经不在 `backlog.repos` 里或配置有误时，返回 409。
  - 迭代的子项也能重新开始，条件是所属迭代还在进行中或受阻、这一步没被替换也没被标成不做；迭代已结束（完成、被拒绝或终止）、这一步已被替换的返回 409。重新开始后子项回到「进行中」，迭代页列出它的每一次 Run；迭代没有别的子项卡住时从「受阻」回到「进行中」（记一条 `iteration.unblocked`），还有别的子项失败时仍然受阻。
- 失败后在等重做的提案会挡住自动侦察（「有 1 条提案在等重做」），和 GitHub 仓库里等重做的 issue 一样。
- **从没有自动重做的版本升级时**：升级前就已经失败的提案（已采纳、最近一次的 Run 失败了的单独提案，以及所属迭代还在进行中或受阻、没被替换的子项），升级后第一轮检查时按第 1 次失败记下：`max_run_attempts` 大于 1 时进入等重做，等待时间从那个旧 Run 结束时算起，通常早就过了，所以同一轮就会重做（受阻的迭代没有别的子项卡住时回到进行中）；`max_run_attempts` 为 1 时直接标成「已失败」。这些重做和别的自动重做一样受工作开关和 `daily_budget_usd` 限制，没设预算时可能一下子建出好几个 Run。其中有的需求可能已经被侦察换个说法重新提过了；不想让它们重做的话，升级前先关掉工作开关，升级后在看板上把重复的 Run 终止（被终止的 Run 不重做，提案保持「已采纳」）。加上自动重做的那次数据库迁移已经发布，Master 不再追加迁移把这些旧的失败一律记成放弃：已经升级过的数据库里，新迁移分不清升级前失败的提案和升级后刚失败、还没来得及记下的提案，一律放弃会把后者的重做次数也吞掉。
- 每次尝试都是一个新 Run，有自己的工作目录和分支；之前失败的 Run 的工作目录和分支保留着（本地提案还不会像 GitHub 仓库的 issue 那样自动删掉更早的尝试），不需要时在看板上手动清理（「工作区」页或 Run 详情页）。
- 迭代的子项也按上面的规则重做，次数、等待时间、预算和工作开关的限制都一样：子项失败后先重做，等重做期间子项保持「进行中」，迭代不受阻，也不会为它另建 Run；次数用完、提案标成「已失败」后，迭代才受阻（见下面的「本地提案池里的迭代」）。只重做所属迭代还在进行中或受阻、自己没被替换也没被标成不做的子项：迭代被终止（或被拒绝、已结束）、子项被侦察替换后，它的失败既不再记下，也不再重做，等重做的子项也不再计入「在等重做」。

### 在看板上采纳或拒绝

看板「需求」页的「本地提案」一节：

- 最上面一张卡片说明本地提案池怎么转，写着多久检查一次、上次检查的时间，有「立即检查」按钮（不等下一轮，马上自动采纳、该侦察时侦察），上一轮检查有没做成的事时写明原因。
- 每个仓库一张卡片：用的模板和它来自数据目录还是仓库、侦察的 Agent 和调度方式（以及现在为什么没有自动侦察）、自动采纳的范围和今天已经自动采纳了几条、合并前要不要审批、今天的自动花费和预算，以及「让 AI 找活」按钮。只配了 `backlog`、没配 `github` 的仓库也能在这里手动侦察。
- 卡片下面是这个仓库的提案，待处理的排在前面（新的在前），之后是已经决定的（最近决定的在前）。看板加载全部待处理的提案和最近的 50 条，更早决定的不显示（仍在数据库里，侦察照样看得到）。每条显示状态、标题、风险、类别、大小和提出的时间，点开能看为什么、证据、要做什么和验收标准。
- 待处理的提案写明它在不在自动采纳范围内：在范围内只是还没采纳（条数、预算或工作开关），之后会自动采纳；不在范围内就等你决定。点「采纳」马上用它建 Run，不受 `max_per_day` 和预算限制（这是人的决定）；仓库已经不在 `backlog.repos` 里或配置有误时不能采纳。要拒绝，先在输入框里写理由（必填，理由为空时「拒绝」按钮不能点），再点「拒绝」「确认拒绝」。拒绝后提案标成「已拒绝」（`rejected`），事件列表里记一条 `proposal.rejected`，数据是 `{ repo, proposalId, reason }`。
- 已采纳的提案显示最近一次建出的 Run 的链接和状态，自动采纳的标着「已自动采纳」，重做过或在等重做的写明是第几次尝试（「第 2/3 次尝试」，上限是 API 的 `maxAttempts`），在等重做的写明预计什么时候重做；已拒绝的显示拒绝的理由；已失败的（「已失败」，红色）写明失败了几次、不再自动重做，下面有「重新开始」按钮（点了要再点「确认重新开始」，见上面的「重新开始」；仓库已经不在 `backlog.repos` 里或配置有误时按钮不能点，旁边写明原因）。有过失败的提案可以展开「失败的尝试及原因」，看每次尝试的 Run（链到 Run 详情页）、失败在哪个阶段和原因；重新开始过的，之后的尝试写成「第 2 轮第 1 次」。
- 迭代的子项也是提案，但不能单独采纳或拒绝：它们没有这两个按钮，链到所属的迭代，在看板的迭代页整体采纳、拒绝或终止（见下面的「本地提案池里的迭代」）。用完次数失败的子项和单独的提案一样可以「重新开始」，这里和迭代页都有这个按钮。
- 被拒绝的提案连同理由会出现在这个仓库之后每次侦察的提示词里（上面「侦察怎么调度」里的「被拒绝的」一节），作为反例：理由写得越具体（为什么不做、什么情况下才值得做），侦察越不会再提类似的东西。
- 从 `backlog.repos` 里拿掉的仓库，如果还有提案，仍然列在这里，写明已经不在 `backlog.repos` 里：不再侦察、不能采纳，待处理的还可以拒绝。

页面在有提案写入、采纳、拒绝、重做、失败或重新开始，侦察开始或结束，建了新 Run、Run 状态变化，以及配置重新加载时自动刷新。

### 本地提案池里的迭代

不接 GitHub 的仓库也用迭代，规则和 GitHub 仓库的一样（规划、整体采纳、依赖、完成、受阻、侦察调整计划、收尾，见「迭代」），只是没有 issue、标签和隐藏标记，一切都记在 Master 的数据库里，在看板上操作：

- **写进提案池**：侦察规划的迭代记成一个迭代，计划里的每一步各写成一条提案，提案上记着所属的迭代（`iterationId`）和它依赖的同一迭代里的提案（`dependsOn`，按提案 id）。依赖直接记在提案上，没有要解析的文字。
- **采纳**：自动采纳按整体判断（见上面的「自动采纳」），记一条 `iteration.auto_accepted`。人在看板的迭代页点「采纳」（`POST /api/iterations/:id/accept`），记一条 `iteration.accepted`；这是人的决定，不受 `max_per_day` 和预算限制。采纳时全部子项的提案一起标成已采纳，自动采纳的迭代的子项也算自动采纳的，它们的 Run 计入当天的自动花费。
- **拒绝**：等采纳的迭代在迭代页填上理由（必填）拒绝（`POST /api/iterations/:id/reject`）：全部子项的提案一起标成已拒绝，记下同一个理由；迭代标为已终止，记一条 `iteration.cancelled`（`pending: true`，带 `reason`）。之后的侦察在「被拒绝的」一节里把整个迭代当作一条反例。
- **依赖门**：一个子项依赖的提案的 Run 都完成后，才为它建 Run。采纳时马上为没有依赖的子项建 Run；之后每轮检查（工作开关开着时）为依赖刚完成的子项建 Run。受阻时，不依赖失败那一步的子项照常开工。
- **完成**：全部子项的 Run 都完成后（被替换的不算），Master 写一份总结（内容和 GitHub 迭代的总结一样），存在迭代上，在迭代页显示，记一条 `iteration.completed`，不通知。
- **受阻**：子项的 Run 失败后先按「本地提案失败后自动重做」重做，这期间子项保持「进行中」（迭代页列出它的每一次 Run，失败的也在，并写明是第几次尝试、预计什么时候重做，可以展开看每次失败的原因），迭代照常进行。子项的 Run 用完 `max_run_attempts` 次仍然失败（提案标成「已失败」）、被人终止，或需求评估结论为不做时，这一步才算没做成，迭代进入受阻，记一条 `iteration.blocked` 并通知「迭代受阻」（点开是迭代页）。侦察下次换个做法补一个子项替换它；替换后迭代回到进行中，新的子项按依赖开工（工作开关开着时马上建 Run）。用完次数失败的子项，也可以修好原因后在迭代页那一步上点「重新开始」（见「本地提案失败后自动重做」的「重新开始」），次数从头算，没有别的子项卡住时迭代回到进行中；Run 被人终止或需求评估结论为不做的子项提案还是「已采纳」，不能重新开始，等侦察替换。每轮检查先记下失败、重做到期的子项，再跟进迭代，所以有次数的子项不会在同一轮里先被当成失败。
- **终止**：已采纳、还没结束的迭代可以在迭代页「终止」（`POST /api/iterations/:id/cancel`）：还没完成的子项不做了，它们还没结束的 Run 被终止，Run 上记 `run.iteration_cancelled`，不算失败；迭代标为已终止，记一条 `iteration.cancelled`。等采纳的迭代不能终止，要拒绝。
- **侦察调整计划**：调整的理由记在迭代上（迭代页的「计划调整」），新子项写成提案，跟着迭代是否已采纳；依赖变了的提案改写 `dependsOn`。
- **收尾**：收尾子项建 Run 之前，把本迭代评审留下的建议（规则同「迭代」的「收尾」）写进它的提案的「要做什么」，看板上看到的就是交给 Run 的内容。收尾子项失败后重做时用提案上已经存好的这段内容，评审建议不会再追加一次。

### 通知

规则和 GitHub 仓库的一样（`src/notify/notice.ts`），通过浏览器、系统通知和 webhook 三条通道发（见「通知」）：

- 侦察结束时，有留着等人的提案（`scout.completed` 的 `pending` 大于 0，等人采纳的迭代也算一条）就通知「有提案等你决定：N 条」，正文说明这些提案没有自动采纳（太大、超出自动采纳的风险，或今天的自动采纳额度用完了），去看板的需求页上采纳或拒绝；点开是「需求」页。每次侦察只通知一次。
- 采纳、自动采纳和拒绝提案或迭代，以及重新开始失败的提案（`proposal.restarted`）都不通知：要么是人自己做的，要么不需要人。迭代完成也不通知。
- 迭代受阻时通知「迭代受阻：<仓库名>」，正文说明有一步没做成（Run 用完重做次数后仍然失败、被终止，或需求评估结论为不做）、侦察下次会换个做法替换它，也可以在看板上终止这个迭代；点开是迭代页。
- 侦察连续失败 3 次时通知「侦察连续失败：<仓库名>」，和 GitHub 仓库一样。
- 从提案建出的 Run 和别的 Run 一样：等审批、卡住、失败时通知（每次失败都通知，自动重做的也是）。安排重做、重做和多次失败后放弃提案（`proposal.redo_scheduled`、`proposal.redone`、`proposal.failed`）不另外通知：失败本身已经通知过，放弃的提案在「需求」页和事件页标成红色。

### 暂时还不支持的

- 自动删掉本地提案更早失败的尝试的工作目录和分支：GitHub 仓库的 issue 重做成功或用完次数后会自动删掉（见「Run 失败后自动重做」），本地提案的还要手动清理。
- GitLab 仓库的完整支持：`config.yaml` 的 `gitlab.repos` 已经能登记 GitLab 仓库（`issues_repo` 写项目路径，如 `grp/sub/demo`），Master 给 GitLab 单独开一路检查（和 GitHub 的各自轮询、各自记错误），把 `ares1:ready` 的 issue 建成 Run、在 issue 上回写进度（评论同样带隐藏标记、去掉家目录）、完成后关闭 issue，`push: true` 时把目标分支推送到 GitLab；作者对项目的权限在 Developer 及以上才算受信任，否则 Run 先等人确认目标。侦察也一样：提案和迭代建成 GitLab 上的 issue（标签、页脚的隐藏标记、迭代 issue 计划里的任务列表都和 GitHub 上相同），侦察的提示词里列的是 GitLab 上已有的 issue，说的也是 GitLab issue；在 `auto_accept` 范围内的自动采纳，迭代整批采纳后子 issue 按依赖开工，全部完成后在迭代 issue 上发总结并关闭；自动侦察的退避按 `gitlab.poll_minutes` 计算。GitLab 仓库的 `scout.completed`、`issue.auto_accepted` 和迭代事件（`iteration.*`）的数据里带 `platform: 'gitlab'`，「有提案等你决定」的通知让你去 GitLab 上采纳或关闭。`GET /api/gitlab` 和 `POST /api/gitlab/poll` 的格式和 `GET /api/github`、`POST /api/github/poll` 相同，`platform` 是 `gitlab`，`host` 是 `gitlab.host`（GitHub 的 `platform` 是 `github`，`host` 为 `null`）。看板上的显示和完整的登记说明还没做完，不支持 MR（`deliver` 只能是 `push`）。

### 本地提案池的 API

- `GET /api/backlog`：本地提案池的状态。`enabled` 表示 `config.yaml` 有 `backlog` 一节，`pollMinutes` 是 `backlog.poll_minutes`，`lastPollAt` 是上一轮检查的时间（还没检查过时为 `null`），`lastError` 是上一轮没做成的事（下一轮全部做成后清空）。`repos` 按 `backlog.repos` 的顺序列出每个仓库，字段和 `GET /api/github` 里每个仓库共有的部分相同：`name`、`template`、`problems`（Master 为什么不能处理这个仓库，比如配置有误、没在看板上登记）、`scout`（`agent`、`auto`、`intervalMinutes`、`maxProposals`、`running`、`lastAt`，以及 `waiting`：上一轮检查时自动侦察为什么没开始；没配侦察时为 `null`）、`autoAccept`（`maxRisk`、`maxSize`、`maxPerDay`、当天已自动采纳的 `usedToday`）、`autoMerge`、`budget`（`dailyUsd`、`spentToday`、`reached`）、`maxRunAttempts`（`max_run_attempts`），另外 `pendingProposals` 是等人或等自动采纳的提案数：等采纳的迭代算一条，它的子项不算。`GET /api/github` 里每个仓库也有 `maxRunAttempts`。
- `POST /api/backlog/poll`：马上检查一轮（跟踪迭代、为依赖完成的子项建 Run，记下失败的 Run、重做到时间的提案，自动采纳范围内的待处理提案和迭代，能开始的自动侦察），不等下一轮；返回检查后的状态，格式同上。
- `GET /api/proposals`：本地提案，新的在前。参数 `repo`（仓库名或 id）只列这个仓库的，`status`（`pending`、`accepted`、`rejected`、`failed`）只列这个状态的，`limit`（1–500 的整数）最多返回几条，不写时全部返回。每一项除了提案本身的字段（`id`、`repoId`、`scoutId`、`title`、`category`、`size`、`risk`、`why`、`evidence`、`what`、`acceptance`、`status`、`rejectReason`、`auto`、`runId`（最近一次建出的 Run）、`attempt`（`runId` 是第几次尝试，从 1 起）、`failures`（失败过的每次尝试，旧的在前：`runId`、`attempt`、`stage`、`error`）、`redo`（最近一次 Run 失败后怎么办：`pending` 等着重做，`exhausted` 次数用完了，其余时候为 `null`）、`iterationId`（所属的迭代，不属于迭代时为 `null`）、`dependsOn`（依赖的同一迭代里的提案 id）、`createdAt`、`decidedAt`），还有仓库名 `repo`、最近一次建出的 Run 的状态 `runStatus`（还没采纳时为 `null`）、预计什么时候重做 `redoAt`（ISO 时间，不在等重做时为 `null`）、一共能跑几次 `maxAttempts`（这个仓库的 `max_run_attempts`，已经跑过的次数 `attempt` 比它多时取 `attempt`；仓库已经不在 `backlog.repos` 里时为 `null`）和能不能重新开始 `restartable`（「已失败」、所属迭代还要它时为 `true`，见「重新开始」）。参数不合法时返回 400，仓库不存在时返回 404。
- `POST /api/proposals/:id/accept`：采纳一条待处理的提案，用提案正文作为目标建 Run（模板和 `auto_merge` 按这个仓库在 `backlog.repos` 里的设置），返回 `{ proposal, run }`：采纳后的提案（格式同上）和建出的 Run（格式同 `GET /api/runs` 的各项）。提案不存在时返回 404；已经采纳、拒绝过或多次失败后放弃了、属于迭代（随迭代整体采纳），或者仓库已经不在 `backlog.repos` 里、配置有误时返回 409。
- `POST /api/proposals/:id/reject`：拒绝一条待处理的提案，请求体是 `{ "reason": "…" }`，理由必填，去掉首尾空白后为空时返回 400。理由会和提案一起出现在这个仓库之后的侦察提示词里，作为不要再提的反例。返回拒绝后的提案；不存在时返回 404，已经采纳或拒绝过、属于迭代（随迭代整体拒绝）时返回 409。
- `POST /api/proposals/:id/restart`：重新开始一条「已失败」的提案（包括迭代里还没被替换的子项），次数从头算，马上建 Run（见「本地提案失败后自动重做」的「重新开始」）。返回 `{ proposal, run }`，格式同 `accept`。提案不存在时返回 404；不是「已失败」、所属迭代已结束、这一步已被替换或不做了，或者仓库已经不在 `backlog.repos` 里、配置有误时返回 409。
- `POST /api/scouts`：手动侦察，请求体是 `{ "repo": "<仓库名>" }`。仓库在 `backlog.repos` 里时交给本地提案池，提案写进本地提案池；在 `github.repos` 或 `gitlab.repos` 里时在那个平台上建 issue。同一个仓库写在不止一处属于配置错误，这时按 `github.repos`、`gitlab.repos`、`backlog.repos` 的顺序只有第一处生效，按它侦察。三处都没有时返回 404。

### 迭代的看板和 API

看板顶栏的「迭代」页列出所有仓库的迭代：没结束的在前（受阻的、等采纳的、进行中的），然后是最近结束的。每个迭代显示目标、状态、进度条（完成几步 / 共几步，被替换的步骤不算）、用了几个 Run、费用和用时，受阻时写明是哪一步失败或不做了。点进去是这个迭代的页面（`#/iterations/<id>`）：目标和对应的 README 目标、完成标准（每条后面写着推进它的步骤）、不做的事、计划里每一步的状态、在等哪几步、被哪一步替换、它的 issue 或本地提案、做过它的每个 Run（链到 Run 详情页，带状态和费用），本地提案池的步骤还写明是第几次尝试（「第 2/3 次尝试」）、在等重做时预计什么时候重做，可以展开「失败的尝试及原因」，用完次数失败的步骤有「重新开始」按钮（受阻的提示里也会提到；迭代的仓库已经不在 `backlog.repos` 里或配置有误时按钮不能点，旁边写明原因，配置有误的连同具体问题）；以及侦察的计划调整和完成后的总结。本地提案池的迭代在这里整体采纳、填理由拒绝或终止；GitHub 的迭代链到迭代 issue，在 GitHub 上操作。首页在 Run 列表上面列出没结束的迭代（按仓库筛选时只列这个仓库的），有受阻的时这一栏标成橙色。「需求」页里属于迭代的本地提案不能单独采纳或拒绝，链到它的迭代。

- `GET /api/iterations`：两种来源的迭代，新的在前。参数 `repo`（仓库名或 id）只列这个仓库的；`status` 是一个状态或用逗号隔开的几个（`pending`、`active`、`blocked`、`done`、`cancelled`），比如 `pending,active,blocked` 列出没结束的；`limit`（1–500 的整数）最多返回几条，不写时全部返回。每一项除了迭代本身的字段（`id`、`repoId`、`source`、`issue`、`title`、`goal`、`readmeGoal`、`criteria`、`outOfScope`、`notes`、`status`、`auto`、`summary`、`createdAt`、`decidedAt`、`endedAt` 等），还有仓库名 `repo`；`children` 的每一步另有 `waitingFor`（还没开工时在等的步骤序号，开工后为空）和 `runs`（做过它的每个 Run 的 `id`、`status`、`costUsd`、`costUnknown`，旧的在前，失败后重做的也在内），本地提案池的步骤还从它的提案读出 `attempt`、`maxAttempts`、`redoAt`、`failures` 和 `restartable`（含义同 `GET /api/proposals`；GitHub 的步骤和还没有提案的步骤分别为 `null`、`null`、`null`、`[]` 和 `false`）；`progress` 是 `{ done, total }`；`totals` 是所有步骤的 Run 合计：`runs`（几个 Run）、`costUsd`、`costUnknown`（有的执行费用未知，`costUsd` 只是下限）、`elapsedMs`（从采纳到结束，没结束时到读取的时候；没采纳时为 `null`）和 `agentMs`（Agent 执行的时间）。参数不合法时返回 400，仓库不存在时返回 404。
- `GET /api/iterations/:id`：一个迭代，格式同上；不存在时返回 404。
- `POST /api/iterations/:id/accept`、`POST /api/iterations/:id/reject`（请求体 `{ "reason": "…" }`，理由必填）、`POST /api/iterations/:id/cancel`：整体采纳、拒绝等采纳的、终止已采纳的本地提案池迭代，返回处理后的迭代（不带上面那些合计）。GitHub 的迭代和状态不对时返回 409，不存在时返回 404。

## Agent 用的 CLI

`agents.yaml` 里每个 Agent 的 `cli` 决定用哪个 CLI 运行它。可执行文件默认从 PATH 里找，不在 PATH 上时在 `config.yaml` 的 `bins` 里写路径（键就是 `cli` 的值，改了要重启 Master）。看板「配置」页的 Agent 一节列出了 Master 支持的 CLI 和其中能以只读方式运行的（API `GET /api/config` 的 `clis`：每项是 `{ cli, readOnly }`）；某个 Agent 的设置它的 CLI 做不到时（比如下面 Codex 的 `permission: safe`），「配置」页和「Agent」页在这个 Agent 的状态下面写明，API 里是 `agentEntries` 各项的 `warnings`，键为 `agents.yaml#<id>` 的 `warnings` 里也有一份。

| `cli` | 默认的可执行文件 | 能以只读方式运行 | `effort` | 花费 |
|---|---|---|---|---|
| `claude-code` | `claude` | 能 | 传给 `--effort` | CLI 自己报 |
| `cursor-agent` | `cursor-agent` | 不能 | 写在模型名里（比如 `grok-4.7-high`），不能配 `effort` 字段 | 不报，配了 `price` 由 Master 估算 |
| `codex` | `codex` | 能 | 传给 `-c model_reasoning_effort=…` | 不报，配了 `price` 由 Master 估算 |

需求评估、拆分任务（`planning: auto` / `llm`）和侦察都以只读方式运行，只能用能以只读方式运行的 CLI 的 Agent，否则加载模板时报错、侦察不启动；出错换 Agent 时，这几步也只换到这些 CLI 的 Agent。同时配上 claude-code 和 codex 的 Agent，一家的额度用完时，这几步还能换另一家接着做。

### Codex CLI

Master 用 `codex exec` 非交互地运行它（按 codex-cli 0.172 的 `codex exec --help` 核对过）：

```
codex exec --json --skip-git-repo-check --ignore-user-config --ignore-rules --model <model>
  --sandbox <read-only | workspace-write> -c approval_policy="never"
  [-c sandbox_workspace_write.network_access=true] [-c model_reasoning_effort="<effort>"]
  [--ephemeral] [--output-schema <临时文件>] [<args>] [resume <会话 id>] -
```

- 提示词从 stdin 传入（最后的 `-`），工作目录就是进程的当前目录。
- 只读运行（需求评估、拆分任务、侦察）：只读沙箱（`--sandbox read-only`），Codex 仍会运行读文件、搜索的命令，但写不了任何东西；加 `--ephemeral`，不保留会话，也从不恢复会话。不看 Agent 的 `permission`。
- `permission: full`（默认）：工作目录可写的沙箱（`--sandbox workspace-write`），可以改工作目录里的文件、执行命令、联网；`approval_policy="never"`，不等交互审批（没人能审批）。不用 `--dangerously-bypass-approvals-and-sandbox`：命令照样在沙箱里运行，写不了工作目录以外的地方（临时目录除外）。
- `permission: safe`：Codex 没有「只改文件、不执行命令」的模式，它改文件本身就要用命令或补丁工具，所以同样用工作目录可写的沙箱，只是不能联网。加载 `agents.yaml` 时会对 `cli: codex` 配 `permission: safe` 给出警告，看板「配置」页和「Agent」页都会显示。只拿它做需求评估、拆分任务和侦察时不受影响。
- `effort`：`low` / `medium` / `high` / `xhigh` / `max` 也是 Codex 自己的推理强度名，原样传过去；模型不一定每档都支持（比如有的模型没有 `max`），配了模型不支持的档位时以 Codex 的处理为准，它报错的话这次执行按出错处理。
- 输出格式：Master 要的 JSON Schema 写到一个临时文件里，用 `--output-schema` 传入，执行结束后删掉。Codex 背后的接口只接受严格形式的 Schema（每个对象列出全部属性、不允许多余的属性），所以传过去之前先改写：可选的属性改成必填、可以为 `null`，去掉 `minLength`、`default` 这类约束；结果回来后再把这些 `null` 去掉，照常按完整的格式校验。Codex 最后一条回复就是这个 JSON。
- 返工时用 `codex exec … resume <会话 id> -` 接着上一次的会话。
- 不读 `~/.codex/config.toml` 和执行规则（`--ignore-user-config`、`--ignore-rules`），就像 Claude Code 不读用户级设置一样：个人配的 MCP 服务器、hooks、交互时批准过的命令不会带进 Agent 的执行，它们可能带着 GitHub 凭据，或者能在沙箱外执行命令。登录信息照常从 `~/.codex`（`CODEX_HOME`）读。需要改 Codex 的设置时写在 Agent 的 `args` 里，比如 `args: ["-c", "model_verbosity=low"]`；`args` 加在 `resume` 之前，`--add-dir` 这类 `codex exec` 自己的选项也能用。`--sandbox` 由上面的规则决定，不要写在 `args` 里。
- Master 解析它的 JSONL 输出：`thread.started` 里的 `thread_id` 是会话 id；`item.completed` 里的 `agent_message` 是回复，`command_execution`、`file_change`、`mcp_tool_call`、`web_search` 显示成工具调用；`turn.completed` 的 `usage` 是 token 用量（`cached_input_tokens` 单独记为缓存，不算进输入）。Codex 的 JSONL 不报实际用的模型，看板上显示配置的模型。
- 环境变量和别的 Agent 一样去掉了 GitHub 和 GitLab 凭据（见「Agent 拿不到 GitHub 和 GitLab 凭据」），Master 不另外给它任何凭据。

## 按难度选 Agent

模板里由 Agent 执行的阶段（`kind` 为 `agent`、`review`、`assess`）可以用 `agent` 指定一个 Agent，总由它做；也可以改写 `agent_candidates`，列出几个候选，由 Master 按需求的难度挑一个。小需求交给档次低、便宜的 Agent，同样的预算（`budget_usd`、`daily_budget_usd`）就能做更多 Run，自动侦察、自动采纳和重做也不容易因为当天的预算用完而停下：

```yaml
stages:
  - id: assess
    kind: assess
    agent: claude-reviewer
  - id: implement
    kind: agent
    agent_candidates: [claude-coder, claude-reviewer, claude-docs]
    inputs: [assessment]
```

- 难度来自需求评估：`kind: assess` 给出 go 时还要给出需求的难度 `difficulty`，三档的值在各种语言下都一样：
  - `low`：局部的小改动，比如改一处文案、补测试；
  - `mid`：跨模块的行为改动；
  - `high`：涉及核心的状态机、git 操作、数据库迁移，或者对正确性要求很高的改动。

  评估提示词里的说明和 Run 详情页显示的含义来自 `src/config/flow.ts` 的同一个定义。难度记在讨论记录里，Run 详情页「需求评估」的结论旁边、规模后面显示「难度 mid」和它的含义。起作用的是最近一次 go 的难度；评估没给难度不算出错，照常开工，按没有难度处理；ask、drop 时给了也照样记下，但不起作用。
- 写了 `agent_candidates` 的阶段每一轮开始时挑一次（规则在 `src/config/flow.ts` 的 `chooseStageAgent`），只看能跑这一轮的候选：已启用（在 `agents.yaml` 里、没被停用），CLI 有对应的 Adapter，这一轮要以只读方式运行（需求评估、要拆分的轮次）时 CLI 还要支持只读。在这些候选里：
  - 有难度时，在档次（`tier`）不低于难度的候选里挑成本（`cost`）最低的，成本一样就按列表的顺序；
  - 没有一个候选的档次够时，挑档次最高的，再一样挑成本低的，再一样按列表的顺序；
  - 没有难度时（模板里没有需求评估阶段，评估没给，Run 的评估是在评估会给出难度之前做的，或者是需求评估阶段自己，它在给出 go 之前还没有难度），用列表里第一个。

  按示例的 `agents.yaml`，上面的编码阶段难度为 `low` 时挑 `claude-docs`（low / low），`mid` 时挑 `claude-reviewer`（mid / mid），`high` 时挑 `claude-coder`（high / high），没有难度时用第一个 `claude-coder`。所以把拿不准时想用的 Agent 写在第一个。
- 选中的 Agent 做完这一轮：检查没过的返工沿用同一个 Agent，不重新挑；只有出错换 Agent（见下面）会换人。评审打回、审批驳回等回退到这个阶段时，新一轮重新挑一次；难度在 Run 里不变，通常还是同一个，除非这期间 `agents.yaml` 变了（比如候选被停用）。
- 要拆分的轮次（`planning: llm`，或者规模为 L 时的 `planning: auto`，见下面的「拆分任务」）只在支持只读的候选里挑，拆分和拆出的各步都交给选中的这个 Agent；拆分时换过 Agent，各步也仍由它做。
- 没有一个候选能跑这一轮时，先交给列表里第一个，它没法启动，按 `on_agent_error` 处理（见下面「Agent 出错时」里的「Agent 不可用」）。
- 每次挑选都和建这一轮的 Task 在同一个事务里记一条 `agent.selected` 事件，数据有：阶段（`stageId`）、轮次（`round`）、这一轮的第一个 Task（`taskId`，要拆分时是拆分任务）、选中的 Agent（`agentId`）、难度（`difficulty`，没有难度时为 `null`）、为什么选它（`reason`：`fit` = 档次够的里成本最低，`highest` = 没有档次够的、挑了档次最高的，`first` = 没有难度、用第一个，`unavailable` = 没有能用的候选、先交给第一个）和候选列表（`candidates`，模板里的顺序）。Run 详情页的事件里用看板的语言写成一句话，比如「阶段 implement 第 1 轮：按难度 mid，从候选（claude-coder、claude-reviewer、claude-docs）里选了 claude-reviewer：档次够用、成本最低」。只写 `agent` 的阶段不记。
- 看板的流程图（「配置」页和 Run 详情页）里，写了候选的阶段按模板的顺序列出每个候选的模型、effort、档次和成本，并写明按难度挑选的规则；「说明」页讲到这个阶段由谁做时也写成「按难度从……中选出的 Agent」。
- 出错换 Agent（`on_agent_error: switch_agent`）时只在这个阶段的候选里换，见下面的「Agent 出错时」。
- 加载模板时检查，有错误的模板被停用，看板「配置」页写明原因：
  - `agent` 和 `agent_candidates` 只能写一个；Agent 执行的阶段两个都不写也是错误。
  - `agent_candidates` 不能是空列表，同一个 Agent 不能写两次。
  - `command`、`merge`、`placeholder` 阶段不调用 Agent，不能写 `agent_candidates`（也不能写 `agent`）。
  - 每个候选都要在 `agents.yaml` 里存在且已启用。
  - 要以只读方式运行的阶段，每个候选都要用支持只读的 CLI（claude-code、codex），因为哪个候选都可能被选中：需求评估阶段，以及 `planning: llm` 或 `auto` 的 Agent 阶段。评审阶段不以只读方式运行，没有这个要求。
  - 评审阶段的候选和它前面编码阶段的 Agent 或候选有重叠时给出警告：选中的可能正好是写代码的那个，等于评审自己的代码。这只是提醒，模板照常可用。
- 带 `agent_candidates` 的完整模板见 [`docs/examples/workflows/cross-review.yaml`](examples/workflows/cross-review.yaml)，注释写了每种难度会挑到谁、出错时换给谁。

## Agent 出错时

Agent 执行出错（CLI 报错、超时等）时怎么处理，由流程模板的 `escalate` 决定，可以写在 `defaults` 里，也可以按阶段写：

```yaml
defaults:
  escalate:
    max_retries: 2               # 不写也是 2
    on_agent_error: switch_agent # 不写也是 switch_agent
```

- 出错后先等一会儿再用同一个 Agent 重试，最多 `max_retries` 次。第一次等 30 秒，之后每次翻倍，最长 10 分钟。等待期间 Run 仍算在正在执行的 Run 里，占着仓库 `concurrency.per_repo` 的一个名额；暂停、终止或停止 Master 会马上结束等待。出错重试和返工分开计数，`max_retries` 对两者各自生效。
- 同一个 Agent 的重试用完后，按 `on_agent_error` 处理：
  - `switch_agent`（默认）：挑一个这个 Task 还没用过、已启用的 Agent 接着做，需求评估阶段和拆分任务（见下面的「拆分任务」）只挑支持只读的。先挑档次（`tier`）不低于当前 Agent 的，其中挑成本（`cost`）低的，再一样就按顺序；没有档次不低于它的，就在剩下的里挑成本低的。从哪些 Agent 里挑看阶段怎么写：只写 `agent` 时在 `agents.yaml` 的所有 Agent 里挑，按文件里的顺序；写了 `agent_candidates` 时只在这个阶段的候选里挑，按候选列表的顺序，不会换到候选以外的 Agent（见上面的「按难度选 Agent」）。换上的 Agent 同样有 `max_retries` 次重试。没有可换的 Agent 时，Run 结束、标为失败。
  - `retry`：不换 Agent，重试用完后 Run 结束、标为失败。
  - `human`：重试用完后 Run 卡住，等人重试（可以换 Agent）或终止。没人在场时 Run 会一直停在那里，加载模板时会提示改成 `switch_agent`。
- Run 因此失败时，`error` 里写明最后是哪个 Agent 出了什么错、试过哪些 Agent。工作目录和分支保留，Master 接着做别的；issue 按 `max_run_attempts` 自动重做（见上面的「Run 失败后自动重做」），重做时这个错误会交给新 Run 的 Agent。
- Agent 不可用（`agents.yaml` 里改了名、删掉、设了 `enabled: false` 或校验失败被停用，没有对应的 Adapter，或者需求评估阶段、拆分任务时它的 CLI 不支持只读）时，Agent 根本没法启动，所以不重试、不消耗重试次数，直接按 `on_agent_error` 处理：
  - `switch_agent`（默认）：按上面同样的规则换一个可用的 Agent 接着做，需求评估阶段和拆分任务只换到支持只读的，写了 `agent_candidates` 的阶段只在候选里换；事件列表里记一条 `task.agent_switched`（数据里 `reason` 为 `unavailable`）。原来的 Agent 已不在 `agents.yaml` 里时，不看档次，直接挑成本低的。没有可换的 Agent 时，Run 结束、标为失败。
  - `retry`：用同一个 Agent 重试也不会成功，Run 直接结束、标为失败。
  - `human`：Run 卡住（Agent 不可用），等人确认 Agent 可用或换一个 Agent 后重试。
  - Run 因此失败时，`error` 里写明是哪个 Task、哪个 Agent、为什么不可用，以及按哪种 `on_agent_error` 结束；还没开始执行，工作目录不回滚，和分支一起保留。issue 同样按 `max_run_attempts` 自动重做。
- 人在看板上重试卡住的 Run 后，返工次数和出错重试次数都重新计算。
- 额度用尽或被限流不算出错：不消耗重试次数，不换 Agent，也不卡住等人。Run 回到队首排队，不再算在正在执行的 Run 里，别的 Run 照常执行；CLI 给了额度重置时间就等到那时再多等 1 分钟，没给就按连续被限流的次数等 5、10、20、40 分钟，之后每次 1 小时。到时间后从同一个 Task 接着做（返工意见不变）。等待期间 Run 详情页和事件列表会写明「额度用尽或被限流，预计 HH:mm 继续」。这个时间记在 `task.rate_limited` 事件的 `retryAt` 里，Master 重启（自动升级、保活脚本拉起、崩溃）后从事件里取回，Run 照样等到那时再继续，详情页也照样显示预计时间。想马上再试，可以暂停后再恢复，等待就此解除，重启后也不会再等。侦察遇到额度用尽或限流时按同样的规则等待，见上面「接入 GitHub」里侦察退避之后的一段。各个 CLI 的限流这样识别：
  - Claude Code：以它输出的限流事件（`rate_limit_event`）为准，重置时间也从事件里取。没有限流事件时，再看失败结果里 CLI 自己的错误文字，按下面同样的规则兜底。
  - cursor-agent：它不输出限流事件，只看失败时 CLI 自己的错误文字：失败的 `result` 事件里的文字，没有 `result` 事件、进程自己退出时则看 stderr 的末尾。超时、被停止或没能启动的不算限流。Agent 在回复里写的文字一律不看（Agent 讨论限流时不会被误判），成功的结果也不看。
  - Codex CLI：同样只看失败时 CLI 自己的错误文字：`turn.failed` 事件和最后一个 `error` 事件里的文字，没有这些事件、进程自己退出时则看 stderr 的末尾（比如额度用完时它报 `Quota exceeded. Check your plan and billing details.`）。中途重连时它也会发 `error` 事件（比如 `Reconnecting... 1/5 (… 429 …)`），这一轮最后完成了就不算失败，也不算限流。超时、被停止或没能启动的不算限流，Agent 回复的文字一律不看。
  - 错误文字的规则（不区分大小写）：含 usage limit、rate limit（rate-limit、rate limited、rate_limit 等写法）、too many requests、resource exhausted（`RESOURCE_EXHAUSTED`）、hit your limit，配额用尽的说法（quota exceeded、exceeded … quota、out of quota、insufficient quota；单独的 quota 不算，disk quota 磁盘配额也不算），或者紧跟在 HTTP、status、code 后面的 429（比如 `HTTP 429`、`status code 429`；4290、行号 429 之类的数字不算）。误判成限流的 Run 会一直等下去，所以规则宁紧勿松：没识别出来的限流照常按出错处理。
  - 错误文字里的重置时间按这个顺序找：Claude 老格式 `limit reached|<epoch>`、ISO 8601 时间、reset 或 retry 后面不远处 10 位的 epoch 秒数（13 位的毫秒数也行），然后是 Codex 的两种写法：`try again in 2 hours 5 minutes`（`retry in 90s` 之类也行，从现在算起）和 `try again at 3:15 PM`、`try again at Nov 25th, 2026 3:15 PM`（按本机时区；只有钟点时取下一次到这个钟点的时间）。找不到、已经过去或在 31 天以后的，当作没给重置时间。

数据目录里已经装好的 `workflows/self-dev.yaml` 不会自动更新。旧版本写的是 `on_agent_error: human`：出错时会先自动重试，重试用完后才卡住等人，加载时也会提示。想让它出错时也不等人，就手动改成 `switch_agent`；给 Ares.1 自己用的，也可以改用仓库自带的 `.ares1/workflows/self-dev.yaml`，它跟着代码更新（见「从数据目录的模板切换到仓库自带的」）。

## 拆分任务

编码这类 `kind: agent` 阶段不写 `planning` 时是 `planning: single`：整个阶段是一个 Task，由一个 Agent 一次做完、一次检查、一次提交。需求大了，容易超时，或者返工到 `max_retries` 用完、回退超过 `max_loops`。写成 `planning: llm` 后，阶段每一轮都先拆分、再一步一步做；写成 `planning: auto` 后，按需求评估给出的规模决定，只有大需求才拆分：

```yaml
  - id: implement
    name: 编码
    kind: agent
    agent: claude-coder
    planning: auto       # 需求评估给出的规模是 L 时，先由这个 Agent 以只读方式把需求拆成几步，再一步一步做
    inputs: [assessment]
```

- 需求评估（`kind: assess`）给出 go 时还会给出需求的规模 `size`，三档按改动范围区分，字母在各种语言下都一样：
  - `S`：一处小改动，比如改一个函数、一段文字或一项配置；
  - `M`：不用拆分、一次就能做完的普通需求；
  - `L`：要改多个模块、一次做完容易超时或返工的需求，可能先拆成几步，再一步一步做。

  侦察给提案标的大小用的是同一套字母和含义（两处的说明来自 `src/config/flow.ts` 的同一个定义），所以侦察和评估对同一条需求的判断一致。规模记在讨论记录里，Run 详情页「需求评估」的结论旁边显示「规模 L」和它的含义。评估没给规模不算出错，照常开工。ask、drop 时给了规模也照样记下，但不起作用。

  go 时评估还会给出难度 `difficulty`（`low` / `mid` / `high`），写了 `agent_candidates` 的阶段按它挑 Agent，见上面的「按难度选 Agent」。规模决定要不要拆分，难度决定交给哪个 Agent，两者各自判断。

  go 时评估还会列出预计会改的文件或目录 `touches`（仓库内的相对路径，最多 20 条）。`concurrency.per_repo` 大于 1 时，同一仓库里预计改同一处的 Run 按它错开，不同时进入编码，见下面的「同时执行几个 Run」。
- `planning: auto` 的阶段每一轮开始时，看这个 Run 最近一次 go 的评估结论：规模是 `L` 就和 `planning: llm` 一样先拆分；`S`、`M`、没给规模，或者模板里没有需求评估阶段时，和 `planning: single` 一样整个阶段是一个 Task，提示词和提交信息也和 `single` 完全一样。评审打回、审批驳回后的新一轮重新判断一次；评估结论在 Run 里不变，所以每一轮的结果都一样。小需求拆分只会多花钱，所以只拆 `L`。Run 详情页里，这种阶段的每一轮都写明按规模拆分了还是没拆；流程图在阶段的「拆分」一行写着它怎么拆分。
- 下面说的拆分和一步一步执行，对 `planning: llm` 和要拆分时的 `planning: auto` 都一样。
- 每一轮阶段开始时，先以只读方式运行阶段的 Agent 拆分任务，Run 详情页里是一个叫「拆分任务」的 Task。它读到目标、阶段的 `instructions`、`inputs`（比如 `assessment`），从第 2 轮起还有上一轮被打回的原因和上一轮的计划（见下面），按依赖顺序拆成 1 到 8 步，每一步有标题和说明；需求本来就小时只给一步。拆分不改文件、不运行检查命令、不提交；它留下的改动会被丢掉（记一条 `plan.changes_discarded` 事件）。拆分的结果列在这次执行的检查里。
- 拆好后，Master 按顺序为每一步建一个 Task，记一条 `stage.planned` 事件，数据里有阶段（`stageId`）、轮次（`round`）、拆分任务的 Task（`taskId`）和各步的标题（`tasks`）。然后一步一步执行，每一步都由阶段的 Agent 做（写了 `agent_candidates` 时是这一轮开始时选中的那个；拆分换过 Agent 也一样）：提示词里有目标、阶段的 `instructions`、这一步的说明和整个计划（哪些已经完成，哪些留给后面的步骤）。已完成的步骤下面附着它的「结果」，也就是做那一步的 Agent 最后一次通过时写的 summary（每条最多 400 字），后面的步骤由此知道前面实际做了什么、做了哪些取舍。做完后照常运行检查命令，通过后单独提交，提交信息里写着「第 2/3 步：标题」；没通过就在这一步里返工，`max_retries` 对每一步各自计算。只拆成一步时，这一步就是整个阶段，提示词和提交信息都和不拆分时一样。
- 步骤的进度在两处能看到：
  - Run 详情页：拆分任务排在这一轮的最前面，每一步的标题前写着「第 2/3 步」，阶段标题旁写着「已完成 1/3 步」（数的是已通过的步骤）。
  - 侦察摘要（侦察提示词里的「最近的 Run」）：拆成几步的轮次先写一行「编码第 1 轮：拆成 3 步」，下面每一步只算自己的执行：返工过的写「第 2/3 步「标题」：执行 2 次，返工原因：…」，没通过的写一行状态（失败，或者 Run 结束时还没执行到、还没做完；Run 被终止或者因为别的原因失败时，没做完的步骤都算后两种），顺利通过的不写；拆分本身返工过也单独写一行「编码第 1 轮的拆分：…」，不算进任何一步。没拆分、只拆成一步的轮次和以前一样，整轮的执行合在一起写一行。这样侦察和人都能看出拆得好不好、卡在哪一步。
- 拆分出错（CLI 报错、超时）或者输出不符合格式（没有 JSON、步数不在 1 到 8 之间、缺标题或说明）时，按 `on_agent_error` 处理（见上面的「Agent 出错时」），一步也不会建；格式的问题会交给下一次拆分。
- 拆分要以只读方式运行，所以阶段的 Agent 要用支持只读的 CLI（claude-code、codex），写了 `agent_candidates` 时每个候选都要，否则加载模板时报错、模板被停用。`planning: auto` 只拆分一部分 Run，但哪个 Run 都可能要拆分，所以同样要求。`planning: llm` 和 `planning: auto` 只能用在 `kind: agent` 阶段，写在评审、需求评估、命令、合并、占位阶段上同样报错。
- 评审打回、审批驳回、命令阶段失败或合并冲突回退到这个阶段时，新一轮重新拆分；打回的原因既交给拆分，也交给每一步。新一轮的拆分还会读到这个阶段上一轮的计划：每一步的标题、说明、是否通过和「结果」（summary，每条最多 400 字；没通过的步骤没有）。上一轮没有拆分时，整个阶段算一步；只拆成一步的也照样写上；拆分格式出错后重试的每一次都有。上一轮通过的步骤都已经提交，改动还在工作目录里，所以提示词要求拆分只列出这次需要做的修改步骤：改正打回的问题、补上没通过的步骤，不要重做已经通过、和打回原因无关的步骤。拆分输出的格式和之后依次执行的方式都不变。
- 拆分进行到一半被暂停、Master 重启或崩溃时，恢复后重新拆分。各步的 Task 和拆分的结果在同一个事务里记下，不会重复，也不会只建一半。
- 默认的 `self-dev.yaml` 的编码阶段是 `planning: auto`。数据目录里已经装好的 `workflows/self-dev.yaml` 不会自动更新，旧版本写的是 `planning: single`：想让大需求先拆分，就手动把编码阶段的 `planning: single` 改成 `planning: auto`（编码阶段的 Agent 要用支持只读的 CLI，默认的 `claude-coder` 就是）。保存后 Master 自动重新加载，新建的 Run 生效；已经建好的 Run 仍按建 Run 时的模板走。给 Ares.1 自己用的，也可以删掉数据目录里那份，改用仓库自带的 `.ares1/workflows/self-dev.yaml`（见「从数据目录的模板切换到仓库自带的」）。带 `planning: auto` 的完整模板见 [`docs/examples/workflows/strict.yaml`](examples/workflows/strict.yaml) 的编码阶段。

## 评审阶段不改代码

评审 Agent 只给意见，不改 Run 的代码。每次评审结束后（不管评审有没有完成），工作目录都会退回到评审开始时的提交：评审者留下的改动和它自己做的 git commit 都会丢掉，切到了别的分支或游离的 HEAD 时 Master 会切回 Run 的分支，Run 照常往下走。评审者在别的分支上做的提交留在那个分支上，不会被合并。评审进行到一半被打断时也一样：Run 被暂停或取消、Master 被升级重启或崩溃后恢复，Master 都会把 Run 的分支退回到评审开始时的提交（评审开始前记在评审任务上），再重新评审；恢复时工作目录如果已经不在了，就从分支恢复出来，在重新评审之前退回去。打断时这一步也可能失败（比如工作目录里留着 git 的锁文件，切不回 Run 的分支），这时 Master 照常暂停、停止或启动，不卡在这里，事件列表里记一条 `review.discard_deferred`，数据里有评审任务（`taskId`）、评审开始时的提交（`baseCommit`）和失败原因（`error`）；Run 再开始执行时，Master 先补做这次退回，再检查工作目录和记录是否一致（见「Run 什么时候停下来等人」里的「工作目录与记录不一致」），所以评审者切走了分支不会让 Run 因为「不在 Run 的分支上」而失败；补做也失败的才按不一致结束 Run。这条规则由 Master 执行，不只靠提示词：否则评审者自己提交的代码没经过评审，合并阶段只会重跑检查命令就合进目标分支。真的丢掉了东西时，事件列表里记一条 `review.changes_discarded`，数据里有这次评审的执行（`attemptId`）、评审开始时的提交（`fromHead`）、结束或被打断时 Run 分支所在的提交（`toHead`）、被丢掉的提交（`discardedCommits`）、有没有未提交的改动（`uncommitted`），以及切到别处时当时检出的分支（`checkedOut`，游离的 HEAD 为 `null`）。

## 命令阶段

模板里的阶段除了由 Agent 执行的 `agent`（编码）、`review`（评审）、`assess`（需求评估），由 Master 执行的 `merge`（合并）和直接通过的 `placeholder`（占位），还可以是 `kind: command`：Master 在 Run 的工作目录里依次运行这一阶段的命令，不调用 Agent。项目自己的端到端测试、冒烟测试或部署前检查（比如 playwright，或者 `docker compose up` 之后探活）都可以这样放成独立的阶段，不用为每种项目写代码：

```yaml
  - id: e2e
    name: E2E
    kind: command
    verify:
      commands: ["npx playwright test"]
    # on_fail: implement   # 命令失败时回到哪个阶段，不写就是前面最近的 Agent 阶段
    # gate: true           # 命令通过后等人审批
```

- 命令写在 `verify.commands` 里，和其他阶段一样；不写就运行仓库登记的检查命令。写成空列表是配置错误。命令阶段不能指定 `agent`、`agent_candidates`、`planning: llm` 或 `planning: auto` 和 `verify.llm_check`。
- 命令按顺序运行，有一条失败就不再往下跑。和检查命令一样不带 GitHub 和 GitLab 凭据（见上面的「Agent 拿不到 GitHub 和 GitLab 凭据」），每条命令的超时是 `config.yaml` 里的 `defaults.command_timeout_minutes`。输出写进数据目录的 `logs/<Run id>/command-<阶段轮次 id>.log`，Run 详情页在这一阶段下列出每条命令是否通过和输出的末尾。
- 全部通过：阶段通过，进入下一阶段。设了 `gate: true` 时先等人审批，审批在命令通过之后；驳回时回到 `on_reject` 指向的阶段，不写就是前面最近的 Agent 阶段。
- 有命令失败：阶段标为没通过（原因是「检查没有通过」），回退到 `on_fail` 指向的阶段，不写就是它前面最近的 Agent 阶段（通常是编码）。失败的命令、退出码和输出的末尾作为反馈交给那个阶段的 Agent。和评审打回一样计入 `max_loops`，用完后按 `on_exhausted` 处理（见下面的「返工或回退用完时」）。
- `on_fail` 指向的不是 Agent 阶段、或者前面根本没有 Agent 阶段时，没有 Agent 按失败输出改代码，同样的代码只会重跑到回退用完，加载模板时会给出警告。
- 命令阶段不提交，也不改 Run 的代码：命令跑完后（被暂停打断时也一样），工作目录会退回到这一阶段开始时的提交，命令留下的改动（生成的报告、截图等没被 git 忽略的文件）和命令自己做的 git commit 都会丢掉，不会被之后的 Agent 一起提交，也不会被合并；切到了别的分支时切回 Run 的分支。阶段通过与否照旧只看命令的退出码。真的丢掉了东西时记一条 `command.discarded_changes` 事件，数据和评审阶段的 `review.changes_discarded` 一样，只是用阶段（`stageId`）代替评审的执行（`attemptId`），见上面的「评审阶段不改代码」。被 git 忽略的文件（比如 `node_modules`、构建产物）不动。
- 阶段没写命令、仓库也没登记检查命令时，没有要运行的命令，阶段直接通过（记一个 `stage.no_commands` 事件），和没有检查命令的编码阶段一样。
- 运行到一半被暂停或 Master 重启时，恢复后这一阶段的命令全部重新运行。
- 这里不调用 Agent，所以 `escalate` 里出错重试、换 Agent、预算的设置对它不起作用，`timeout_minutes` 也不用于命令。

默认的 `self-dev.yaml` 里 E2E 阶段仍是 `kind: placeholder`，注释写了怎样改成命令阶段。数据目录里已经装好的模板不会自动更新，需要时手动改；放在仓库 `.ares1/workflows/` 里的模板跟着代码一起改（见「仓库自带的流程模板」）。带命令阶段的完整模板见 [`docs/examples/workflows/with-e2e.yaml`](examples/workflows/with-e2e.yaml)。

## 返工或回退用完时

Task 没通过检查（检查命令失败、结构化输出不合格等）时，带着问题返工；评审打回、审批被驳回、命令阶段的命令失败（见上面的「命令阶段」）、合并前同步目标分支后检查没过、合并时和目标分支冲突（见下面的「合并冲突」）时，回退到 `on_fail` / `on_reject` 指向的阶段重做。两者都有上限，用完后怎么处理由 `escalate.on_exhausted` 决定：

```yaml
defaults:
  escalate:
    max_retries: 2       # 返工次数上限，不写也是 2
    on_exhausted: fail   # 不写也是 fail
  max_loops: 3           # 同一阶段最多回退重做几轮，不写也是 3
```

- `fail`（默认）：Run 结束、标为失败，不等人。`error` 里写明是哪个 Task 返工了几次、或哪个阶段回退了几轮，以及最后一次没通过的原因（检查命令的输出、评审意见或驳回意见）。工作目录和分支保留，Master 接着做别的；issue 按 `max_run_attempts` 自动重做（见上面的「Run 失败后自动重做」），重做时这个原因会交给新 Run 的 Agent，次数用完后 issue 关闭并写明每次的原因。
- `human`：Run 卡住，等人重试或终止。重试时返工次数重新计算；回退用完的，重试会多给一轮。没人在场时 Run 会一直停在那里，加载模板时会提示改成 `fail`。
- 返工用完时取这个阶段生效的 `on_exhausted`，所以也可以按阶段写。回退不属于某个阶段，回退用完时只看 `defaults.escalate.on_exhausted`。审批被人多次驳回导致回退用完，也按它处理。
- 旧版本的 `self-dev.yaml` 没写 `on_exhausted`，按默认的 `fail` 处理；想保持以前卡住等人的做法，就加上 `on_exhausted: human`。

## 同时执行几个 Run

不同仓库的 Run 可以同时执行。同一个仓库同一时间最多执行几个 Run，由 `config.yaml` 的 `concurrency.per_repo` 决定；所有仓库合计最多执行几个，由 `concurrency.max_runs` 决定：

```yaml
concurrency:
  per_repo: 2    # 默认 1：同一仓库的 Run 一个接一个
  max_runs: 3    # 不写 = 不限：所有仓库合计同时执行的 Run 只受 per_repo 限制
```

- `per_repo` 必须是不小于 1 的整数，写 0、负数或小数时 `config.yaml` 无效。它对每个仓库分别生效；登记到同一路径的仓库（比如同一个 git 仓库按不同目标分支登记了两次，路径按解析符号链接之后的算）共用一个上限。
- `max_runs` 不写时不限，和没有这个设置时一样；写了必须是不小于 1 的整数，写 0、负数或小数时 `config.yaml` 无效。登记的仓库多了、或者调高了 `per_repo` 时，用它给同时执行的 Run 数兜底，费用、本机负载和 Agent 额度都不会随仓库数增长。
- 排队的 Run 按队列顺序开始：仓库里正在执行的 Run 少于 `per_repo` 个、并且所有仓库合计正在执行的 Run 少于 `max_runs` 个时，就开始下一个。仓库已满的 Run 被跳过，后面别的仓库的 Run 可以先开始；合计已满时这一轮不再开始任何 Run，等有 Run 结束再按队列顺序挑，所以没有哪个仓库能一直插队。等额度恢复的 Run（见「Agent 出错时」）照旧被跳过，后面的先开始。
- `per_repo` 和 `max_runs` 计入的 Run 相同：等审批、卡住、暂停和等额度恢复的 Run 不算在正在执行的 Run 里；出错后等着重试的、在合并阶段等前一个 Run 合并完的 Run 算在里面。改了 `per_repo` 或 `max_runs` 保存后立即生效：调大时排队的 Run 马上开始；调小时正在执行的 Run 照常做完，之后按新的上限开始。
- 设置了 `max_runs` 时，看板首页「正在执行」一栏写着「执行中 n / 上限 m」（按仓库筛选时 n 仍是所有仓库合计的）。因为合计已满而排队的 Run，首页的卡片和 Run 详情页写明原因。API `GET /api/config` 的 `maxRuns` 是这个上限（不限时为 `null`）；`GET /api/runs` 的各项和 `GET /api/runs/:id` 的 `waitingForMaxRuns` 为 `true` 表示这个 Run 在排队、没有在等额度恢复，并且所有仓库合计正在执行的 Run 已经达到 `max_runs`（它的仓库可能也满了）。
- 每个 Run 在自己的工作目录和分支上做，编码、评审和检查命令都同时进行。合并阶段（合入目标分支的最新代码、有新提交时重跑检查命令、快进目标分支）按仓库一个一个来：后到的 Run 等前一个合并完，再把前一个合并的提交合进来、重跑检查；没冲突就直接合并，有冲突就按下面的「合并冲突」回到 Agent 阶段解决，目标分支不会丢提交。
- `per_repo` 大于 1 时，预计改同一处的 Run 不同时往下做，免得在合并阶段冲突、返工：
  - 需求评估（`kind: assess`）给出 go 时会列出预计会改的文件或目录 `touches`：仓库内的相对路径，最多 20 条，拿不准具体文件时写到目录这一层。Master 先整理再记进讨论记录：去掉首尾空白，`\` 换成 `/`，去掉开头的 `./`、中间的 `.`、重复的 `/` 和末尾的 `/`；空项、绝对路径（`/` 或盘符开头）和含 `..` 的项被丢掉；重复的只留第一条；超过 20 条时只留前 20 条。这些都不算出错。ask、drop 时给了也不记；整理后一条不剩，就当作没给。
  - 两条路径相同，或者一条是另一条的上级目录，就算重叠。按 `/` 分段比较，不按字符串前缀：`src` 和 `src/engine` 重叠，`src/a` 和 `src/ab` 不重叠。
  - 评估阶段通过、准备进入下一个阶段时（评估阶段要审批时，是审批通过之后），如果同一执行位（登记到同一路径的仓库共用一个，和 `per_repo` 的上限一样）里有另一个 Run 正在执行或者在等 PR 合并（`pr_open`），它的合并阶段还没通过，而且两边的 `touches` 重叠，这个 Run 就让出名额回到队首：评估保持通过，进度保留，再开始时直接进入下一个阶段，不重跑评估。同时记一条 `run.waiting_conflict` 事件，数据有当时的阶段（`stageId`）、等的 Run（`blockedBy`）和重叠的路径（`paths`，每对重叠的路径取更具体的那条）。排队、暂停、等审批或卡住等人的 Run 不挡别人：它们可能要等很久，谁先往下做谁先合并。
  - 按队列顺序挑 Run 时，已经评估过、和执行中（或在等 PR 合并）的 Run 重叠的 Run 被跳过，后面不重叠的 Run 先开始；它等的 Run 换了时再记一条 `run.waiting_conflict`。挡它的 Run 合并阶段通过或者结束（完成、失败、终止或不做）后，Master 马上重新挑。
  - 为了不让排在前面的 Run 一直等：一个 Run 在队列里等某个 Run，等到对方合并阶段通过或者结束之后，对方就不能再挡它，比如对方合并后又被放回编码。这份记录在内存里，Master 重启后从 `run.waiting_conflict` 事件还原。
  - 没有评估阶段的模板、评估没给 `touches` 的 Run，不挡别人，也不被别人挡，和以前一样调度。`per_repo` 为 1 时不做这个判断，调度和以前完全一样。
  - 看板首页排队的卡片和 Run 详情页写明「等 Run X：预计改同一处（路径）」，详情页里可以点进 X；路径超过 3 条时只列前 3 条，后面写一共几处。Run 详情页的事件里也有这一条。API `GET /api/runs` 的各项和 `GET /api/runs/:id` 的 `waitingForConflict` 是 `{ runId, paths }`：这个 Run 在排队，在等 `runId` 合并或结束，`paths` 是重叠的路径；不在等时为 `null`。它不再等之后，照常等仓库和合计的名额。
  - Run 的用时里，这样错开等的时间单独算作「错开等待」，不算进「排队」：从 `run.waiting_conflict` 开始，到这个 Run 离开队列（开始执行、暂停、终止等，下一条状态不是排队的 `run.status`）为止，和 Master 重启后还原等待记录的规则相同。评估后让出名额时，事件记在回到队列之前，只从回到队列时算起；排队期间等的 Run 换了，等待照样接着算；等的 Run 合并了、但仓库名额还满着时，到真正开始执行之前也都算错开等待。这段时间里停工的部分算「停工」，不重复计算。看板 Run 详情页的用时和侦察摘要都列出这一项；issue 结束评论里的用时只分 Agent 执行、排队和等人三组，错开等待和排队同属「排队」一组（都是在等别的 Run）。API `GET /api/runs/:id` 的 `times.conflictWaitMs` 是它的毫秒数。
  - 侦察摘要（侦察提示词里的「最近的 Run」）的第一行写着当时的 `concurrency.per_repo`，以及列出的这批 Run 里，有几个的执行时间（各次 Agent 执行的起止，还在执行的算到现在）和这批里别的 Run 有重叠。等过冲突的 Run 多一行「为避开冲突等了 n 次，共 X 分钟（等 run-…，重叠路径 …）」：次数是 `run.waiting_conflict` 的条数，时长就是上面的错开等待（还在等时写「现在还在等」，这一段等完之前不计入时长），等过的 Run 去重，重叠路径去重后最多列 3 条，多出的只计数；来自陌生人 issue、还没人确认过的 Run 不列路径。某一轮以合并冲突结束时，如果从这个 Run 开始做评估之后的第一个阶段到这次冲突之间，同一执行位里有别的 Run 在执行，或者有别的 Run 的合并阶段通过了，这一行写成「并行时合并冲突（同一仓库里同时在执行或先合并了的有 run-…）」，否则和以前一样写「合并冲突」。侦察据此权衡：`per_repo` 为 1、排队时间远多于 Agent 执行时间、并行带来的错开等待和合并冲突又很少时，它可以建议人调大 `per_repo`；它只提建议，不改你的配置。
- 会改仓库共用的 git 数据的操作，也和合并排在一起一个一个来：新建 Run 的工作目录和分支、恢复被删掉的工作目录、补做被打断的评审的退回（见「评审阶段不改代码」）、合并后删掉 Run 的工作目录和分支、删掉被取代的尝试留下的工作目录（见「Run 失败后自动重做」）。排队等这些操作时，暂停、终止 Run 或停止 Master 会马上结束等待。人在看板上清理工作目录和 Master 补删遗留的工作目录不排队，只动失败或终止的 Run 自己的工作目录和分支。
- Master 重启（升级、保活脚本拉起、崩溃）后，上次正在执行的 Run 都回到队首，再按 `per_repo` 和 `max_runs` 重新开始。
- `per_repo` 大于 1 时吞吐更高，代价是：几个 Run 的准备命令和检查命令可能同时运行，更吃 CPU、内存和磁盘，命令也要能在同一台机器上同时跑（比如不能都占同一个端口）；同时做的 Run 改到同一处时会合并冲突，冲突要回到 Agent 阶段解决，返工和花费都会变多。上面按 `touches` 错开的规则降低了这个风险，但评估估计的路径不一定全，Agent 也可能改到评估没想到的地方，没有评估阶段或评估没给 `touches` 的 Run 也不参与判断，所以冲突仍可能出现。合并一个一个来，所以合并阶段的检查命令要跑很久时，后到的 Run 会在合并阶段多等一会儿。

## 合并冲突

Run 等审批或卡住等人时不算在正在执行的 Run 里，同一仓库也可以同时执行几个 Run（见上面的「同时执行几个 Run」），别的 Run 可能先合并进目标分支，所以走到合并阶段时，和目标分支冲突很常见。这时不用人懂 git：

- 合并阶段先把目标分支的最新代码合并进 Run 的分支。有冲突时，Master 放弃这次合并（工作目录保持原样），把合并阶段标为没通过（原因是「和目标分支冲突」），记下冲突的文件，回退到合并阶段 `on_fail` 指向的阶段（默认是它前面最近的 Agent 阶段，通常是编码）。反馈里列出冲突的文件，并写明要合入目标分支的最新代码、解决冲突、保留本需求的改动。
- 回退后的这一轮，每次启动 Agent 之前，Master 先在工作目录里执行 `git merge --no-commit <目标分支的最新提交>`，把冲突标记留在文件里。提示词里会说明有一个未完成的合并、列出冲突的文件，要求清除所有冲突标记、保留两边的意图，不要执行 `git commit`、`git merge --abort`、`git reset`。
- Agent 完成后，Master 先检查冲突文件里还有没有冲突标记（`git diff --check` 找到的 `<<<<<<<`、`=======`、`>>>>>>>`），有的话带着这些文件名返工；返工接着这次合并，不会重新合并。之后照常运行检查命令，通过后由 Master 提交，提交出来的是合并提交（全部按本需求这边解决、内容和原来一样时也是）。之后的评审只看本需求的改动：基线是这次合入的目标分支提交，不会把别人合并进去的改动算到这个 Run 头上。
- 这一轮中途被暂停、Master 重启或 Task 最终失败时，工作目录会回到合并之前，不留下半截的合并；下次执行时重新合并，用的是目标分支那时的最新提交。
- 冲突反复出现时，和别的回退一样受 `max_loops` 限制，用完后按 `on_exhausted` 处理（默认 Run 结束、标为失败）。
- 合并阶段的 `on_fail` 指向的不是 Agent 阶段（比如评审阶段，它不能改文件）时，没有 Agent 能解决冲突，Run 不等人，直接结束、标为失败，`error` 里列出冲突的文件；从 issue 来的按 `max_run_attempts` 自动重做（见下面的「Run 什么时候停下来等人」）。重做在目标分支的最新代码上新建工作目录，编码 Agent 从一开始就基于最新代码改，原来的冲突也就没了。加载模板时会对这种设置给出警告；想让 Agent 解决冲突，就把 `on_fail` 指向一个 Agent 阶段。
- git 合并因为冲突以外的原因失败时（git 锁、磁盘满、索引损坏等，git 没报出冲突的文件），没有冲突可解决，Run 结束、标为失败，从 issue 来的按 `max_run_attempts` 自动重做（见下面的「Run 什么时候停下来等人」）。
- 分叉时 Master 建的合并 Run 也用这套做法让 Agent 解决冲突，只是合并的是 GitHub 上的那个提交，而且从第一个会改代码的 Agent 阶段一开始就合并，不用等合并阶段冲突回退，见上面的「交给 Run 合并」。

## Run 什么时候停下来等人

Run 卡住（`blocked`）、已暂停或等审批时不算在正在执行的 Run 里（见「同时执行几个 Run」），排队的 Run 照常执行。这些只等人的 Run 也不会让仓库停止自动侦察：它们和等你处理的提案一起计入 `scout.max_proposals`，合计没到上限时照常侦察，到了上限才等你处理（见上面的「接入 GitHub」）。只有排队、执行中的 Run，等评估回复且设了超时的 Run，以及等目标分支上的改动清掉的 Run（见下面），会让侦察等它们做完。默认配置下，只有这些情况会停下来等人：

- 审批：模板里设了 `gate` 的阶段（从 issue 来的 Run 和分叉时交给 Run 合并的 Run，在仓库打开 `auto_merge` 时，合并不等审批）。
- 需求评估有疑问，等你回复，最多等 `reply_timeout_hours`（到时间评估自己决定，所以这种 Run 算作会自己往下走；设为 `null` 时一直等，算作只等人）；issue 作者不是仓库成员，等你确认需求。
- 配置为等人时：`on_agent_error: human`（包括 Agent 不可用时）、`on_exhausted: human`、`on_budget_exceeded: pause`（超出预算）。
- 仓库通过 PR 交付（`deliver: pr`）时，合并阶段检查通过后等 PR 在 GitHub 上合并（`pr_open`，看板上显示「等 PR 合并」）。这不是出了问题：不发「Run 卡住了」的通知，也没有可以重试的，PR 合并、被关掉或者需要返工时 Master 自己往下走（见上面的「接入 GitHub」）。要人在 GitHub 上审 PR、合并，所以算作只等人，计入 `scout.max_proposals`。

目标分支有未提交的改动时，Run 也会卡住（`target_dirty`），但不用你做任何决定：合并阶段要快进目标分支，而目标分支在某个目录里检出、且有已跟踪文件的改动没提交（未跟踪的文件不算），快进会动到这些改动，所以先停下，并照常发「Run 卡住了」的通知。之后 Master 大约每分钟复查一次，你提交或丢弃这些改动后，Run 会自己回到队首接着合并：重新同步目标分支，有新提交时重跑检查，再快进。不用去看板点重试（点了也行，会立刻继续）。改动还在时复查什么都不改，也不会重复通知；工作开关关着时不会自动继续，打开时马上查一次。自举时 Master 正是往开发仓库的 `main` 合并，在那里随手改了文件，处理掉就行。这种 Run 算作会自己往下走，不计入 `scout.max_proposals`。

准备命令或检查命令找不到要运行的程序时（包括 Agent 报告没做完、而检查命令要运行的程序找不到时），Run 也会卡住（`environment`，看板上显示「运行环境缺少命令」），同样不用你做决定，环境好了就自己接着做。这类问题出在 Master 的运行环境上，不在代码里：比如用 nvm 换了 Node 版本，Master 继承下来的 PATH 还指向被删掉的目录，`npm ci`、`npm test` 都找不到 `npm`。Agent 改不了 Master 的环境，返工多少次都没用，重做的 Run 在同样的环境里也会同样失败，最后把 `max_run_attempts` 用完、issue 被关掉。所以：

- 怎么判断：命令的退出码是 127（shell 找不到命令），并且在命令运行时的 PATH 里找不到命令行的第一个程序（跳过开头的 `VAR=value` 和 `env`、`exec` 这类包装，整条命令用 `&&`、`;`、`|` 拼接时只看第一段），或者找得到它、但它的 `#!` 行要的解释器找不到（比如 `npm` 开头是 `#!/usr/bin/env node`，PATH 里却没有 `node`）。第一个程序写成绝对路径时，看这个文件在不在、能不能执行。不看输出里的「command not found」，因为不同 shell 和语言下的文字不一样。
- Agent 报告没有完成（`status: incomplete`）时也做同样的判断，只是不运行命令：Agent 自己的 shell 继承的是同一个 PATH，换了 Node 版本后它往往先在自己跑的 `npm test` 里碰到找不到 `npm`，然后如实报告没做完。所以在返工之前，Task 有检查命令时先看 Master 正在用的 node 还在不在，再对每条检查命令按上面的规则取第一个程序，看它（和它 `#!` 行要的解释器）在 PATH 里找不找得到。有一个找不到，Run 就按「运行环境缺少命令」卡住，卡住的原因写明是哪条检查命令、缺哪个程序（`missing` 是那个程序；node 不在了时是 Master 的 node 路径）。不看 Agent 回复里写了什么：它写的「找不到 npm」不一定可信，也因语言而不同。都找得到时照常带着 Agent 的说明返工。
- 不算环境问题、照常返工的：第一个程序找得到，127 来自它内部（比如 npm script 里调用了仓库没装的工具，代码能修）；第一个程序是相对路径（`./scripts/check.sh`、`node_modules/.bin/vitest`），那是工作目录里的文件，归代码管；第一个词是 shell 自己执行的（`cd`、`if`、子 shell 等），这时说不清是哪一段出的错。
- 卡住时：不返工，不消耗返工次数，Run 不算失败，也不触发重做，`max_run_attempts` 不受影响。卡住的原因写明找不到哪个程序、是哪条命令（事件数据和 `blocked` 里有结构化的 `missing` 字段），按通知规则发「Run 卡住了：运行环境里找不到 npm」这样的通知，issue 上也照常说明。
- 停在哪一步：准备命令找不到程序时，工作目录还没记到 Run 上，接着做时重新创建工作目录、重新运行准备命令；Agent 做完后的检查命令找不到程序时，Agent 的改动留在工作目录里，Task 停在「验收中」，接着做时只重跑检查命令，不再让 Agent 做一遍（找不到上次执行的结果，或者它解决的合并已经不在进行中时，才从 Task 开始前的提交重做，也不算返工）；Agent 报告没有完成时，它这次的改动会撤销，Task 回到「待执行」，接着做时从 Task 开始前的提交重新执行 Agent（只重跑检查会把没做完的改动当成通过），这次执行不算返工，返工次数不变；命令阶段接着做时重跑它的命令；合并阶段刚合进目标分支的最新代码会先撤掉，接着做时重新同步、重新检查。
- 怎么接着做：Master 大约每分钟查一次，缺的程序又能在 PATH 里找到时（比如装上了），Run 自己回到队首接着做；Master 启动时（包括换了 node 后的重启，见「稳定副本和自动升级」）把所有这类 Run 都接着做一遍，因为新进程的 PATH 可能已经不一样了，仍然找不到就再卡住一次。工作开关关着时不自动接着做，打开时马上查一次。也可以在看板上点重试，立刻再跑一次。
- 这类 Run 算作只等人（环境好不好要人看），计入 `scout.max_proposals`。下一个 Run 碰到同样的问题也会同样卡住、不耗次数，所以不会因此暂停整个队列。

Agent 出错且重试、换 Agent 都用完，Agent 不可用且没有可换的 Agent（或配置为 `on_agent_error: retry`），返工或回退用完，超出预算（默认；配置为 `on_budget_exceeded: pause` 时才等人），准备命令失败，Master 内部错误，合并时 git 因冲突以外的原因失败，合并冲突但没有 Agent 阶段能解决，工作目录与记录不一致（工作目录只是被删了的除外，见下面）时，Run 不等人，直接结束、标为失败。工作目录和分支保留（同一 issue 之后有 Run 完成时自动删掉），Master 接着做别的；从 issue 来的 Run 按 `max_run_attempts` 自动重做（见上面的「Run 失败后自动重做」），重做时失败原因会交给新 Run 的 Agent。

- 超出预算：模板或 Run 设了 `budget_usd` 时，Master 每次启动 Agent 之前检查花费，越过预算的那次执行照常检查和提交，之后不再开始新的执行。默认（`on_budget_exceeded: abort`）Run 结束、标为失败，`error` 写明已花费多少、预算多少。重做的 Run 从零算花费，总花费仍然有界：每个 Run 受 `budget_usd` 限制，次数受 `max_run_attempts` 限制，当天的总花费受 `daily_budget_usd` 限制。配置为 `on_budget_exceeded: pause` 时 Run 卡住（超出预算），在看板上填一个更高的预算后重试，从停下的地方接着做；配置页会对这个设置给出警告，`on_agent_error: human`、`on_exhausted: human` 也一样。
- 准备命令失败：`error` 里写明是哪条准备命令、退出码或超时，以及输出的末尾。准备命令失败多半是偶发的或者和环境有关（依赖源连不上、安装中途出错等），重做时会在新的工作目录里重新运行。找不到要运行的程序（退出码 127）的除外：那种 Run 卡住等环境恢复，不结束（见上面）。
- Master 内部错误：Master 自己执行 Run 时出了异常（git 锁、磁盘满、命令起不来等）。`error` 以「Master 内部错误：」开头（英文为 `Master internal error:`），后面是原因。正在执行的 Agent 会被结束，这次执行记为中断（`interrupted`），没做完的 Task 标为已取消；工作目录保持出错时的样子，不回滚，方便查看。
- 合并时 git 因冲突以外的原因失败：合并阶段同步目标分支时 `git merge` 出错，但没报出冲突的文件（git 锁、磁盘满、索引损坏等）。这次合并已放弃，工作目录保持合并之前的样子。`error` 写明「合并 <目标分支> 的最新代码失败：」（英文为 `Merging the latest <目标分支> failed:`），后面是 git 的报错；合并阶段的检查里也记下这次失败。
- 合并冲突但没有 Agent 阶段能解决：合并阶段同步目标分支时有冲突，而合并阶段的 `on_fail` 指向的不是 Agent 阶段（见上面的「合并冲突」）。这次合并已放弃，目标分支没动，工作目录保持合并之前的样子。`error` 写明合并哪个目标分支的最新代码时哪些文件有冲突、为什么没有 Agent 能解决，以及重做时会基于目标分支的最新代码；合并阶段的检查里也记下这次冲突。
- 工作目录与记录不一致：Run 每次开始执行时（包括 Master 重启后），Master 都会检查它的工作目录还是不是自己留下的样子。Run 正在评审阶段、评审任务已经开始过的，检查之前 Master 先把工作目录放回 Run 的分支上评审开始时的提交（和重新评审前做的一样，见「评审阶段不改代码」）：评审中途被打断、当时没能退回（`review.discard_deferred`）时，评审者切到了别的分支或改写了 Run 的分支，补做之后就一致了，Run 照常重新评审；补做也失败的，`error` 先写补做失败的原因，再写下面的不一致说明。工作目录只是被删了（比如清理磁盘时删掉），而 Run 的分支还在时，Master 自己从分支把工作目录恢复回来（`git worktree add`），复查通过就照常接着做，不停下，事件列表里记一条 `run.workspace_restored`（数据里有路径和分支）。其他情况说明工作目录已经不可信，Run 结束、标为失败，`error` 写明原因：工作目录当前不在 Run 的分支上；提交历史和记录不一致（Master 记录的最新提交已不在分支上，比如被手动 `git reset` 或改写过）；工作目录和分支都没了；从分支恢复失败（比如分支在别处检出）或恢复后复查仍不一致。工作目录和分支按实际情况保留（`error` 末尾写明保留了哪些），不做改动，方便查看；重做会在新的工作目录里进行。在工作目录里手动加的提交不算不一致，后面的检查照常会检查它们。
- 除超出预算外，这几种情况都没有「卡住等人」的配置：要是原因确实每次都会重现，issue 会把 `max_run_attempts` 次用完，然后关闭并写明每次的原因。
- 旧版本里因为这几种情况卡住（`blocked`）的 Run 仍然可以在看板上重试或终止：准备命令失败的会重新建工作目录、重新运行准备命令；内部错误的从出错的 Task 开始重做；合并失败的重新同步目标分支；因合并冲突卡住的，可以先在工作目录里自己 `git merge`、解决冲突并提交再重试，重试时重新同步目标分支，仍有冲突就按现在的做法结束 Run，也可以直接终止；工作目录与记录不一致的会先把被删的工作目录从分支恢复回来，再以工作目录当前的提交为准接着做。

## 通知

只在需要你做点什么时通知：Run 卡住或失败、等审批、提案等人决定、迭代受阻、侦察连续失败、推送或升级失败、目标分支没能拉取 GitHub 上的新提交；Run 完成、侦察完成、迭代完成、拉取成功都不通知。通过 PR 交付（`deliver: pr`）时，等 PR 合并不通知（GitHub 会通知 PR 的评审者），PR 要求修改、CI 没过或冲突时 Run 回去返工也不通知（issue 上有评论），返工用完 `max_loops` 后按 `on_exhausted` 停下来或失败时照常通知，PR 没合并就被关掉按「Run 失败了」通知。

侦察失败（Agent 出错或超时、输出不符合约定、建临时工作目录失败等）时，事件列表里记一条 `scout.failed`（看板「事件」页能看到，标成红色），数据里有 `scoutId`、`repo`、`message`（错误信息）和 `streak`：这个仓库从最近一次侦察往回数连续失败的次数（包括这一次；自动和手动触发的都算）。额度用尽或被限流的、被 Master 停止打断的、还在进行的侦察既不计数，也不打断计数；正常结束的侦察（哪怕没找到需求）让计数从头开始。`streak` 正好到 3 时通知一次「侦察连续失败：<仓库名>」，正文是错误信息的第一行，点开是「需求」页；之后接着失败不再通知，直到有侦察正常结束、又连续失败 3 次。被 Master 停止打断的侦察也记 `scout.failed`，但不带 `streak`，不通知。

迭代的一个子 issue 用完重做次数后以失败关闭，或者被人关成不做，又没有别的子 issue 替换它时，迭代进入「受阻」，事件列表里记一条 `iteration.blocked`（看板「事件」页能看到，标成橙色），数据里有 `repo`、`iterationId`、`issue`（迭代 issue）、`position` 和 `child`（是计划里的第几步、哪个子 issue）、`reason`（`failed` 是用完重做次数，`dropped` 是被人关掉），并通知「迭代受阻：<仓库名>」，点开是看板上这个迭代的页面（`#/iterations/<id>`）。每次进入受阻通知一次；那个子 issue 被重新打开、或者侦察换个做法补了一个子 issue 替换它之后，迭代回到进行中（`iteration.unblocked`），之后再受阻会再通知。

访问 GitHub 失败（读写 issue、推送目标分支、侦察时搜索 issue 等）时，事件列表里记一条 `github.error`（数据是 `{ message }`，错误信息），并通知「GitHub 访问失败」，正文是错误信息的第一行，点开是「需求」页。一轮轮询要对每个登记的仓库做好几步，每一步都可能失败，所以按「一串连续失败」去重：从第一次失败起，到有一轮轮询对 GitHub 的访问全部成功为止，同一个错误只记一条、只通知一次，哪怕几种错误轮流出现（比如两个仓库一个返回 404、一个返回 502）也是每种各一条，不会每轮都通知。有一轮访问全部成功后重新开始，之后同样的错误再出现会再记、再通知。错误信息里可能带每次都变的内容（比如请求 id），所以一串失败最多记 20 种不同的错误，超过后这串失败不再记新的 `github.error`。看板「需求」页上的「GitHub 调用失败」不去重，始终显示最近一次失败的时间和信息，有一轮访问全部成功后消失。

目标分支和 GitHub 上的分叉了、Master 没能自动合并（`github.diverged`），或者因为检出的工作目录有未提交的改动没能快进（`github.pull_blocked`）时，通知「没能拉取 GitHub 上的新提交：<仓库名>」，正文说明原因和要你做什么：自动合并有冲突（列出冲突的文件）或者合并后哪条命令没通过，已交给 Run <id> 处理（编码 Agent 合并两边，评审并合并后自动推送），点开是这个 Run；建不了 Run，或者这个 Run 被终止、失败了，要你手动合并；检查要用的程序找不到，装好后会自动再合并；或者要处理那些改动。除了交给 Run 的，点开都是「需求」页。同一次分叉里，交给同一个 Run、要你手动合并、同一种原因都只通知一次，细节见「拉取 GitHub 上的新提交」和「交给 Run 合并」。快进成功（`github.pulled`）、分叉后自动合并成功（`github.merged_remote`）、建了合并 Run（`github.diverged_run`，由同时记的 `github.diverged` 通知）和合并 Run 因为目标分支已经有那个提交而直接完成（`run.merge_remote_obsolete`）不通知。

通知有三条通道，用同一套规则（`src/notify/notice.ts`）：

- 浏览器：在看板顶栏打开「通知」，由浏览器发，要开着至少一个看板标签页（可以在后台）。
- 系统通知：Master 自己发，不用开着看板，但要人在这台机器前。在 `config.yaml` 里打开：

```yaml
notify:
  system: true
```

系统通知按 Master 运行的平台发送：

- macOS：通知中心，通过 `osascript` 发，不用另装东西。
- Linux：`notify-send`，需要装 libnotify（Debian、Ubuntu 上是 `libnotify-bin` 包，Fedora 上是 `libnotify`），Master 也要能连上桌面会话（D-Bus）。应用名、标题和正文作为参数直接传给 `notify-send`，不经过 shell。
- 其他平台（如 Windows）不支持。

在 macOS 和 Linux 上打开 `notify.system` 后，`/api/health` 的 `systemNotify` 为 `true`，看板不再重复发浏览器通知；在不支持的平台上它为 `false`，看板照常由浏览器发，不会因为打开了这个设置反而什么都收不到。系统通知发送失败（比如 Linux 上没装 `notify-send`，没有桌面会话，`osascript` 出错，或者命令 10 秒内没有响应被终止）不重试，不影响 Master。一串连续的失败只记第一次：在 Master 的输出里记一行原因（以 `[通知]` 开头，英文为 `[notify]`），同时在事件列表里记一条全局事件 `notify.system_failed`（看板「事件」页能看到，标成红色；见上面的「全局事件」），数据是 `{ command, reason }`：`command` 是发通知的命令（`osascript` 或 `notify-send`），`reason` 是一行原因，比如找不到命令、10 秒内无响应被终止、被信号终止，或者退出码加上命令错误输出的第一行；不写完整的命令行，免得把通知正文（Run 的目标）也记进去。Master 多由保活脚本在后台启动，没人看它的输出，人回到看板时在「事件」页就能看到系统通知坏了以及原因。之后连续的失败不再记；有一条通知发送成功后，下次再失败重新记一次。这条事件本身不发通知（不发系统通知、webhook，看板也不发浏览器通知），免得失败了再发、再失败。不支持的平台上不发系统通知，也就不记这条事件。

自动升级脚本（`scripts/self-upgrade.sh`）在 Master 一个都没能启动时（找不到安装目录，回退后找不到能用的 node，或者回退后旧版本也没能启动）也发一条系统通知：有 `osascript` 就用它，否则有 `notify-send` 就用它，两个都没有就不发。这时 Master 不在运行，自己发不了 webhook，所以升级脚本和保活脚本（见「保活」）会自己把这条通知也发到配置的 webhook（见下面「webhook」里的「Master 停了、起不来时」）。这些脚本发的系统通知不受 `notify.system` 开关影响。

### webhook

第三条通道：Master 把通知 POST 到 `config.yaml` 里配置的地址，人不在这台机器前也能收到，适合 Master 跑在没有桌面的 Linux 服务器上，或者人离开了电脑。可以接 [ntfy](https://ntfy.sh)、Slack 的入站 webhook，或者你自己的服务：

```yaml
notify:
  webhook:
    url: https://ntfy.sh/<你的主题>     # 必填，只能是 http:// 或 https:// 开头的地址
    headers:                           # 可选：额外的请求头，比如鉴权；和默认的请求头同名时覆盖默认值
      Authorization: Bearer <你的 token>
    format: json                       # 可选：json（默认）/ text
```

- 不写 `webhook` 就不发，和以前一样。它和 `notify.system` 互不影响，配了就发，不需要打开 `system`；浏览器通知也照常可以开，不去重。
- 地址里不能带用户名和密码（`https://user:pass@...`），要鉴权就写在 `headers` 里（比如 `Authorization`），或者用服务自己的写法（比如 ntfy 地址后面的 `?auth=`）。请求头的值不能有换行。地址或请求头不合法时 `config.yaml` 无效，和其他配置错误一样处理。
- 每次有事件都读当前的配置，改了 `config.yaml` 保存后立即生效，不用重启。
- 发什么：和其他通道一样，只在需要人处理时发（见上面），Run 完成等不需要人处理的事件不发。每条通知 POST 一次。
- `format: json`（默认）：`Content-Type: application/json`，正文是

  ```json
  {
    "kind": "blocked",
    "title": "Run 卡住了：Agent 执行出错",
    "body": "Run 的需求的第一行",
    "text": "Run 卡住了：Agent 执行出错\nRun 的需求的第一行",
    "runId": "run_…",
    "about": "run",
    "eventType": "run.blocked",
    "at": "2026-11-23T08:00:00.000Z"
  }
  ```

  `kind` 是通知的种类（`approval`、`discussion`、`blocked`、`failed`、`proposals`、`iteration`、`scout`、`github`、`pull`、`upgrade`；只由脚本在 Master 停了、起不来时发的 `master_down`，见下面；以及人在看板上点「发一条测试通知」时发的 `test`，见下面的「测试通知」），`title`、`body` 是通知的标题和正文（按 `language` 的语言），`text` 是「标题\n正文」，`runId` 是相关的 Run（没有时为 `null`），`about` 说明点开该去哪里（`run` 是 Run 详情页，`issues` 是「需求」页，`master` 没有特定页面），`eventType` 是引起通知的事件类型，`at` 是事件发生的时间。Slack 的入站 webhook 会显示 `text`、忽略其他字段，可以直接接。
- `format: text`：`Content-Type: text/plain; charset=utf-8`，正文就是「标题\n正文」，适合 ntfy 这类直接显示正文的服务。
- 飞书、钉钉的机器人 webhook 要求固定的消息格式，不能直接接：要经过一层转发（自己的小服务把正文改成它们要的格式），或者先发到 ntfy 这类服务。
- 发出去的标题、正文和 `text` 都先把用户目录下的路径换成 `~`（和发到 GitHub 的文字一样，见「发到 GitHub 的文字不带用户目录」），不把系统用户名发给外部服务。
- `/api/health` 的 `webhookNotify` 只说明有没有配 webhook，不返回地址和请求头；看板的「说明」页和顶栏的通知开关会提一句已配置 webhook。
- 失败时：地址返回的不是 2xx（比如 500）、连不上或 10 秒内没有响应都算失败。不重试，不影响 Master。一串连续的失败只记第一次：在 Master 的输出里记一行原因（以 `[通知]` 开头，英文为 `[notify]`），同时在事件列表里记一条全局事件 `notify.webhook_failed`（看板「事件」页能看到，标成红色；见上面的「全局事件」），数据是 `{ reason, status }`：`reason` 是 HTTP 状态码或错误信息，`status` 是 HTTP 状态码（没有响应时为 `null`）。两处都不写地址和请求头，免得把里面的 token 记下来。之后连续的失败不再记；有一条通知发送成功后，下次再失败重新记一次（webhook 恢复后又坏掉，人回来时在「事件」页能看到）；改了 `notify.webhook.url`（配置重新加载后）再失败时也重新记一次。这条事件本身不发通知（不发系统通知，也不再发到 webhook），免得失败了再发、再失败。
- Master 停止时（SIGTERM、Ctrl-C、重启、交给自动升级）：不再发新的通知，但先等已经发出、还没收到响应的通知发完，最多等 10 秒（webhook 的超时），再关闭数据库退出。所以停止前一刻产生的通知（比如侦察完成时待人采纳的提案、Run 卡住、等待审批）不会因为 Master 退出而丢掉；这期间发送失败的，照常记 `notify.webhook_failed`。10 秒后还没发完的被中止，在 Master 的输出里记一行放弃了几条（以 `[通知]` 开头），不记 `notify.webhook_failed`：原因是 Master 自己在停止，不是 webhook 坏了，也不影响上面那一串失败的记录。没有在途的通知时不多等。自动升级脚本最多等旧 Master 退出两分钟，这 10 秒不会让升级超时。
- Master 停了、起不来时：这时 Master 自己发不了，由脚本发。保活脚本（见「保活」）在 Master 停了、它没能启动起来时，自动升级脚本在 Master 一个都没能启动时（见上面的系统通知），除了系统通知，也把同一条通知 POST 到 webhook。
  - 脚本不读 `config.yaml`，用的是 Master 写下的设置：Master 启动时、每次配置重新加载成功后，把 webhook 的地址、请求头（和上面一样，默认的 `Content-Type` 被同名的覆盖）和 `format` 写进数据目录的 `webhook.curl`（curl 能直接读的配置文件，先写临时文件再改名，脚本不会读到写了一半的）；去掉 `webhook` 后删掉这个文件，重新加载失败、沿用旧配置时不动它。所以脚本用的是最近一次运行的 Master 写下的设置：Master 一次都没运行过（没写过这个文件），或者停机期间才改了 `config.yaml`，都不会生效，要等 Master 再运行一次。
  - `webhook.curl` 里有地址和请求头，可能带 token，所以权限是 0600，只有你能读。Master 正常停止时不删它，脚本正是要在 Master 不在运行时用它。
  - 每条通知 POST 一次，用 `curl`（`-q -K webhook.curl`，最多等 10 秒），不需要 node 和 jq（这时可能正是 node 找不到）；没有这个文件或者没有 `curl` 就不发，其他照旧。`-q` 让 curl 不读你自己的 curl 配置（`~/.curlrc`，或者 `$CURL_HOME`、`$XDG_CONFIG_HOME` 下的），只用 Master 写下的设置：那里的代理、`--trace`、额外请求头之类的设置不会改变这次发送，也不会把地址和请求头写进跟踪文件。保活脚本和系统通知一样，同一次停转只发一次。
  - `format: json` 时字段和上面一样：`kind` 是 `master_down`，`title` 是通知标题（展示名），`body` 是系统通知里的那句话，`text` 是「标题\n正文」，`runId` 为 `null`，`about` 是 `master`，`eventType` 保活脚本是 `keepalive.alert`、升级脚本是 `upgrade.master_down`，`at` 是发送的时间（精确到秒，比如 `2026-11-23T08:00:00Z`）。`format: text` 时正文是「标题\n正文」。正文里以用户目录开头的路径同样换成 `~`。
  - 失败时（不是 2xx、连不上或 10 秒内没有响应）不重试，不影响脚本的退出码，只在各自的日志里记一行（保活脚本在 `keepalive.log`，升级脚本在 `upgrade.log`），只写 curl 的退出码（比如 7 是连不上，22 是返回了错误状态码，28 是超时），不写地址和请求头。

### 测试通知

配好 `notify.system` 或 `notify.webhook` 后，不用等到真有 Run 卡住才知道通道通不通：在看板「说明」页的「会在什么时候通知你」一节点「发一条测试通知」，Master 立即按当前的配置（改了 `config.yaml` 保存后不用重启）向打开的每条通道各发一条，等结果都回来（webhook 最多等 10 秒）再在按钮旁逐条显示：

- 系统通知：在 macOS、Linux 上打开了 `notify.system` 时发，标题是「测试通知」，正文是「这是一条测试通知，收到说明通知通道可用。」（按 `language` 的语言）。命令正常结束显示「已交给系统显示」：这不保证一定弹出来了，勿扰、专注模式或者没允许通知都可能拦下，没看到要去检查系统的通知设置。命令失败时显示原因，写法和 `notify.system_failed` 的原因一样，比如 Linux 上没装 `notify-send`、命令的退出码加上它错误输出的第一行、10 秒内无响应被终止；不显示完整的命令行。没打开时显示「没有打开」，Master 所在的平台不支持（比如 Windows）时显示「不支持」，都不执行任何命令。
- webhook：配了 `notify.webhook` 时 POST 一条，格式和真实的通知一样（`format: json` 时 `kind` 是 `test`，`eventType` 是 `notify.test`，`runId` 为 `null`，`about` 是 `master`，`at` 是发送的时间；`format: text` 时正文是「标题\n正文」），文字同样把用户目录换成 `~`。返回 2xx 时显示「对方已接收」和状态码；失败时显示 HTTP 状态码或错误原因（连不上、10 秒内没有响应等），不显示地址和请求头。没配时显示「没有配置」。

两条通道都没有（没打开 `notify.system` 或平台不支持，也没配 `notify.webhook`）时按钮不能点，旁边写明要先配哪个。浏览器通知不经过 Master，不在测试之列。

测试通知不是由事件引起的，不记任何事件。测试发送失败不记 `notify.webhook_failed` 或 `notify.system_failed`，也不在 Master 的输出里记一行，结果只返回给按钮；它也不影响真实通知的失败记录：测试失败后真实通知第一次失败照样记，测试成功也不结束真实通知连续失败的那一串。

对应的 API 是 `POST /api/notify/test`（不需要请求体），返回

```json
{
  "system": { "enabled": true, "supported": true, "ok": true, "reason": null },
  "webhook": { "enabled": true, "ok": false, "status": 500, "reason": "HTTP 500 Internal Server Error" }
}
```

`enabled` 说明这条通道这次有没有发（`system` 要打开了 `notify.system` 且平台支持，`webhook` 要配了 `notify.webhook`），`ok` 说明发成功了没有，`reason` 是失败的原因（按 Master 的 `language`，不含 webhook 的地址和请求头；成功或没发时为 `null`）；`system.supported` 说明 Master 所在的平台支不支持系统通知，`webhook.status` 是 webhook 返回的 HTTP 状态码（没有响应或没发时为 `null`）。

## 稳定副本和自动升级

自举时，Master 不从开发仓库运行，而是从开发仓库的一份克隆（稳定副本）运行。Run 合并进开发仓库后，稳定副本就落后于它的 origin。这时 Master 不再开始新的 Run，等手上的工作（所有仓库正在执行的 Run 和侦察）做完，再拉取、构建并重启自己；任何一步失败都会回退到旧版本（新版本已经迁移过的数据库怎么处理，见下面的「回退时的数据库」）。

```bash
git clone <开发仓库路径> ~/ares1-stable
cd ~/ares1-stable && npm ci && npm run build
nohup node dist/cli.js --home ~/.ares1 >> ~/.ares1/master.out 2>&1 &
```

然后在 `config.yaml` 里打开自动升级：

```yaml
upgrade:
  auto: true
```

升级过程记在 `~/.ares1/upgrade.log`。如果稳定副本里有本地改动，或者和 origin 分叉了，升级会停下来，等你手动整理好。

回退时复用升级前的依赖，不重新下载。`npm ci` 一开始就会删掉已有的 `node_modules`：npm 源出故障（registry 不可用、网络抖动、代理出错）时，新版本的依赖装不上，旧版本的依赖也没了，回退后起不来；保活脚本只执行 `node dist/cli.js`、不装依赖，也救不回来。所以升级脚本在拉取之前，先把稳定副本里的 `node_modules` 改名成 `node_modules.ares1-prev`（只改名、不复制；上次留下的同名目录先删掉；仓库的 `.gitignore` 忽略它，不算本地改动）。回退时，不管 `git reset` 成没成功，都先删掉新版本留下的、可能只装了一半的 `node_modules`，把备份改名回来，再只执行 `npm run build`，用旧依赖重新构建旧版本的 `dist`，不执行 `npm ci`；只有升级前就没有 `node_modules` 时，才照旧执行 `npm ci && npm run build`。这次构建失败也照样启动旧版本，起不来时照常发通知。观察期满新版本还在运行时，脚本删掉备份；新版本在观察期内以退出码 0 退出时备份留着（它可能把位置交给了下一次升级，下一次升级的脚本也许已经把 `node_modules` 改名成了同一个备份目录），下一次升级开始时再删。

新版本启动后，升级脚本先等它的 `/api/health` 有响应（最多一分钟），没有响应就结束它、回退。有响应以后，脚本不马上退出，而是再观察它一段时间（观察期，默认 5 分钟），每 5 秒看一次进程还在不在，免得新版本在第一次轮询 issue、第一次跑 Run 或侦察时才崩溃，进程一退出，系统就停转了，也没有人知道：

- 观察期内新版本以非 0 的退出码退出（崩溃、未捕获的异常、被信号杀掉）：和启动后没有响应一样处理，记为升级失败，回退到旧版本、重新构建并启动。消息写成「新版本 xxx 启动后 N 分钟内退出（退出码 c），已回退到 yyy」，`detail` 是新版本这次启动写进 `master.out` 的内容。回退后启动的旧版本不再观察。
- 观察期内新版本以退出码 0 退出：说明是有意停止的（有人用 SIGTERM 或 Ctrl-C 停了它，或者它又发现了更新的提交、把自己交给了下一次升级），不回退，脚本照常结束。
- 观察期满新版本还在运行：升级成功，脚本结束。

Master 收到 SIGTERM 或 SIGINT 后停下工作、关闭服务，等已经发出的 webhook 通知发完（最多 10 秒，见「通知」的「webhook」），再关闭数据库，然后以退出码 0 退出；如果停止过程中出错，它把错误打印出来，以退出码 1 退出，这在观察期内同样算崩溃、会回退。`npm test` 里的冒烟测试（`test/cli.smoke.test.ts`）以子进程启动构建出的 Master，检查它能在空数据目录上启动、`/api/health` 有响应、SIGTERM 后以退出码 0 退出，这类问题在合并前就会被检查命令拦下。

所以观察期内要停止 Master，用 SIGTERM（`kill <pid>`、`pkill -f ...`，下面「手动升级」的做法）或 Ctrl-C；用 `kill -9` 强行结束会被当成崩溃，回退到旧版本。观察期的长度由 Master 进程的环境变量 `ARES1_UPGRADE_WATCH` 决定（单位秒，默认 300，设为 0 就不观察），升级脚本从 Master 继承它。

观察期内新版本可能又发起下一次升级，所以 Master 每次把升级脚本复制成数据目录里的 `self-upgrade.sh` 时，都是先写一个临时文件再改名换上去，不会改写还在运行的那一份；脚本自己也把要花时间的步骤都放在一个函数里，bash 先读完整个函数再执行。

新版本启动时就读到了「升级成功」的结果（脚本在启动它之前写下），观察期内崩溃时脚本再写一份失败的结果，回退后的旧版本读到它：失败的目标仍然是新版本的提交，`upgrade.failed` 事件和侦察提示词里的「Master 自动升级失败」一节都照常出现，这个提交也不会再试。

升级的目标是 Master 检查时看到的 origin 最新提交，脚本只快进到这个提交。拉取、构建、启动某个目标失败，或者它在观察期内崩溃后，这个目标只试一次，不会每轮检查都重试；等 origin 有更新的提交再试。例如稳定副本里有和新提交冲突的未跟踪文件时，快进会失败，Master 回退到旧版本接着工作，删掉这些文件后要等下一个新提交才会再升级。

例外是环境问题：升级脚本找不到能用的 node，或者找不到 npm（构建的退出码是 127）时，在结果文件里写 `env: true`，消息写明是运行环境的问题、不是这个提交的问题。Master 照样记下这次失败（`upgrade.failed` 事件带 `env: true`，「最近一次升级失败」也照常更新，并标明是环境造成的），但不把这个提交记成失败过，等一会儿再试同一个提交：第一次等一个检查周期（2 分钟），同一个提交每再因为环境失败一次，等待时间翻一倍，最长 1 小时，免得环境一直坏着时每隔几分钟就停一次 Master、重新构建。等待期间看板「需求」页的升级状态是「跳过」，写明什么时候再试。同一个提交因为环境反复失败时，只有第一次发通知（之后的事件带 `repeated: true`）。升级成功、或者因为别的原因失败后，等待清零。

升级失败的原因会交给 Master 自身仓库的侦察，让系统自己修好坏掉的版本：

- 脚本把出错的输出末尾（最后 60 行，最多约 8000 个字符）写进结果文件的 `detail`：拉取或构建失败时是 `git` 和 `npm` 的输出，新版本启动后没有响应或在观察期内崩溃时是它这次启动写进 `master.out` 的内容（不含之前的旧日志）。
- 下一次启动的 Master 把它放进 `upgrade.failed` 事件数据的 `detail` 字段（看板「事件」页能展开看），并记下「最近一次升级失败」（起点、目标提交、消息、输出末尾、时间，是否因为环境失败），直到有一次升级成功才清掉。
- Master 启动时读稳定副本的 origin（`git remote get-url origin`），判断哪个登记的仓库是它自己的源码：origin 是本地路径时，和仓库的目录比较（都解析符号链接后）；是 GitHub 地址时，和仓库在 GitHub 上的名字比较（不区分大小写）。
- 这个仓库的侦察提示词里，「最近的 Run」前面会多出一节「Master 自动升级失败」，列出目标提交、失败消息和输出末尾（用户目录换成 `~`，因为提案会发到 GitHub），并要求侦察把修复作为最高优先级；如果输出表明是网络、npm 源这类环境问题，就不要硬提代码修复。修复合并后，下一次升级自然成功，这一节随之消失。
- 因为环境失败（结果文件带 `env: true`，见上面）时，这一节的标题改成「Master 自动升级因运行环境失败」，目标提交、失败消息和输出末尾照列，但不再要求侦察优先修复：它写明这次失败和提交的代码无关、Master 会等一会儿自己再试，让侦察不要为此提代码修复，也不要排在其他线索前面；只有输出表明仓库里的脚本（比如 `scripts/find-node.sh`、`scripts/self-upgrade.sh`）本身有缺陷时才提。这样侦察不会把提案名额花在和代码无关的问题上。
- 其他仓库的侦察不受影响；不是从稳定副本运行（比如 `npm run dev`），或者 origin 和哪个仓库都对不上时，什么也不做。

### 换 Node 版本时

用 nvm 这类工具换 Node 版本很平常，但它会删掉旧版本的目录，比如 `~/.nvm/versions/node/v24.22.1`。正在运行的 Master 不受影响（进程已经在内存里），可它的 `process.execPath` 和 PATH 还指向那个目录，它启动的检查命令就找不到 `node`、`npm` 了。Master 这样处理：

- 发现自己的 node 没了：升级检查（每 2 分钟一次，Run 状态变化时也会马上查一次）和每次运行准备命令、检查命令之前，Master 都看一下 `process.execPath` 还在不在。不在了，就不再运行这些命令（Run 停在「运行环境缺少命令」上，见「Run 什么时候停下来等人」，不返工、不耗次数），而是在 `master.out` 里打一行原因，事件里记一条 `master.node_missing`（数据里有原来的 node 路径和当前提交，看板「事件」页能看到），看板「需求」页的升级状态显示原因，然后通过升级脚本在当前版本上重启：目标就是当前提交（事件 `upgrade.started` 的 `from` 和 `to` 相同，带 `reason: node_missing`）。这和自动升级一样交给 `self-upgrade.sh`，但不等手上的 Run 和侦察做完（反正检查命令跑不了），直接停下它们：执行中的 Run 按重启后恢复的流程接着做，因为环境问题卡住的 Run 也会在新的 Master 启动时接着做。这一步不看 `upgrade.auto` 和工作开关：它只是让 Master 活下去，不换版本。不是从稳定副本的构建启动的 Master（比如 `npm run dev`）不能自己重启，只发一条「Master 自动升级失败」的通知，请你手动重启。
- 升级脚本怎么找 node：脚本拿到的是旧 Master 的 node 路径。构建之前、启动之前、回退之前，它都先找一次要用的 node（回退前再找一次，因为这期间 node 可能又换了）。找 node 的办法只在 `scripts/find-node.sh` 一处定义，升级脚本和保活脚本都用它。按顺序取第一个能执行、版本又满足当前 `package.json` 里 `engines.node` 的：
  1. 给定的 node（路径，或者在 PATH 里查的名字）；
  2. PATH 里的每一个 `node`，按顺序；
  3. nvm 的默认版本：`$NVM_DIR`（没设时是 `~/.nvm`）下的 `alias/default`，顺着别名找下去（`lts/*`、别名指向别名都行），解析成已经装好的版本里匹配的最高的一个，支持 `v26`、`26`、`24.22`，`node` 和 `stable` 表示装好的最高版本；
  4. 常见的安装位置：`/opt/homebrew/bin`、`/usr/local/bin`（环境变量 `ARES1_NODE_DIRS` 可以换成别的目录，用冒号分隔）。

  版本只认 `>=X`、`>=X.Y`、`>=X.Y.Z` 这种写法，别的写法（或者没写）就只要求能执行。找到后把它所在的目录放到 PATH 最前面，`npm` 和新启动的 Master 都用这一套，Master 再启动的 Agent 和命令也一样。换用了别的 node 时，`upgrade.log` 里会写一行，说明原来那个为什么用不了、换成了哪个路径、什么版本。
- 都找不到时：构建前找不到，就按环境问题记为升级失败（见上面），回退；回退前也找不到，脚本没法启动 Master，就记日志、发一条系统通知（配了 webhook 的话也发到 webhook，见「通知」的「webhook」）后退出，这时要你手动处理（装了保活的话，保活脚本每分钟用同样的办法再找一次）。
- 升级脚本复制到数据目录运行（`data/self-upgrade.sh`），`find-node.sh` 和发 webhook 通知的 `webhook.sh` 也一起复制过去（`data/find-node.sh`、`data/webhook.sh`），脚本从自己所在的目录读它们，不从安装目录读，免得拉取时被改写。

所以换 Node 版本后什么都不用做：几分钟内 Master 会自己换到新的 node 上重启，卡住的 Run 接着做。只要新的 node 能被上面的办法找到：最稳的是让 nvm 的默认版本（`nvm alias default <版本>`）指向装好的、满足 `engines` 的版本。

### 回退时的数据库

新版本如果带了数据库迁移，一启动就会把数据库（`data/ares1.db`）迁移到新的版本，迁移前先把原来的库备份成同一目录下的 `ares1.db.bak-v<旧版本>-<时间>`。

每份备份都是整个库的完整拷贝，所以只保留最近 5 份：迁移全部成功后，按文件名里的时间（不看修改时间）留下包括这次新建的在内最新的 5 份，更早的删掉。回退只需要最新的一份，多留几份够连续几次升级出问题时排查、手动恢复。只删名字严格是 `ares1.db.bak-v<数字>-<时间>` 的文件；带 `-wal`、`-shm` 后缀的、`.newer-v…`、`.restoring-…`、你自己复制出来改过名的拷贝都不动，想长期留着的备份改个名字（比如在末尾加 `.keep`）就不会被删。删除失败只在 Master 的输出里打一行警告，照常启动。迁移中途失败时不清理，免得反复启动失败做出的备份把回退要用的那份挤掉。

回退只把代码退回旧提交、重新构建，不动数据库，所以回退后启动的旧版本会发现数据库比自己支持的版本新。这时它在数据库所在目录里找版本号正好等于自己所支持版本的备份（`ares1.db.bak-v<N>-*`，`N` 后面紧跟 `-`，有好几份时取时间最新的一份；一次升级跨了好几个迁移也一样，备份的版本号就是旧版本的），找到了就：

- 先把备份复制一份、确认它的版本对得上，再把较新的数据库连同它的 `-wal`、`-shm` 改名成 `ares1.db.newer-v<较新的版本>-<时间>`（`-wal`、`-shm` 的后缀照原样保留），留着不删，以后再升级时可以找回；
- 把备份的那份副本换成 `ares1.db`，打开后照常工作，备份本身不动；
- 在 Master 的输出（`master.out`）里打一行说明，写明恢复了哪个备份、较新的库移到了哪里，事件列表里记一条 `store.backup_restored`（看板「事件」页能看到，写明恢复了哪个备份），数据里有 `backup`、`movedTo`、`fromVersion`（较新的库的版本）和 `toVersion`（恢复后的版本）。

代价是新版本迁移以后记下的进度都会丢掉，通常就是观察期内它做的事：推进过的 Run、侦察、事件等等。恢复后 Run 的记录会比工作目录旧，这交给现有的工作目录一致性检查（见「Run 什么时候停下来等人」里的「工作目录与记录不一致」）：Run 再开始执行时，记录对不上的就结束、标为失败，从 issue 来的 Run 随后自动重做（见「Run 失败后自动重做」）；对得上的照常接着做。不另做处理。

找不到版本号正好匹配的备份时（比如只有更早版本的 `ares1.db.bak-v1-…`），旧版本和以前一样拒绝启动，报「数据库版本比当前 Master 支持的更新」，错误信息里写明备份所在的目录和文件名格式，数据库文件原样不动；备份的实际版本和文件名对不上、复制失败时也一样拒绝启动，不再试别的备份。这时可以升级 Master，或者手动处理：停掉 Master，把 `ares1.db` 和它的 `-wal`、`-shm` 移开，挑一份版本不超过当前 Master 支持版本的备份复制成 `ares1.db`（版本更早的会在启动时再迁移上来）。

这一步在 Master 打开数据库时做，不只在自动升级回退时生效：保活脚本拉起的旧版本、你手动退回旧版本启动时都一样。所以如果你有意用了一段时间新版本，再手动降级，也会恢复到当时迁移前的备份，丢掉那之后的进度。较新的库还以 `ares1.db.newer-v…` 留着：重新升级到新版本后，停掉 Master，把 `ares1.db` 和它的 `-wal`、`-shm` 移开，把 `.newer-v…` 那个文件（连同同名带 `-wal`、`-shm` 后缀的文件，如果有的话）改回 `ares1.db`（及 `ares1.db-wal`、`ares1.db-shm`），再启动即可找回。

## 保活

升级脚本只在观察期内看着 Master，观察期一过就退出了。之后 Master 崩溃、被 `kill -9`、被系统杀掉（比如内存不够），或者机器重启、用户注销，都没有人把它拉起来，系统就停转了。`scripts/keepalive.sh` 补上这一块：交给系统的定时机制每分钟调用一次，每次只检查一次就退出，Master 停了就把它启动起来。

```bash
scripts/keepalive.sh <安装目录> <数据目录> [<端口>] [<node 路径>] [<通知标题>]
```

- 安装目录：稳定副本，要已经构建过（有 `dist/cli.js`）。
- 数据目录：和启动 Master 时的 `--home` 一样。Master 要用 `--home <数据目录>` 启动（本文的启动命令都是这样），脚本靠命令行里的 `dist/cli.js --home <数据目录>` 认出它。
- 端口：不传或传空字符串时，读 `config.yaml` 顶层的 `port`，读不到就用 4870。
- node 路径：不传（或传空字符串）时用 PATH 里的 `node`。给定的 node 不存在、不能执行，或者版本不满足安装目录 `package.json` 里的 `engines.node` 时，脚本用和升级脚本一样的办法（`scripts/find-node.sh`，见「换 Node 版本时」）换一个：PATH 里的其他 `node`、nvm 的默认版本、常见的安装位置，并在 `keepalive.log` 里写一行换成了哪个。脚本把最后用的 node 所在的目录放到 PATH 最前面再启动 Master，Master 和它启动的 Agent 用同一个 node。
- 通知标题：系统通知和 webhook 通知的标题，默认 `Master`。
- 日志和通知的语言按 `config.yaml` 的 `language`。

每次调用按顺序判断：

1. `http://127.0.0.1:<端口>/api/health` 有响应：什么也不做，退出 0，也不写日志，免得每分钟一行把日志撑大。
2. 有正在进行的自动升级（有命令行里同时带 `self-upgrade.sh` 和这个数据目录的进程）：不插手，退出 0。升级脚本自己会停掉、启动或回退 Master，观察期也归它管，保活脚本这时再启动一个，就会有两个 Master 用同一个数据目录。升级脚本退出（观察期满，或者回退完）以后，保活脚本才接着看管。
3. 另一次调用正在进行（数据目录里有 `keepalive.lock` 目录）：退出 0。所以连续或同时调用两次只会启动一个 Master。锁目录超过 5 分钟还在，说明是被强行结束的调用留下的，会被清掉。
4. 有命令行带 `dist/cli.js --home <数据目录>` 的进程，但 health 没有响应（卡住了，或者还在启动）：不强行结束它，只在日志里记一笔，退出 0。真卡死了要你看 `master.out` 自己处理。
5. 端口被别的进程占着（连得上，但不是 Master 的 health）：不启动，在日志里记一笔，发一条系统通知，退出 0。
6. 其他情况：在安装目录里用和升级脚本一样的方式启动 Master（`nohup node dist/cli.js --home <数据目录> >> <数据目录>/master.out 2>&1 &`），最多等一分钟看 health 有没有响应。有响应就在 `keepalive.log` 里写一行带时间的记录（pid、几秒后有响应）。启动的 Master 退出了，或者一分钟内没有响应，也写一行，并发一条系统通知，脚本以退出码 1 结束；启动后没响应的进程不会被结束，下一次调用按第 4 条处理。

只看端口不够：两个 Master 用同一个数据目录很危险。Master 启动时先恢复 Run 的状态、再监听端口，第二个实例在发现端口被占之前就已经改了数据库。所以只要有这个数据目录的 Master 进程（卡住的、正在启动的、手动启动的），保活脚本就不会再启动一个。

系统通知和升级脚本一样：有 `osascript` 就用它，否则有 `notify-send` 就用它，都没有就不发。配置了 `notify.webhook` 时，同一条通知也 POST 到 webhook（`kind` 为 `master_down`，`eventType` 为 `keepalive.alert`），用的是最近一次运行的 Master 留在数据目录 `webhook.curl` 里的设置，人不在这台机器前、或者在没有桌面的服务器上也能收到；发送失败只在 `keepalive.log` 里记一行 curl 的退出码（见「通知」的「webhook」）。同一次停转只通知一次（系统通知和 webhook 都是）：数据目录里的 `keepalive.notified` 记着已经通知过，Master 重新有响应后删掉，之后再起不来会再通知。找不到安装目录、能用的 node 或 curl 时也记日志、发通知（找不到 curl 时发不了 webhook）。

所以：

- Master 崩溃、被 `kill -9`、被系统杀掉之后，下一次调用（最多一分钟）就把它拉起来；机器重启或重新登录后，定时任务一跑也会把它拉起来。正在执行的 Run 由新启动的 Master 照常恢复。
- 新启动的 Master 发现上一个是异常退出的，会在事件里记一条 `master.restarted`，看板「事件」页能看到，写明上一个 Master 的 pid 和启动时间。Master 启动时在数据目录写 `data/master-running.json`（pid 和启动时间），正常停止（SIGTERM、Ctrl-C、交给自动升级）时删掉；启动时发现它还在，说明上一个没有正常停止（崩溃、`kill -9`、被系统杀掉、断电），事件数据里是上一个 Master 的 `pid` 和 `startedAt`。不管是保活脚本、升级脚本还是你自己启动的，都一样记。
- 观察期内新版本崩溃仍由升级脚本回退；回退后旧版本也起不来时，升级脚本发通知后退出，之后保活脚本每分钟再试一次。
- 想有意停掉 Master（比如下面的「手动升级」），要先停掉定时任务，否则一分钟内它又会被拉起来，做完再打开。

下面的例子假设稳定副本在 `~/ares1-stable`、数据目录是 `~/.ares1`，换成你自己的路径。定时任务的 PATH 很短，例子里都显式设了 PATH，要包含 node、git、gh 和用到的 Agent CLI（claude、cursor-agent、codex）所在的目录（用 `command -v node git gh claude cursor-agent codex` 查）；node 不在 PATH 里时，也可以作为第四个参数传进去。

node 参数怎么填最稳：

- 最好不传，或者只写 `node`，在 plist、systemd 单元或 crontab 的 PATH 里给出 node 所在的目录。也可以干脆不管：PATH 里找不到时，脚本会去找 nvm 的默认版本和 `/opt/homebrew/bin`、`/usr/local/bin`。
- 用 nvm 时，不建议把带版本号的路径（比如 `~/.nvm/versions/node/v24.22.1/bin/node`）作为参数传进去或写进 PATH：nvm 换版本时会删掉它。写了也不会因此停转（这个路径没了，脚本会换一个并记一行日志），但每次启动都要多找一遍，日志里也会一直提醒。
- 换了 Node 版本以后，确认 `nvm alias default` 指向的是装好的、满足 `engines` 的版本，这样升级脚本和保活脚本都能找到它。

### macOS：launchd

存成 `~/Library/LaunchAgents/com.ares1.keepalive.plist`。launchd 不展开 `~` 和 `$HOME`，路径要写全（下面的 `/Users/me` 换成你的用户目录）：

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.ares1.keepalive</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>/Users/me/ares1-stable/scripts/keepalive.sh</string>
    <string>/Users/me/ares1-stable</string>
    <string>/Users/me/.ares1</string>
  </array>
  <key>StartInterval</key>
  <integer>60</integer>
  <key>RunAtLoad</key>
  <true/>
  <!-- 必须为 true：否则脚本一结束，launchd 会把同一进程组里刚启动的 Master 一起杀掉 -->
  <key>AbandonProcessGroup</key>
  <true/>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/opt/homebrew/bin:/usr/local/bin:/Users/me/.local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
  <!-- 脚本平时什么也不输出，只有参数错了才往这里写 -->
  <key>StandardErrorPath</key>
  <string>/Users/me/.ares1/keepalive.err</string>
</dict>
</plist>
```

```bash
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.ares1.keepalive.plist   # 打开
launchctl bootout gui/$(id -u)/com.ares1.keepalive                                   # 停掉
```

LaunchAgent 在你登录后运行，机器重启后要登录才会把 Master 拉起来（可以打开自动登录）。

### Linux：systemd timer

用户级的单元，`~/.config/systemd/user/ares1-keepalive.service`：

```ini
[Unit]
Description=Ares.1 keepalive

[Service]
Type=oneshot
ExecStart=/bin/bash %h/ares1-stable/scripts/keepalive.sh %h/ares1-stable %h/.ares1
# 必须设：否则脚本一结束，systemd 会把同一个 cgroup 里刚启动的 Master 一起清掉
KillMode=process
Environment=PATH=%h/.local/bin:/usr/local/bin:/usr/bin:/bin
```

`~/.config/systemd/user/ares1-keepalive.timer`：

```ini
[Unit]
Description=Ares.1 keepalive every minute

[Timer]
OnCalendar=minutely

[Install]
WantedBy=timers.target
```

```bash
systemctl --user daemon-reload
systemctl --user enable --now ares1-keepalive.timer   # 打开
loginctl enable-linger "$USER"                         # 注销后、开机还没登录时也运行
systemctl --user stop ares1-keepalive.timer            # 停掉（disable 后开机也不再运行）
```

不打开 linger 的话，用户注销后用户级的 systemd 会停掉，定时任务不再运行。Master 留在 keepalive 服务的 cgroup 里，下一次触发时 systemd 会提示有残留的进程（`Found left-over process`），不影响运行。没有桌面会话时 `notify-send` 发不出去，看 `keepalive.log`；想在别处收到 Master 停了的通知，配置 `notify.webhook`（见「通知」的「webhook」）。

### Linux：cron

没有 systemd 时用 cron（`crontab -e`），每分钟一次：

```
PATH=/usr/local/bin:/usr/bin:/bin
* * * * * /bin/bash "$HOME/ares1-stable/scripts/keepalive.sh" "$HOME/ares1-stable" "$HOME/.ares1"
```

cron 不会在任务结束后结束它启动的进程。停掉时把这一行注释掉。机器重启后 cron 起来就会接着调用。

## 手动升级

没有打开自动升级时，按下面的步骤升级。停止 Master 时，正在执行的 Run（每个仓库最多 `concurrency.per_repo` 个）都会按开始执行的先后回到队首。打开了保活的定时任务时，先停掉它（见上面的「保活」），升级完再打开，否则停掉的 Master 会在构建过程中被拉起来。

```bash
pkill -f "dist/cli.js --home $HOME/.ares1"
cd ~/ares1-stable && git pull --ff-only && npm ci && npm run build
nohup node dist/cli.js --home ~/.ares1 >> ~/.ares1/master.out 2>&1 &
```
