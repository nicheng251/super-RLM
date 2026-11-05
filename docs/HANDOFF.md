# super-RLM Handoff

Status: core vertical slice, CLI, L2 + L3 TUI vertical slice, capability-routed profiles, generic workspaces, per-profile delivery, migration backup, callback outbox, backup/restore, artifact copy-out, and real-model regression all work. HEAD 以 `git log` 为准。
Last updated: 2026-11-05

## 1. 项目一句话

super-RLM 是一个本地优先、Pi Agent 驱动的元代理系统：

- 用户通过 Pi Agent CLI 与 Router 对话；
- Router 把任务拆成 Ticket；
- Orchestrator 调度 Ticket；
- Worker 为每个 Ticket 启动一个 Prime Agent ACP session；
- Prime Agent 内部可以递归 `rlm.spawn` 子 Agent，外部不建模。

## 2. 当前状态

- 仓库有文档、ADR、两个已通过的本地 spike，以及可运行的核心垂直切片；`super-rlm` CLI、L2 页面、backup/restore 和真实模型回归已完成。
- 46 个 ADR 已记录：44 accepted，2 superseded。
- 架构、状态机、Router API、Worker API、审计和 spike 计划已写入 docs。
- 项目本地运行时已建立：
  - `runtime/pi/`：Pi 1.5.0（npm 包）；Node.js 由用户自备，不进入 runtime。
  - `runtime/prime-agent/`：Prime Agent 0.10.2（项目内副本）。
- Spike 结果：
  - `docs/spikes/pi-router.md`：Router 现在暴露 11 个控制面工具 + SSE 通知；伪 `bash` 调用被拒绝。
  - `docs/spikes/prime-acp.md`：ACP 驱动成功；`rlm.spawn` 两个子 Agent；report skill 的 `completed` / `waiting` 和 enforcement prompt 均验证。
