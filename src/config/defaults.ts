// Files written into the Master home directory on first start, in the language in use;
// existing files are never overwritten.

import { brandName } from '../brand.js';
import { lang, t } from '../i18n.js';

/** config.yaml written on first start. */
export function defaultConfigYaml(): string {
  return t({
    zh: `# ${brandName()}全局配置。修改后自动生效；端口和 CLI 路径（bins）需要重启 Master。

# 语言：zh（中文）/ en（English）。Master 写的 issue 评论、通知、给 Agent 的提示词（Agent 也会用它回答）
# 都用这个语言，也是看板的默认语言
language: ${lang()}

port: 4870

# 某个 CLI 不在 PATH 上时，在这里指定可执行文件路径（Master 自己用的 gh、glab 也一样）
# bins:
#   claude-code: /usr/local/bin/claude
#   cursor-agent: /usr/local/bin/cursor-agent
#   codex: /usr/local/bin/codex
#   glab: /usr/local/bin/glab

defaults:
  timeout_minutes: 60          # 单次 Agent 执行的超时
  command_timeout_minutes: 20  # 单条检查 / 准备命令的超时

# 同一仓库最多同时执行几个 Run，各在自己的工作目录里做，合并时一个一个来；大于 1 时更容易出现合并冲突，
# 所以评估预计改同一处（touches）的 Run 不会同时进入编码，后一个等前一个合并
# max_runs：所有仓库合计最多同时执行几个 Run，不写 = 不限（只受 per_repo 限制）
# concurrency:
#   per_repo: 1
#   max_runs: 3

# 用 GitHub Issues 管理需求，让 AI 侦察提需求（说明见${brandName()}仓库的 docs/running.md）：需要安装并登录 gh
# github:
#   account: my-account          # 可选：用 gh 的哪个账号，不写则用当前账号
#   poll_minutes: 5              # 多久查一次带 ares1:ready 标签的 issue
#   repos:
#     my-repo:                   # 看板上登记的仓库名
#       template: self-dev       # 从 issue 建 Run 用的模板
#       scout:                   # AI 侦察：读代码、文档和 Run 记录，提 issue
#         agent: claude-reviewer # 以只读方式运行，要用支持只读的 CLI（claude-code、codex）的 Agent
#         auto: true             # 仓库没有会自己往下走的 Run 时自动侦察（只等人的 Run 不挡，计入 max_proposals）；false = 只在看板上手动触发
#         interval_minutes: 0    # 两次自动侦察至少间隔几分钟；0 = 不限（侦察没找到需求或失败后另会退避，最长 6 小时；遇到额度用尽或限流则等额度恢复）
#         max_proposals: 5       # 一次最多提几条；未处理的提案加上只等人的 Run 达到这个数就不再自动侦察（开了自动采纳时提案只算在采纳范围内的）
#       auto_accept:
#         max_risk: none         # 自动采纳到哪个风险等级：none（都由人采纳）/ low / mid / high
#         # max_size: L          # 自动采纳到哪个大小：S / M / L（默认）；风险和大小都不超过才自动采纳。编码阶段 planning: auto 的模板会把 L 拆成几步做完
#         # max_per_day: 3       # 每天最多自动采纳几条；不写 = 不限
#       auto_merge: false        # true = 从 issue 来的 Run 合并前不等人审批
#       push: false              # true = 合并后把目标分支推送到 GitHub，每轮检查时也把 GitHub 上的新提交快进到本地目标分支
#       deliver: push            # push（默认）= 合并进本地目标分支后推送；pr = 推送 Run 分支并开 PR，PR 在 GitHub 上合并后 Run 才完成，适合目标分支受保护、要走 PR 或 CI 的仓库；pr 要求 push: true
#       daily_budget_usd: 20     # 可选：当天侦察、自动采纳的 Run 和自动重做的 Run 花费达到后停止自动行为；不写 = 不限
#       max_run_attempts: 3      # 一个 issue 最多跑几次 Run（含第一次）：失败后自动重做，带上失败原因；用完就关闭 issue 并写明每次的原因；1 = 不重做

# 托管在 GitLab 上的仓库（gitlab.com 或自建的）用 GitLab Issues 管理需求，规则和 github 的一样（说明见${brandName()}仓库的
# docs/running.md「接入 GitLab」）：需要安装 glab 并登录（glab auth login，自建的加 --hostname，和下面的 host 一样）。
# 登录的账号要能改 issue 和标签，push: true 时还要能推送目标分支（Developer 及以上，受保护分支要允许它推送；deliver: mr 时只推送 Run 的分支、开 MR）；
# 作者对项目的权限在 Developer 及以上才受信任，其他人开的 issue 建出的 Run 先等你确认需求
# gitlab:
#   host: gitlab.com             # GitLab 的主机名，默认 gitlab.com；自建的写它的主机名，不带 https://
#   # account: my-account        # 可选：Master 在 GitLab 上用的账号，要和 glab 登录的一致；不写则问 glab 当前登录的账号
#   poll_minutes: 5              # 多久查一次带 ares1:ready 标签的 issue
#   repos:
#     my-gitlab-repo:            # 看板上登记的仓库名，不能和 github.repos 里的重名
#       issues_repo: my-group/my-gitlab-repo  # 必填：项目在 GitLab 上的路径，在子组里就写全：group/subgroup/name
#       template: self-dev       # 从 issue 建 Run 用的模板；scout、auto_accept、auto_merge、daily_budget_usd、max_run_attempts 和 github.repos 里的一样
#       push: false              # true = 合并后把目标分支推送到 GitLab，每轮检查时也把 GitLab 上的新提交快进到本地目标分支
#       deliver: push            # push（默认）= 合并进本地目标分支后推送；mr = 推送 Run 分支并开 MR，MR 在 GitLab 上合并后 Run 才完成，适合目标分支受保护、要走 MR、流水线或审批的项目；mr 要求 push: true

# 没有 GitHub 或 GitLab issue 可用的仓库（只在本机的仓库、没有这两种账号、托管在内网其他服务上）用本地提案池：
# 侦察的提案存在 Master 里，在看板上采纳，或按 auto_accept 自动采纳后直接建 Run；人也可以用 POST /api/proposals 写自己的需求，
# 马上开工或先存着（先存着的不会自动采纳，也不计入挡住自动侦察的 max_proposals）；不需要 gh 或 glab。字段的含义和 github.repos
# 里的同名字段一样（说明见${brandName()}仓库的 docs/running.md「不用 GitHub 时」）。一个仓库只能写在 github.repos、gitlab.repos、
# backlog.repos 中的一处，按这个顺序检查，后出现的不生效
# backlog:
#   poll_minutes: 5              # 多久检查一次本地提案池：自动采纳范围内的提案、该侦察时侦察
#   repos:
#     my-local-repo:             # 看板上登记的仓库名，不能和 github.repos、gitlab.repos 里的重名
#       template: self-dev       # 采纳的提案建 Run 用的模板
#       scout:                   # 不写 = 不侦察，这个仓库只做人写的需求
#         agent: claude-reviewer # 以只读方式运行，要用支持只读的 CLI（claude-code、codex）的 Agent
#         auto: true             # 仓库没有会自己往下走的 Run 时自动侦察；false = 只在看板上手动触发
#       auto_accept:
#         max_risk: low          # 风险和大小都在范围内的提案直接建 Run；范围外的等你在看板上采纳或拒绝
#       auto_merge: false        # true = 采纳的提案建出的 Run 合并前不等人审批
#       daily_budget_usd: 10     # 可选：当天侦察、自动采纳的 Run 和自动重做的 Run 花费达到后停止自动行为；不写 = 不限
#       max_run_attempts: 3      # 一条提案最多跑几次 Run（含第一次）：失败后自动重做，带上失败原因；用完就把提案标为失败；1 = 不重做

# 需要人处理时（Run 卡住或失败、等审批、提案等人决定、推送或升级失败），Master 直接发系统通知
# macOS 用通知中心；Linux 需要 notify-send（libnotify）；其他平台不支持，仍由浏览器发通知
# notify:
#   system: true

# 稳定副本落后于它的 origin（开发仓库）时，Master 自动升级并重启，失败自动回退；Master 要从稳定副本的构建（dist/cli.js）启动
# upgrade:
#   auto: true
`,
    en: `# ${brandName()} global configuration. Changes apply on their own; the port and CLI paths (bins) need a Master restart.

# Language: zh (Chinese) / en (English). Issue comments, notifications and prompts to agents (agents answer in it
# too) are written in it; it is also the dashboard's default language
language: ${lang()}

port: 4870

# The executable of a CLI that is not on PATH (also of gh and glab, which the Master uses itself)
# bins:
#   claude-code: /usr/local/bin/claude
#   cursor-agent: /usr/local/bin/cursor-agent
#   codex: /usr/local/bin/codex
#   glab: /usr/local/bin/glab

defaults:
  timeout_minutes: 60          # timeout of a single agent execution
  command_timeout_minutes: 20  # timeout of a single verify / setup command

# How many Runs of one repo execute at the same time, each in its own worktree; they merge one at a time. Above 1, merge conflicts get more likely
# max_runs: how many Runs of all repos together execute at the same time; omitted = no limit (only per_repo applies)
# concurrency:
#   per_repo: 1
#   max_runs: 3

# Requirements as GitHub Issues, with an AI scout proposing them (see docs/running.md in the ${brandName()} repo); needs gh installed and logged in
# github:
#   account: my-account          # optional: which gh account to use; omitted = the active one
#   poll_minutes: 5              # how often to look for issues labeled ares1:ready
#   repos:
#     my-repo:                   # the repo name registered on the dashboard
#       template: self-dev       # template of the Runs created from issues
#       scout:                   # AI scout: reads code, docs and Run records, files issues
#         agent: claude-reviewer # runs read-only, so it needs an agent of a CLI that supports that (claude-code, codex)
#         auto: true             # scout whenever no Run of the repo goes on by itself (Runs only a human moves on count toward max_proposals instead); false = only from the dashboard
#         interval_minutes: 0    # at least this many minutes between automatic scouts; 0 = no minimum (scouts that find nothing or fail still back off, up to 6 hours; out of quota or rate-limited, it waits for the quota)
#         max_proposals: 5       # proposals per scout; no automatic scout while this many proposals and Runs stuck waiting for a human await you (with auto-accept on, only proposals within its range count)
#       auto_accept:
#         max_risk: none         # accept automatically up to this risk: none (a human accepts all) / low / mid / high
#         # max_size: L          # accept automatically up to this size: S / M / L (default); both risk and size must be within. A template with planning: auto in its coding stage splits an L into steps
#         # max_per_day: 3       # at most this many automatic accepts a day; omitted = no limit
#       auto_merge: false        # true = Runs from issues merge without waiting for approval
#       push: false              # true = push the target branch to GitHub after merging, and fast-forward it to new commits on GitHub at every check
#       deliver: push            # push (default) = merge into the local target branch, then push it; pr = push the Run's branch and open a pull request, and the Run completes once it is merged on GitHub: for target branches that are protected or need a PR or CI; pr needs push: true
#       daily_budget_usd: 20     # optional: stop automatic actions once the day's scouts, auto-accepted Runs and automatic redos cost this much; omitted = no limit
#       max_run_attempts: 3      # Runs an issue gets at most, the first included: a failed Run is redone automatically with its reason; once they are used up, the issue is closed with every reason; 1 = never redone

# Repos hosted on GitLab (gitlab.com or a self-hosted one) take requirements as GitLab Issues, by the same rules as github (see the GitLab section of
# docs/running.md in the ${brandName()} repo); needs glab installed and logged in (glab auth login, with --hostname set to the host below for a self-hosted one).
# The account must be able to edit issues and labels, and with push: true to push the target branch (Developer or above; a protected branch must let it push; with deliver: mr it pushes only the Runs' branches and opens merge requests).
# Authors are trusted from Developer up on the project; a Run from anybody else's issue waits for you to confirm its goal
# gitlab:
#   host: gitlab.com             # the GitLab's host name, gitlab.com by default; a self-hosted one's own, without https://
#   # account: my-account        # optional: the account the Master acts as on GitLab, the one glab is logged in as; omitted = asked of glab
#   poll_minutes: 5              # how often to look for issues labeled ares1:ready
#   repos:
#     my-gitlab-repo:            # the repo name registered on the dashboard; not one of github.repos
#       issues_repo: my-group/my-gitlab-repo  # required: the project's path on GitLab, subgroups included: group/subgroup/name
#       template: self-dev       # template of the Runs created from issues; scout, auto_accept, auto_merge, daily_budget_usd and max_run_attempts as in github.repos
#       push: false              # true = push the target branch to GitLab after merging, and fast-forward it to new commits on GitLab at every check
#       deliver: push            # push (default) = merge into the local target branch, then push it; mr = push the Run's branch and open a merge request, and the Run completes once it is merged on GitLab: for target branches that are protected or need an MR, pipelines or approvals; mr needs push: true

# Repos with neither GitHub nor GitLab issues (local only, no such account, hosted on another intranet service) use the local backlog: the scout's
# proposals are kept by the Master, and become Runs once accepted on the dashboard or automatically by auto_accept. You can write requirements of your
# own with POST /api/proposals, started at once or kept for later (those kept are never accepted automatically, and do not count toward the
# max_proposals that hold the automatic scout back). No gh or glab needed. The fields
# mean what they mean in github.repos (see the local backlog section of docs/running.md in the ${brandName()} repo). A repo can be in only one of github.repos,
# gitlab.repos and backlog.repos; they are checked in that order, and a later one does not take effect
# backlog:
#   poll_minutes: 5              # how often to go over the local backlog: auto-accept proposals within range, scout when it is time
#   repos:
#     my-local-repo:             # the repo name registered on the dashboard; not one of github.repos or gitlab.repos
#       template: self-dev       # template of the Runs created from accepted proposals
#       scout:                   # omitted = no scouting: the repo works on the requirements humans write
#         agent: claude-reviewer # runs read-only, so it needs an agent of a CLI that supports that (claude-code, codex)
#         auto: true             # scout whenever no Run of the repo goes on by itself; false = only from the dashboard
#       auto_accept:
#         max_risk: low          # proposals within both risk and size become Runs right away; the others wait for you to accept or reject them on the dashboard
#       auto_merge: false        # true = Runs from accepted proposals merge without waiting for approval
#       daily_budget_usd: 10     # optional: stop automatic actions once the day's scouts, auto-accepted Runs and automatic redos cost this much; omitted = no limit
#       max_run_attempts: 3      # Runs a proposal gets at most, the first included: a failed Run is redone automatically with its reason; once they are used up, the proposal is marked failed; 1 = never redone

# When a human is needed (a Run is stuck or failed, an approval or a proposal waits, a push or upgrade failed), the Master sends a system notification:
# Notification Center on macOS; on Linux it needs notify-send (libnotify); other platforms are not supported, and the browser keeps sending them
# notify:
#   system: true

# When the stable copy falls behind its origin (the development repo), the Master upgrades and restarts itself, rolling back on failure; the Master must run from the stable copy's build (dist/cli.js)
# upgrade:
#   auto: true
`,
  });
}

