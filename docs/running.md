# 运行和升级

## 安装和启动

需要 Node.js >= 24 和 git。要用的 Agent CLI（Claude Code 的 `claude`、`cursor-agent`）需要先装好并登录。

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
| `config.yaml` | 全局配置：语言、端口、GitHub、通知、自动升级 |
| `agents.yaml` | Agent 定义（CLI + 模型 + 运行参数） |
| `workflows/` | 流程模板 |
| `data/ares1.db` | 运行状态（SQLite），升级迁移前自动备份成 `ares1.db.bak-v<版本>-<时间>`，只保留最近 5 份，更早的在迁移成功后自动删掉；旧版本遇到比自己新的库时恢复备份，较新的库改名成 `ares1.db.newer-v<版本>-<时间>` 留着（见「稳定副本和自动升级」） |
| `data/logs/` | 执行日志：`<Run id>/` 下每次 Agent 执行的原始输出（`<执行 id>.jsonl` 和 `.jsonl.stderr`）、看板展示用的精简事件（`.events.jsonl`）、检查命令的输出（`.verify.log`），以及 `setup.log`、`command-*.log`、`merge-*.log`；`scouts/` 下是侦察的原始输出。原始输出在 Run 或侦察结束 30 天后自动删掉，其余一直保留（见下面「原始日志的保留期」） |
| `data/artifacts/` | 评审意见等产物 |
| `data/agent-gh-config/` | 给 Agent 用的空 gh 配置目录，每次用之前清空（见「Agent 拿不到 GitHub 凭据」） |
| `worktrees/` | 每个 Run 的工作目录 |
| `data/master-running.json` | Master 运行时的标记，正常停止时删掉（见「保活」） |
| `data/self-upgrade.sh`、`data/find-node.sh` | 自动升级时从安装目录复制过来的升级脚本和找 node 的脚本（见「稳定副本和自动升级」） |
| `master.out`、`upgrade.log`、`keepalive.log` | 后台运行时的输出、自动升级的日志、保活脚本的日志 |

配置文件改动后会自动重新加载。改端口或 CLI 路径（`bins`）需要重启 Master。

### 原始日志的保留期

Agent CLI 的原始输出（stream-json）带着工具调用的完整结果：读到的文件内容、测试输出等等，Master 一直运转就会一直变大。看板展示 Agent 输出用的是另存的精简事件（`.events.jsonl`），原始输出只用于下载排查，所以 Master 只保留 30 天：

- Master 启动时清理一次，之后每天一次。
- Run 结束（完成、失败、取消或评估后不做）超过 30 天，删掉它每次 Agent 执行的原始输出 `<执行 id>.jsonl` 和 `<执行 id>.jsonl.stderr`。执行中、排队、等审批、卡住、暂停的 Run 不论多旧都不碰；失败后等着重做的 Run 也不碰。时间按 Run 的结束时间算，没有结束时间的不碰。
- 侦察结束超过 30 天，删掉它的 `scouts/<侦察 id>.jsonl` 和 `.stderr`。正在进行的侦察不碰。
- 一直保留：`.events.jsonl`（看板上照常能看历史 Run 的 Agent 输出）、`.verify.log`、`setup.log`、`command-*.log`、`merge-*.log` 和 `data/artifacts/` 里的产物，以及数据库里的全部记录（统计、侦察提示词都不受影响）。Master 按数据库里每次执行记下的路径逐个删除，不按目录或通配符删。
- 有文件被删掉时，事件列表里记一条全局事件 `logs.pruned`（看板「事件」页能看到，写明删了几个文件、多大、涉及几个 Run 和几次侦察；见下面的「全局事件」），数据是 `{ runs, scouts, files, bytes }`：涉及的 Run 数、侦察数、删掉的文件数和它们删除前的总字节数。什么都没删时不记，所以重复清理不会重复记事件。文件已经不在不算错误；删不掉的文件在 Master 的输出（`master.out`）里记一行原因（每个文件只记一次），不影响别的文件，下一轮再试。
- 原始输出被删掉后，Run 详情页每次执行下面的「原始日志」「下载」换成「原始日志已超过保留期（Run 结束 30 天后）被删除」，Agent 输出照常从事件展示。API `GET /api/attempts/:id/log` 这时返回 404，数据是 `{ "error": "…", "pruned": true }`；原始输出因为别的原因不在时也是 404，但 `pruned` 为 `false`。

### 全局事件

Master 把不属于任何 Run 的事记成全局事件（事件的 Run 为空）：上一个 Master 异常退出（`master.restarted`）、清理原始日志（`logs.pruned`）、恢复数据库备份（`store.backup_restored`）、node 不见了（`master.node_missing`）、打开或关闭工作开关（`master.working`）、配置重新加载（`config.reloaded`、`config.reload_failed`）、访问 GitHub 出错（`github.error`）、webhook 通知发送失败（`notify.webhook_failed`）、推送目标分支（`github.pushed`）、自动采纳提案（`issue.auto_accepted`）、侦察（`scout.started`、`scout.completed`、`scout.failed`、`scout.rate_limited`）和升级（`upgrade.started`、`upgrade.done`、`upgrade.failed`）。这篇文档里说「事件列表里记一条」这些事件的地方，都指这里。

Master 大部分时间没人看着，人回来时在看板的「事件」页查这段时间发生过什么：

- 最新的在前，每页 200 条，底部「加载更早的」往前翻；有新的全局事件时自动刷新。
- 每条有时间、类型和一句说明：比如删了几个原始日志、多大，上一个 Master 的 pid 和启动时间，恢复了哪个备份、较新的库移到了哪里。出错的（`github.error`、`notify.webhook_failed`、`config.reload_failed`、`upgrade.failed`、`scout.failed`）标成红色，值得留意的（`master.restarted`、`master.node_missing`、`store.backup_restored`，有无效配置项的 `config.reloaded`）标成橙色。升级失败带着脚本输出末尾时可以展开看。鼠标悬停在说明上能看到原始数据。
- 侦察和自动采纳的事件带着去「需求」页的链接。
- 看板还不认识的事件类型（以后新加的）照样列出，显示类型名和原始数据。
- 每个 Run 自己的事件不在这里，在 Run 详情页。

