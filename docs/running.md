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
| `data/ares1.db` | 运行状态（SQLite），升级迁移前自动备份 |
| `data/logs/`、`data/artifacts/` | Agent 的执行日志和产物 |
| `data/agent-gh-config/` | 给 Agent 用的空 gh 配置目录，每次用之前清空（见「Agent 拿不到 GitHub 凭据」） |
| `worktrees/` | 每个 Run 的工作目录 |
| `master.out`、`upgrade.log` | 后台运行时的输出、自动升级的日志 |

配置文件改动后会自动重新加载。改端口或 CLI 路径（`bins`）需要重启 Master。

## 接入 GitHub

Run 只从 GitHub issue 来。

1. 安装并登录 [gh](https://cli.github.com/)。登录了多个账号时，在 `config.yaml` 的 `github.account` 里指定用哪个。
2. 在看板的「仓库」页登记本地仓库：填仓库名、绝对路径、目标分支和检查命令。
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

AI 侦察、自动采纳、自动合并、推送和每日预算的设置写在 `config.yaml` 的注释里。

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

侦察没找到需求或失败后，自动侦察会退避，免得仓库没变时每轮检查都花钱重新侦察一遍。从最近一次侦察往回数，连续 k 次没有建出 issue（包括提案全部重复、没建成 issue 的）或失败，下次自动侦察就要等到最近那次侦察结束后 `poll_minutes × 2^(k-1)` 分钟，最长 6 小时；手动触发的侦察也算在内，被 Master 停止打断的不算。有侦察建出了 issue，或者目标分支的最新提交（按提交者时间）晚于最近那次侦察的开始时间，退避马上解除，目标分支更新之前的侦察不再计数。退避和 `interval_hours` 同时生效，取较晚的时间；看板上能看到退避的原因和下次侦察的时间。在看板上手动触发侦察不受退避限制。

侦察的 Agent 额度用尽或被限流（目前能识别 Claude Code 的限流事件）不算失败，和 Run 遇到限流的处理一致（见下面的「Agent 出错时」）：侦察记为「额度用尽/限流」（`rate_limited`），`error` 里写明预计什么时候恢复额度（CLI 给了重置时间时），费用照常记录，事件列表里记一条 `scout.rate_limited`（数据里有 `scoutId`、`repo`，CLI 给了重置时间时还有 `retryAt`），不发系统通知。这样的侦察既不计入上面的连续次数，也不打断已有的连续计数，也不占用 `interval_hours` 的间隔（间隔从最近一次没被限流的侦察开始时间算起）。最近一次侦察（被 Master 停止打断的不算）被限流时，自动侦察先等额度恢复：CLI 给了额度重置时间就等到那时再多等 1 分钟，没给就从那次侦察结束时起，按连续被限流的侦察次数等 5、10、20、40 分钟，之后每次 1 小时。到时间后的下一轮检查就会侦察。这个等待和退避、`interval_hours` 同时生效，取最晚的时间，看板上写明「侦察遇到额度用尽或限流，等额度恢复」和预计时间。重置时间只记在内存里，Master 重启后按没给重置时间的规则等。在看板上手动触发侦察不受这个等待限制；手动侦察正常结束或失败后，等待就解除了。

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
- 用完 `max_run_attempts` 次后不再重做：评论列出每次失败的原因，issue 打上 `ares1:failed`，关闭为 not planned。这不等于不要这个需求：侦察读到这类 issue 时知道它不是人拒绝的，可以换个思路重新提案。要按原样再做，重新打开 issue 并加上 `ares1:ready`。
- 人加 `ares1:ready` 开始的 Run 是第 1 次；之后重新加 `ares1:ready`，次数从头算。等待重做期间关闭 issue，到时间后就不再重做（事件列表里记一条 `issue.redo_abandoned`），issue 保持你留下的样子。
- 被终止的 Run（人在看板上终止，或者关闭了 issue）不重做，issue 打上 `ares1:failed`，等你决定。

### 只信任仓库成员写的内容

公开仓库里任何人都能发 issue、写评论，而编码 Agent 会在运行 Master 的机器上执行命令，所以从 GitHub 读进 Agent 提示词的内容只认这些人写的：

- GitHub 的 `authorAssociation` 为 `OWNER`、`MEMBER`、`COLLABORATOR` 的人，也就是仓库所有者、所属组织的成员和协作者；
- Master 自己用的账号：`github.account`，没配时是 gh 当前登录的账号（启动后第一次需要时查一次）。

其余的人一律不信任，包括提过 PR 的 `CONTRIBUTOR`、`FIRST_TIME_CONTRIBUTOR` 和 `NONE`。Master 自己的评论仍然靠隐藏标记识别，但只认受信任的人写的：别人照抄标记也不算 Master 的。具体是：

- **需求评估的回复**：只把受信任的人的评论当作回复。陌生人的评论不交给 Agent，只在看板的讨论记录里记下「issue 上有 N 条非仓库成员的评论，没有当作回复」。只有陌生人回复时，就当作还没人回复，照常等待或按 `reply_timeout_hours` 超时。
- **侦察**：提示词里只列受信任的人或 Master 建的 issue；「不做」的理由只取受信任的人写的最后一条评论，没有就不写理由；「多次失败后关闭」也只认受信任的人写的标记。陌生人建的 issue 完全不出现，代价是侦察可能提出和它重复的提案，你在采纳时能发现。最近的 Run 里，来自陌生人 issue、还没人确认过的 Run 只列 issue 编号，不列内容。
- **从 issue 建 Run**：只有有 triage 及以上权限的人能加 `ares1:ready`，所以标签可信，但 issue 可能是陌生人写的，加标签之后也还能改。这时 Master 照常建 Run，目标是建 Run 那一刻 issue 的内容，之后再改 issue 不影响它；Run 一建好就停在「issue 作者不是仓库成员，等你确认需求」，在 issue 上说明原因，打上 `ares1:needs-you`。在这之前没有任何 Agent（包括只读的需求评估）读到它。你在 Run 详情页读过目标后点「确认并开始」，Run 才从头开始，之后照常按模板和 `auto_merge` 的设置走；这一步不管怎么设置都要人来做。不想做就终止 Run 或关闭 issue。Run 页上一直标着 issue 作者和确认的时间。
- **自动重做**：重做时目标从 issue 重新读。作者不受信任时，内容和上次确认过的一样就直接重做，改过就要重新确认。

### Agent 拿不到 GitHub 凭据

只把陌生人写的内容挡在提示词外面还不够：Agent 能执行命令，要是继承了本机 gh 的登录，它自己跑一下 `gh issue view 12 --comments`，陌生人的评论就又进来了；它还能以本机登录的所有 GitHub 账号读写这些账号能访问的所有仓库。Master 读 issue、发评论、推送都是自己做的，Agent 用不着 GitHub 凭据，所以 Agent（编码、评审、需求评估、侦察）和准备命令、检查命令都在去掉了 GitHub 凭据的环境里运行：

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
- 额度用尽或被限流（目前能识别 Claude Code 的限流事件）不算出错：不消耗重试次数，不换 Agent，也不卡住等人。Run 回到队首排队并让出执行位，别的 Run 照常执行；CLI 给了额度重置时间就等到那时再多等 1 分钟，没给就按连续被限流的次数等 5、10、20、40 分钟，之后每次 1 小时。到时间后从同一个 Task 接着做（返工意见不变）。等待期间 Run 详情页和事件列表会写明「额度用尽或被限流，预计 HH:mm 继续」。这个时间只记在内存里，Master 重启后 Run 会直接再试一次；想马上再试，可以暂停后再恢复。侦察遇到额度用尽或限流时按同样的规则等待，见上面「接入 GitHub」里侦察退避之后的一段。

数据目录里已经装好的 `workflows/self-dev.yaml` 不会自动更新。旧版本写的是 `on_agent_error: human`：出错时会先自动重试，重试用完后才卡住等人，加载时也会提示。想让它出错时也不等人，就手动改成 `switch_agent`。

## 返工或回退用完时

Task 没通过检查（检查命令失败、结构化输出不合格等）时，带着问题返工；评审打回、审批被驳回、合并前同步目标分支后检查没过、合并时和目标分支冲突（见下面的「合并冲突」）时，回退到 `on_fail` / `on_reject` 指向的阶段重做。两者都有上限，用完后怎么处理由 `escalate.on_exhausted` 决定：

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

Agent 出错且重试、换 Agent 都用完，Agent 不可用且没有可换的 Agent（或配置为 `on_agent_error: retry`），返工或回退用完，超出预算（默认；配置为 `on_budget_exceeded: pause` 时才等人），准备命令失败，Master 内部错误，合并时 git 因冲突以外的原因失败，合并冲突但没有 Agent 阶段能解决，工作目录与记录不一致（工作目录只是被删了的除外，见下面）时，Run 不等人，直接结束、标为失败。工作目录和分支保留，Master 接着做别的；从 issue 来的 Run 按 `max_run_attempts` 自动重做（见上面的「Run 失败后自动重做」），重做时失败原因会交给新 Run 的 Agent。

- 超出预算：模板或 Run 设了 `budget_usd` 时，Master 每次启动 Agent 之前检查花费，越过预算的那次执行照常检查和提交，之后不再开始新的执行。默认（`on_budget_exceeded: abort`）Run 结束、标为失败，`error` 写明已花费多少、预算多少。重做的 Run 从零算花费，总花费仍然有界：每个 Run 受 `budget_usd` 限制，次数受 `max_run_attempts` 限制，当天的总花费受 `daily_budget_usd` 限制。配置为 `on_budget_exceeded: pause` 时 Run 卡住（超出预算），在看板上填一个更高的预算后重试，从停下的地方接着做；配置页会对这个设置给出警告，`on_agent_error: human`、`on_exhausted: human` 也一样。
- 准备命令失败：`error` 里写明是哪条准备命令、退出码或超时，以及输出的末尾。准备命令失败多半是偶发的或者和环境有关（依赖源连不上、安装中途出错等），重做时会在新的工作目录里重新运行。
- Master 内部错误：Master 自己执行 Run 时出了异常（git 锁、磁盘满、命令起不来等）。`error` 以「Master 内部错误：」开头（英文为 `Master internal error:`），后面是原因。正在执行的 Agent 会被结束，这次执行记为中断（`interrupted`），没做完的 Task 标为已取消；工作目录保持出错时的样子，不回滚，方便查看。
- 合并时 git 因冲突以外的原因失败：合并阶段同步目标分支时 `git merge` 出错，但没报出冲突的文件（git 锁、磁盘满、索引损坏等）。这次合并已放弃，工作目录保持合并之前的样子。`error` 写明「合并 <目标分支> 的最新代码失败：」（英文为 `Merging the latest <目标分支> failed:`），后面是 git 的报错；合并阶段的检查里也记下这次失败。
- 合并冲突但没有 Agent 阶段能解决：合并阶段同步目标分支时有冲突，而合并阶段的 `on_fail` 指向的不是 Agent 阶段（见上面的「合并冲突」）。这次合并已放弃，目标分支没动，工作目录保持合并之前的样子。`error` 写明合并哪个目标分支的最新代码时哪些文件有冲突、为什么没有 Agent 能解决，以及重做时会基于目标分支的最新代码；合并阶段的检查里也记下这次冲突。
- 工作目录与记录不一致：Run 每次拿到执行位时（包括 Master 重启后），Master 都会检查它的工作目录还是不是自己留下的样子。工作目录只是被删了（比如清理磁盘时删掉），而 Run 的分支还在时，Master 自己从分支把工作目录恢复回来（`git worktree add`），复查通过就照常接着做，不停下，事件列表里记一条 `run.workspace_restored`（数据里有路径和分支）。其他情况说明工作目录已经不可信，Run 结束、标为失败，`error` 写明原因：工作目录当前不在 Run 的分支上；提交历史和记录不一致（Master 记录的最新提交已不在分支上，比如被手动 `git reset` 或改写过）；工作目录和分支都没了；从分支恢复失败（比如分支在别处检出）或恢复后复查仍不一致。工作目录和分支按实际情况保留（`error` 末尾写明保留了哪些），不做改动，方便查看；重做会在新的工作目录里进行。在工作目录里手动加的提交不算不一致，后面的检查照常会检查它们。
- 除超出预算外，这几种情况都没有「卡住等人」的配置：要是原因确实每次都会重现，issue 会把 `max_run_attempts` 次用完，然后关闭并写明每次的原因。
- 旧版本里因为这几种情况卡住（`blocked`）的 Run 仍然可以在看板上重试或终止：准备命令失败的会重新建工作目录、重新运行准备命令；内部错误的从出错的 Task 开始重做；合并失败的重新同步目标分支；因合并冲突卡住的，可以先在工作目录里自己 `git merge`、解决冲突并提交再重试，重试时重新同步目标分支，仍有冲突就按现在的做法结束 Run，也可以直接终止；工作目录与记录不一致的会先把被删的工作目录从分支恢复回来，再以工作目录当前的提交为准接着做。

## 稳定副本和自动升级

自举时，Master 不从开发仓库运行，而是从开发仓库的一份克隆（稳定副本）运行。Run 合并进开发仓库后，稳定副本就落后于它的 origin。这时 Master 会等手上的工作做完，再拉取、构建并重启自己；任何一步失败都会回退到旧版本。

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

新版本启动后，升级脚本先等它的 `/api/health` 有响应（最多一分钟），没有响应就结束它、回退。有响应以后，脚本不马上退出，而是再观察它一段时间（观察期，默认 5 分钟），每 5 秒看一次进程还在不在，免得新版本在第一次轮询 issue、第一次跑 Run 或侦察时才崩溃，进程一退出，系统就停转了，也没有人知道：

- 观察期内新版本以非 0 的退出码退出（崩溃、未捕获的异常、被信号杀掉）：和启动后没有响应一样处理，记为升级失败，回退到旧版本、重新构建并启动。消息写成「新版本 xxx 启动后 N 分钟内退出（退出码 c），已回退到 yyy」，`detail` 是新版本这次启动写进 `master.out` 的内容。回退后启动的旧版本不再观察。
- 观察期内新版本以退出码 0 退出：说明是有意停止的（有人用 SIGTERM 或 Ctrl-C 停了它，或者它又发现了更新的提交、把自己交给了下一次升级），不回退，脚本照常结束。
- 观察期满新版本还在运行：升级成功，脚本结束。

所以观察期内要停止 Master，用 SIGTERM（`kill <pid>`、`pkill -f ...`，下面「手动升级」的做法）或 Ctrl-C；用 `kill -9` 强行结束会被当成崩溃，回退到旧版本。观察期的长度由 Master 进程的环境变量 `ARES1_UPGRADE_WATCH` 决定（单位秒，默认 300，设为 0 就不观察），升级脚本从 Master 继承它。

观察期内新版本可能又发起下一次升级，所以 Master 每次把升级脚本复制成数据目录里的 `self-upgrade.sh` 时，都是先写一个临时文件再改名换上去，不会改写还在运行的那一份；脚本自己也把要花时间的步骤都放在一个函数里，bash 先读完整个函数再执行。

新版本启动时就读到了「升级成功」的结果（脚本在启动它之前写下），观察期内崩溃时脚本再写一份失败的结果，回退后的旧版本读到它：失败的目标仍然是新版本的提交，`upgrade.failed` 事件和侦察提示词里的「Master 自动升级失败」一节都照常出现，这个提交也不会再试。

升级的目标是 Master 检查时看到的 origin 最新提交，脚本只快进到这个提交。拉取、构建、启动某个目标失败，或者它在观察期内崩溃后，这个目标只试一次，不会每轮检查都重试；等 origin 有更新的提交再试。例如稳定副本里有和新提交冲突的未跟踪文件时，快进会失败，Master 回退到旧版本接着工作，删掉这些文件后要等下一个新提交才会再升级。

升级失败的原因会交给 Master 自身仓库的侦察，让系统自己修好坏掉的版本：

- 脚本把出错的输出末尾（最后 60 行，最多约 8000 个字符）写进结果文件的 `detail`：拉取或构建失败时是 `git` 和 `npm` 的输出，新版本启动后没有响应或在观察期内崩溃时是它这次启动写进 `master.out` 的内容（不含之前的旧日志）。
- 下一次启动的 Master 把它放进 `upgrade.failed` 事件数据的 `detail` 字段，并记下「最近一次升级失败」（起点、目标提交、消息、输出末尾、时间），直到有一次升级成功才清掉。
- Master 启动时读稳定副本的 origin（`git remote get-url origin`），判断哪个登记的仓库是它自己的源码：origin 是本地路径时，和仓库的目录比较（都解析符号链接后）；是 GitHub 地址时，和仓库在 GitHub 上的名字比较（不区分大小写）。
- 这个仓库的侦察提示词里，「最近的 Run」前面会多出一节「Master 自动升级失败」，列出目标提交、失败消息和输出末尾（用户目录换成 `~`，因为提案会发到 GitHub），并要求侦察把修复作为最高优先级；如果输出表明是网络、npm 源这类环境问题，就不要硬提代码修复。修复合并后，下一次升级自然成功，这一节随之消失。
- 其他仓库的侦察不受影响；不是从稳定副本运行（比如 `npm run dev`），或者 origin 和哪个仓库都对不上时，什么也不做。

## 手动升级

没有打开自动升级时，按下面的步骤升级。停止 Master 时，正在执行的 Run 会回到队首。

```bash
pkill -f "dist/cli.js --home $HOME/.ares1"
cd ~/ares1-stable && git pull --ff-only && npm ci && npm run build
nohup node dist/cli.js --home ~/.ares1 >> ~/.ares1/master.out 2>&1 &
```