/** agents.yaml written on first start. */
export function defaultAgentsYaml(): string {
  return t({
    zh: `# Agent = CLI + 模型 + 运行参数：同一个 CLI 换了模型或 effort 就是另一个 Agent
# cli 可以写 claude-code、cursor-agent 或 codex；需求评估、拆分任务和侦察以只读方式运行，要用 claude-code 或 codex 的 Agent
agents:
  claude-coder:
    cli: claude-code
    model: opus
    effort: xhigh             # 可选：low / medium / high / xhigh / max，不写则用 CLI 默认值
    tier: high
    cost: high
    tags: [coding]

  claude-reviewer:
    cli: claude-code
    model: opus               # 与编码者模型相同但运行参数（effort）不同，仍算作不同的 Agent
    # effort: high            # 不写则用 CLI 默认值
    tier: high
    cost: high
    tags: [review]
`,
    en: `# Agent = CLI + model + run settings: the same CLI with another model or effort is another agent
# cli can be claude-code, cursor-agent or codex; assessments, task plans and scouts run read-only, which needs a claude-code or codex agent
agents:
  claude-coder:
    cli: claude-code
    model: opus
    effort: xhigh             # optional: low / medium / high / xhigh / max; omitted = the CLI's default
    tier: high
    cost: high
    tags: [coding]

  claude-reviewer:
    cli: claude-code
    model: opus               # the coder's model with other run settings (effort) is still another agent
    # effort: high            # omitted = the CLI's default
    tier: high
    cost: high
    tags: [review]
`,
  });
}

