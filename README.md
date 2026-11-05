# super-RLM

> Local-first meta-agent runtime: Pi Router → Orchestrator → Worker → Prime Agent RLM.

**Version: v0.1.0** · Windows-first · 本地优先 · 无后台服务常驻

super-RLM 把一次自然语言请求拆成可调度的 Ticket，交给隔离的 Worker 执行；
每个 Worker 内部运行 Prime Agent，可以继续递归 `rlm.spawn` 子 Agent。
它不替代 Pi 或 Prime，而是把两者组织成一个可控、可观察、可恢复的本地 Agent 平台。

---

## 1. 它解决什么问题

单 Agent 做长任务时常见问题：

- 一个上下文越来越长
- 多件事混在一个对话里
- 失败后难以重试部分工作
- 无法并行
- 结果、文件、session 和状态难以追踪
- 权限和清理边界不清晰

super-RLM 的模型：

```text
用户
  ↓
Pi Router（规划、拆分、选择 profile）
  ↓
Orchestrator（Task/Ticket 状态机、SQLite、调度、SSE）
  ↓
Worker（准备 workspace、启动 Prime Agent ACP）
  ↓
Prime Agent（执行 Ticket，可递归 rlm.spawn）
  ↓
super_rlm_report（结构化回传）
```

---

## 2. 核心能力

- **Task / Ticket 拆分**：Router 把独立工作拆成 Ticket。
- **并行调度**：Orchestrator 管理 slot、并发、优先级、重试和恢复。
- **Worker profile**：不同 Ticket 使用不同模型、thinking、workspace、交付策略。
- **Prime Agent RLM**：Worker 内可递归 `rlm.spawn` 子 Agent。
- **HITL**：`waiting` / `blocked` Ticket 可以回答后 resume。
- **Session resume**：使用 durable `session_ref` 继续 Prime session。
- **结果交付**：artifacts 或 workspace 复制回启动目录。
- **L3 TUI**：Chat、Tasks、Task Detail、Workers、Events、模型/Profile 选择器、Session viewer。
- **Windows Job 隔离**：TUI、Orchestrator、Worker、Prime daemon 和 kernel 都在同一个 Job Object 中。
- **显式 daemon 生命周期**：Worker 启动时启动 Prime daemon，TUI 退出时有序停止。
- **本地 secrets**：随机 token、loopback 绑定、callback 基础 SSRF 防护。
- **清理与备份**：`gc`、`backup/restore`、日志轮转、启动 GC。
- **安装器**：Windows 用户级 ZIP + PowerShell 安装器，uv 内置，Prime Agent 随包分发。

---

## 3. 系统结构

```text
super-rlm (TUI supervisor)
  └─ Windows Job Object (KILL_ON_JOB_CLOSE)
       ├─ Orchestrator
       ├─ Worker
       │    └─ Prime daemon
       │         ├─ session worker
       │         └─ Python kernel
       └─ TUI (Pi Router RPC)
```

主要组件：

```text
apps/router          Pi Router extension：控制面工具 + SSE + L2 页面
apps/orchestrator    TypeScript 控制面：状态机、SQLite、调度、outbox
apps/worker          Python FastAPI + Prime Agent ACP adapter
apps/cli             super-rlm 启动器、安装后维护、Job supervisor 调用
apps/tui             L3 终端 UI
packages/protocol    JSON Schema、Python pydantic、TypeScript 类型
config/models.yaml   Provider/模型注册表
config/profiles.yaml Worker profile 定义
```

---

## 4. 环境要求

### 运行

- Windows 10/11 x64
- Node.js **>= 22.19**（宿主机自备，不随包分发）
- 网络：
  - 安装时访问 npm registry
  - 首次 setup 访问 PyPI
- PowerShell 5.1+

### 安装包已包含

- Prime Agent 固定版本二进制
- `prime-agent-runtime`
- `uv.exe`
- Pi 依赖清单
- Worker/Orchestrator/Router/TUI 源码

### 当前平台限制

- TUI supervisor 目前只支持 Windows Job Object。
- 非 Windows 入口会 fail-closed，不会降级成无隔离启动。

---

## 5. 安装

### 5.1 从 release ZIP 安装

```powershell
Expand-Archive .\super-rlm-v0.1.0-win-x64.zip -DestinationPath .
powershell -NoProfile -ExecutionPolicy Bypass -File .\super-rlm-v0.1.0-win-x64\installer\install.ps1
```

默认安装到：

```text
%LOCALAPPDATA%\Programs\super-RLM\
  current
  versions\0.1.0
  bin\super-rlm.cmd
```

安装器会：

- 检查 Node >= 22.19
- 校验 SHA256SUMS
- 安装 Pi / CLI / Orchestrator / Router / TUI 的 npm 依赖
- 用内置 uv 创建 `apps\worker\.venv`
- 安装 Worker runtime
- 创建 `super-rlm` 命令
- 默认把 `bin` 加入用户 PATH

新开一个终端后检查：

```powershell
super-rlm --version
super-rlm status
```

### 5.2 从源码运行

需要 Node >= 22.19、`uv`、PowerShell。

