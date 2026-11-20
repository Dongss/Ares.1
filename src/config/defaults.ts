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

# 某个 CLI 不在 PATH 上时，在这里指定可执行文件路径
# bins:
#   claude-code: /usr/local/bin/claude
#   cursor-agent: /usr/local/bin/cursor-agent

defaults:
  timeout_minutes: 60          # 单次 Agent 执行的超时
  command_timeout_minutes: 20  # 单条检查 / 准备命令的超时

# 用 GitHub Issues 管理需求，让 AI 侦察提需求（说明见${brandName()}仓库的 docs/running.md）：需要安装并登录 gh
# github:
#   account: my-account          # 可选：用 gh 的哪个账号，不写则用当前账号
#   poll_minutes: 5              # 多久查一次带 ares1:ready 标签的 issue
#   repos:
#     my-repo:                   # 看板上登记的仓库名
#       template: self-dev       # 从 issue 建 Run 用的模板
#       scout:                   # AI 侦察：读代码、文档和 Run 记录，提 issue
#         agent: claude-reviewer # 只能用 claude-code 的 Agent，以只读方式运行
#         auto: true             # 仓库没有未结束的 Run 时自动侦察；false = 只在看板上手动触发
#         interval_hours: 0      # 两次自动侦察至少间隔几小时；0 = 不限
#         max_proposals: 5       # 一次最多提几条；未处理的提案达到这个数就不再自动侦察
#       auto_accept:
#         max_risk: none         # 自动采纳到哪个风险等级：none（都由人采纳）/ low / mid / high
#         # max_per_day: 3       # 每天最多自动采纳几条；不写 = 不限
#       auto_merge: false        # true = 从 issue 来的 Run 合并前不等人审批
#       push: false              # true = 合并后把目标分支推送到 GitHub
#       daily_budget_usd: 20     # 可选：当天侦察和自动采纳的 Run 花费达到后停止自动行为；不写 = 不限

# 需要人处理时（Run 卡住或失败、等审批、提案等人决定、推送或升级失败），Master 直接发系统通知
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

# The executable of a CLI that is not on PATH
# bins:
#   claude-code: /usr/local/bin/claude
#   cursor-agent: /usr/local/bin/cursor-agent

defaults:
  timeout_minutes: 60          # timeout of a single agent execution
  command_timeout_minutes: 20  # timeout of a single verify / setup command

# Requirements as GitHub Issues, with an AI scout proposing them (see docs/running.md in the ${brandName()} repo); needs gh installed and logged in
# github:
#   account: my-account          # optional: which gh account to use; omitted = the active one
#   poll_minutes: 5              # how often to look for issues labeled ares1:ready
#   repos:
#     my-repo:                   # the repo name registered on the dashboard
#       template: self-dev       # template of the Runs created from issues
#       scout:                   # AI scout: reads code, docs and Run records, files issues
#         agent: claude-reviewer # must be a claude-code agent; it runs read-only
#         auto: true             # scout whenever the repo has no unfinished Run; false = only from the dashboard
#         interval_hours: 0      # at least this many hours between automatic scouts; 0 = no minimum
#         max_proposals: 5       # proposals per scout; no automatic scout while this many await a decision
#       auto_accept:
#         max_risk: none         # accept automatically up to this risk: none (a human accepts all) / low / mid / high
#         # max_per_day: 3       # at most this many automatic accepts a day; omitted = no limit
#       auto_merge: false        # true = Runs from issues merge without waiting for approval
#       push: false              # true = push the target branch to GitHub after merging
#       daily_budget_usd: 20     # optional: stop automatic actions once the day's scouts and auto-accepted Runs cost this much; omitted = no limit

# When a human is needed (a Run is stuck or failed, an approval or a proposal waits, a push or upgrade failed), the Master sends a system notification
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

/** workflows/self-dev.yaml written on first start. */
export function defaultSelfDevYaml(): string {
  return t({
    zh: `# 自举用的流程：需求评估 → 编码 → 检查 → 评审 → E2E（占位）→ 合并前人工审批 → 合并
id: self-dev
name: 自举开发

defaults:
  escalate:
    max_retries: 2
    on_agent_error: human
  max_loops: 3

stages:
  - id: assess
    name: 需求评估
    kind: assess               # 只读地评估需求：go 开工；ask 在 issue / 看板上讨论；人同意后 drop 不做
    agent: claude-reviewer     # 以只读方式运行，要用支持只读的 CLI（claude-code）

  - id: implement
    name: 编码
    kind: agent
    agent: claude-coder
    planning: single
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
    max_retries: 2
    on_agent_error: human
  max_loops: 3

stages:
  - id: assess
    name: Requirement assessment
    kind: assess               # judges the requirement read-only: go starts; ask discusses on the issue / dashboard; drop (once a human agrees) skips it
    agent: claude-reviewer     # runs read-only, so it needs a CLI that supports that (claude-code)

  - id: implement
    name: Coding
    kind: agent
    agent: claude-coder
    planning: single
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

  - id: merge
    name: Merge
    kind: merge
    gate: true
    on_reject: implement
`,
  });
}