- `packages/protocol` 已建立：JSON Schema、Python pydantic 模型、TypeScript 类型；28 个 Python 测试通过，`tsc --noEmit` 通过。
- `apps/orchestrator` 最小实现已完成：状态机、SQLite、slot、HTTP API、Worker dispatch、SSE、单实例锁、启动恢复、forward-only migration（v1->v6，迁移前自动备份）；55 个 `node:test` 测试通过。
- `apps/worker` 最小实现已完成：FastAPI、ACP、report skill、session_ref、resume、worker/assignment heartbeat、HMAC report；83 个 pytest 通过（含真实 Prime Agent ACP 集成测试、profiles、workspace prepare、blocked commands、delivery、daemon lifecycle 和 security 测试）。
- `apps/cli` 已实现：`super-rlm` 直接启动 L3 TUI，并在 Windows Job Object 中管理 Orchestrator、Worker、Prime daemon 的完整生命周期；`tui` 是别名；后台语义 `up/router/dev` 已删除；`down/status/tasks/doctor/init/config/bootstrap/models sync/backup/restore/artifacts/profiles` 保留；52 个 `node:test` 通过。
- 当前单元/集成测试合计 316 个：protocol 28、orchestrator 67、worker 96、cli 96、router 2、tui 27。
- P0-A1 已实现：`super-rlm` 直接启动 TUI；Windows Job Object (`KILL_ON_JOB_CLOSE`) 包含 Orchestrator/Worker/TUI/daemon；Worker 显式启动并停止项目 daemon；Ticket cancel 使用 `prime-agent stop <session_ref stem>` 并记录 `cleanup_error`；随机 token 写入 `<home>/secrets/api.env`；Orchestrator/Worker 直接启动 fail-closed；loopback 强制；callback 基础 SSRF 防护；每 Ticket TEMP/PIP/NPM/XDG 隔离；prepare 输出 secret 脱敏。
- 已实现 `super-rlm gc`：默认 dry-run，按 terminal Ticket/Task 清理 tmp/sessions/workspaces，worktrees 需显式 `--worktrees`，运行中服务拒绝执行，脏 worktree 跳过。
- 已实现启动维护：TUI 启动前轮转 Orchestrator/Worker 日志（默认 10 MiB、保留 3 份）并自动执行旧资源 GC（可用 `SUPER_RLM_AUTO_MAINTENANCE=0` 关闭）；`down` 后轮转已关闭日志。
- Task Detail 新增 `v` 只读 Ticket Session viewer：Worker `GET /v1/tickets/:id/session`、Prime JSONL 解析、j/k 滚动、r 刷新、Esc 逐级返回；L3 状态栏显示 `ctx:已用/窗口`。
- 已实现 Windows 用户级安装器：`installer/install.ps1` + `scripts/package/windows.ps1`，版本 `0.1.0`；内置 uv、随包分发 Prime Agent、检查 Node、安装 Pi/CLI/Orchestrator/Router/TUI npm 依赖与 Worker venv、用户 PATH、升级回滚、卸载；新增 `super-rlm setup` 首次项目初始化。
- `profiles.overrides.json` 已改为原子写、严格校验、fail-closed 启动，并支持 `super-rlm profiles reset <name>|--all`。
- 新增 `scripts/regression/windows_lifecycle.py`：Job 优雅退出/失败/杀 supervisor/启动失败/daemon 生命周期，5 个非付费 case 通过；`--real-prime` 管理 smoke 6/6 通过。
- L3 状态栏现在显示 `ctx:已用/窗口`（来自 Pi `getSessionStats().contextUsage`）。
- 明确未做：模型 Proxy、Restricted Token、AppContainer、网络出口 allowlist、真正 `read_only` 文件系统强制。
- 已手动跑通 Orchestrator -> Worker -> Prime Agent -> `super-rlm-report` -> Orchestrator：Task `succeeded`，`session_ref` 回写。
- 已手动跑通完整 HITL：`waiting` -> answer -> `--resume` -> `completed`，`session_ref` 保持同一个文件。
- 已用真实 DeepSeek `deepseek-flash` 跑通：写文件任务成功（`hello.txt` 内容正确），以及 TUI 中 `/tasks` -> Task Detail -> 回答 -> resume -> succeeded。
- 已实现离线 backup/restore：manifest + SHA256、secrets 默认排除、服务未停止拒绝、schema 版本检查、原子恢复；4 个 CLI 测试通过。
- 已实现真实模型回归脚本 `scripts/regression/real_model.py`；`report`、`file`、`hitl` 三个 DeepSeek 用例全部通过（run `20261104T092740Z_5348`）。
- 已实现 workspace preparation：`SUPER_RLM_PREPARE_COMMAND` + `SUPER_RLM_PROJECT_REPO`，Worker 在启动 Prime Agent 前执行一次，支持 git worktree、超时、失败报告 `.super-rlm-prepared` 幂等标记。
- 已实现结果交付：CLI 捕获 `SUPER_RLM_ORIGIN_CWD`，Router 写入 Task metadata，Worker 在 `completed` 后按 `SUPER_RLM_DELIVERY_MODE` 复制 artifacts 到用户启动目录；支持 `version/overwrite/error` 冲突策略和 `strip_prefix`。
- 已实现 per-profile：`config/profiles.yaml`、`ExecutionOptions`、`/v1/profiles`、未知 profile 拒绝、`super-rlm profiles list/show/validate`。
- profile 现在带 `capabilities/requires_repo/read_only/write_files`；Router prompt 要求先 `profile_list`，按能力为每个 Ticket 选 profile，并把 `profile_reasons` 写入 Task metadata。
- 新增 `reviewer` profile（read-only 策略、git worktree、delivery none）；`requires_repo` profile 在 `SUPER_RLM_PROJECT_REPO` 缺失时由 Orchestrator 拒绝。
- 已实现通用 workspace：`agent_cwd`、`artifact_root`、`metadata_command`、`workspace_metadata`；Orchestrator 不再调用 git，git 只是 profile 元数据。
- 已实现 profile delivery：每个 profile 可独立设置 `delivery.mode/collision/strip_prefix/workspace_subdir`。
- 已用真实 DeepSeek 验证 default（artifact delivery）和 git（worktree + blocked git + metadata + delivery none）两个 profile（`docs/spikes/profiles-e2e.md`）。
- 已实现迁移前自动备份：旧 schema 打开时先 `VACUUM INTO` 备份到 `<home>/orchestrator/backups/`，备份成功后才迁移；失败则拒绝启动。
- 已实现 durable outbox + 用户 callback HMAC：重要事件入 outbox，后台投递，HMAC-SHA256(timestamp+nonce+body)，失败按 2/5/15/60/300 秒重试，8 次后标记 failed。
- 已用本地 callback receiver 验证 v4->v5 自动备份、outbox 投递和签名校验（`docs/spikes/callback-outbox-e2e.md`）。
- 已实现 L3 TUI 垂直切片：`apps/tui` 使用 `@earendil-works/pi-tui` + Pi RpcClient，包含 Chat、Tasks、Task Detail、Workers、Events；CLI 新增 `super-rlm tui`。
- L3 只用 **Alt+1..4** 切换 Chat/Tasks/Workers/Events；Task Detail 不是侧边栏页面，而是 Tasks 中用 Enter 打开的子页面；在 Task Detail 中 Esc 返回 Tasks。Ctrl+数字、F1..F5、Tab、侧边栏数字和 `/chat` 等斜杠命令都不用于切换视图。输入 `/` 会显示非视图命令的自动补全。
- Router SSE 在 session_start 时从 `/v1/events/latest` 开始，不再在每次进入时重放旧通知。
- L3 Tasks 增加 filter/search：`/filter all|waiting|running|terminal`、`/search <text>`、`/clear`，Tasks 主区域 `f` 循环过滤。
- 已用真实 DeepSeek 跑通 L3 Chat E2E：Pi RPC Chat -> task_create -> Worker -> artifact delivery；Task `tsk_3ad4882b3493458ab949` succeeded（`docs/spikes/l3-chat-e2e.md`）。
- 已新增 `GET /v1/workers` 和 WorkerView 协议，TUI Workers 页可用。
- L3 目前是垂直切片：真实 DeepSeek Chat E2E 已通过；后续继续打磨搜索/过滤、overlay、鼠标和快捷键兼容性。
- 已实现 `super-rlm artifacts <ticket_id>`：从 Ticket workspace 复制 artifacts 或整个 workspace；workspace/branch/commit 已写入 Ticket result 和 TUI Task Detail。
- 默认 provider/model 从 `config/models.yaml` 的 `default` 读取，环境变量仍优先；`models sync` 只把 `providers` 写入 Pi/Prime models.json。L3 `/model` 打开两级 Model & Profiles 页面（替换 Chat 内容，但保留并覆盖不到的侧边栏、输入提示和输入框；禁用 Alt 切换；Profile 页 ↑↓/Enter/Esc，模型页 ↑↓/←→/Enter 应用后回 Profile/Esc 逐级返回）；可配置 Router 和 Worker profiles 的模型与推理强度，Worker 覆盖写入 `<SUPER_RLM_HOME>/profiles.overrides.json`；状态栏显示 Router 模型名、推理强度、上下文窗口（`config/models.yaml` 的 `name`/`thinking`/`contextWindow`，缺失时用 `provider/model` 和 `?`）；Worker 模型由 `config/profiles.yaml` 的 profile `provider/model/thinking` 决定，Task Detail 显示 profile 对应的 model/thinking/context。
- 已用真实 DeepSeek 跑通 prepare + git worktree + artifacts copy-out：Task `tsk_19178d670a9f41759178` succeeded，workspace branch/commit 正确，artifact 复制成功（`docs/spikes/prepare-artifacts-e2e.md`）。
- 发现并修复 resident kernel 环境过期问题：Worker 在每个 workspace 写 `.super-rlm-report.json`，skill 通过 `SUPER_RLM_REPORT_CONFIG` 每次读取当前 assignment 的 report URL/token。
- 下一阶段是 L3 体验打磨、安装器/CI、可观测性；Worker 隔离暂时搁置，发行/打包暂不做。