API 是 `GET /api/events`，按 id 从新到旧返回 Run 为空的事件，格式和 `GET /api/runs/:id/events` 的一样（`id`、`runId`、`ts`、`type`、`data`）。参数 `limit` 是 1–500 的整数，默认 200；`before=<id>` 只返回比这个 id 更早的，用上一页最后一条的 id 往前翻。参数不合法时返回 400。

默认配置只有给 Ares.1 开发自己用的 `self-dev` 模板。给别的项目配置时，可以参考 [`docs/examples/`](examples/README.md)：一组完整的 `config.yaml`、`agents.yaml` 和几种场景的流程模板（轻量、严格、带 E2E、交叉评审），每一项都有注释，目录结构和数据目录一样，可以直接复制过来改；那里还写了 npm、pnpm、Python、Go、Rust 项目登记仓库时检查命令和准备命令怎么填。

## 接入 GitHub

Run 只从 GitHub issue 来。

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

4. 给要做的 issue 加上 `ares1:ready` 标签。Master 每 `poll_minutes` 分钟（默认 5）检查一次，把它建成 Run，进展回写到 issue 上。同一时间只执行一个 Run。

Master 第一次访问仓库时会自动创建这些标签：

| 标签 | 含义 |
|---|---|
| `ares1:proposal` | AI 侦察提出的需求，等你决定。采纳就加 `ares1:ready`，不做就关闭为 not planned 并写一句理由 |
| `ares1:ready` | 可以开工。你自己写的 issue 加上它也会被做 |
| `ares1:running` | 正在做 |
| `ares1:needs-you` | 等你处理：审批、卡住、需求待讨论（在 issue 下回复即可），或在看板上确认非仓库成员写的需求 |
| `ares1:failed` | 被终止，或失败次数达到上限后不再自动重做。重新加 `ares1:ready` 会再做一次 |
| `ares1:auto` | 按 `auto_accept` 的设置自动采纳的 |

AI 侦察、自动采纳、自动合并、推送和每日预算的设置写在 `config.yaml` 的注释里；[`docs/examples/config.yaml`](examples/config.yaml) 有登记了多个仓库、各用不同设置的完整示例。

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

为了不堆积没人看的工作，等你处理的提案和只等人的 Run 合计达到 `scout.max_proposals` 时，Master 不再自动侦察，看板上写明两部分各有几个，比如「有 2 条提案、1 个卡住的 Run 等你处理」。`auto_accept.max_risk` 为 `none` 时，所有没处理的提案都算；开了自动采纳时，只算在采纳范围内、因为当天的自动采纳数（`max_per_day`）已满还没采纳的提案，以及找不到侦察记录的提案。超出范围的提案（风险更高，或大小为 L）照样等你决定，但不会让侦察停下。卡住的 Run 对应的 issue 还开着，侦察能在提示词里看到它们，不会重复提案。

侦察没找到需求或失败后，自动侦察会退避，免得仓库没变时每轮检查都花钱重新侦察一遍。从最近一次侦察往回数，连续 k 次没有建出 issue（包括提案全部重复、没建成 issue 的）或失败，下次自动侦察就要等到最近那次侦察结束后 `poll_minutes × 2^(k-1)` 分钟，最长 6 小时；手动触发的侦察也算在内，被 Master 停止打断的不算。有侦察建出了 issue，或者目标分支的最新提交（按提交者时间）晚于最近那次侦察的开始时间，退避马上解除，目标分支更新之前的侦察不再计数。退避和 `scout.interval_minutes`（两次自动侦察至少间隔几分钟，默认 0 即不限，可以写小数）同时生效，取较晚的时间；看板上能看到退避的原因和下次侦察的时间。在看板上手动触发侦察不受退避限制。偶尔失败一次只退避，不通知；连续失败 3 次时会发一条「侦察连续失败」的通知（见下面的「通知」），免得侦察一直坏着、新需求悄悄断掉。

侦察的 Agent 额度用尽或被限流（怎么识别见下面的「Agent 出错时」）不算失败，和 Run 遇到限流的处理一致（见下面的「Agent 出错时」）：侦察记为「额度用尽/限流」（`rate_limited`），`error` 里写明预计什么时候恢复额度（CLI 给了重置时间时），费用照常记录，事件列表里记一条 `scout.rate_limited`（看板「事件」页能看到；数据里有 `scoutId`、`repo`，CLI 给了重置时间时还有 `retryAt`），不发系统通知。这样的侦察既不计入上面的连续次数，也不打断已有的连续计数，也不占用 `interval_minutes` 的间隔（间隔从最近一次没被限流的侦察开始时间算起）。最近一次侦察（被 Master 停止打断的不算）被限流时，自动侦察先等额度恢复：CLI 给了额度重置时间就等到那时再多等 1 分钟，没给就从那次侦察结束时起，按连续被限流的侦察次数等 5、10、20、40 分钟，之后每次 1 小时。到时间后的下一轮检查就会侦察。这个等待和退避、`interval_minutes` 同时生效，取最晚的时间，看板上写明「侦察遇到额度用尽或限流，等额度恢复」和预计时间。重置时间只记在内存里，Master 重启后按没给重置时间的规则等。在看板上手动触发侦察不受这个等待限制；手动侦察正常结束或失败后，等待就解除了。

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