```powershell
git clone https://github.com/nicheng251/super-RLM.git
cd super-RLM
npm ci --prefix runtime/pi
npm ci --prefix apps/cli
npm ci --prefix apps/orchestrator
npm ci --prefix apps/router
npm ci --prefix apps/tui
```

首次在项目目录运行：

```powershell
cd C:\path\to\your-project
super-rlm setup
super-rlm
```

---

## 6. 首次运行

`super-rlm setup` 只准备当前项目，不启动 TUI：

```powershell
cd C:\path\to\your-project
super-rlm setup
```

它会：

1. 创建 `.super-rlm-project.json`
2. 检查 Node、uv、provider key
3. 创建项目 kernel venv
4. 创建 Worker venv
5. 安装 Prime kernel runtime、默认 Python 包、report skill
6. 写入项目本地 Pi/Prime `models.json`
7. 运行 `doctor`

缺少 API key 时：

```text
Add this line to <home>/secrets/providers.env:
  DEEPSEEK_API_KEY=<your deepseek API key>
```

然后重新运行：

```powershell
super-rlm setup
```

可以先用 `--allow-missing-key` 跳过 key 检查：

```powershell
super-rlm setup --allow-missing-key
```

Provider 可以显式选择：

```powershell
super-rlm setup --provider deepseek --model deepseek-flash
```

---

## 7. 使用

### 7.1 启动

```powershell
cd C:\path\to\your-project
super-rlm
```

`super-rlm` 会直接启动 L3 TUI，并拥有整个运行栈：

- Orchestrator
- Worker
- Prime daemon
- TUI

退出 TUI 时全部停止。没有后台 `up` 模式。

兼容别名：

```powershell
super-rlm tui
```

### 7.2 L3 视图

```text
Alt+1  Chat
Alt+2  Tasks
Alt+3  Workers
Alt+4  Events
```

- Task Detail 不是侧边栏页面，而是 Tasks 中按 Enter 打开的子页面。
- Task Detail 中按 `Esc` 返回 Tasks。
- `Task Detail -> v` 打开只读 Ticket Session viewer。
- `Esc` 逐级返回。

### 7.3 Chat 命令

```text
/filter [all|waiting|running|terminal]
/search <text>
/clear
/refresh
/answer
/abort
/model
/quit
/help
```

`/model` 打开两级 Model & Profiles 页面：

```text
Profile 页：↑↓ 选择，Enter 进入，Esc 关闭
模型页：   ↑↓ 选模型，←→ 调 thinking
           Enter 应用并返回 Profile 页
           Esc 返回 Profile 页
```

可配置：

- Router 当前模型/thinking
- Worker profile 模型/thinking
- Worker override 保存到 `<home>/profiles.overrides.json`

### 7.4 Ticket Session

Task Detail 中选择 Ticket，按：

```text
v
```

只读查看最近 100 条 Prime JSONL 消息：

- user / assistant
- thinking
- tool call
- tool result（截断）
- j/k 滚动
- r 刷新
- Esc 返回 Task Detail

---

## 8. 配置

### 8.1 模型注册表

```yaml
# config/models.yaml
default:
  provider: deepseek
  model: deepseek-flash
  thinking: medium

providers:
  deepseek:
    name: DeepSeek
    api: openai-completions
    baseUrl: https://api.deepseek.com/v1
    apiKey: $DEEPSEEK_API_KEY
    authHeader: true
    models:
      - id: deepseek-flash
        name: DeepSeek V4.1 Flash
        contextWindow: 1048576
        maxTokens: 393216
```

同步到项目本地 Pi/Prime：

```powershell
super-rlm models sync
```

### 8.2 Worker profiles

```yaml
# config/profiles.yaml
profiles:
  default:
    provider: deepseek
    model: deepseek-flash
    thinking: medium
    capabilities: [code, script, docs]
    requires_repo: false
    read_only: false
    write_files: true
    workspace:
      agent_cwd: "."
      artifact_root: "."
    delivery:
      mode: artifacts

  git:
    provider: deepseek
    model: deepseek-flash
    thinking: medium
    capabilities: [code, git, refactor]
    requires_repo: true
    blocked_commands: [git, gh]
    workspace:
      agent_cwd: repo
      artifact_root: "."
    delivery:
      mode: none
```

Worker profile 可以独立设置：

- provider/model/thinking
- timeout
- prepare_command
- blocked_commands
- workspace
- delivery
- read_only / write_files

Router 只选择 profile 名称，不直接传模型或密钥。

### 8.3 Secrets

本地 secrets：

```text
<SUPER_RLM_HOME>/secrets/api.env
<SUPER_RLM_HOME>/secrets/providers.env
```

`api.env` 由 CLI 首次生成：

- router token
- worker token
- callback key

`providers.env` 需要用户自己填写：

```text
DEEPSEEK_API_KEY=...
```

不要把 secrets 提交到 Git。

---

## 9. CLI