当前实现缺口：

- Orchestrator outbox 已做基础 SSRF 防护：scheme/credentials/DNS 私网/重定向/响应大小；仍不是完整 DNS pinning 或网络沙箱。
- Worker 已有 per-profile prepare/blocked/model/thinking/agent_cwd/metadata/delivery；`read_only` 目前是策略元数据，尚未做文件系统写保护。
- 仍缺 per-Worker control token、真正文件系统 ACL/AppContainer、模型 Proxy；L3 的快捷键兼容性和更多交互还需要补。
- 报告 skill 依赖 per-workspace 配置文件；这是 resident kernel 的必要 workaround。
- HMAC report 和 assignment heartbeat 已端到端验证：Worker 日志显示 assignment heartbeat 200、report 200、Task succeeded。
- Router SSE 通知已在 `--mode rpc` 下验证：`ticket.waiting` 事件成功触发 `pi.sendMessage` 和新的 turn。
- Router 默认异步调度：`task_create` 后立即返回，由 SSE 通知 Task 终态；`task_wait` 只用于用户显式要求等待，默认 15 秒、最大 60 秒，避免阻塞 TUI。
- backup/restore 已实现；SQLite 当前 schema v6（outbox + cleanup_error + 迁移前自动备份）。
- 真实模型回归是手动脚本，不进入普通 CI，避免产生 API 费用。
- `runtime/prime-agent/` 和 `runtime/pi/node_modules/` 是本地 ignored 资产；`super-rlm bootstrap` 已覆盖 kernel venv 和 report skill，但 Pi package 仍需首次 npm install。
- Baseline 已提交；当前 HEAD 以 `git log` 为准，工作树保持 clean。