- 时机：Master 启动、恢复完上次没做完的 Run 之后补删一次，之后每天和原始日志的清理（见上面的「原始日志的保留期」）一起补删一次。补删不占执行位，有 Run 正在执行时照样进行，只动下面这些失败或终止的 Run 自己的工作目录和分支。Master 关闭时做完手上这一个就停，剩下的下次再补。
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
- **侦察**：提示词里列出未关闭的 issue（最多 100 条）和最近关闭的 30 条（完成的只列标题）；在这 30 条之外，更早被关闭为不做（not planned）的 issue 也连同理由列在单独一节「更早被关闭为不做的」里（最多 300 条），不管多早被拒绝的需求，侦察都看得到理由，不会换个说法再提。这份列表靠 GitHub 的搜索接口取得，它有单独的限流和索引延迟；搜索失败时侦察不会因此失败，只用最近关闭的 30 条继续（最近的「不做」issue 本来就在里面），提示词里写明更早被关闭为不做的 issue 这次没能取到、提案要多加小心，Master 记一条 `github.error` 事件，写明搜索失败的原因（看板「事件」页能看到）。这条 `github.error` 只在侦察继续进行时记录。取未关闭和最近关闭 issue 的请求失败时，侦察照旧失败；这时即使搜索也失败了，也只按侦察失败处理（偶尔失败一次只退避，连续失败 3 次才通知），不另记搜索失败。这些都只列受信任的人或 Master 建的 issue；「不做」的理由只取受信任的人写的最后一条评论，没有就不写理由；「多次失败后关闭」也只认受信任的人写的标记。陌生人建的 issue 完全不出现，代价是侦察可能提出和它重复的提案，你在采纳时能发现。最近的 Run 里，来自陌生人 issue、还没人确认过的 Run 只列 issue 编号，不列内容；被终止的 Run 多一行「终止」，写明原因：issue 被人关闭（已完成，或关闭为不做）、issue 改过后已按新内容重开（写出新 Run），还是人在看板上终止，侦察据此分清是需求被拒、已经由别的途径做完，还是人改了方向。评审未通过的轮次列出必须修改的问题（每轮最多 5 条），建议只计数；评审通过的轮次有建议时，列出评审通过时给的建议（每轮最多 3 条，带文件名，多出的只计数）。这些建议是评审有意留到以后的改进，不会写进 issue，侦察可以拿它们当提案来源，但要先核对代码里是否仍然存在、是否已经有 issue 覆盖。陌生人 issue、还没人确认过的 Run 不列建议：评审读过它的目标，建议里可能带着其中的文字。
- **从 issue 建 Run**：只有有 triage 及以上权限的人能加 `ares1:ready`，所以标签可信，但 issue 可能是陌生人写的，加标签之后也还能改。这时 Master 照常建 Run，目标是建 Run 那一刻 issue 的内容，之后再改 issue 不影响它；Run 一建好就停在「issue 作者不是仓库成员，等你确认需求」，在 issue 上说明原因，打上 `ares1:needs-you`。在这之前没有任何 Agent（包括只读的需求评估）读到它。你在 Run 详情页读过目标后点「确认并开始」，Run 才从头开始，之后照常按模板和 `auto_merge` 的设置走；这一步不管怎么设置都要人来做。不想做就终止 Run 或关闭 issue。Run 页上一直标着 issue 作者和确认的时间。
- **自动重做**：重做时目标从 issue 重新读。作者不受信任时，内容和上次确认过的一样就直接重做，改过就要重新确认。

### Agent 拿不到 GitHub 凭据

只把陌生人写的内容挡在提示词外面还不够：Agent 能执行命令，要是继承了本机 gh 的登录，它自己跑一下 `gh issue view 12 --comments`，陌生人的评论就又进来了；它还能以本机登录的所有 GitHub 账号读写这些账号能访问的所有仓库。Master 读 issue、发评论、推送都是自己做的，Agent 用不着 GitHub 凭据，所以 Agent（编码、评审、需求评估、侦察）和准备命令、检查命令（包括命令阶段的命令）都在去掉了 GitHub 凭据的环境里运行：

- 去掉 `GH_TOKEN`、`GITHUB_TOKEN`、`GH_ENTERPRISE_TOKEN`、`GITHUB_ENTERPRISE_TOKEN`，再把 `GH_TOKEN` 设成一个无效的值 `ares1-agent-no-github-access`。gh 优先用 `GH_TOKEN`，GitHub 会拒绝它，gh 也就不会退回去用存在配置文件或 macOS 钥匙串里的登录。
- `GH_CONFIG_DIR` 指向数据目录下的空目录 `data/agent-gh-config/`，gh 在里面是未登录状态。每次启动 Agent、运行命令之前都会把它清空，Agent 往里面写的东西留不到下一次。
- git 的凭据助手（钥匙串、gh 等）全部清掉，去掉 `GIT_ASKPASS`、`SSH_ASKPASS`，并设置 `GIT_TERMINAL_PROMPT=0`：通过 https 访问需要登录的仓库会直接失败，不会弹出要密码的提示。
- 其他环境变量原样保留，包括 `PATH`、`HOME`，以及 Claude Code 和 cursor-agent 自己的登录信息。
- 给 Agent 的提示词也写明：需求、讨论和 issue 的内容都已经在提示词里，不要自己去 GitHub 读。

副作用：准备命令和检查命令里需要 GitHub 凭据的操作会失败，比如通过 https 安装 GitHub 上的私有依赖、在测试里调用需要登录的 GitHub API。

剩下的边界：Agent 和 Master 以同一个系统用户运行，用户目录里的东西 Agent 仍然读得到、用得上，包括 SSH 密钥（可以用 SSH 推送）、gh 自己的配置目录、钥匙串（可以直接调用 `security` 命令读出 gh 存的 token）和其他文件。上面这些做法只能防止 Agent 无意中用到这些权限，挡不住它有意为之。被构建的是公开仓库、或者需求不完全受信时，建议让 Master 以单独的系统用户运行（这个用户只有这个项目需要的权限，比如单个仓库的 deploy key 或权限最小的 token），或者放在单独的机器上跑。

### 发到 GitHub 的文字不带用户目录

错误输出和 Agent 写的总结常带着本机的绝对路径，比如 `/Users/<用户名>/.ares1/worktrees/run-…`，发到公开仓库就会把系统用户名和目录结构公开出去。所以 Master 发到 GitHub 的文字（issue 评论、侦察提案 issue 的标题和正文、Master 提交的提交信息）里，以用户目录开头的路径都换成 `~`，比如 `~/.ares1/worktrees/run-…`；不在用户目录下的路径保持原样。看板和本地日志照旧显示完整路径，方便排查。提交信息是提交时就替换好的，所以看板上看到的提交信息也是 `~`。

