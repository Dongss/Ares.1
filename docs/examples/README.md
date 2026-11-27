# 配置示例

这里是一组完整的配置示例，目录结构和数据目录（默认 `~/.ares1`）一样，复制过去改改名字就能用。每个文件里的注释说明了每一项的含义和默认值。运行、配置和升级的完整说明见 [`docs/running.md`](../running.md)。

| 文件 | 内容 |
|---|---|
| [`config.yaml`](config.yaml) | 全局配置：语言、端口、CLI 路径、超时、同时执行几个 Run、通知、自动升级；GitHub 里登记了 4 个仓库，分别用下面 4 个模板，侦察、自动采纳、自动合并、推送、每日预算的设置各不相同；1 个托管在自建 GitLab 上的仓库（`gitlab`，项目在子组里）；另有 1 个不接 GitHub 和 GitLab 的仓库用本地提案池（`backlog`） |
| [`agents.yaml`](agents.yaml) | 6 个 Agent：编码用的强模型配高 effort（`claude-coder`），评审、需求评估、侦察用的便宜一档的模型（`claude-reviewer`），只改文件不执行命令的 `permission: safe`（`claude-docs`），cursor-agent 的另一家模型（`cursor-grok`，带 `price`），同样能以只读方式运行的 Codex CLI（`codex-reviewer`，Claude 额度用完时接着做需求评估、拆分任务和侦察），停用的 `enabled: false`（`claude-max`）；也演示了 `timeout_minutes`、`args` 的写法 |
| [`workflows/light.yaml`](workflows/light.yaml) | 轻量：编码 → 评审 → 合并，不做需求评估。适合文档、小改动 |
| [`workflows/strict.yaml`](workflows/strict.yaml) | 严格：需求评估 → 编码 → 评审 → 人工审批 → 合并。适合生产仓库；编码阶段用 `planning: auto`：需求评估给出的规模是 L 时先把需求拆成几步，再一步一步做、一步一步检查和提交 |
| [`workflows/with-e2e.yaml`](workflows/with-e2e.yaml) | 带 E2E：编码 → 评审 → E2E（`kind: command`，比如 playwright，或 `docker compose up` 之后探活；`serve: true` 时 Master 先用仓库登记的启动命令起服务，命令用 `$ARES1_SERVICE_URL` 访问它）→ 合并，E2E 失败时回到编码 |
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
- `config.yaml` 里的 `my-web`、`my-api`、`my-docs`、`my-tool`、`my-gitlab-service`、`my-intranet-tool` 是占位名：改成你在看板「仓库」页登记的仓库名，用不到的整段删掉（不用 GitLab 就删掉整个 `gitlab` 段）。GitHub 仓库的 `issues_repo` 也要改成你自己的 GitHub 仓库，或者删掉，让 gh 按本地仓库的 remote 推断；GitLab 仓库的 `issues_repo` 必填，改成你的项目在 GitLab 上的路径，`gitlab.host` 改成你的 GitLab 的主机名（用 gitlab.com 就删掉这一行）。
- 用 GitLab 要先装好 glab 并登录（`glab auth login`，自建的 GitLab 加 `--hostname <主机名>`），用 GitHub 要先装好 gh 并登录。登记方式和权限要求见 [`docs/running.md`](../running.md#接入-gitlab) 的「接入 GitLab」。
- 只想要其中一部分也行：模板可以只挑需要的复制，但 `config.yaml` 里仓库用的模板（`template`）、模板和侦察用的 Agent 都得存在，否则对应的仓库或模板会被停用。
- 模板也可以不复制到数据目录，而是提交到仓库目标分支的 `.ares1/workflows/` 里，格式一样，跟着代码一起评审、一起演进，只给这个仓库用；数据目录里有同 id 的模板时用数据目录那份。详见 [`docs/running.md`](../running.md#仓库自带的流程模板) 的「仓库自带的流程模板」。
- 数据目录里原来的 `workflows/self-dev.yaml` 用的是 `claude-coder` 和 `claude-reviewer`，示例的 `agents.yaml` 保留了这两个名字，换上示例后它照样能用。
- 示例的 `language` 是 `zh`；想让 issue 评论和给 Agent 的提示词用英文，就改成 `en`。

## 哪些设置在配置文件里，哪些在看板上

| 设置 | 在哪里 |
|---|---|
| 语言、端口、CLI 路径（`bins`）、Agent 执行和命令的超时、同一仓库同时执行几个 Run、系统通知、自动升级 | `config.yaml` |
| 仓库接不接 GitHub、用哪个模板、侦察、自动采纳、自动合并、推送、推送还是开 PR 交付（`deliver`）、每日预算、一个 issue 最多跑几次 | `config.yaml` 的 `github.repos.<仓库名>` |
| 托管在 GitLab 上的仓库：在哪个项目读写 issue（必填）、用哪个模板、侦察、自动采纳、自动合并、推送、推送还是开 MR 交付（`deliver`）、每日预算、一个 issue 最多跑几次；GitLab 的主机名和账号 | `config.yaml` 的 `gitlab.repos.<仓库名>`（不能和 `github.repos` 重名）；`gitlab.host`、`gitlab.account` |
| 不接 GitHub 和 GitLab 的仓库用本地提案池：用哪个模板、侦察、自动采纳、自动合并、每日预算 | `config.yaml` 的 `backlog.repos.<仓库名>`（不能和 `github.repos`、`gitlab.repos` 重名） |
| 有哪些 Agent：CLI、模型、effort、权限、档次、价格、超时、额外参数 | `agents.yaml` |
| 流程：有哪些阶段、谁来做、返工和回退的次数、出错时怎么办、单个 Run 的预算、哪里要人审批、命令阶段运行什么 | `workflows/*.yaml` |
| 仓库名、本地路径、目标分支、检查命令、准备命令 | 看板的「仓库」页（存在数据库里，不在配置文件里） |
| 工作开关、浏览器通知、看板的显示语言 | 看板顶栏 |

模板阶段里写了 `verify.commands` 时，这个阶段用它代替仓库登记的检查命令；不写就用仓库登记的。

## 在看板上登记仓库

第一次在看板上接入一个项目，可以用「仓库」页顶部的「接入新项目」向导：按顺序登记仓库、按项目文件探测命令、试运行、设置需求来源，最后告诉你怎么开始第一个需求，每一步做什么、对应哪个 API 见 [`docs/running.md`](../running.md#接入新项目) 的「接入新项目」。下面是登记时各项怎么填，向导和「仓库」页底部的登记表单都一样，只是向导把准备命令和检查命令放到第 2 步，先探测再填。

在看板的「仓库」页填：

- **名称**：只能包含字母、数字、`.`、`_`、`-`。`config.yaml` 的 `github.repos`、`gitlab.repos` 和 `backlog.repos` 按这个名字找仓库。
- **路径**：本地仓库的绝对路径。每个 Run 都会从这里建一个独立的 git worktree，在里面干活。本机还没有这个仓库时，可以选「从远端克隆」（多填一个远端地址）或「新建空项目」，路径填一个不存在的路径或空目录，Master 克隆或新建好再登记，见 [`docs/running.md`](../running.md#登记仓库)。
- **目标分支**：合并进哪个分支；不填就用仓库当前检出的分支（克隆时是远端的默认分支，新建空项目时是 `main`）。
- **准备命令**：每个 Run 建好工作目录后运行一次，通常是安装依赖。每个 Run 的工作目录都是新的，所以每次都要装。有一条失败，Run 就结束、标为失败，从 issue 来的会自动重做。
- **检查命令**：每次编码完成后运行，全部通过才算验收通过；没通过就带着输出返工。合并前同步了目标分支的新提交后也会再跑一遍；命令阶段没写 `verify.commands` 时也运行它们。
- **服务启动命令**（登记后在「修改」的「服务」一栏填，可空）：命令阶段写了 `serve: true` 时，Master 先在 Run 的工作目录里运行它起服务，服务要监听环境变量 `PORT` 给的端口，比如 `npm start`、`node dist/server.js`。另有就绪路径（默认 `/`）和就绪超时（默认 120 秒），见 [`docs/running.md`](../running.md#服务启动命令)。常见项目的启动命令见下表最后一列；「按项目文件探测」也按这张表建议启动命令和就绪路径，列在「服务」一栏顶上，点「采用建议」才填进去，规则见下面的「按项目文件探测」。保存前可以点「试运行表单里的命令和服务」确认服务起得来，看板会写明是否就绪、地址和用时，没就绪时分开写超时还是进程提前退出，并能展开看服务输出的末尾。

每行一条命令，在 Run 的工作目录里用 `/bin/sh -c` 依次运行，有一条失败就不再往下跑。常见项目可以这样填：

| 项目 | 准备命令 | 检查命令 | 启动命令 |
|---|---|---|---|
| npm | `npm ci` | `npm run build`<br>`npm test`<br>`npm run lint` | `npm run dev` |
| pnpm | `pnpm install --frozen-lockfile` | `pnpm build`<br>`pnpm test`<br>`pnpm lint` | `pnpm dev` |
| yarn 1 | `yarn install --frozen-lockfile` | `yarn build`<br>`yarn test`<br>`yarn lint` | `yarn dev` |
| yarn 2 及以上（Berry） | `yarn install --immutable` | `yarn build`<br>`yarn test`<br>`yarn lint` | `yarn dev` |
| bun | `bun install` | `bun run build`<br>`bun run test`<br>`bun run lint` | `bun run dev` |
| Python（uv） | `uv sync` | `uv run ruff check .`<br>`uv run ruff format --check .`<br>`uv run pytest` | （无） |
| Python（pip + venv） | `python3 -m venv .venv`<br>`.venv/bin/pip install -e '.[dev]'` | `.venv/bin/ruff check .`<br>`.venv/bin/ruff format --check .`<br>`.venv/bin/pytest` | （无） |
| Python（只有 requirements.txt） | `python3 -m venv .venv`<br>`.venv/bin/pip install -r requirements.txt` | `.venv/bin/pytest` | （无） |
| Django（manage.py） | `python3 -m venv .venv`<br>`.venv/bin/pip install -r requirements.txt` | `.venv/bin/pytest` | `.venv/bin/python manage.py runserver 127.0.0.1:$PORT` |
| Go | `go mod download` | `go build ./...`<br>`go vet ./...`<br>`go test ./...` | （无） |
| Rust | `cargo fetch` | `cargo build --all-targets`<br>`cargo clippy --all-targets -- -D warnings`<br>`cargo test`<br>`cargo fmt --check` | （无） |
| Makefile（有 test 目标） | （无） | `make test` | （无） |

`npm run build` 这类脚本名按项目 `package.json` 里实际有的写，Node 各行的启动命令假设 `scripts` 里有 `dev`；pip 的 `'.[dev]'` 假设开发依赖（pytest、ruff）写在 `pyproject.toml` 的 `dev` 可选依赖里，按项目实际情况改。Django 那一行假设依赖写在 `requirements.txt` 里，准备命令和检查命令同「只有 requirements.txt」那一行；用 uv 管理时准备命令和检查命令按 uv 那一行，启动命令是 `uv run python manage.py runserver 127.0.0.1:$PORT`。启动命令的就绪路径都是 `/`，就绪超时用默认的 120 秒。

### 按项目文件探测

已经登记的仓库，在「仓库」页点「修改」，再点「按项目文件探测」，Master 会看目标分支上已提交的根目录文件（工作目录里没提交的改动不算），按上面这张表建议准备命令、检查命令和启动命令（连同就绪路径），把准备命令和检查命令填进两个输入框，并列出是凭哪些文件判断的；启动命令不自动填，列在「服务」一栏顶上，点「采用建议」才填进去（就绪超时保持原样）。它只填表单，不保存：检查一遍、按需要改过之后点「保存」才生效。规则如下（`src/workspace/detect.ts`，改规则时这张表和它一起改，`test/detect.test.ts` 会拿这张表核对）：

- **Node**（有 `package.json`）：包管理器先看 `package.json` 的 `packageManager` 字段（如 `pnpm@9.0.0`），没有就看锁文件：`package-lock.json` 或 `npm-shrinkwrap.json` → npm，`pnpm-lock.yaml` → pnpm，`yarn.lock` → yarn，`bun.lock` 或 `bun.lockb` → bun；有几个锁文件时按这个顺序取第一个。都没有就按 npm 处理。准备命令按表里那一行；yarn 只有 `packageManager` 字段写明 2 及以上的版本（如 `yarn@4.1.0`）时才按 Berry 那一行用 `--immutable`，没有这个字段时按 yarn 1 处理。用的包管理器没有自己的锁文件时不加 `--frozen-lockfile`、`--immutable`，npm 用 `npm install` 代替 `npm ci`。检查命令只按 `scripts` 里实际有的 `build`、`test`、`lint` 生成，顺序是 build → test → lint；`npm init` 生成的占位 `test`（`no test specified`）不算。`package.json` 是符号链接时不读它的内容：包管理器只按锁文件选，不生成检查命令，依据里写明是符号链接。
- **Python**（有 `pyproject.toml` 或 `requirements.txt`）：有 `pyproject.toml` 和 `uv.lock` 时按 uv 那一行；只有 `pyproject.toml` 时按 pip + venv 那一行（`pyproject.toml` 里没有 `dev` 可选依赖时依据里会提醒改 `'.[dev]'`）；只有 `requirements.txt` 时按「只有 requirements.txt」那一行。`pytest` 一定加；ruff 的两条只在项目配置了 ruff 时才加：根目录有 `ruff.toml` 或 `.ruff.toml`，`pyproject.toml` 里有 `[tool.ruff]`，或者 `pyproject.toml`、`requirements.txt` 的依赖里有 ruff。
- **Go**（有 `go.mod`）、**Rust**（有 `Cargo.toml`）：按表里那一行。
- **Makefile**（根目录的 `GNUmakefile`、`makefile` 或 `Makefile`，按 make 找它们的顺序取第一个）：有 `test` 目标时检查命令加 `make test`。
- **混合项目**：每种认出来的都加上，按 Node → Python → Go → Rust → Makefile 的顺序拼起来，同一条命令只出现一次；依据每种一条。
- **启动命令**：只在有把握时建议一条，就绪路径是 `/`。
  - Node：`package.json` 的 `scripts` 里有 `dev` 就用 `dev`，没有再用 `start`，用上面选出的包管理器运行：`npm run dev` / `pnpm dev` / `yarn dev` / `bun run dev`，`npm start` / `pnpm start` / `yarn start` / `bun run start`。脚本要让服务在 `127.0.0.1` 上监听环境变量 `PORT` 给的端口，不是这样时请改命令，比如 vite 要加 `--host 127.0.0.1 --port $PORT`，依据里会写明这一点。
  - Django：认出了 Python，根目录又有 `manage.py`（只看有没有，不读内容）时，用 `runserver` 在 `127.0.0.1:$PORT` 上起服务，python 和准备命令用的一致：按 uv 那一行时是 `uv run python manage.py runserver 127.0.0.1:$PORT`，否则用 venv 里的 `.venv/bin/python manage.py runserver 127.0.0.1:$PORT`。
  - `manage.py` 和 Node 的建议都有时用 `manage.py`：这类项目的 `package.json` 通常只用来构建前端资源，依据里写明原因。
  - 不建议的情况：`package.json` 是符号链接、解析不了、`scripts` 里 `dev` 和 `start` 都没有（比如 `npm init` 生成的）；Python 项目根目录没有 `manage.py`；Go、Rust、Makefile 看不出服务怎么起，一律不建议。这时依据里多一条，写明没有建议启动命令和原因。
- 都认不出来时两栏都是空的，也没有建议的启动命令，依据里写明没认出来，输入框不动。只认出准备命令或只认出检查命令时，没有建议的那一栏也不动。

检查命令为空的仓库，卡片上会标「没有检查命令」：这时 Run 的改动不经任何检查就进入评审和合并（模板阶段自己写了 `verify.commands` 的除外）。

注意：

- **装出来的目录要被 git 忽略**。Master 提交时会把工作目录里所有没被忽略的改动都提交上去（`git add -A`），所以 `node_modules`、`.venv`、`target` 这类目录要写在仓库的 `.gitignore` 里。
- **命令要在 Master 的 PATH 上**。`pnpm`、`uv`、`go`、`cargo` 都要能从启动 Master 的环境里找到；用保活脚本的定时任务启动时 PATH 很短，见 `docs/running.md` 的「保活」。
- **没有 GitHub 和 GitLab 凭据**。准备命令和检查命令在去掉了 GitHub 和 GitLab 凭据的环境里运行（见 `docs/running.md` 的「Agent 拿不到 GitHub 和 GitLab 凭据」），通过 https 装 GitHub、GitLab 上的私有依赖会失败。
- **环境变量**：命令运行时设了 `CI=1`、`NO_COLOR=1`，测试框架会按 CI 环境运行（比如不进入 watch 模式）。每条命令的超时是 `config.yaml` 的 `defaults.command_timeout_minutes`。
- **E2E 要的东西也在准备命令里装**。用 `workflows/with-e2e.yaml` 跑 playwright 时，在准备命令里加上 `npx playwright install chromium`；Linux 上浏览器需要的系统库要先在机器上用 `npx playwright install-deps` 装一次（需要 root）。

## 示例要和代码保持同步

`test/examples.test.ts` 把这个目录当作数据目录，用 Master 加载配置的同一个函数加载它，要求没有任何错误和警告，每个模板都能加载，`config.yaml` 里每个仓库（`github`、`gitlab`、`backlog` 三种来源都有，仓库名互不重复）用的模板、模板和侦察用的 Agent 都在示例里。改配置格式时，这个测试会提醒你同步更新这里的示例。
