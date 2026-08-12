# Paperclip 与 Multica 架构调研

> 调研日期：2026-08-11（Asia/Shanghai）  
> 仅使用一手资料：项目仓库 README、官方文档、源码、包清单与部署文件。  
> 固定版本：Paperclip [`66575fe519db7320147aece94fa66e15eba375c1`](https://github.com/paperclipai/paperclip/commit/66575fe519db7320147aece94fa66e15eba375c1)（提交时间 2026-08-10 21:45:58 -0400）；Multica [`6bce42b84a509a7f5aba4208949e6e4b83f6c574`](https://github.com/multica-ai/multica/commit/6bce42b84a509a7f5aba4208949e6e4b83f6c574)（提交时间 2026-08-11 02:23:11 +0800）。

## 结论先行

这两个项目解决的是相邻但不同的问题：

- **Paperclip 是组织与治理优先的控制面**。它把 company、goal、org tree、issue、heartbeat、budget、approval、activity 等建成一套强领域模型，再用 adapter 调用任意 agent runtime。它最值得借鉴的是任务所有权、原子 checkout、可持久化唤醒、成本/审批/权限/审计的一体化设计。[产品定义](https://github.com/paperclipai/paperclip/blob/66575fe519db7320147aece94fa66e15eba375c1/doc/PRODUCT.md#L10-L96)与[实现规范](https://github.com/paperclipai/paperclip/blob/66575fe519db7320147aece94fa66e15eba375c1/doc/SPEC-implementation.md#L203-L226)都明确把它定义为 control plane，而非 agent framework。
- **Multica 是共享工作空间与成员本地执行优先的系统**。中心服务记录 workspace、issue、comment、agent、task；每个成员自己的机器运行 daemon，daemon 注册“机器 × AI CLI”的 runtime、认领任务、启动本地进程并回写执行流。这个拓扑与“不同的人和自己的 agents 在共享空间协作、agent 在各自机器工作”高度一致。[运行路径](https://multica.ai/docs/how-multica-works)和[daemon/runtime 定义](https://multica.ai/docs/daemon-runtimes)对此有直接说明。
- 对目标系统，最佳取舍不是二选一，而是：**采用 Multica 的中心协调面 + 出站本地 runner 拓扑，叠加 Paperclip 的强任务语义、可持久化调度、权限/预算/审批/审计；runtime 扩展则应采用 Paperclip 的显式 adapter contract，而不是 Multica 当前以核心代码内置 provider 为主的方式。**

## 1. Paperclip

### 1.1 目的与领域模型

Paperclip 自称“管理 AI agents 工作的应用”和“AI agent teams 的开源编排系统”，Node.js 服务端与 React UI 组成统一控制面。[README](https://github.com/paperclipai/paperclip/blob/66575fe519db7320147aece94fa66e15eba375c1/README.md#L203-L212)中的核心对象包括：

- company 是一等租户边界；一套部署可承载多个 company；
- agent 同时具有角色、汇报关系、能力说明、adapter type/config、预算与权限；
- issue 是工作与协作主轴，关联 goal/project/parent、assignee、评论、审批和执行状态；
- 所有工作应可沿父任务或项目目标追溯到 company goal；
- board/human 通过审批、暂停、终止、预算硬停等方式治理 agent。

这些不是 UI 标签，而是数据库与状态机中的显式字段和约束。例如 issue 包含单一 human/agent assignee、checkout/execution locks、`backlog | todo | in_progress | in_review | done | blocked | cancelled` 状态、review policy 与 execution policy；`in_progress` 必须有 assignee。[实现规范中的 issue 模型](https://github.com/paperclipai/paperclip/blob/66575fe519db7320147aece94fa66e15eba375c1/doc/SPEC-implementation.md#L379-L417)

### 1.2 人与 agent 的协作模型

协作的核心不是自由群聊，而是 **issue + comment + document/work product + approval**。agent 在 heartbeat 中获取已分配工作、原子 checkout、执行、写评论/文档/产物并显式推进状态；human 可以在同一任务线程审阅、补充上下文、批准或阻断。[Paperclip agent skill 的执行约定](https://github.com/paperclipai/paperclip/blob/66575fe519db7320147aece94fa66e15eba375c1/skills/paperclip/SKILL.md#L30-L126)要求所有变更携带 run ID，因而“谁在什么 run 中做了什么”可以归因。

组织关系也是调度与授权的一部分：agent 组成严格的 `reports_to` 树，而不是任意 peer mesh；任务可向下委派，board 保留最终控制。[V1 决策表](https://github.com/paperclipai/paperclip/blob/66575fe519db7320147aece94fa66e15eba375c1/doc/SPEC-implementation.md#L212-L226)

需要注意一处文档漂移：2026-04 的 V1 实现规范仍写着“single human board operator”，但当前 README 路线表已把“Multiple Human Users”标为完成，源码的实时连接鉴权也实际查询 `companyMemberships` 与实例角色。[README 路线表](https://github.com/paperclipai/paperclip/blob/66575fe519db7320147aece94fa66e15eba375c1/README.md#L430-L445)、[WebSocket membership 鉴权](https://github.com/paperclipai/paperclip/blob/66575fe519db7320147aece94fa66e15eba375c1/server/src/realtime/live-events-ws.ts#L117-L196)。因此应以当前代码为准，同时把“规格版本与实现的一致性检查”视为必要工程机制。

### 1.3 编排与执行

agent 不是常驻线程，而是由短执行窗口 heartbeat 驱动。timer、assignment、on-demand 与 automation 可触发 wake；新 wake 会进入数据库队列，并在同 agent/issue 已运行时合并或延期，避免重复执行。[runtime guide](https://github.com/paperclipai/paperclip/blob/66575fe519db7320147aece94fa66e15eba375c1/docs/agents-runtime.md#L10-L50)；实际 `enqueueWakeup` 在入队前检查 company 状态、预算、agent invokability、heartbeat policy、issue/execution 条件并写 `agentWakeupRequests`，[源码](https://github.com/paperclipai/paperclip/blob/66575fe519db7320147aece94fa66e15eba375c1/server/src/services/heartbeat.ts#L17130-L17460)。

一次执行的大致链路是：

1. 持久化 wake request / heartbeat run，并获得 agent 级启动锁；
2. 解析 issue、goal、project、workspace、skills、secret bindings、budget 与 execution policy；
3. 选择 adapter 与 execution target；
4. 为本地 adapter 签发 run-scoped agent JWT；
5. 调用统一的 `adapter.execute(context)`，通过 `onLog`、`onEvent`、`onMeta`、`onRuntimeProgress` 流式记录；
6. 保存 usage/cost、session params、日志引用、结果与 workspace finalize 状态；失败时进入受控恢复/重试路径。

源码中 `adapter.execute` 收到 run、agent、runtime、config、execution target/transport、MCP access、日志与事件回调以及 auth token，证明 adapter 是控制面与执行面的真正边界。[heartbeat 调用点](https://github.com/paperclipai/paperclip/blob/66575fe519db7320147aece94fa66e15eba375c1/server/src/services/heartbeat.ts#L15320-L15610)

### 1.4 Runtime 与 adapter 扩展

内建 adapter 覆盖 Claude Code、Codex、Gemini、OpenCode、Cursor、Pi、Hermes、OpenClaw、process 与 HTTP。adapter 可以 spawn CLI，也可以调用已运行的 gateway/webhook；外部 adapter 作为 npm package 由插件系统装载，无需修改核心代码。[adapter overview](https://github.com/paperclipai/paperclip/blob/66575fe519db7320147aece94fa66e15eba375c1/docs/adapters/overview.md#L10-L94)

一个 adapter 包面向三类消费者分层：共享 metadata、服务端 `execute/parse/test`、UI transcript parser、CLI formatter。服务端的关键契约是 `AdapterExecutionContext -> AdapterExecutionResult`，结果可带 usage 和不透明 `sessionParams`，因此控制面无需理解某 runtime 的内部 session 格式。[adapter authoring guide](https://github.com/paperclipai/paperclip/blob/66575fe519db7320147aece94fa66e15eba375c1/packages/adapters/AUTHORING.md#L1-L104)；[registry 源码](https://github.com/paperclipai/paperclip/blob/66575fe519db7320147aece94fa66e15eba375c1/server/src/adapters/registry.ts#L424-L568)显示内建与外部 adapter 进入同一注册表。

执行位置方面，local CLI adapter 可运行在 Paperclip host、SSH target 或受管 sandbox；HTTP/gateway adapter 可触达外部常驻 agent。[adapter overview](https://github.com/paperclipai/paperclip/blob/66575fe519db7320147aece94fa66e15eba375c1/docs/adapters/overview.md#L26-L69) 但在本次核验的核心路径中，**没有发现像 Multica 那样由每个成员机器上的通用 daemon 主动连回中心、注册 runtimes 并 pull/claim 工作的第一等协议**；跨机器主要依赖中心发起 SSH/HTTP 或特定 gateway。此项是基于当前 adapter 文档、registry 与 heartbeat 调用路径的源码推断，而不是项目对未来能力的承诺。

### 1.5 消息、事件、状态与存储

- **权威状态**：PostgreSQL，Drizzle schema/migration；本地默认自动创建 embedded Postgres，生产可接外部 Postgres。[DB 包清单](https://github.com/paperclipai/paperclip/blob/66575fe519db7320147aece94fa66e15eba375c1/packages/db/package.json)与[README 部署说明](https://github.com/paperclipai/paperclip/blob/66575fe519db7320147aece94fa66e15eba375c1/README.md#L391-L405)
- **执行状态**：`heartbeat_runs` 保存状态、上下文快照、usage、session before/after、日志引用、进程元数据、liveness、retry 等；`agent_wakeup_requests` 负责可持久化唤醒与 coalescing。[heartbeat run 字段选择](https://github.com/paperclipai/paperclip/blob/66575fe519db7320147aece94fa66e15eba375c1/server/src/services/heartbeat.ts#L2182-L2305)
- **运行日志**：进行中的 NDJSON 落本地文件，完成或按间隔镜像到 S3/object storage，DB 只保存 log ref、大小与校验信息。[run log store](https://github.com/paperclipai/paperclip/blob/66575fe519db7320147aece94fa66e15eba375c1/server/src/services/run-log-store.ts#L60-L143)
- **实时事件**：company-scoped WebSocket 推送 UI；连接先按 human membership 或 agent API key 鉴权。[live-events WebSocket](https://github.com/paperclipai/paperclip/blob/66575fe519db7320147aece94fa66e15eba375c1/server/src/realtime/live-events-ws.ts#L117-L250) 当前 live broadcaster 本身是进程内 `EventEmitter`，因此它适合刷新/观察而不是权威消息队列；持久化正确性仍由 DB 状态和 run/activity records 承担。[live-events 源码](https://github.com/paperclipai/paperclip/blob/66575fe519db7320147aece94fa66e15eba375c1/server/src/services/live-events.ts)

### 1.6 身份、安全与权限

Paperclip 区分 `local_trusted` 与 `authenticated`，后者又分 private/public exposure；bind（loopback/LAN/tailnet/custom）与 auth model 解耦。[部署模式](https://github.com/paperclipai/paperclip/blob/66575fe519db7320147aece94fa66e15eba375c1/doc/DEPLOYMENT-MODES.md#L194-L250)

human 通过用户身份、实例角色与 company membership 鉴权；agent 可用长期 API key，而本地 heartbeat 更优先使用短期 run JWT。JWT 默认约一小时，签名密钥按 instance + company 派生，claim 包含 agent、company、adapter 与 run，减少跨租户/跨实例重放面。[agent JWT 源码](https://github.com/paperclipai/paperclip/blob/66575fe519db7320147aece94fa66e15eba375c1/server/src/agent-auth-jwt.ts#L40-L85)、[签发与校验](https://github.com/paperclipai/paperclip/blob/66575fe519db7320147aece94fa66e15eba375c1/server/src/agent-auth-jwt.ts#L116-L223)

授权不是简单角色判断：代码包含 company boundary、agent permission grants、结构化 scope、issue/project/agent resource、低信任 issue subtree boundary 与 task-bridge 受限权限。[authorization action/resource](https://github.com/paperclipai/paperclip/blob/66575fe519db7320147aece94fa66e15eba375c1/server/src/services/authorization.ts#L60-L140)、[低信任边界](https://github.com/paperclipai/paperclip/blob/66575fe519db7320147aece94fa66e15eba375c1/server/src/services/authorization.ts#L955-L1076)。这对多 agent 协作比单纯 RBAC 更合适，但实现复杂度显著。

### 1.7 代码组织

Paperclip 是 pnpm/TypeScript monorepo：[根目录](https://github.com/paperclipai/paperclip/tree/66575fe519db7320147aece94fa66e15eba375c1)与[workspace 配置](https://github.com/paperclipai/paperclip/blob/66575fe519db7320147aece94fa66e15eba375c1/pnpm-workspace.yaml)可归纳为：

```text
server/                  # Express API、domain services、auth、routes、realtime、storage
ui/                      # React UI
cli/                     # 安装、运维、agent 本地命令
packages/
  db/                    # Drizzle schema/migrations、embedded/external Postgres
  shared/                # 跨 UI/server/CLI 的类型与 schema
  adapter-utils/         # adapter 共用执行、SSH/工作区能力
  adapters/*/            # 每个 runtime 一个独立包
  plugins/               # plugin SDK/runtime
  mcp-server/            # MCP 接入面
  skills-catalog/        # skills 分发
docs/, doc/, skills/, tests/, evals/
```

优点是 adapter、DB、共享契约与产品 server 分离明确；缺点是 `server/src/services/heartbeat.ts` 已成为超大编排模块，集成了队列、workspace、auth、budget、session、retry、logging、policy 等大量职责。对新系统应保留其领域完整性，但不要复制这个“单个 orchestration god module”的演化结果。

### 1.8 对目标系统的价值与局限

**优势**

- 任务所有权、原子 checkout、持久化 wake、coalescing、session 续接与预算硬停，能解决 agent 重复工作和失控执行。
- issue/goal/org/approval/activity 让多 agent 工作可解释、可干预、可审计。
- adapter contract 与外部插件是跨 runtime 长期演进的好边界。
- run-scoped 身份与资源级授权比“daemon 拿用户永久 token 执行一切”更安全。

**局限**

- 领域语言偏“AI company/员工/汇报树”，不一定适合研究、设计、知识协作等开放型团队。
- 当前默认执行拓扑仍以控制面主机、SSH/sandbox 或外部 HTTP endpoint 为中心，不直接满足“每个人的机器作为自治执行节点”。
- company-wide 可见、组织树、权限/审批/成本/工作区策略同时存在，学习和实现成本高；不适合直接作为 MVP 起点。
- 规范与高速变化的代码存在漂移，需要机器可校验的协议/schema version 与兼容性策略。

## 2. Multica

### 2.1 目的与领域模型

Multica 把自己定义为“把 AI coding agents 像队友一样分配 issue 的开源 workspace”：agent 会认领 issue、报告进度、提出 blocker、交回 human review；支持自托管与多种 CLI。[README](https://github.com/multica-ai/multica/blob/6bce42b84a509a7f5aba4208949e6e4b83f6c574/README.md#L7-L50)

其对象边界比 Paperclip 更贴近常规协作软件：

- workspace 是多人和 agents 的共同租户边界；
- issue 是长期工作对象，可由 member、agent 或 squad 负责；
- agent 是可复用的身份/指令/模型/skills/access/runtime 配置，不是常驻进程；
- task 是一次具体 run；同一 issue 可以有多个不覆盖历史的 task；
- runtime 是“某台已连接机器 + 某个 AI coding tool/custom profile”；
- project、squad、chat、inbox、autopilot 分别负责组织、团队路由、即时对话、人类通知与自动触发。[官方核心对象图与定义](https://multica.ai/docs/concepts)

### 2.2 人与 agent 的协作模型

human 与 agent 同在 issue board、comment timeline 与 project 中。agent 可以作为 assignee、被评论 @mention、直接 chat、加入 squad/project 或被 autopilot 触发；每次触发都产生独立 task，结果回到原 issue/chat。[Agents 文档](https://multica.ai/docs/agents)

human review 是默认交付边界：README 明确说 intent、run、decisions、diff 留在同一 issue，工作返回 review 而不是直接视为完成。[README](https://github.com/multica-ai/multica/blob/6bce42b84a509a7f5aba4208949e6e4b83f6c574/README.md#L32-L65) 这比把 agent run 成功等同于任务完成更稳健；官方 task 文档也明确 `completed` 只代表一次 run 正常结束，不代表 issue goal 已完成。[Tasks](https://multica.ai/docs/tasks)

### 2.3 中心—本地执行拓扑

Multica 最有参考价值的设计是控制与执行分离：

```text
Web / Desktop / Mobile
          |
Next.js frontend -> Go API + WebSocket -> PostgreSQL
                         |
                  outbound WS/HTTPS
                         |
            member machine: multica daemon
                         |
              local Claude/Codex/Cursor/...
```

中心保存协作事实并调度；每个成员机器上的 daemon 主动连接中心，发现 PATH 上的 CLI，为每个允许的 workspace 注册 runtimes，认领 task 后在本地工作目录启动子进程。[README 架构图](https://github.com/multica-ai/multica/blob/6bce42b84a509a7f5aba4208949e6e4b83f6c574/README.md#L166-L192)、[daemon/runtime 文档](https://multica.ai/docs/daemon-runtimes)

完整执行链路是 issue trigger → DB task queue → runtime claim → local CLI → progress/tool messages → task terminal result → issue timeline/review。若 runtime 离线，任务在队列等待；daemon 恢复后重新注册并处理未干净结束的任务。[How Multica works](https://multica.ai/docs/how-multica-works)

### 2.4 消息协议、可靠性与调度

中心与 daemon 有持久 WebSocket 控制连接。协议 envelope 是 `{type, payload}`，事件包括 runtime heartbeat/register、task available、task state/message、workspace/profile changed 与通用 RPC request/response。[协议消息](https://github.com/multica-ai/multica/blob/6bce42b84a509a7f5aba4208949e6e4b83f6c574/server/pkg/protocol/messages.go#L1-L117)、[事件枚举](https://github.com/multica-ai/multica/blob/6bce42b84a509a7f5aba4208949e6e4b83f6c574/server/pkg/protocol/events.go#L1-L138)

关键的可靠性选择是：**WebSocket 多数时候只是低延迟 hint，而不是唯一事实通道**。hub 源码明确说消息为 best-effort wakeup hints，daemon 仍以 claim API 保证正确性；daemon 端连接失败或 ack 缺失时退回 HTTP poll/heartbeat。[hub 注释](https://github.com/multica-ai/multica/blob/6bce42b84a509a7f5aba4208949e6e4b83f6c574/server/internal/daemonws/hub.go#L150-L190)、[wakeup fallback](https://github.com/multica-ai/multica/blob/6bce42b84a509a7f5aba4208949e6e4b83f6c574/server/internal/daemon/wakeup.go#L36-L147)。这是很好的“通知可丢、状态不可丢”分层。

WebSocket RPC 带 request ID、method、body、timeout，并以 HTTP-like status 响应；服务端限制每连接最多 8 个并发 RPC，防止单 daemon 无限放大 DB 工作。[RPC contract](https://github.com/multica-ai/multica/blob/6bce42b84a509a7f5aba4208949e6e4b83f6c574/server/pkg/protocol/messages.go#L18-L54)、[hub 并发限制](https://github.com/multica-ai/multica/blob/6bce42b84a509a7f5aba4208949e6e4b83f6c574/server/internal/daemonws/hub.go#L105-L153)

task 有 `deferred → queued → dispatched → waiting_local_directory/running → completed/failed/cancelled` 状态机；queued、dispatch、runtime liveness、自动 retry 都有明确超时/上限。[Tasks 状态与重试规则](https://multica.ai/docs/tasks) 每个 task 独立 workdir，并对同一路径做本地目录锁，降低并发冲突。

### 2.5 状态与存储

- PostgreSQL 17 + pgvector 是主存储；Go 服务端使用 pgx/sqlc，前端不持有权威状态。[README architecture](https://github.com/multica-ai/multica/blob/6bce42b84a509a7f5aba4208949e6e4b83f6c574/README.md#L166-L192)、[Go dependencies](https://github.com/multica-ai/multica/blob/6bce42b84a509a7f5aba4208949e6e4b83f6c574/server/go.mod)
- migrations 明确覆盖 task context/lifecycle/session/messages/usage、daemon token、runtime owner、issue/comment/chat/project/search 等，说明协作与执行结果以 DB 记录而非仅靠日志文件维系。[migration tree](https://github.com/multica-ai/multica/tree/6bce42b84a509a7f5aba4208949e6e4b83f6c574/server/migrations)
- 代码目录、AI CLI 登录凭据和实际命令执行留在成员机器；中心保存 issue/comment/agent config/task context/run/result。agent 主动回写的内容可能包含源码片段；`custom_env` 和 MCP config 则明确存于中心并在运行时下发。[数据边界](https://multica.ai/docs/how-multica-works)

### 2.6 Runtime 适配与扩展

daemon 自动探测约 20 个 CLI。源码通过 provider → executable/args/parser 的内建描述和探测代码实现，其中相当一部分 provider 仍在 `agents_probe.go` 中显式列出。[provider probe 源码](https://github.com/multica-ai/multica/blob/6bce42b84a509a7f5aba4208949e6e4b83f6c574/server/internal/daemon/agents_probe.go#L88-L248)

workspace admin 可创建 custom runtime profile，但 profile 必须选择 Multica 已支持的 protocol family；它只是替换兼容命令/固定参数，并不扩展新的 wire/stream/parser protocol。[custom runtime profile](https://multica.ai/docs/daemon-runtimes) 因而 Multica 的“runtime 多样性”很强，但“第三方在不改核心代码的情况下定义新 runtime 协议”的边界弱于 Paperclip adapter plugin。

### 2.7 身份、权限与安全

workspace member 角色为 owner/admin/member，主要控制团队和 workspace 设置；日常 issue/comment 对所有成员开放。agent 另有独立 Access：Only me、Entire workspace、Specific people；workspace admin 能管理 agent，但不能绕过 Access 去运行别人的私有 agent。[成员角色](https://multica.ai/docs/members-roles)、[agent Access](https://multica.ai/docs/agents)

runtime 有明确 owner，默认 private：owner 与 workspace owner/admin 可在其上建 agent；设为 public 后其他成员才能路由自己的 agent 到这台机器，但不会直接获得底层 CLI 登录凭据。[private/public runtime](https://multica.ai/docs/daemon-runtimes) daemon WebSocket connection 也持有已认证的 user、workspace IDs 与 runtime IDs，heartbeat/RPC handler 必须在该 scope 内执行。[ClientIdentity](https://github.com/multica-ai/multica/blob/6bce42b84a509a7f5aba4208949e6e4b83f6c574/server/internal/daemonws/hub.go#L20-L94)

执行时中心下发 `mat_` 前缀的 task-scoped token；daemon 拒绝缺失或非 task-scoped token，再将其作为 `MULTICA_TOKEN` 注入子进程。[daemon token 检查](https://github.com/multica-ai/multica/blob/6bce42b84a509a7f5aba4208949e6e4b83f6c574/server/internal/daemon/daemon.go#L120-L151)

最重要的风险是：**Multica 默认不提供文件系统沙箱**。agent 子进程拥有运行 daemon 的 OS 用户的全部文件、凭据与网络权限；官方建议使用专用 Unix user、容器或 VM 建立外部隔离边界。每 task workdir、task-scoped CODEX_HOME 和 API token 只是 blast-radius reduction，不是恶意任务的安全边界。[官方 security model](https://multica.ai/docs/security-model)

### 2.8 部署与代码组织

自托管基础拓扑是 Go REST/WS 单体 + Next.js + PostgreSQL；Docker Compose 是快速路径，也提供 Helm chart，生产可为 uploads 配置 S3。[Self-hosting](https://github.com/multica-ai/multica/blob/6bce42b84a509a7f5aba4208949e6e4b83f6c574/SELF_HOSTING.md#L1-L132)

代码采用 Go backend + pnpm/Turbo 前端 monorepo：[根目录](https://github.com/multica-ai/multica/tree/6bce42b84a509a7f5aba4208949e6e4b83f6c574)组织为：

```text
apps/
  web/                   # Next.js web
  desktop/               # Electron，共享 web UI packages
  mobile/                # Expo / React Native
  docs/
packages/
  core/                  # 跨前端核心契约/客户端能力
  ui/                    # UI primitives
  views/                 # 可复用产品视图
server/
  cmd/server/            # API server 入口
  cmd/multica/           # CLI + daemon 入口
  internal/daemon/       # 本地 runner、repo cache、exec environment
  internal/daemonws/     # 服务端 daemon connection hub
  internal/handler/      # HTTP/WS transport handlers
  internal/service/      # 领域用例
  internal/auth|events|realtime|scheduler|storage/
  pkg/protocol/          # 共享 wire protocol
  pkg/db/                # sqlc 生成层/queries
  migrations/
deploy/helm/, docker/, e2e/
```

目录证据见 [`apps`](https://github.com/multica-ai/multica/tree/6bce42b84a509a7f5aba4208949e6e4b83f6c574/apps)、[`packages`](https://github.com/multica-ai/multica/tree/6bce42b84a509a7f5aba4208949e6e4b83f6c574/packages)、[`server/internal`](https://github.com/multica-ai/multica/tree/6bce42b84a509a7f5aba4208949e6e4b83f6c574/server/internal)。优点是中心 server、边缘 daemon 与 wire protocol 都在同一个 Go module，可复用类型并容易做端到端测试；缺点是 CLI、daemon 与 server 共享同一大 backend module，provider 增长可能持续抬高 daemon 核心复杂度。

### 2.9 对目标系统的价值与局限

**优势**

- 出站 daemon 无需中心反向 SSH 用户电脑，天然适合 NAT、个人机器、headless box 与多人各自管理凭据。
- agent identity 与 runtime 分离；一个 agent 可多次执行，一个 runtime 可托管多个 agent，生命周期语义干净。
- runtime owner/private/public 与 agent Access 分开，符合“每个人和自己的 agents”这一所有权模型。
- WebSocket hint + HTTP/DB claim fallback 兼顾低延迟和可靠性。
- issue 与 task 分离，避免“一个 run 完成 = 业务目标完成”的错误建模。

**局限**

- 产品中心仍明显偏 AI coding、Git repo、diff/PR/workdir；对设计、研究、办公、物理设备等 runtime 需抽象 artifact/resource，而不是继续围绕 checkout 扩展。
- 默认 agent 继承 daemon 用户全部能力；若多人能把 agent 路由到 public runtime，风险尤其高。
- runtime protocol 扩展仍主要由核心 provider 列表与兼容 profile 驱动，缺少成熟的第三方 SDK/插件隔离。
- 多进程/多实例扩展时，需确认 WebSocket hub、scheduler 与 event broadcast 的横向扩展方案；仅 PostgreSQL 权威状态不足以自动完成跨实例实时路由。

## 3. 横向比较

| 维度 | Paperclip | Multica | 对目标系统的判断 |
|---|---|---|---|
| 核心抽象 | AI company、org tree、goal、issue、heartbeat、approval、budget | workspace、issue、agent、task、runtime、squad、chat | 以中性 workspace 为顶层；goal/org 是可选模块，不应绑死核心 |
| 人机协作 | issue/comment/document/approval，强调层级委派与治理 | 同一 board/timeline/chat，human review 默认明确 | 借鉴 issue/task 分离与 review gate，再加入可选审批 |
| 执行拓扑 | 控制面调用本机 CLI、SSH/sandbox 或 HTTP/gateway | 每成员机器 daemon 主动连接、注册 runtime、claim task | 目标系统应优先采用 Multica 拓扑 |
| Runtime 扩展 | 清晰 adapter interface，外部 npm plugin 可装载 | 大量内建 CLI + custom compatible profile | 采用 Paperclip 式 SDK contract，运行在 Multica 式 edge runner |
| 调度正确性 | DB wake queue、coalesce、agent lock、atomic checkout、budget gate | DB task queue、claim、heartbeat、retry、local-directory lock | 两者合并：DB lease/claim + idempotency + coalesce + resource lock |
| 实时通信 | company WebSocket；进程内 broadcaster，DB/activity 为事实 | daemon/Web client WebSocket；hint 可丢，HTTP claim 回退 | 事件只做 hint；所有状态迁移必须落 durable command/result |
| Session | adapter 不透明 `sessionParams`，按 task key 续接 | task/session 记录，retry 尽量复用 session/workdir | session 属于 runtime adapter，不进入核心领域模型 |
| 存储 | Postgres + 本地/S3 logs/artifacts | Postgres/pgvector + 本地 code/workdirs + uploads/S3 | 中心只存协作事实/事件/产物元数据；代码与 runtime credential 默认在 edge |
| Human 权限 | instance role + company membership + resource/grant/low-trust boundary | workspace role + agent Access + runtime ownership/visibility | 需要 workspace role、agent ownership、runtime ownership、capability policy 四层 |
| Agent 身份 | API key 或 company/instance/run-scoped JWT | task-scoped API token，daemon/user/runtime scope | 采用短时 task capability token，禁用把人类 token 传给 agent |
| 隔离 | 支持 managed sandbox/SSH target，但拓扑由中心掌控 | 默认无 FS sandbox，靠 daemon 外部 OS/container/VM 边界 | runner 必须显式声明 isolation profile；public runtime 禁止默认裸机执行 |
| 部署 | 本地单 Node + embedded PG；生产外部 PG/object store | Go API/WS + Next + PG；Docker Compose/Helm；每人 daemon | MVP 可模块化单体 + PG；edge runner 独立二进制；以后再拆服务 |
| 主要风险 | 领域和 orchestration 过重；并非原生个人 edge daemon | coding 偏置；sandbox 弱；provider 扩展侵入核心 | 核心保持中性、协议版本化、能力最小化 |

## 4. 可借鉴 / 不应照搬

### 可借鉴

1. **Multica 的 edge runner 所有权模型**：`Human -> Device/Runner -> Runtime -> Agent binding` 分层；runner 主动出站连接，中心不保存模型/CLI 的长期登录凭据。
2. **Multica 的可靠通知原则**：WebSocket 只提示“可能有工作”，真正 claim 走可幂等、可事务化的 durable API；断线后 poll/heartbeat 能自动收敛。
3. **Paperclip 的 durable wake 与 execution ledger**：每次触发先产生 command/wakeup/run 记录，执行日志、usage、成本、actor、session 与结果都有可追溯 ID。
4. **Paperclip 的 adapter seam**：核心只依赖统一 execute/event/result contract；adapter 拥有 runtime-specific config、session codec、stream parser 和 capability probe。
5. **两者共有的 issue/task 分离**：issue 是协作目标，run/task 是一次尝试；retry 创建新 attempt，不覆盖历史。
6. **短时 capability token**：token 同时绑定 workspace、agent、task/run、允许的 action/resource 与过期时间；runner 只拿执行该任务所需最小权限。
7. **权限与资源所有权分离**：workspace role 不应自动取得某人的私有 agent/runtime 使用权；agent owner、runner owner、resource ACL 与治理角色分别建模。
8. **模块化单体起步**：中心先用一个部署单元完成端到端闭环，但在代码中让 domain、application、ports、transport、persistence 分层；edge runner 从第一天就是独立进程。

### 不应照搬

1. **不要把“company/员工/老板”写死为核心语言**。它适合 Paperclip 的产品定位，却会限制通用 shared space；把 org/goal/budget 做成核心之上的可选 governance module。
2. **不要把 Git checkout/PR 当通用 work object**。核心应只有 Resource/Artifact/Reference；Git workspace 是一种 adapter capability。
3. **不要复制巨型 heartbeat/daemon 编排文件**。把 claim/lease、context assembly、policy、runtime dispatch、event ingestion、finalization 分成可独立测试的 application services。
4. **不要让 WebSocket event 成为权威事实**。网络重连、重复、乱序是常态；状态机迁移必须在中心事务中验证，event 带 sequence/cursor 仅供追赶。
5. **不要默认在个人 OS 用户权限下执行 public/shared agent**。至少要求 dedicated user/container；更强场景用 VM/microVM，并明确 filesystem/network/secret capability。
6. **不要把 provider 列表硬编码进 runner 主流程**。第一版也应使用 manifest + adapter process/WASI/container/stdio protocol，内建 adapter 只是预装插件。
7. **不要一开始复制 Paperclip 全套治理复杂度**。MVP 只需 workspace、identity、agent、runner/runtime、work item、run、event、artifact、basic ACL；预算、组织树、审批策略逐层叠加。

## 5. 对自研架构的直接约束

从两项目的证据可得出以下第一性约束：

- **共享的是事实，不是进程**：中心持有 work item、conversation、decision、run ledger 与 artifact references；agent process 和本地 code/credential 属于 edge。
- **agent 是身份与策略，runtime 是可用执行环境，run 是一次有期限的绑定**；三者绝不能合并成一张“agent process”表。
- **所有远程执行都从 edge 主动出站**；中心只发 command，runner claim 后才获得短时 capability。
- **实时层负责速度，持久层负责正确性**；任何 WebSocket 消息都允许丢失、重复、乱序，runner 必须能通过 cursor/claim API 恢复。
- **跨 runtime 的最小共同语义应很小**：`probe -> prepare -> start -> emit -> cancel -> finalize`；text/tool-call/token/session/artifact 均以 capability 声明为可选，不强迫所有 runtime 伪装成同一种 agent loop。
- **安全边界在 runner 隔离环境，而不在 prompt 或 CLI approval flag**；中心策略只能决定授权，不能替代 OS/container/VM 隔离。

因此，若只能从两者各选一个最重要的部件：从 Multica 选择 **per-user outbound runner protocol**，从 Paperclip 选择 **durable work/run/governance ledger + adapter contract**。