## Agent 出错时

Agent 执行出错（CLI 报错、超时等）时怎么处理，由流程模板的 `escalate` 决定，可以写在 `defaults` 里，也可以按阶段写：

```yaml
defaults:
  escalate:
    max_retries: 2               # 不写也是 2
    on_agent_error: switch_agent # 不写也是 switch_agent
```

- 出错后先等一会儿再用同一个 Agent 重试，最多 `max_retries` 次。第一次等 30 秒，之后每次翻倍，最长 10 分钟。等待期间 Run 仍占着执行位；暂停、终止或停止 Master 会马上结束等待。出错重试和返工分开计数，`max_retries` 对两者各自生效。
- 同一个 Agent 的重试用完后，按 `on_agent_error` 处理：
  - `switch_agent`（默认）：从 `agents.yaml` 里挑一个这个 Task 还没用过、已启用的 Agent 接着做，需求评估阶段只挑支持只读的。先挑档次（`tier`）不低于当前 Agent 的，同档次里挑成本（`cost`）低的，再一样就按文件里的顺序。换上的 Agent 同样有 `max_retries` 次重试。没有可换的 Agent 时，Run 结束、标为失败。
  - `retry`：不换 Agent，重试用完后 Run 结束、标为失败。
  - `human`：重试用完后 Run 卡住，等人重试（可以换 Agent）或终止。没人在场时 Run 会一直停在那里，加载模板时会提示改成 `switch_agent`。
- Run 因此失败时，`error` 里写明最后是哪个 Agent 出了什么错、试过哪些 Agent。工作目录和分支保留，Master 接着做别的；issue 按 `max_run_attempts` 自动重做（见上面的「Run 失败后自动重做」），重做时这个错误会交给新 Run 的 Agent。
- Agent 不可用（`agents.yaml` 里改了名、删掉、设了 `enabled: false` 或校验失败被停用，没有对应的 Adapter，或者需求评估阶段它的 CLI 不支持只读）时，Agent 根本没法启动，所以不重试、不消耗重试次数，直接按 `on_agent_error` 处理：
  - `switch_agent`（默认）：按上面同样的规则换一个可用的 Agent 接着做，需求评估阶段只换到支持只读的；事件列表里记一条 `task.agent_switched`（数据里 `reason` 为 `unavailable`）。原来的 Agent 已不在 `agents.yaml` 里时，不看档次，直接挑成本低的。没有可换的 Agent 时，Run 结束、标为失败。
  - `retry`：用同一个 Agent 重试也不会成功，Run 直接结束、标为失败。
  - `human`：Run 卡住（Agent 不可用），等人确认 Agent 可用或换一个 Agent 后重试。
  - Run 因此失败时，`error` 里写明是哪个 Task、哪个 Agent、为什么不可用，以及按哪种 `on_agent_error` 结束；还没开始执行，工作目录不回滚，和分支一起保留。issue 同样按 `max_run_attempts` 自动重做。
- 人在看板上重试卡住的 Run 后，返工次数和出错重试次数都重新计算。
- 额度用尽或被限流不算出错：不消耗重试次数，不换 Agent，也不卡住等人。Run 回到队首排队并让出执行位，别的 Run 照常执行；CLI 给了额度重置时间就等到那时再多等 1 分钟，没给就按连续被限流的次数等 5、10、20、40 分钟，之后每次 1 小时。到时间后从同一个 Task 接着做（返工意见不变）。等待期间 Run 详情页和事件列表会写明「额度用尽或被限流，预计 HH:mm 继续」。这个时间只记在内存里，Master 重启后 Run 会直接再试一次；想马上再试，可以暂停后再恢复。侦察遇到额度用尽或限流时按同样的规则等待，见上面「接入 GitHub」里侦察退避之后的一段。各个 CLI 的限流这样识别：
  - Claude Code：以它输出的限流事件（`rate_limit_event`）为准，重置时间也从事件里取。没有限流事件时，再看失败结果里 CLI 自己的错误文字，按下面同样的规则兜底。
  - cursor-agent：它不输出限流事件，只看失败时 CLI 自己的错误文字：失败的 `result` 事件里的文字，没有 `result` 事件、进程自己退出时则看 stderr 的末尾。超时、被停止或没能启动的不算限流。Agent 在回复里写的文字一律不看（Agent 讨论限流时不会被误判），成功的结果也不看。
  - 错误文字的规则（不区分大小写）：含 usage limit、rate limit（rate-limit、rate limited、rate_limit 等写法）、too many requests、resource exhausted（`RESOURCE_EXHAUSTED`）、hit your limit，配额用尽的说法（quota exceeded、exceeded … quota、out of quota、insufficient quota；单独的 quota 不算，disk quota 磁盘配额也不算），或者紧跟在 HTTP、status、code 后面的 429（比如 `HTTP 429`、`status code 429`；4290、行号 429 之类的数字不算）。误判成限流的 Run 会一直等下去，所以规则宁紧勿松：没识别出来的限流照常按出错处理。
  - 错误文字里的重置时间按这个顺序找：Claude 老格式 `limit reached|<epoch>`、ISO 8601 时间、reset 或 retry 后面不远处 10 位的 epoch 秒数（13 位的毫秒数也行）。找不到、已经过去或在 31 天以后的，当作没给重置时间。

数据目录里已经装好的 `workflows/self-dev.yaml` 不会自动更新。旧版本写的是 `on_agent_error: human`：出错时会先自动重试，重试用完后才卡住等人，加载时也会提示。想让它出错时也不等人，就手动改成 `switch_agent`。

## 评审阶段不改代码