当前已存在的代码/资产：

```text
apps/router/.pi/settings.json
apps/router/extensions/super-rlm.ts          # 11 个控制面工具 + SSE 通知
apps/cli/                                    # super-rlm TUI supervisor + maintenance commands
apps/orchestrator/                           # 最小 TS 控制面：状态机/SQLite/slot/dispatch
apps/worker/                                 # Python FastAPI + Prime Agent ACP adapter
apps/worker/skills/super-rlm-report/        # Python report skill
apps/worker/src/super_rlm_worker/delivery.py # 结果交付到用户启动目录
apps/worker/src/super_rlm_worker/execution_profile.py # ExecutionOptions 解析
apps/worker/src/super_rlm_worker/blocked.py # blocked_commands shims
apps/worker/src/super_rlm_worker/metadata.py # metadata_command
config/profiles.yaml                        # default / git profiles
apps/orchestrator/src/profiles.ts           # profile loader/validation
apps/orchestrator/src/outbox.ts              # callback dispatcher
apps/tui/                                    # L3 独立 TUI shell
apps/cli/src/commands/tui.ts                 # super-rlm tui
apps/orchestrator/src/db.ts                  # schema v6 + migration backup + outbox store
packages/protocol/                          # v0 JSON Schema + Python/TS types
spikes/                                     # fake LLM、mock Orchestrator、ACP probes
scripts/regression/                         # 真实 DeepSeek / L3 Chat 手动回归 harness
docs/guides/developing-with-super-rlm.md      # 用真实项目开发的工作流
runtime/manifest.json                       # Pi 1.5.0 / Prime 0.10.2；Node 为宿主机依赖
runtime/pi/                                 # 本地 Pi package（node_modules ignored）
runtime/prime-agent/                        # 本地 Prime binary/runtime（ignored）
docs/spikes/pi-router.md
docs/spikes/prime-acp.md
```

Git 状态：

```text
branch: main
HEAD: 以 `git log --oneline -1` 为准
origin/main: 与 HEAD 同步
working tree: clean
```

当前仓库：

```text
C:/Users/15065/Project/super-RLM
remote: https://github.com/nicheng251/super-RLM.git
```

## 3. 必读文档

按顺序读：

1. `docs/HANDOFF.md`（本文件）
2. `docs/architecture.md`
3. `docs/adr/README.md`
4. `docs/protocol/state-machine.md`
5. `docs/protocol/router-api.md`
6. `docs/protocol/worker-api.md`
7. `docs/protocol/report-skill.md`
8. `docs/audit/design-audit.md`
9. `docs/audit/follow-up-decisions.md`
10. `docs/project-structure.md`
11. `docs/spikes/plan.md`
12. `docs/spikes/pi-router.md`（spike 结果）
13. `docs/spikes/prime-acp.md`（spike 结果）
14. `docs/spikes/tui-pages.md`（L2 TUI 验证）
15. `scripts/regression/README.md`（真实模型回归）
16. `docs/spikes/real-model-regression.md`（真实模型回归结果）
17. `docs/guides/developing-with-super-rlm.md`（真实项目开发工作流）
18. `docs/spikes/prepare-artifacts-e2e.md`（prepare/artifacts E2E）
19. `docs/spikes/delivery-e2e.md`（结果交付 E2E）
20. `docs/spikes/profiles-e2e.md`（profiles / generic workspace / per-profile delivery E2E）
21. `docs/spikes/callback-outbox-e2e.md`（callback outbox + migration backup E2E）
22. `docs/guides/l3-tui.md`（L3 TUI 使用和架构）
23. `docs/spikes/l3-chat-e2e.md`（L3 Chat 真实 E2E）

## 4. 架构总览

