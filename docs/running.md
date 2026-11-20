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

仓库有会自己往下走的 Run 时，Master 不自动侦察，等它们做完再找新活：排队的、执行中的，等你回复评估的疑问、但设了超时（`reply_timeout_hours` 不是 `null`）的 Run，以及因为目标分支有未提交的改动而停下、改动清掉后会自动接着合并的 Run。只等人的 Run（见下面的「Run 什么时候停下来等人」）不会挡住侦察，否则没人在场时只要有一个 Run 卡住，这个仓库就再也不会有新需求。

为了不堆积没人看的工作，等你处理的提案和只等人的 Run 合计达到 `scout.max_proposals` 时，Master 不再自动侦察，看板上写明两部分各有几个，比如「有 2 条提案、1 个卡住的 Run 等你处理」。`auto_accept.max_risk` 为 `none` 时，所有没处理的提案都算；开了自动采纳时，只算在采纳范围内、因为当天的自动采纳数（`max_per_day`）已满还没采纳的提案，以及找不到侦察记录的提案。超出范围的提案（风险更高，或大小为 L）照样等你决定，但不会让侦察停下。卡住的 Run 对应的 issue 还开着，侦察能在提示词里看到它们，不会重复提案。

侦察没找到需求或失败后，自动侦察会退避，免得仓库没变时每轮检查都花钱重新侦察一遍。从最近一次侦察往回数，连续 k 次没有建出 issue（包括提案全部重复、没建成 issue 的）或失败，下次自动侦察就要等到最近那次侦察结束后 `poll_minutes × 2^(k-1)` 分钟，最长 6 小时；手动触发的侦察也算在内，被 Master 停止打断的不算。有侦察建出了 issue，或者目标分支的最新提交（按提交者时间）晚于最近那次侦察的开始时间，退避马上解除，目标分支更新之前的侦察不再计数。退避和 `interval_hours` 同时生效，取较晚的时间；看板上能看到退避的原因和下次侦察的时间。在看板上手动触发侦察不受退避限制。

### Run 失败后自动重做

从 issue 来的 Run 失败后（`failed`，比如 Agent 出错且重试、换 Agent 都用完，返工或回退次数用完，超出预算且配置为终止，准备命令失败，Master 内部错误；不包括被终止的），Master 不等人，自动再开一个 Run 重做。次数上限是 `github.repos.<name>.max_run_attempts`：

```yaml
github:
  repos:
    my-repo:
      template: self-dev
      max_run_attempts: 3   # 一个 issue 最多跑几次 Run，含第一次；不写也是 3；1 = 不重做
```

- 失败时，issue 上的评论写明失败原因和「第 n/N 次尝试」，标签保持 `ares1:running`。新 Run 的目标仍然从 issue 读（期间改过 issue 就用改过的），之前每次失败的原因和失败的阶段会写进需求评估和编码的提示词，提醒 Agent 避开同样的问题。
- 自动重做的 Run 计入当天的自动花费（`daily_budget_usd`）。花费已达上限时先不重做，issue 上会说明，第二天预算恢复后再做；等待不算用掉一次。工作开关关着时也不重做，打开后再做。
- 用完 `max_run_attempts` 次后不再重做：评论列出每次失败的原因，issue 打上 `ares1:failed`，关闭为 not planned。这不等于不要这个需求：侦察读到这类 issue 时知道它不是人拒绝的，可以换个思路重新提案。要按原样再做，重新打开 issue 并加上 `ares1:ready`。
- 人加 `ares1:ready` 开始的 Run 是第 1 次；之后重新加 `ares1:ready`，次数从头算。等待重做期间关闭 issue，就不再重做，issue 保持你留下的样子。
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
- 额度用尽或被限流（目前能识别 Claude Code 的限流事件）不算出错：不消耗重试次数，不换 Agent，也不卡住等人。Run 回到队首排队并让出执行位，别的 Run 照常执行；CLI 给了额度重置时间就等到那时再多等 1 分钟，没给就按连续被限流的次数等 5、10、20、40 分钟，之后每次 1 小时。到时间后从同一个 Task 接着做（返工意见不变）。等待期间 Run 详情页和事件列表会写明「额度用尽或被限流，预计 HH:mm 继续」。这个时间只记在内存里，Master 重启后 Run 会直接再试一次；想马上再试，可以暂停后再恢复。

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
- 合并阶段的 `on_fail` 指向的不是 Agent 阶段（比如评审阶段，它不能改文件），或者 git 合并因为冲突以外的原因失败时，Run 卡住（合并冲突），等人在工作目录里自己 `git merge`、解决冲突并提交后重试。