```text
super-rlm                    启动 L3 TUI 和整个运行栈
super-rlm tui                同 super-rlm
super-rlm setup              首次项目初始化
super-rlm status             查看 Orchestrator/Worker/supervisor/daemon
super-rlm down               停止当前栈和项目 daemon
super-rlm init               创建项目 marker
super-rlm bootstrap          创建 kernel/Worker venv 和 runtime
super-rlm doctor             环境/依赖/服务检查
super-rlm models sync        写入项目 Pi/Prime models.json
super-rlm profiles list      查看 Worker profile
super-rlm profiles show <n>  查看单个 profile
super-rlm profiles validate  校验 profile
super-rlm profiles reset <n> 删除 profile override
super-rlm profiles reset --all
super-rlm tasks              查看 Task
super-rlm artifacts <id>     复制 Ticket artifacts
super-rlm gc                 清理旧资源（默认 dry-run）
super-rlm backup <dir>       离线备份
super-rlm restore <dir>      恢复备份
super-rlm config             输出脱敏配置
```

已删除：

```text
super-rlm up
super-rlm router
super-rlm dev
--no-services
```

---

## 10. 数据目录

```text
<SUPER_RLM_HOME>/
  secrets/
  pi/
    agent/
    sessions/
  prime/
    agent/
    sessions/
    daemon/
    harness/
    kernel-venv/
  workspaces/
  tmp/
  orchestrator/
    orchestrator.sqlite
    backups/
  profiles.overrides.json
```

默认：

```text
%USERPROFILE%\.super-rlm\projects\<project-id>\
```

GC：

```powershell
super-rlm gc                         # dry-run
super-rlm gc --apply
super-rlm gc --apply --older-than 14
super-rlm gc --apply --worktrees
```

只删除 terminal Ticket/Task 的旧资源；运行中的栈会拒绝执行。

---

## 11. 安全边界

当前威胁模型是 **A：防误操作，不假设 Agent 主动攻击宿主机**。

已实现：

- Windows Job Object + `KILL_ON_JOB_CLOSE`
- Worker 显式拥有 daemon
- loopback-only 服务绑定
- 随机 token
- callback 基础 SSRF 防护
- 每 Ticket TEMP / PIP / NPM / XDG 隔离
- prepare 输出 secret 脱敏
- `read_only` 作为策略元数据

**未实现**：

- 模型 Proxy
- Restricted Token
- AppContainer
- 真正 `read_only` 文件系统强制
- 网络出口 allowlist

因此：

> 不要在当前版本中直接执行不可信仓库、不可信 Prompt 或不可信代码。
> `blocked_commands` 是 PATH shim，不是安全沙箱。

---

## 12. 开发

### 测试

```powershell
cd packages/protocol/python
.venv\Scripts\python.exe -m pytest -q

cd apps/orchestrator
npm test
npm run check

cd apps/worker
.venv\Scripts\python.exe -m pytest -q

cd apps/cli
npm test
npm run check

cd apps/router
npm test
npm run check

cd apps/tui
npm test
npm run check
```

当前：

```text
protocol      28
orchestrator  67
worker        96
cli           96
router         2
tui           27
total        316
```

### Windows 生命周期回归

```powershell
apps\worker\.venv\Scripts\python.exe scripts\regression\windows_lifecycle.py
```

覆盖：

- Job 正常退出
- TUI 异常退出
- supervisor 被强杀
- 启动失败
- daemon 生命周期
- 可选真实 Prime Agent admin smoke

### 真实模型 E2E

```powershell
apps\worker\.venv\Scripts\python.exe scripts\regression\real_model.py --help
apps\worker\.venv\Scripts\python.exe scripts\regression\l3_chat.py --help
```

会产生真实模型费用。

---

## 13. 安装器与发布

构建 release：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\package\windows.ps1 `
  -UvPath C:\Users\me\.local\bin\uv.exe
```

输出：

```text
dist\super-rlm-v0.1.0-win-x64.zip
dist\super-rlm-v0.1.0-win-x64.zip.sha256
```

安装：

```powershell
installer\install.ps1
```

卸载：

```powershell
installer\install.ps1 -Uninstall
```

保留项目数据是默认行为；`-PurgeData` 会删除 `%USERPROFILE%\.super-rlm`。

---

## 14. 文档

- [架构](docs/architecture.md)
- [项目结构](docs/project-structure.md)
- [开发指南](docs/guides/developing-with-super-rlm.md)
- [L3 TUI](docs/guides/l3-tui.md)
- [ADR](docs/adr/)
- [Spike 与 E2E 证据](docs/spikes/)
- [Windows 安装器](installer/README.md)

---

## 15. 当前状态

- 版本：`v0.1.0`
- 平台：Windows 10/11 x64
- 真实 DeepSeek TUI + Job + daemon E2E 已通过
- 真实 TUI/Job 证据：
  - `docs/spikes/real-tui-job-e2e.md`
- 生命周期回归：5/5 普通 cases，6/6 `--real-prime`
- 测试：316 个

暂未完成：

- MSI / 代码签名 / 自动更新
- CI
- 跨平台 Job 等价方案
- Worker 交互式 attach
- P0-A2 文件系统隔离
- 模型 Proxy

---

## 16. 一句话

**super-RLM 是一个把 Pi Router、Orchestrator、Worker、Prime Agent RLM 组织成本地可调度执行栈的实验性平台。**
