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
| `ares1:needs-you` | 等你处理：审批、卡住，或需求待讨论（在 issue 下回复即可） |
| `ares1:failed` | 失败或被终止。重新加 `ares1:ready` 会再做一次 |
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

为了不堆积没人看的提案，等着采纳的提案达到 `scout.max_proposals` 条时，Master 不再自动侦察。`auto_accept.max_risk` 为 `none` 时，所有没处理的提案都算；开了自动采纳时，只算在采纳范围内、因为当天的自动采纳数（`max_per_day`）已满还没采纳的提案，以及找不到侦察记录的提案。超出范围的提案（风险更高，或大小为 L）照样等你决定，但不会让侦察停下。

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
- Run 因此失败时，`error` 里写明最后是哪个 Agent 出了什么错、试过哪些 Agent。工作目录和分支保留，issue 打上 `ares1:failed`，Master 接着做别的。要再做一次，重新加 `ares1:ready`。
- 人在看板上重试卡住的 Run 后，返工次数和出错重试次数都重新计算。

数据目录里已经装好的 `workflows/self-dev.yaml` 不会自动更新。旧版本写的是 `on_agent_error: human`：出错时会先自动重试，重试用完后才卡住等人，加载时也会提示。想让它出错时也不等人，就手动改成 `switch_agent`。

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
