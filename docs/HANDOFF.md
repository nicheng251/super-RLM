# super-RLM Handoff

Status: architecture decision design complete; both local spikes passed; core implementation not started. Baseline committed at `c530a5a`.  
Last updated: 2026-11-03

## 1. 项目一句话

super-RLM 是一个本地优先、Pi Agent 驱动的元代理系统：

- 用户通过 Pi Agent CLI 与 Router 对话；
- Router 把任务拆成 Ticket；
- Orchestrator 调度 Ticket；
- Worker 为每个 Ticket 启动一个 Prime Agent ACP session；
- Prime Agent 内部可以递归 `rlm.spawn` 子 Agent，外部不建模。

## 2. 当前状态

- 仓库有文档、ADR 和两个已通过的本地 spike；核心实现尚未开始。
- 46 个 ADR 已记录：44 accepted，2 superseded。
- 架构、状态机、Router API、Worker API、审计和 spike 计划已写入 docs。
- 项目本地运行时已建立：
  - `runtime/pi/`：Pi 1.5.0（npm 包）；Node.js 由用户自备，不进入 runtime。
  - `runtime/prime-agent/`：Prime Agent 0.10.2（项目内副本）。
- Spike 结果：
  - `docs/spikes/pi-router.md`：Router 只暴露 6 个控制面工具；伪 `bash` 调用被拒绝。
  - `docs/spikes/prime-acp.md`：ACP 驱动成功；`rlm.spawn` 两个子 Agent；report skill 的 `completed` / `waiting` 和 enforcement prompt 均验证。
- 下一阶段是最小 Orchestrator + Worker 垂直切片；发行、安装器、打包暂不做。

当前实现缺口：

- 没有 Orchestrator service、Worker service、`super-rlm` CLI。
- Router extension 只有 6 个 spike 工具，缺 `ticket_answer`、`ticket_resume`、`ticket_retry`、`ticket_cancel`、`task_cancel`，也没有 SSE 通知。
- 没有生产级 auth、SQLite、migration、backup、model sync。
- `runtime/prime-agent/` 和 `runtime/pi/node_modules/` 是本地 ignored 资产；需要 bootstrap 脚本。
- Baseline 已提交（`c530a5a`）；当前仓库有两个 commit。

当前已存在的代码/资产：

```text
apps/router/.pi/settings.json
apps/router/extensions/super-rlm.ts          # 6 个控制面工具，spike 级
apps/worker/skills/super-rlm-report/        # Python report skill
spikes/                                     # fake LLM、mock Orchestrator、ACP probes
runtime/manifest.json                       # Pi 1.5.0 / Prime 0.10.2；Node 为宿主机依赖
runtime/pi/                                 # 本地 Pi package（node_modules ignored）
runtime/prime-agent/                        # 本地 Prime binary/runtime（ignored）
docs/spikes/pi-router.md
docs/spikes/prime-acp.md
```

Git 状态：

```text
branch: main
commits: 2 (initial + baseline)
working tree: clean
baseline: c530a5a
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
- 测试：unit + contract + integration + 小 E2E + fault；真实模型 E2E 后置。

### UI

- Phase 1（L2）：Pi 扩展 custom screens。
  - Chat
  - Tasks
  - Task Detail
- L2 轮询；L3 用 SSE。
- 共享 `PageModel` + `OrchestratorClient`；L2/L3 只做渲染适配。
- Phase 2（L3）：一级 TUI shell，实现方式待定（自建 shell / fork Pi / 上游 API）。
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
1. 建立 `packages/protocol` 的最小 JSON Schema 和 TypeScript/Python 类型。
2. 实现 Orchestrator 的最小状态机、SQLite 存储、slot 和 mock/real Worker dispatch。
3. 实现 Worker 的 ACP 生命周期：`initialize` -> `session/new` -> `session/prompt`，report skill，session_ref 发现与 resume。
4. 补 Router 缺失工具：`ticket_answer`、`ticket_resume`、`ticket_retry`、`ticket_cancel`、`task_cancel`。
5. 实现 Router SSE 通知 + `pi.sendMessage`。
6. 跑通 CLI -> Router -> Orchestrator -> Worker -> Prime Agent 的第一个本地任务。
7. L2 Chat/Tasks/Task Detail 页面后置。

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
> 两个 spike 已通过，但核心实现还没开始；当前阶段是提交 baseline，然后做最小 Orchestrator + Worker 垂直切片。  
> 不要重做 spike；先实现本地闭环，再补 Router 缺失工具和 SSE 通知。

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