评审 Agent 只给意见，不改 Run 的代码。每次评审结束后（不管评审有没有完成），工作目录都会退回到评审开始时的提交：评审者留下的改动和它自己做的 git commit 都会丢掉，切到了别的分支或游离的 HEAD 时 Master 会切回 Run 的分支，Run 照常往下走。评审者在别的分支上做的提交留在那个分支上，不会被合并。评审进行到一半被打断时也一样：Run 被暂停或取消、Master 被升级重启或崩溃后恢复，Master 都会把 Run 的分支退回到评审开始时的提交（评审开始前记在评审任务上），再重新评审；恢复时工作目录如果已经不在了，就从分支恢复出来，在重新评审之前退回去。打断时这一步也可能失败（比如工作目录里留着 git 的锁文件，切不回 Run 的分支），这时 Master 照常暂停、停止或启动，不卡在这里，事件列表里记一条 `review.discard_deferred`，数据里有评审任务（`taskId`）、评审开始时的提交（`baseCommit`）和失败原因（`error`）；Run 再拿到执行位时，Master 先补做这次退回，再检查工作目录和记录是否一致（见「Run 什么时候停下来等人」里的「工作目录与记录不一致」），所以评审者切走了分支不会让 Run 因为「不在 Run 的分支上」而失败；补做也失败的才按不一致结束 Run。这条规则由 Master 执行，不只靠提示词：否则评审者自己提交的代码没经过评审，合并阶段只会重跑检查命令就合进目标分支。真的丢掉了东西时，事件列表里记一条 `review.changes_discarded`，数据里有这次评审的执行（`attemptId`）、评审开始时的提交（`fromHead`）、结束或被打断时 Run 分支所在的提交（`toHead`）、被丢掉的提交（`discardedCommits`）、有没有未提交的改动（`uncommitted`），以及切到别处时当时检出的分支（`checkedOut`，游离的 HEAD 为 `null`）。

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

- 命令写在 `verify.commands` 里，和其他阶段一样；不写就运行仓库登记的检查命令。写成空列表是配置错误。命令阶段不能指定 `agent`、`agent_candidates`、`planning: llm` 和 `verify.llm_check`。
- 命令按顺序运行，有一条失败就不再往下跑。和检查命令一样不带 GitHub 凭据（见上面的「Agent 拿不到 GitHub 凭据」），每条命令的超时是 `config.yaml` 里的 `defaults.command_timeout_minutes`。输出写进数据目录的 `logs/<Run id>/command-<阶段轮次 id>.log`，Run 详情页在这一阶段下列出每条命令是否通过和输出的末尾。
- 全部通过：阶段通过，进入下一阶段。设了 `gate: true` 时先等人审批，审批在命令通过之后；驳回时回到 `on_reject` 指向的阶段，不写就是前面最近的 Agent 阶段。
- 有命令失败：阶段标为没通过（原因是「检查没有通过」），回退到 `on_fail` 指向的阶段，不写就是它前面最近的 Agent 阶段（通常是编码）。失败的命令、退出码和输出的末尾作为反馈交给那个阶段的 Agent。和评审打回一样计入 `max_loops`，用完后按 `on_exhausted` 处理（见下面的「返工或回退用完时」）。
- `on_fail` 指向的不是 Agent 阶段、或者前面根本没有 Agent 阶段时，没有 Agent 按失败输出改代码，同样的代码只会重跑到回退用完，加载模板时会给出警告。
- 命令阶段不提交，也不改 Run 的代码：命令跑完后（被暂停打断时也一样），工作目录会退回到这一阶段开始时的提交，命令留下的改动（生成的报告、截图等没被 git 忽略的文件）和命令自己做的 git commit 都会丢掉，不会被之后的 Agent 一起提交，也不会被合并；切到了别的分支时切回 Run 的分支。阶段通过与否照旧只看命令的退出码。真的丢掉了东西时记一条 `command.discarded_changes` 事件，数据和评审阶段的 `review.changes_discarded` 一样，只是用阶段（`stageId`）代替评审的执行（`attemptId`），见上面的「评审阶段不改代码」。被 git 忽略的文件（比如 `node_modules`、构建产物）不动。
- 阶段没写命令、仓库也没登记检查命令时，没有要运行的命令，阶段直接通过（记一个 `stage.no_commands` 事件），和没有检查命令的编码阶段一样。
- 运行到一半被暂停或 Master 重启时，恢复后这一阶段的命令全部重新运行。
- 这里不调用 Agent，所以 `escalate` 里出错重试、换 Agent、预算的设置对它不起作用，`timeout_minutes` 也不用于命令。

默认的 `self-dev.yaml` 里 E2E 阶段仍是 `kind: placeholder`，注释写了怎样改成命令阶段。数据目录里已经装好的模板不会自动更新，需要时手动改。带命令阶段的完整模板见 [`docs/examples/workflows/with-e2e.yaml`](examples/workflows/with-e2e.yaml)。

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

## 合并冲突

Run 等审批或卡住等人时会让出执行位，别的 Run 可能先合并进目标分支，所以走到合并阶段时，和目标分支冲突很常见。这时不用人懂 git：

- 合并阶段先把目标分支的最新代码合并进 Run 的分支。有冲突时，Master 放弃这次合并（工作目录保持原样），把合并阶段标为没通过（原因是「和目标分支冲突」），记下冲突的文件，回退到合并阶段 `on_fail` 指向的阶段（默认是它前面最近的 Agent 阶段，通常是编码）。反馈里列出冲突的文件，并写明要合入目标分支的最新代码、解决冲突、保留本需求的改动。
- 回退后的这一轮，每次启动 Agent 之前，Master 先在工作目录里执行 `git merge --no-commit <目标分支的最新提交>`，把冲突标记留在文件里。提示词里会说明有一个未完成的合并、列出冲突的文件，要求清除所有冲突标记、保留两边的意图，不要执行 `git commit`、`git merge --abort`、`git reset`。
- Agent 完成后，Master 先检查冲突文件里还有没有冲突标记（`git diff --check` 找到的 `<<<<<<<`、`=======`、`>>>>>>>`），有的话带着这些文件名返工；返工接着这次合并，不会重新合并。之后照常运行检查命令，通过后由 Master 提交，提交出来的是合并提交（全部按本需求这边解决、内容和原来一样时也是）。之后的评审只看本需求的改动：基线是这次合入的目标分支提交，不会把别人合并进去的改动算到这个 Run 头上。
- 这一轮中途被暂停、Master 重启或 Task 最终失败时，工作目录会回到合并之前，不留下半截的合并；下次执行时重新合并，用的是目标分支那时的最新提交。
- 冲突反复出现时，和别的回退一样受 `max_loops` 限制，用完后按 `on_exhausted` 处理（默认 Run 结束、标为失败）。
- 合并阶段的 `on_fail` 指向的不是 Agent 阶段（比如评审阶段，它不能改文件）时，没有 Agent 能解决冲突，Run 不等人，直接结束、标为失败，`error` 里列出冲突的文件；从 issue 来的按 `max_run_attempts` 自动重做（见下面的「Run 什么时候停下来等人」）。重做在目标分支的最新代码上新建工作目录，编码 Agent 从一开始就基于最新代码改，原来的冲突也就没了。加载模板时会对这种设置给出警告；想让 Agent 解决冲突，就把 `on_fail` 指向一个 Agent 阶段。
- git 合并因为冲突以外的原因失败时（git 锁、磁盘满、索引损坏等，git 没报出冲突的文件），没有冲突可解决，Run 结束、标为失败，从 issue 来的按 `max_run_attempts` 自动重做（见下面的「Run 什么时候停下来等人」）。