## Run 什么时候停下来等人

Run 卡住（`blocked`）、已暂停或等审批时会让出执行位，排队的 Run 照常执行。这些只等人的 Run 也不会让仓库停止自动侦察：它们和等你处理的提案一起计入 `scout.max_proposals`，合计没到上限时照常侦察，到了上限才等你处理（见上面的「接入 GitHub」）。只有排队、执行中的 Run，等评估回复且设了超时的 Run，以及等目标分支上的改动清掉的 Run（见下面），会让侦察等它们做完。默认配置下，只有这些情况会停下来等人：

- 审批：模板里设了 `gate` 的阶段（从 issue 来的 Run 打开 `auto_merge` 时，合并不等审批）。
- 需求评估有疑问，等你回复，最多等 `reply_timeout_hours`（到时间评估自己决定，所以这种 Run 算作会自己往下走；设为 `null` 时一直等，算作只等人）；issue 作者不是仓库成员，等你确认需求。
- 超出预算（`on_budget_exceeded: pause`，默认）。
- 合并冲突但没有 Agent 阶段能解决（见上面的「合并冲突」）、工作目录与记录不一致。
- 配置为等人时：`on_agent_error: human`（包括 Agent 不可用时）、`on_exhausted: human`。

目标分支有未提交的改动时，Run 也会卡住（`target_dirty`），但不用你做任何决定：合并阶段要快进目标分支，而目标分支在某个目录里检出、且有已跟踪文件的改动没提交（未跟踪的文件不算），快进会动到这些改动，所以先停下，并照常发「Run 卡住了」的通知。之后 Master 大约每分钟复查一次，你提交或丢弃这些改动后，Run 会自己回到队首接着合并：重新同步目标分支，有新提交时重跑检查，再快进。不用去看板点重试（点了也行，会立刻继续）。改动还在时复查什么都不改，也不会重复通知；工作开关关着时不会自动继续，打开时马上查一次。自举时 Master 正是往开发仓库的 `main` 合并，在那里随手改了文件，处理掉就行。这种 Run 算作会自己往下走，不计入 `scout.max_proposals`。

Agent 出错且重试、换 Agent 都用完，Agent 不可用且没有可换的 Agent（或配置为 `on_agent_error: retry`），返工或回退用完，超出预算且配置为 `on_budget_exceeded: abort`，准备命令失败，Master 内部错误时，Run 不等人，直接结束、标为失败。工作目录和分支保留，Master 接着做别的；从 issue 来的 Run 按 `max_run_attempts` 自动重做（见上面的「Run 失败后自动重做」），重做时失败原因会交给新 Run 的 Agent。

- 准备命令失败：`error` 里写明是哪条准备命令、退出码或超时，以及输出的末尾。准备命令失败多半是偶发的或者和环境有关（依赖源连不上、安装中途出错等），重做时会在新的工作目录里重新运行。
- Master 内部错误：Master 自己执行 Run 时出了异常（git 锁、磁盘满、命令起不来等）。`error` 以「Master 内部错误：」开头（英文为 `Master internal error:`），后面是原因。正在执行的 Agent 会被结束，这次执行记为中断（`interrupted`），没做完的 Task 标为已取消；工作目录保持出错时的样子，不回滚，方便查看。
- 这两种情况都没有「卡住等人」的配置：要是原因确实每次都会重现，issue 会把 `max_run_attempts` 次用完，然后关闭并写明每次的原因。
- 旧版本里因为这两种情况卡住（`blocked`）的 Run 仍然可以在看板上重试：准备命令失败的会重新建工作目录、重新运行准备命令；内部错误的从出错的 Task 开始重做。

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

## 手动升级

没有打开自动升级时，按下面的步骤升级。停止 Master 时，正在执行的 Run 会回到队首。

```bash
pkill -f "dist/cli.js --home $HOME/.ares1"
cd ~/ares1-stable && git pull --ff-only && npm ci && npm run build
nohup node dist/cli.js --home ~/.ares1 >> ~/.ares1/master.out 2>&1 &
```
