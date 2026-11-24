# 配置示例

这里是一组完整的配置示例，目录结构和数据目录（默认 `~/.ares1`）一样，复制过去改改名字就能用。每个文件里的注释说明了每一项的含义和默认值。运行、配置和升级的完整说明见 [`docs/running.md`](../running.md)。

| 文件 | 内容 |
|---|---|
| [`config.yaml`](config.yaml) | 全局配置：语言、端口、CLI 路径、超时、同时执行几个 Run、通知、自动升级；GitHub 里登记了 4 个仓库，分别用下面 4 个模板，侦察、自动采纳、自动合并、推送、每日预算的设置各不相同 |
| [`agents.yaml`](agents.yaml) | 6 个 Agent：编码用的强模型配高 effort（`claude-coder`），评审、需求评估、侦察用的便宜一档的模型（`claude-reviewer`），只改文件不执行命令的 `permission: safe`（`claude-docs`），cursor-agent 的另一家模型（`cursor-grok`，带 `price`），同样能以只读方式运行的 Codex CLI（`codex-reviewer`，Claude 额度用完时接着做需求评估、拆分任务和侦察），停用的 `enabled: false`（`claude-max`）；也演示了 `timeout_minutes`、`args` 的写法 |
| [`workflows/light.yaml`](workflows/light.yaml) | 轻量：编码 → 评审 → 合并，不做需求评估。适合文档、小改动 |
| [`workflows/strict.yaml`](workflows/strict.yaml) | 严格：需求评估 → 编码 → 评审 → 人工审批 → 合并。适合生产仓库；编码阶段用 `planning: auto`：需求评估给出的规模是 L 时先把需求拆成几步，再一步一步做、一步一步检查和提交 |
| [`workflows/with-e2e.yaml`](workflows/with-e2e.yaml) | 带 E2E：编码 → 评审 → E2E（`kind: command`，比如 playwright，或 `docker compose up` 之后探活）→ 合并，E2E 失败时回到编码 |
| [`workflows/cross-review.yaml`](workflows/cross-review.yaml) | 交叉评审：需求评估 → 编码 → 评审 → 合并。编码阶段从三个 Claude 的 Agent 里按难度挑（`claude-docs` / `claude-reviewer` / `claude-coder`），评审阶段从别家的 `codex-reviewer`、`cursor-grok` 里挑；Agent 出错时只在这个阶段的候选里换一个再试 |

`cross-review.yaml` 演示了 `agent_candidates`：一个阶段列几个候选 Agent，Master 按需求评估给出的难度从中挑档次（`tier`）够用、成本（`cost`）最低的一个，模板里的注释写了每种难度会挑到谁。

## 复制到数据目录

```bash
cp ~/.ares1/config.yaml ~/.ares1/config.yaml.bak     # 先备份已有的配置
cp ~/.ares1/agents.yaml ~/.ares1/agents.yaml.bak
cp docs/examples/config.yaml docs/examples/agents.yaml ~/.ares1/
cp docs/examples/workflows/*.yaml ~/.ares1/workflows/
```