```text
用户
  │
  ▼
Pi Agent CLI / TUI
  │  Router tools
  ▼
Orchestrator（TypeScript，唯一任务状态写入者）
  │  HTTP + SSE
  ▼
Worker（Python，Prime Agent 适配器）
  │  ACP over stdio
  ▼
Prime Agent RLM
  └── rlm.spawn 子 Agent（内部，外部不建模）
```

### Router

- 是 Pi Agent CLI 的项目本地 profile + 扩展。
- 只注册控制面工具，不执行任务。
- 负责理解需求、拆 Ticket、查看状态、回答问题、重试/取消。
- 通过 SSE 接收等待/完成通知，并用 Pi `sendMessage` 唤醒。
- 对话历史持久化在项目 runtime 的 `pi/sessions`。

### Orchestrator

- 独立长期运行服务，TypeScript。
- 唯一写 Task/Ticket/Assignment/Report 状态。
- 不含 LLM，不拆任务。
- SQLite + 目录锁 + forward-only migration + outbox。
- 负责 slot、lease、worker registry、retry、SSE、备份边界。

### Worker

- Python FastAPI 服务。
- 每个 Assignment 一个 `prime-agent --mode acp` 进程。
- 不写任务状态，只上报事实。
- Prime Agent 使用 resident session；waiting/blocked 关闭 ACP、保留 session、释放 slot。
- 通过 `super-rlm-report` Python skill 接收结构化终态报告。

### Prime Agent

- 执行内核。
- 内部 RLM 拆分、子 Agent 数量、生命周期，外部不关心。
- Prime 只暴露最终结果、高层进度和 session 引用。

## 5. 已确认的核心决策

### 任务模型

- Ticket 独立，无 Ticket DAG；顺序在 Ticket 内部由 Prime Agent 处理。
- Task 是 Ticket 分组和结果聚合，保持薄。
- Task 状态：`queued | running | waiting | succeeded | partial | failed | cancelled | timed_out`。
- Ticket 状态：`queued | assigned | running | waiting | blocked | succeeded | failed | cancelled | timed_out | lost`。
- Assignment：`pending | running | ended` + `end_reason`。
- Report：`progress | waiting | blocked | completed | dropped | failed | cancelled`。
- `dropped` 表示无事可做；Ticket 结束为 `succeeded` + `outcome=dropped` + `no_op=true`。
- 默认 `max_concurrent_tickets_per_task=2`；priority slot 不受此限制。
- 完全重复的 title/prompt 会被拒绝；近似重复只警告。

### HITL

- `waiting`：需要用户回答；`blocked`：需要外部动作。
- 两者都释放 slot、保存 session_ref。
- `ticket_answer` 处理 waiting；`ticket_resume` 处理 blocked；`ticket_retry` 处理 failed/lost。
- 默认不自动超时；可选 `waiting_timeout_s`。
- 第一次回答原子生效；重复回答返回 `ticket_not_waiting`，幂等重试返回原 assignment。
- v0 没有通用 follow-up API；终态后的新工作建新 Ticket。

### Worker / Prime

- 一个 Assignment 一个 ACP 进程。
- 启动参数包含 workspace、项目 session dir、profile model/thinking、report skill、worker prompt。
- 恢复时 `--resume <session_ref>`。
- 缺终态报告：先补一次 enforcement prompt；仍缺失才 `failed / missing_report`。
- 工具事件只记日志，不逐条上报；progress 由 skill 主动上报并节流。
- 取消/超时由 Orchestrator 权威；Worker 发 `session/cancel`。
- Ticket 存逻辑 `session_key=ticket_id`；Worker 发现 opaque `session_ref`，发现失败安全 fallback。

### Runtime / 配置

- 运行时根目录：
  ```text
  SUPER_RLM_ROOT = ~/.super-rlm
  <SUPER_RLM_HOME> = $SUPER_RLM_ROOT/projects/<project_id>
  ```
- Node.js `>= 22.19` 是宿主机前置依赖，由用户自备；项目 runtime 只包含 Pi 和 Prime Agent。
- 目标项目只放 `.super-rlm-project.json`，且默认 gitignored。
- `super-rlm init` 创建项目标记；共享环境用 `--project-id` / `SUPER_RLM_PROJECT_ID`。
- Pi/Prime 只读项目本地 agent/session/auth/daemon 路径；剥离继承的 `PI_*` / `PRIME_AGENT_*`。
- 不读 `~/.pi` / `~/.prime`。
- Router 使用固定 session：`super-rlm-router-<project_id>`；`--new` / `--session` 可覆盖。
- Model Registry：
  - `config/models.yaml`
  - `config/router.yaml`
  - `config/profiles.yaml`
  - `secrets/providers.env`