## Run 什么时候停下来等人

Run 卡住（`blocked`）、已暂停或等审批时会让出执行位，排队的 Run 照常执行。这些只等人的 Run 也不会让仓库停止自动侦察：它们和等你处理的提案一起计入 `scout.max_proposals`，合计没到上限时照常侦察，到了上限才等你处理（见上面的「接入 GitHub」）。只有排队、执行中的 Run，等评估回复且设了超时的 Run，以及等目标分支上的改动清掉的 Run（见下面），会让侦察等它们做完。默认配置下，只有这些情况会停下来等人：

- 审批：模板里设了 `gate` 的阶段（从 issue 来的 Run 打开 `auto_merge` 时，合并不等审批）。
- 需求评估有疑问，等你回复，最多等 `reply_timeout_hours`（到时间评估自己决定，所以这种 Run 算作会自己往下走；设为 `null` 时一直等，算作只等人）；issue 作者不是仓库成员，等你确认需求。
- 配置为等人时：`on_agent_error: human`（包括 Agent 不可用时）、`on_exhausted: human`、`on_budget_exceeded: pause`（超出预算）。

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
- 工作目录与记录不一致：Run 每次拿到执行位时（包括 Master 重启后），Master 都会检查它的工作目录还是不是自己留下的样子。Run 正在评审阶段、评审任务已经开始过的，检查之前 Master 先把工作目录放回 Run 的分支上评审开始时的提交（和重新评审前做的一样，见「评审阶段不改代码」）：评审中途被打断、当时没能退回（`review.discard_deferred`）时，评审者切到了别的分支或改写了 Run 的分支，补做之后就一致了，Run 照常重新评审；补做也失败的，`error` 先写补做失败的原因，再写下面的不一致说明。工作目录只是被删了（比如清理磁盘时删掉），而 Run 的分支还在时，Master 自己从分支把工作目录恢复回来（`git worktree add`），复查通过就照常接着做，不停下，事件列表里记一条 `run.workspace_restored`（数据里有路径和分支）。其他情况说明工作目录已经不可信，Run 结束、标为失败，`error` 写明原因：工作目录当前不在 Run 的分支上；提交历史和记录不一致（Master 记录的最新提交已不在分支上，比如被手动 `git reset` 或改写过）；工作目录和分支都没了；从分支恢复失败（比如分支在别处检出）或恢复后复查仍不一致。工作目录和分支按实际情况保留（`error` 末尾写明保留了哪些），不做改动，方便查看；重做会在新的工作目录里进行。在工作目录里手动加的提交不算不一致，后面的检查照常会检查它们。
- 除超出预算外，这几种情况都没有「卡住等人」的配置：要是原因确实每次都会重现，issue 会把 `max_run_attempts` 次用完，然后关闭并写明每次的原因。
- 旧版本里因为这几种情况卡住（`blocked`）的 Run 仍然可以在看板上重试或终止：准备命令失败的会重新建工作目录、重新运行准备命令；内部错误的从出错的 Task 开始重做；合并失败的重新同步目标分支；因合并冲突卡住的，可以先在工作目录里自己 `git merge`、解决冲突并提交再重试，重试时重新同步目标分支，仍有冲突就按现在的做法结束 Run，也可以直接终止；工作目录与记录不一致的会先把被删的工作目录从分支恢复回来，再以工作目录当前的提交为准接着做。

## 通知

只在需要你做点什么时通知：Run 卡住或失败、等审批、提案等人决定、侦察连续失败、推送或升级失败；Run 完成、侦察完成都不通知。

侦察失败（Agent 出错或超时、输出不符合约定、建临时工作目录失败等）时，事件列表里记一条 `scout.failed`（看板「事件」页能看到，标成红色），数据里有 `scoutId`、`repo`、`message`（错误信息）和 `streak`：这个仓库从最近一次侦察往回数连续失败的次数（包括这一次；自动和手动触发的都算）。额度用尽或被限流的、被 Master 停止打断的、还在进行的侦察既不计数，也不打断计数；正常结束的侦察（哪怕没找到需求）让计数从头开始。`streak` 正好到 3 时通知一次「侦察连续失败：<仓库名>」，正文是错误信息的第一行，点开是「需求」页；之后接着失败不再通知，直到有侦察正常结束、又连续失败 3 次。被 Master 停止打断的侦察也记 `scout.failed`，但不带 `streak`，不通知。

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

在 macOS 和 Linux 上打开 `notify.system` 后，`/api/health` 的 `systemNotify` 为 `true`，看板不再重复发浏览器通知；在不支持的平台上它为 `false`，看板照常由浏览器发，不会因为打开了这个设置反而什么都收不到。系统通知发送失败（比如 Linux 上没装 `notify-send`，或者没有桌面会话）不影响 Master，只在 Master 的输出里记一次原因（以 `[通知]` 开头，英文为 `[notify]`），之后的失败不再记。