- Master 发现配置文件变了会自动重新加载，不用重启（改 `port`、`bins` 除外）。加载的结果在看板的「配置」页：哪个 Agent、模板或仓库有问题，就只停用它自己，并写明原因。
- `config.yaml` 里的 `my-web`、`my-api`、`my-docs`、`my-tool` 是占位名：改成你在看板「仓库」页登记的仓库名，用不到的整段删掉。`issues_repo` 也要改成你自己的 GitHub 仓库，或者删掉，让 gh 按本地仓库的 remote 推断。
- 只想要其中一部分也行：模板可以只挑需要的复制，但 `config.yaml` 里仓库用的模板（`template`）、模板和侦察用的 Agent 都得存在，否则对应的仓库或模板会被停用。
- 模板也可以不复制到数据目录，而是提交到仓库目标分支的 `.ares1/workflows/` 里，格式一样，跟着代码一起评审、一起演进，只给这个仓库用；数据目录里有同 id 的模板时用数据目录那份。详见 [`docs/running.md`](../running.md#仓库自带的流程模板) 的「仓库自带的流程模板」。
- 数据目录里原来的 `workflows/self-dev.yaml` 用的是 `claude-coder` 和 `claude-reviewer`，示例的 `agents.yaml` 保留了这两个名字，换上示例后它照样能用。
- 示例的 `language` 是 `zh`；想让 issue 评论和给 Agent 的提示词用英文，就改成 `en`。

## 哪些设置在配置文件里，哪些在看板上

| 设置 | 在哪里 |
|---|---|
| 语言、端口、CLI 路径（`bins`）、Agent 执行和命令的超时、同一仓库同时执行几个 Run、系统通知、自动升级 | `config.yaml` |
| 仓库接不接 GitHub、用哪个模板、侦察、自动采纳、自动合并、推送、每日预算、一个 issue 最多跑几次 | `config.yaml` 的 `github.repos.<仓库名>` |
| 有哪些 Agent：CLI、模型、effort、权限、档次、价格、超时、额外参数 | `agents.yaml` |
| 流程：有哪些阶段、谁来做、返工和回退的次数、出错时怎么办、单个 Run 的预算、哪里要人审批、命令阶段运行什么 | `workflows/*.yaml` |
| 仓库名、本地路径、目标分支、检查命令、准备命令 | 看板的「仓库」页（存在数据库里，不在配置文件里） |
| 工作开关、浏览器通知、看板的显示语言 | 看板顶栏 |

模板阶段里写了 `verify.commands` 时，这个阶段用它代替仓库登记的检查命令；不写就用仓库登记的。

## 在看板上登记仓库

在看板的「仓库」页填：

- **名称**：只能包含字母、数字、`.`、`_`、`-`。`config.yaml` 的 `github.repos` 按这个名字找仓库。
- **路径**：本地仓库的绝对路径。每个 Run 都会从这里建一个独立的 git worktree，在里面干活。
- **目标分支**：合并进哪个分支；不填就用仓库当前检出的分支。
- **准备命令**：每个 Run 建好工作目录后运行一次，通常是安装依赖。每个 Run 的工作目录都是新的，所以每次都要装。有一条失败，Run 就结束、标为失败，从 issue 来的会自动重做。
- **检查命令**：每次编码完成后运行，全部通过才算验收通过；没通过就带着输出返工。合并前同步了目标分支的新提交后也会再跑一遍；命令阶段没写 `verify.commands` 时也运行它们。

每行一条命令，在 Run 的工作目录里用 `/bin/sh -c` 依次运行，有一条失败就不再往下跑。常见项目可以这样填：

| 项目 | 准备命令 | 检查命令 |
|---|---|---|
| npm | `npm ci` | `npm run build`<br>`npm test`<br>`npm run lint` |
| pnpm | `pnpm install --frozen-lockfile` | `pnpm build`<br>`pnpm test`<br>`pnpm lint` |
| Python（uv） | `uv sync` | `uv run ruff check .`<br>`uv run ruff format --check .`<br>`uv run pytest` |
| Python（pip + venv） | `python3 -m venv .venv`<br>`.venv/bin/pip install -e '.[dev]'` | `.venv/bin/ruff check .`<br>`.venv/bin/ruff format --check .`<br>`.venv/bin/pytest` |
| Go | `go mod download` | `go build ./...`<br>`go vet ./...`<br>`go test ./...` |
| Rust | `cargo fetch` | `cargo build --all-targets`<br>`cargo clippy --all-targets -- -D warnings`<br>`cargo test`<br>`cargo fmt --check` |

`npm run build` 这类脚本名按项目 `package.json` 里实际有的写；pip 的 `'.[dev]'` 假设开发依赖（pytest、ruff）写在 `pyproject.toml` 的 `dev` 可选依赖里，按项目实际情况改。

注意：

- **装出来的目录要被 git 忽略**。Master 提交时会把工作目录里所有没被忽略的改动都提交上去（`git add -A`），所以 `node_modules`、`.venv`、`target` 这类目录要写在仓库的 `.gitignore` 里。
- **命令要在 Master 的 PATH 上**。`pnpm`、`uv`、`go`、`cargo` 都要能从启动 Master 的环境里找到；用保活脚本的定时任务启动时 PATH 很短，见 `docs/running.md` 的「保活」。
- **没有 GitHub 凭据**。准备命令和检查命令在去掉了 GitHub 凭据的环境里运行（见 `docs/running.md` 的「Agent 拿不到 GitHub 凭据」），通过 https 装 GitHub 上的私有依赖会失败。
- **环境变量**：命令运行时设了 `CI=1`、`NO_COLOR=1`，测试框架会按 CI 环境运行（比如不进入 watch 模式）。每条命令的超时是 `config.yaml` 的 `defaults.command_timeout_minutes`。
- **E2E 要的东西也在准备命令里装**。用 `workflows/with-e2e.yaml` 跑 playwright 时，在准备命令里加上 `npx playwright install chromium`；Linux 上浏览器需要的系统库要先在机器上用 `npx playwright install-deps` 装一次（需要 root）。

## 示例要和代码保持同步

`test/examples.test.ts` 把这个目录当作数据目录，用 Master 加载配置的同一个函数加载它，要求没有任何错误和警告，每个模板都能加载，`config.yaml` 里每个仓库用的模板、模板和侦察用的 Agent 都在示例里。改配置格式时，这个测试会提醒你同步更新这里的示例。