- `super-rlm models sync` 只写项目 runtime 下的 Pi/Prime models.json。
- v0 显式选 profile；profile 固定映射到 model alias；不做自动任务路由。

### 基础设施

- Orchestrator：SQLite WAL、目录锁、forward-only migration、outbox、replaceable repositories。
- 传输：HTTP/JSON + SSE，版本 `/v1`。
- 认证：最小 bearer token + Worker report/callback HMAC；无 OIDC/mTLS。
- 入口：v0 CLI-only；公共任务 API 延后。
- 并发：全局 + 每 Worker + 一个 priority slot。
- 重试：transient/worker_lost/startup 3 次，2s/5s/15s jitter；config/workspace/timeout/cancel 不重试；missing_report 一次。
- 备份：离线；schema 只向前；迁移前自动备份；secrets 默认不备份。
- 可观测性：JSON logs、SQLite event log、SSE、基础指标、correlation IDs；OpenTelemetry 延后。
- 测试：unit + contract + integration + 小 E2E + fault；真实模型 E2E 已落地为手动回归脚本。

### UI

- Phase 1（L2）：Pi 扩展 custom screens。
  - Chat
  - Tasks
  - Task Detail
- L2 轮询；L3 用 SSE。
- 共享 `PageModel` + `OrchestratorClient`；L2/L3 只做渲染适配。
- Phase 2（L3）：独立 `apps/tui` shell 已实现垂直切片（pi-tui + Pi RpcClient，Chat/Tasks/Detail/Workers/Events）；后续继续打磨和真实 Chat E2E。
- Router 通知：SSE + Pi `sendMessage`，cursor/dedupe/节流；只唤醒 waiting/blocked 和 Task 终态。

## 6. 关键不变量

- Orchestrator 是唯一状态写入者。
- Router 和 Worker 都不能直接改 Task/Ticket 状态。
- Prime Agent 内部 RLM 树不进入 Orchestrator 数据模型。
- 一个 Ticket 同时最多一个 active Assignment。
- waiting/blocked 不占 slot。
- 一个 Assignment 一个 ACP 进程，不共享 session。
- 终态报告必须以结构化 skill 形式到达；自然语言不是成功依据。
- 项目运行时数据不写入目标仓库。
- 用户正常 Pi/Prime 配置不被读写。

## 7. 审计结论

审计文档：`docs/audit/design-audit.md`

已接受的修正：

- ADR 0039：Router SSE 通知/收件箱
- ADR 0040：report enforcement
- ADR 0041：session_ref 发现
- ADR 0042：项目标记本地、gitignored
- ADR 0043：v0 无通用 follow-up API
- ADR 0044：dropped/no-op
- ADR 0045：per-Task quota
- ADR 0046：重复/重叠 Ticket 检查

仍未作为架构回退的审计建议：

- O1：第一个本地闭环可以简化运行时/认证复杂度，但保留契约。
- O2：v0 先用一个默认 profile 和内置 provider；custom-provider fallback 晚点做。

## 8. 已完成 spike 与实现约束

| Spike | 状态 | 证据 |
| --- | --- | --- |
| Pi Router extension | passed | `docs/spikes/pi-router.md` |
| Prime Agent ACP | passed with constraints | `docs/spikes/prime-acp.md` |

### Spike 1：Pi Router extension

已验证：

- Pi 1.5.0，项目本地 `runtime/pi/`。
- `defaultTools: []` 移除所有内置工具，但保留扩展工具。
- `--no-extensions -e ./extensions/super-rlm.ts` 只加载 Router 扩展。
- 模型声明的工具只有 6 个：`profile_list`、`task_create`、`task_list`、`task_status`、`task_wait`、`ticket_result`。
- 模型幻觉调用 `bash` 返回 `Tool bash not found`，没有执行 shell。
- 项目本地 session 持久化到 `~/.super-rlm/projects/prj_spike_local/pi/sessions`。

Caveat：Pi 需要 Node.js；Node 由用户自备，不进入 runtime。

### Spike 2：Prime Agent ACP

已验证：