自动升级脚本（`scripts/self-upgrade.sh`）在 Master 一个都没能启动时（找不到安装目录，或者回退后旧版本也没能启动）也发一条系统通知：有 `osascript` 就用它，否则有 `notify-send` 就用它，两个都没有就不发。这时 Master 不在运行，webhook 也就发不出去。

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

  `kind` 是通知的种类（`approval`、`discussion`、`blocked`、`failed`、`proposals`、`scout`、`github`、`upgrade`），`title`、`body` 是通知的标题和正文（按 `language` 的语言），`text` 是「标题\n正文」，`runId` 是相关的 Run（没有时为 `null`），`about` 说明点开该去哪里（`run` 是 Run 详情页，`issues` 是「需求」页，`master` 没有特定页面），`eventType` 是引起通知的事件类型，`at` 是事件发生的时间。Slack 的入站 webhook 会显示 `text`、忽略其他字段，可以直接接。
- `format: text`：`Content-Type: text/plain; charset=utf-8`，正文就是「标题\n正文」，适合 ntfy 这类直接显示正文的服务。
- 飞书、钉钉的机器人 webhook 要求固定的消息格式，不能直接接：要经过一层转发（自己的小服务把正文改成它们要的格式），或者先发到 ntfy 这类服务。
- 发出去的标题、正文和 `text` 都先把用户目录下的路径换成 `~`（和发到 GitHub 的文字一样，见「发到 GitHub 的文字不带用户目录」），不把系统用户名发给外部服务。
- `/api/health` 的 `webhookNotify` 只说明有没有配 webhook，不返回地址和请求头；看板的「说明」页和顶栏的通知开关会提一句已配置 webhook。
- 失败时：地址返回的不是 2xx（比如 500）、连不上或 10 秒内没有响应都算失败。不重试，不影响 Master。一串连续的失败只记第一次：在 Master 的输出里记一行原因（以 `[通知]` 开头，英文为 `[notify]`），同时在事件列表里记一条全局事件 `notify.webhook_failed`（看板「事件」页能看到，标成红色；见上面的「全局事件」），数据是 `{ reason, status }`：`reason` 是 HTTP 状态码或错误信息，`status` 是 HTTP 状态码（没有响应时为 `null`）。两处都不写地址和请求头，免得把里面的 token 记下来。之后连续的失败不再记；有一条通知发送成功后，下次再失败重新记一次（webhook 恢复后又坏掉，人回来时在「事件」页能看到）；改了 `notify.webhook.url`（配置重新加载后）再失败时也重新记一次。这条事件本身不发通知（不发系统通知，也不再发到 webhook），免得失败了再发、再失败。

## 稳定副本和自动升级

自举时，Master 不从开发仓库运行，而是从开发仓库的一份克隆（稳定副本）运行。Run 合并进开发仓库后，稳定副本就落后于它的 origin。这时 Master 会等手上的工作做完，再拉取、构建并重启自己；任何一步失败都会回退到旧版本（新版本已经迁移过的数据库怎么处理，见下面的「回退时的数据库」）。

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

Master 收到 SIGTERM 或 SIGINT 后停下工作、关闭服务和数据库，然后以退出码 0 退出；如果停止过程中出错，它把错误打印出来，以退出码 1 退出，这在观察期内同样算崩溃、会回退。`npm test` 里的冒烟测试（`test/cli.smoke.test.ts`）以子进程启动构建出的 Master，检查它能在空数据目录上启动、`/api/health` 有响应、SIGTERM 后以退出码 0 退出，这类问题在合并前就会被检查命令拦下。

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
- 都找不到时：构建前找不到，就按环境问题记为升级失败（见上面），回退；回退前也找不到，脚本没法启动 Master，就记日志、发一条系统通知后退出，这时要你手动处理（装了保活的话，保活脚本每分钟用同样的办法再找一次）。
- 升级脚本复制到数据目录运行（`data/self-upgrade.sh`），`find-node.sh` 也一起复制过去（`data/find-node.sh`），脚本从自己所在的目录读它，不从安装目录读，免得拉取时被改写。

所以换 Node 版本后什么都不用做：几分钟内 Master 会自己换到新的 node 上重启，卡住的 Run 接着做。只要新的 node 能被上面的办法找到：最稳的是让 nvm 的默认版本（`nvm alias default <版本>`）指向装好的、满足 `engines` 的版本。

### 回退时的数据库

新版本如果带了数据库迁移，一启动就会把数据库（`data/ares1.db`）迁移到新的版本，迁移前先把原来的库备份成同一目录下的 `ares1.db.bak-v<旧版本>-<时间>`。

每份备份都是整个库的完整拷贝，所以只保留最近 5 份：迁移全部成功后，按文件名里的时间（不看修改时间）留下包括这次新建的在内最新的 5 份，更早的删掉。回退只需要最新的一份，多留几份够连续几次升级出问题时排查、手动恢复。只删名字严格是 `ares1.db.bak-v<数字>-<时间>` 的文件；带 `-wal`、`-shm` 后缀的、`.newer-v…`、`.restoring-…`、你自己复制出来改过名的拷贝都不动，想长期留着的备份改个名字（比如在末尾加 `.keep`）就不会被删。删除失败只在 Master 的输出里打一行警告，照常启动。迁移中途失败时不清理，免得反复启动失败做出的备份把回退要用的那份挤掉。

回退只把代码退回旧提交、重新构建，不动数据库，所以回退后启动的旧版本会发现数据库比自己支持的版本新。这时它在数据库所在目录里找版本号正好等于自己所支持版本的备份（`ares1.db.bak-v<N>-*`，`N` 后面紧跟 `-`，有好几份时取时间最新的一份；一次升级跨了好几个迁移也一样，备份的版本号就是旧版本的），找到了就：

- 先把备份复制一份、确认它的版本对得上，再把较新的数据库连同它的 `-wal`、`-shm` 改名成 `ares1.db.newer-v<较新的版本>-<时间>`（`-wal`、`-shm` 的后缀照原样保留），留着不删，以后再升级时可以找回；
- 把备份的那份副本换成 `ares1.db`，打开后照常工作，备份本身不动；
- 在 Master 的输出（`master.out`）里打一行说明，写明恢复了哪个备份、较新的库移到了哪里，事件列表里记一条 `store.backup_restored`（看板「事件」页能看到，写明恢复了哪个备份），数据里有 `backup`、`movedTo`、`fromVersion`（较新的库的版本）和 `toVersion`（恢复后的版本）。