/**
 * workflows/self-dev.yaml written on first start. Its Chinese text is also this repo's own
 * .ares1/workflows/self-dev.yaml, the workflow it is developed with: change both together.
 */
export function defaultSelfDevYaml(): string {
  return t({
    zh: `# 自举用的流程：需求评估 → 编码 → 检查 → 评审 → E2E（占位）→ 合并前人工审批 → 合并
id: self-dev
name: 自举开发

defaults:
  escalate:
    max_retries: 2               # 返工次数上限；Agent 出错时也按这个次数重试（带退避），两者分开计数
    on_agent_error: switch_agent # Agent 出错：重试用完后换另一个 Agent 再试，都不行就结束 Run、标为失败；human = 重试用完后卡住等人
    on_exhausted: fail           # 返工 max_retries 次仍未通过，或回退超过 max_loops：结束 Run、标为失败，从 issue 来的会带着原因自动重做；human = 卡住等人
  max_loops: 3                 # 同一阶段最多回退重做几轮（评审打回、审批驳回都算）

stages:
  - id: assess
    name: 需求评估
    kind: assess               # 只读地评估需求：go 开工；ask 在 issue / 看板上讨论；人同意后 drop 不做
    agent: claude-reviewer     # 以只读方式运行，要用支持只读的 CLI（claude-code 或 codex）
    reply_timeout_hours: 24    # 提出疑问后等人回复几小时，超时由评估自己决定（写明假设后开工，或者不做）；0 = 不等人；null = 一直等

  - id: implement
    name: 编码
    kind: agent
    agent: claude-coder        # planning: auto 要以只读方式拆分，要用支持只读的 CLI（claude-code 或 codex）
    planning: auto             # 按需求评估给出的规模：L（要改多个模块）先由这个 Agent 只读地拆成几步，再一步一步做、
                               # 一步一步检查和提交；S、M 或没给规模时整个阶段一次做完。single = 从不拆分，llm = 总是拆分
    inputs: [assessment]       # 评估结论（讨论后修改的需求）放进提示词
    instructions: |
      实现目标中描述的需求，并补充必要的测试。
    # 检查命令默认使用仓库登记时配置的命令，也可以在这里覆盖：
    # verify:
    #   commands: ["npm run build", "npm test", "npm run lint"]

  - id: review
    name: 评审
    kind: review
    agent: claude-reviewer
    inputs: [diff, assessment]
    on_fail: implement

  - id: e2e
    name: E2E
    kind: placeholder          # 占位：暂未实现，执行到这一步直接通过
    instructions: |
      端到端测试（暂未实现）
    # 想在这里运行项目自己的端到端测试、冒烟测试或部署前检查，就改成 kind: command 并写上命令
    # （去掉上面的 instructions）。Master 在工作目录依次运行，不调 Agent；有命令失败时带着输出
    # 回到 on_fail（不写就是前面最近的 Agent 阶段，即编码），计入 max_loops。不写 verify 就运行
    # 仓库登记的检查命令。
    # kind: command
    # verify:
    #   commands: ["npx playwright test"]

  - id: merge
    name: 合并
    kind: merge
    gate: true
    on_reject: implement
`,
    en: `# The self-development flow: assess → code → verify → review → E2E (placeholder) → approval before merging → merge
id: self-dev
name: Self-development

defaults:
  escalate:
    max_retries: 2               # reworks allowed; an agent that errors is also retried this many times (with a backoff), counted apart
    on_agent_error: switch_agent # agent errors: once the retries are used up, another agent tries; if none succeeds, the Run ends as failed; human = wait for a human once the retries are used up
    on_exhausted: fail           # still failing after max_retries reworks, or rolled back more than max_loops times: the Run ends as failed, and a Run from an issue is redone with the reason; human = wait for a human
  max_loops: 3                 # how many times a stage may be redone after rollbacks (sent back by a review or rejected at approval)

stages:
  - id: assess
    name: Requirement assessment
    kind: assess               # judges the requirement read-only: go starts; ask discusses on the issue / dashboard; drop (once a human agrees) skips it
    agent: claude-reviewer     # runs read-only, so it needs a CLI that supports that (claude-code or codex)
    reply_timeout_hours: 24    # hours to wait for a reply to its questions; then the assessment decides on its own (goes ahead on written-down assumptions, or drops it); 0 = no wait; null = wait forever

  - id: implement
    name: Coding
    kind: agent
    agent: claude-coder        # planning: auto splits read-only, so it needs a CLI that supports that (claude-code or codex)
    planning: auto             # by the size the assessment gave: an L (changes across modules) is first split into steps by this
                               # agent, read-only, each then done, checked and committed on its own; S, M or no size is done in
                               # one go. single = never split, llm = always split
    inputs: [assessment]       # the assessment (the requirement as revised in the discussion) goes into the prompt
    instructions: |
      Implement the requirement described in the goal, and add the tests it needs.
    # Verify commands default to the ones set when the repo was registered; they can be overridden here:
    # verify:
    #   commands: ["npm run build", "npm test", "npm run lint"]

  - id: review
    name: Review
    kind: review
    agent: claude-reviewer
    inputs: [diff, assessment]
    on_fail: implement

  - id: e2e
    name: E2E
    kind: placeholder          # placeholder: not implemented yet, this step passes right away
    instructions: |
      End-to-end tests (not implemented yet)
    # To run the project's own end-to-end tests, smoke tests or pre-deployment checks here, change
    # it to kind: command and write the commands (and drop the instructions above). The Master runs
    # them in order in the worktree, without an agent; when one fails, the stage goes back to
    # on_fail (by default the nearest earlier agent stage, i.e. coding) with the output, counted
    # toward max_loops. Without verify it runs the repo's verify commands.
    # kind: command
    # verify:
    #   commands: ["npx playwright test"]

  - id: merge
    name: Merge
    kind: merge
    gate: true
    on_reject: implement
`,
  });
}