- Prime Agent 0.10.2，项目本地 `runtime/prime-agent/`。
- ACP 序列：`initialize` -> `session/new` -> `session/prompt`。
- `rlm.spawn` 两个子 Agent；ACP prompt 等待 terminal quiescence。
- `super-rlm-report` skill 报告 `completed` / `waiting`。
- 缺报告时，一次 enforcement prompt 能得到终态报告。
- `session_ref` 是 durable session 文件，不是 ACP sessionId。
- `--resume` 必须用同一个 daemon socket；lease 失败回退新 session。

### 实现约束

- Prime Agent 额外需要：
  - `PRIME_AGENT_KERNEL_VENV`
  - `PRIME_AGENT_KERNEL_PYTHON`
  - Windows: `PRIME_AGENT_BASH_SHELL`
- 项目 kernel venv 需要：
  - `prime-agent-runtime`（editable）
  - `mcp>=2,<3`
  - `tyro`
  - 默认 Python 包：`requests`、`httpx`、`pyyaml`、`tomli`、`python-dotenv`、`pandas`、`numpy`、`scipy`、`beautifulsoup4`、`lxml`
- 建议每个 Ticket 独立 session 目录：
  `prime/sessions/<ticket_id>/`
- `rlm.collect()` 不能作为唯一完成信号；依赖 ACP prompt result / terminal quiescence。
- `--print` 模式不适合 report skill 生命周期；必须用 ACP，并在终态报告后关闭 ACP 进程。

## 9. 下一步：最小垂直切片

0. Baseline 已提交（`c530a5a`）。
1. [done] 建立 `packages/protocol` 的最小 JSON Schema 和 TypeScript/Python 类型。
2. [done] 实现 Orchestrator 的最小状态机、SQLite 存储、slot 和 mock/real Worker dispatch。
3. [done] 实现 Worker 的 ACP 生命周期：`initialize` -> `session/new` -> `session/prompt`，report skill，session_ref 发现与 resume。
4. [done] 补 Router 缺失工具：`ticket_answer`、`ticket_resume`、`ticket_retry`、`ticket_cancel`、`task_cancel`。
5. [done] 实现 Router SSE 通知 + `pi.sendMessage`；交互/RPC 模式下的唤醒验证待补。
6. [done, manual] 跑通 Orchestrator -> Worker -> Prime Agent 的第一个本地任务；CLI/Router 链路待补。
7. [done] L2 Tasks / Task Detail 页面；已在真实 TUI 中用 DeepSeek 验证。
8. [done] 写 `apps/cli` 的 `super-rlm` 启动器；默认一键拉起后台 Orchestrator/Worker 再启动 Router，另有 `up/down/status`。
9. [done] 在 RPC 模式下验证 SSE 唤醒（`spikes/pi_sse_rpc_probe.py`）。
10. [done] 补完整的 Orchestrator + Worker HITL 联调（waiting -> answer -> resume -> completed）。

## 10. 不要做的事

- 不要在没有读文档的情况下重新决定已接受的架构。
- 不要把目标项目变成 runtime 数据目录。
- 不要让 Router 拥有 shell/file 执行工具。
- 不要让 Orchestrator 调 LLM 或拆任务。
- 不要让 Worker 写 Task/Ticket 状态。
- 不要用自然语言解析代替 `super-rlm-report`。
- 不要共享 ACP session 给多个 Ticket。
- 不要把发行打包放在核心闭环之前。
- 不要把用户全局 Pi/Prime 配置引入项目。

## 11. 建议的下一个对话开场

> 先读 `docs/HANDOFF.md`、`docs/spikes/pi-router.md`、`docs/spikes/prime-acp.md` 和 `docs/protocol/`。  
> 两个 spike 已通过；协议、Orchestrator、Worker、Router 工具/SSE、`super-rlm` CLI 已实现。  
> 下一步是交互/RPC 模式下的 SSE 唤醒验证、完整 HITL 联调和 L2 页面。

## 12. 相关文件索引

- 架构：`docs/architecture.md`
- ADR：`docs/adr/README.md`
- 状态机：`docs/protocol/state-machine.md`
- Router API：`docs/protocol/router-api.md`
- Worker API：`docs/protocol/worker-api.md`
- Report skill：`docs/protocol/report-skill.md`
- 审计：`docs/audit/design-audit.md`
- 审计修正：`docs/audit/follow-up-decisions.md`
- 项目结构：`docs/project-structure.md`
- Spike 计划：`docs/spikes/plan.md`