代价是新版本迁移以后记下的进度都会丢掉，通常就是观察期内它做的事：推进过的 Run、侦察、事件等等。恢复后 Run 的记录会比工作目录旧，这交给现有的工作目录一致性检查（见「Run 什么时候停下来等人」里的「工作目录与记录不一致」）：Run 再拿到执行位时，记录对不上的就结束、标为失败，从 issue 来的 Run 随后自动重做（见「Run 失败后自动重做」）；对得上的照常接着做。不另做处理。

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
- 通知标题：系统通知的标题，默认 `Master`。
- 日志和通知的语言按 `config.yaml` 的 `language`。

每次调用按顺序判断：

1. `http://127.0.0.1:<端口>/api/health` 有响应：什么也不做，退出 0，也不写日志，免得每分钟一行把日志撑大。
2. 有正在进行的自动升级（有命令行里同时带 `self-upgrade.sh` 和这个数据目录的进程）：不插手，退出 0。升级脚本自己会停掉、启动或回退 Master，观察期也归它管，保活脚本这时再启动一个，就会有两个 Master 用同一个数据目录。升级脚本退出（观察期满，或者回退完）以后，保活脚本才接着看管。
3. 另一次调用正在进行（数据目录里有 `keepalive.lock` 目录）：退出 0。所以连续或同时调用两次只会启动一个 Master。锁目录超过 5 分钟还在，说明是被强行结束的调用留下的，会被清掉。
4. 有命令行带 `dist/cli.js --home <数据目录>` 的进程，但 health 没有响应（卡住了，或者还在启动）：不强行结束它，只在日志里记一笔，退出 0。真卡死了要你看 `master.out` 自己处理。
5. 端口被别的进程占着（连得上，但不是 Master 的 health）：不启动，在日志里记一笔，发一条系统通知，退出 0。
6. 其他情况：在安装目录里用和升级脚本一样的方式启动 Master（`nohup node dist/cli.js --home <数据目录> >> <数据目录>/master.out 2>&1 &`），最多等一分钟看 health 有没有响应。有响应就在 `keepalive.log` 里写一行带时间的记录（pid、几秒后有响应）。启动的 Master 退出了，或者一分钟内没有响应，也写一行，并发一条系统通知，脚本以退出码 1 结束；启动后没响应的进程不会被结束，下一次调用按第 4 条处理。

只看端口不够：两个 Master 用同一个数据目录很危险。Master 启动时先恢复 Run 的状态、再监听端口，第二个实例在发现端口被占之前就已经改了数据库。所以只要有这个数据目录的 Master 进程（卡住的、正在启动的、手动启动的），保活脚本就不会再启动一个。

系统通知和升级脚本一样：有 `osascript` 就用它，否则有 `notify-send` 就用它，都没有就不发。同一次停转只通知一次：数据目录里的 `keepalive.notified` 记着已经通知过，Master 重新有响应后删掉，之后再起不来会再通知。找不到安装目录、能用的 node 或 curl 时也记日志、发通知。

所以：

- Master 崩溃、被 `kill -9`、被系统杀掉之后，下一次调用（最多一分钟）就把它拉起来；机器重启或重新登录后，定时任务一跑也会把它拉起来。正在执行的 Run 由新启动的 Master 照常恢复。
- 新启动的 Master 发现上一个是异常退出的，会在事件里记一条 `master.restarted`，看板「事件」页能看到，写明上一个 Master 的 pid 和启动时间。Master 启动时在数据目录写 `data/master-running.json`（pid 和启动时间），正常停止（SIGTERM、Ctrl-C、交给自动升级）时删掉；启动时发现它还在，说明上一个没有正常停止（崩溃、`kill -9`、被系统杀掉、断电），事件数据里是上一个 Master 的 `pid` 和 `startedAt`。不管是保活脚本、升级脚本还是你自己启动的，都一样记。
- 观察期内新版本崩溃仍由升级脚本回退；回退后旧版本也起不来时，升级脚本发通知后退出，之后保活脚本每分钟再试一次。
- 想有意停掉 Master（比如下面的「手动升级」），要先停掉定时任务，否则一分钟内它又会被拉起来，做完再打开。

下面的例子假设稳定副本在 `~/ares1-stable`、数据目录是 `~/.ares1`，换成你自己的路径。定时任务的 PATH 很短，例子里都显式设了 PATH，要包含 node、git、gh、claude、cursor-agent 所在的目录（用 `command -v node git gh claude cursor-agent` 查）；node 不在 PATH 里时，也可以作为第四个参数传进去。

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

不打开 linger 的话，用户注销后用户级的 systemd 会停掉，定时任务不再运行。Master 留在 keepalive 服务的 cgroup 里，下一次触发时 systemd 会提示有残留的进程（`Found left-over process`），不影响运行。没有桌面会话时 `notify-send` 发不出去，看 `keepalive.log`。

### Linux：cron

没有 systemd 时用 cron（`crontab -e`），每分钟一次：

```
PATH=/usr/local/bin:/usr/bin:/bin
* * * * * /bin/bash "$HOME/ares1-stable/scripts/keepalive.sh" "$HOME/ares1-stable" "$HOME/.ares1"
```

cron 不会在任务结束后结束它启动的进程。停掉时把这一行注释掉。机器重启后 cron 起来就会接着调用。

## 手动升级

没有打开自动升级时，按下面的步骤升级。停止 Master 时，正在执行的 Run 会回到队首。打开了保活的定时任务时，先停掉它（见上面的「保活」），升级完再打开，否则停掉的 Master 会在构建过程中被拉起来。

```bash
pkill -f "dist/cli.js --home $HOME/.ares1"
cd ~/ares1-stable && git pull --ff-only && npm ci && npm run build
nohup node dist/cli.js --home ~/.ares1 >> ~/.ares1/master.out 2>&1 &
```
