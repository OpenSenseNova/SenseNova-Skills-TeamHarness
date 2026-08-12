# OpenAgents 架构与源码调研

> 调研对象：[`openagents-org/openagents`](https://github.com/openagents-org/openagents)  
> 固定版本：[`ffbd0c92ad87c5c262ba5524183994727e572079`](https://github.com/openagents-org/openagents/commit/ffbd0c92ad87c5c262ba5524183994727e572079)（提交时间 2026-08-10）  
> 调研日期：2026-08-11  
> 来源范围：项目 README、官方 ONM 设计文档、包清单及实际源码；下述“已实现”结论均以该提交源码为准。

## 结论摘要

OpenAgents 现在其实是三套相关但尚未收敛的产品/代码：面向最终用户的 hosted Workspace、在用户机器上运行 Agent 的 Node Launcher，以及较早的 Python Network SDK。README 对外把它们描述为“协作层、管理层、扩展层”；源码目录也对应 `workspace/`、`packages/agent-connector`/`packages/launcher`、`sdk/` 三块。[README](https://github.com/openagents-org/openagents/blob/ffbd0c92ad87c5c262ba5524183994727e572079/README.md#all-openagents-projects)

对“多人带着各自本地 Agent 进入共享空间、且兼容多 runtime”这个目标，最值得研究的是 **Workspace + Launcher**，不是旧 SDK：中心服务保存事件、线程、成员、文件等共享状态；每台个人机器运行 daemon，通过 runtime adapter 把远端事件翻译为本地 CLI 子进程调用，再把结果写回共享空间。当前 Workspace 的生产路径主要是 HTTPS `POST/GET /v1/events` + 轮询，浏览器客户端另有 SSE；并不是 Agent 之间建立 P2P 连接。[事件 API](https://github.com/openagents-org/openagents/blob/ffbd0c92ad87c5c262ba5524183994727e572079/workspace/backend/app/routers/events.py#L1-L7) [SSE 实现](https://github.com/openagents-org/openagents/blob/ffbd0c92ad87c5c262ba5524183994727e572079/workspace/backend/app/routers/events.py#L820-L891) [本地轮询循环](https://github.com/openagents-org/openagents/blob/ffbd0c92ad87c5c262ba5524183994727e572079/packages/agent-connector/src/adapters/base.js#L614-L694)

它最强的设计是：把本地执行与共享控制面分开，以统一事件信封承载通信，以线程为运行时会话隔离单元，以 adapter 隔离不同 CLI 的差异。它最大的风险则是：机器侧共用 workspace token，token 被直接注入 Agent prompt；该 token 在服务端被视为 owner 等价凭据，而 Codex adapter 还以关闭审批与沙箱的模式运行。因此它适合学习产品闭环和适配器工程，不适合原样复制其信任模型。[访问判定](https://github.com/openagents-org/openagents/blob/ffbd0c92ad87c5c262ba5524183994727e572079/workspace/backend/app/access.py#L247-L280) [token 注入 prompt](https://github.com/openagents-org/openagents/blob/ffbd0c92ad87c5c262ba5524183994727e572079/packages/agent-connector/src/adapters/workspace-prompt.js#L210-L245) [Codex 启动参数](https://github.com/openagents-org/openagents/blob/ffbd0c92ad87c5c262ba5524183994727e572079/packages/agent-connector/src/adapters/codex.js#L283-L313)

## 1. 项目目的与核心抽象

官方将 Workspace 定义为一个持久的 Agent 协作中心：不同机器/环境中的 Agent 共享线程、文件和浏览器，人类通过同一 URL 参与，并用 `@mention` 指派工作。[README](https://github.com/openagents-org/openagents/blob/ffbd0c92ad87c5c262ba5524183994727e572079/README.md#introducing-openagents-workspace)

新的 OpenAgents Network Model（ONM）提出七个基本概念：Network、Address、Verification、Event、Mod、Resource、Transport。核心选择是“所有交互都是 Event”，Network 是信任与部署的有界上下文，Mod 是有序事件拦截器，传输只负责把同一事件编码上网。[ONM 文档](https://github.com/openagents-org/openagents/blob/ffbd0c92ad87c5c262ba5524183994727e572079/docs/openagents_network_model.md#2-core-concepts) [设计哲学](https://github.com/openagents-org/openagents/blob/ffbd0c92ad87c5c262ba5524183994727e572079/docs/openagents_network_model.md#design-philosophy)

但要注意“模型”和“当前实现”的差距。Workspace 后端明确声明其 ONM `Event` 与旧 SDK 的 `models.event.Event` 是两套不同模型，并计划最终替换后者；前者字段是 `id/type/source/target/payload/metadata/timestamp/network/visibility`，且 `target` 必填。[Workspace ONM Event](https://github.com/openagents-org/openagents/blob/ffbd0c92ad87c5c262ba5524183994727e572079/workspace/backend/openagents/core/onm_events.py#L1-L53) 旧 SDK 使用 `event_id/event_name/source_id/destination_id/...`，并包含旧地址格式和兼容逻辑。[旧 SDK Event](https://github.com/openagents-org/openagents/blob/ffbd0c92ad87c5c262ba5524183994727e572079/sdk/src/openagents/models/event.py#L47-L128)

## 2. 实际执行与协作模型

### 2.1 从人类消息到本地 Agent

当前主链路如下：

1. 人类或 Agent 向 `POST /v1/events` 提交 ONM event；服务端依次执行 `AuthMod → WorkspaceMod → PersistenceMod`，提交数据库后发布缓存事件，并在需要时触发云 Agent。[事件写入](https://github.com/openagents-org/openagents/blob/ffbd0c92ad87c5c262ba5524183994727e572079/workspace/backend/app/routers/events.py#L143-L267) [Pipeline 组装](https://github.com/openagents-org/openagents/blob/ffbd0c92ad87c5c262ba5524183994727e572079/workspace/backend/app/pipeline_factory.py#L17-L27)
2. 本地 daemon 中每个 Agent adapter 周期性查询 `GET /v1/events?type=workspace.message.posted&target_agents=<name>`，用 event cursor 推进消费位置，并在客户端再次按 `metadata.target_agents` 过滤。[pollPending](https://github.com/openagents-org/openagents/blob/ffbd0c92ad87c5c262ba5524183994727e572079/packages/agent-connector/src/workspace-client.js#L280-L360)
3. adapter 按 channel 调度任务：不同 channel 可并行；同一 channel 只有一个 worker，后续消息进入内存队列串行执行。这样线程会话不会并发踩踏，但队列不是持久化工作队列，daemon 崩溃时未执行项没有本地恢复语义。[本地 channel 调度](https://github.com/openagents-org/openagents/blob/ffbd0c92ad87c5c262ba5524183994727e572079/packages/agent-connector/src/adapters/base.js#L702-L772)
4. runtime adapter 启动本地 CLI、解析其结构化输出、持续回传 thinking/status/final。以 Codex 为例，它为每个 channel 保存独立 thread id 到 `~/.openagents/sessions/...json`，收到消息时执行 `codex exec [resume <thread>] --json ...`。[Codex 会话保存](https://github.com/openagents-org/openagents/blob/ffbd0c92ad87c5c262ba5524183994727e572079/packages/agent-connector/src/adapters/codex.js#L62-L110) [Codex 子进程桥接](https://github.com/openagents-org/openagents/blob/ffbd0c92ad87c5c262ba5524183994727e572079/packages/agent-connector/src/adapters/codex.js#L272-L370)

adapter 启动时会把 cursor 直接跳到事件流头部以忽略历史消息，随后以 2–15 秒自适应间隔轮询；因此它实现的是“在线时消费新消息”，不是 ONM 文档所描述的、带 ACK 和重试的严格 at-least-once 投递。[跳过历史与轮询策略](https://github.com/openagents-org/openagents/blob/ffbd0c92ad87c5c262ba5524183994727e572079/packages/agent-connector/src/adapters/base.js#L232-L249) [轮询策略](https://github.com/openagents-org/openagents/blob/ffbd0c92ad87c5c262ba5524183994727e572079/packages/agent-connector/src/adapters/base.js#L614-L694) [ONM 的目标语义](https://github.com/openagents-org/openagents/blob/ffbd0c92ad87c5c262ba5524183994727e572079/docs/openagents_network_model.md#delivery-guarantees)

### 2.2 多 Agent 路由

Workspace 把 channel 同时作为会话/线程和 Agent 参与者边界。`Channel` 保存 `master_agent`、参与者、`resume_from` 以及三种 orchestration mode：`dynamic`（小模型选择下一发言者）、`master`（确定性星形路由）、`workflow`（把用户的自然语言协作计划注入路由 prompt）。[Channel 模型](https://github.com/openagents-org/openagents/blob/ffbd0c92ad87c5c262ba5524183994727e572079/workspace/backend/app/models.py#L133-L171)

`WorkspaceMod` 对人类消息、Agent 消息、`@mention`、在线状态及 master 做路由，最终把目标写入 `event.metadata.target_agents`；没有下一发言者时写入 `__no_response__` 哨兵，防止旧客户端把空数组误解为广播。路由还会避免自循环、优先在线 Agent，并对人类消息保证至少选择一个 fallback responder。[消息路由实现](https://github.com/openagents-org/openagents/blob/ffbd0c92ad87c5c262ba5524183994727e572079/workspace/backend/app/mods/workspace_mod.py#L1222-L1388) [LLM 路由防护](https://github.com/openagents-org/openagents/blob/ffbd0c92ad87c5c262ba5524183994727e572079/workspace/backend/app/mods/workspace_mod.py#L742-L947)

这是一种“中心化 next-speaker 决策”，并非一般化任务编排引擎。其优点是聊天体验自然、能约束 Agent 互相唤醒；局限是路由决策依赖中央模型与最近少量消息，且 durable task、租约、重试、幂等结果、补偿等工作流语义并不由这一层提供。[路由器读取最近 5 条消息](https://github.com/openagents-org/openagents/blob/ffbd0c92ad87c5c262ba5524183994727e572079/workspace/backend/app/mods/workspace_mod.py#L765-L798)

### 2.3 节点、Agent 与会话是分离概念

一个 Node 表示运行 Launcher daemon 的设备，一台 Node 可承载多个或零个 Agent；Node 与 Agent 都有独立 heartbeat。设备用短时、单次 pairing code 换取 workspace token；Agent 每次 join 还会旋转 `session_id`，让同名 Agent 的旧 adapter 在后续 heartbeat/post 时被拒绝。[Node 数据模型](https://github.com/openagents-org/openagents/blob/ffbd0c92ad87c5c262ba5524183994727e572079/workspace/backend/app/models.py#L311-L365) [配对流程](https://github.com/openagents-org/openagents/blob/ffbd0c92ad87c5c262ba5524183994727e572079/workspace/backend/app/routers/nodes.py#L1-L12) [Agent session 旋转](https://github.com/openagents-org/openagents/blob/ffbd0c92ad87c5c262ba5524183994727e572079/workspace/backend/app/mods/workspace_mod.py#L51-L135)

这是非常适合目标系统的建模：`Person ≠ Device/Node ≠ AgentInstance ≠ RuntimeProcess ≠ ThreadSession`，不应把这些身份压成一个 `agent_id`。

## 3. 协议、消息、状态与存储

Workspace 的 Event 是通用信封，事件类型采用层次命名；`source` 使用 `human:` / `openagents:`，`target` 使用 `channel/` 等地址。模型还预留 `visibility`，请求-响应通过 `metadata.in_reply_to` 关联。[ONM Event 源码](https://github.com/openagents-org/openagents/blob/ffbd0c92ad87c5c262ba5524183994727e572079/workspace/backend/openagents/core/onm_events.py#L23-L80)

Mod pipeline 有 `guard / transform / observe` 三类，并固定按类别、再按 priority 排序。当前 Workspace 实际只装载 auth、workspace、persistence 三个 mod；persistence 把事件写入 `events`，而 workspace mod 同时维护 Agent presence、channel membership 和路由投影。[Pipeline 核心](https://github.com/openagents-org/openagents/blob/ffbd0c92ad87c5c262ba5524183994727e572079/workspace/backend/openagents/core/onm_pipeline.py#L1-L82) [PersistenceMod](https://github.com/openagents-org/openagents/blob/ffbd0c92ad87c5c262ba5524183994727e572079/workspace/backend/app/mods/persistence.py#L22-L76)

持久层是“事件日志 + 物化状态表”的混合，而非纯 event sourcing。`events` 保存所有通过 pipeline 的事件；`workspaces`、`workspace_members`、`channels`、成员关系、用户权限、Node、文件、知识、浏览器、Todo/Kanban/Timer/Routine 等是为查询和业务约束维护的关系表。[核心 ORM 模型](https://github.com/openagents-org/openagents/blob/ffbd0c92ad87c5c262ba5524183994727e572079/workspace/backend/app/models.py#L1-L45) [事件与协作投影](https://github.com/openagents-org/openagents/blob/ffbd0c92ad87c5c262ba5524183994727e572079/workspace/backend/app/models.py#L46-L207)

数据库通过 SQLAlchemy 支持 PostgreSQL，SQLite 主要用于本地/测试兼容；Redis 用于 poll read-through cache、head cursor 和 SSE pub/sub，文件元数据进入数据库、实际对象通过 storage 层保存。[数据库配置](https://github.com/openagents-org/openagents/blob/ffbd0c92ad87c5c262ba5524183994727e572079/workspace/backend/app/database.py#L1-L90) [事件缓存与发布](https://github.com/openagents-org/openagents/blob/ffbd0c92ad87c5c262ba5524183994727e572079/workspace/backend/app/routers/events.py#L27-L136) [文件模型](https://github.com/openagents-org/openagents/blob/ffbd0c92ad87c5c262ba5524183994727e572079/workspace/backend/app/models.py#L395-L428)

## 4. Runtime 与 Agent 扩展性

Launcher 的扩展边界清楚但目前是**源码级静态注册**：`BaseAdapter` 统一处理连接、cursor、heartbeat、控制事件、channel 队列和状态回传，子类只需实现 `_handleMessage`；但 runtime type 到 class 的映射硬编码在 `ADAPTER_MAP`，未知 type 直接报错。增加 runtime 需要新增 adapter 文件并修改核心 registry，而不是安装一个独立 provider/plugin。[BaseAdapter 契约](https://github.com/openagents-org/openagents/blob/ffbd0c92ad87c5c262ba5524183994727e572079/packages/agent-connector/src/adapters/base.js#L1-L17) [静态 Adapter Map](https://github.com/openagents-org/openagents/blob/ffbd0c92ad87c5c262ba5524183994727e572079/packages/agent-connector/src/adapters/index.js#L24-L53)

各 adapter 处理的差异包括：binary 探测与安装、认证环境变量、非交互命令行参数、JSON stream 解析、per-channel session resume、取消整个子进程树、工具/审批策略和 runtime 特有错误。这比试图规定一个“统一 Agent 类”更贴近现实，但缺少稳定的 adapter manifest、能力协商、版本化协议和 out-of-process 插件边界。[Codex adapter](https://github.com/openagents-org/openagents/blob/ffbd0c92ad87c5c262ba5524183994727e572079/packages/agent-connector/src/adapters/codex.js#L1-L20) [Launcher package manifest](https://github.com/openagents-org/openagents/blob/ffbd0c92ad87c5c262ba5524183994727e572079/packages/agent-connector/package.json)

旧 Python SDK 的 `AgentClient` 另有 transport auto-detection 和 agent-level mod adapters，但它实际上只构造 gRPC/HTTP connector，WebSocket 路径仍直接 `NotImplementedError`；因此“HTTP/gRPC/WebSocket/A2A/MCP 全部可互换”更多是框架方向而非当前统一生产能力。[旧 SDK transport 选择](https://github.com/openagents-org/openagents/blob/ffbd0c92ad87c5c262ba5524183994727e572079/sdk/src/openagents/sdk/client.py#L240-L314) 旧 SDK 的 decentralized topology 也把 mDNS/DHT peer discovery 留为 TODO。[Topology 源码](https://github.com/openagents-org/openagents/blob/ffbd0c92ad87c5c262ba5524183994727e572079/sdk/src/openagents/sdk/topology.py#L674-L766) [peer discovery TODO](https://github.com/openagents-org/openagents/blob/ffbd0c92ad87c5c262ba5524183994727e572079/sdk/src/openagents/sdk/topology.py#L966-L987)

## 5. 代码组织与部署拓扑

### 5.1 代码组织

```text
openagents/
├── workspace/
│   ├── backend/                 # FastAPI + SQLAlchemy + ONM pipeline
│   │   ├── openagents/core/     # 新 ONM Event / Mod / Pipeline 最小核心
│   │   └── app/
│   │       ├── mods/            # auth / workspace / persistence
│   │       ├── routers/         # events/files/nodes/tasks/browser/...
│   │       ├── services/        # cloud agent、push 等
│   │       └── models.py        # event log + 业务投影
│   └── frontend/                # Next.js Workspace Web UI
├── packages/
│   ├── agent-connector/         # agn CLI、daemon、runtime adapters、HTTP client
│   ├── launcher/                # Electron 管理界面
│   └── go/                      # Swift/iOS/macOS 客户端与另一个 Web 客户端
├── sdk/
│   ├── src/openagents/          # 旧 Python Network SDK、transport、mods、agents
│   └── studio/                  # 旧 Studio React 前端
├── docs/                        # ONM 与产品文档
└── tests/
```

这种 monorepo 便于端到端演进，但同一仓库中同时存在旧/新 event model、`core/` 与 `sdk/` 兼容 shim、旧 Studio 与新 Workspace、多套 Web 客户端，概念重复明显。新项目不应从一开始复制这种历史层叠；应先固定一份协议 schema 和一个服务端核心，再让 SDK/Launcher/客户端依赖生成的契约。

### 5.2 部署形态

从依赖与源码可还原当前主拓扑：Next.js 前端连接 FastAPI Workspace API；FastAPI 连接 PostgreSQL、Redis、对象存储，并可接 BrowserFabric/Playwright、推送与云 Agent provider；每个用户设备运行 Node daemon，daemon 再管理若干 runtime adapter/CLI 子进程。Workspace 后端依赖表明确包含 FastAPI、SQLAlchemy、PostgreSQL driver、Redis、boto3、Playwright 和 LLM SDK；前端是 Next.js/React。[后端依赖](https://github.com/openagents-org/openagents/blob/ffbd0c92ad87c5c262ba5524183994727e572079/workspace/backend/requirements.txt) [前端依赖](https://github.com/openagents-org/openagents/blob/ffbd0c92ad87c5c262ba5524183994727e572079/workspace/frontend/package.json)

仓库根 `Dockerfile/docker-compose.yml` 部署的是较旧的 Python Network + Studio（HTTP 8700、gRPC 8600），不是上面的新 Workspace 全栈；因此自托管文档与 hosted Workspace 的实际组件也需要分别看待。[Docker Compose](https://github.com/openagents-org/openagents/blob/ffbd0c92ad87c5c262ba5524183994727e572079/docker-compose.yml) [Dockerfile](https://github.com/openagents-org/openagents/blob/ffbd0c92ad87c5c262ba5524183994727e572079/Dockerfile)

## 6. 身份、安全与权限

### 已实现的机制

- 人类身份由经过验证的 Firebase/Google 或 Apple bearer 映射到 `User`；`WorkspaceMembership` 有 `owner/admin/member/viewer` 层级，事件写路径要求身份调用者至少是 `member`。[用户/成员模型](https://github.com/openagents-org/openagents/blob/ffbd0c92ad87c5c262ba5524183994727e572079/workspace/backend/app/models.py#L252-L307) [AuthMod](https://github.com/openagents-org/openagents/blob/ffbd0c92ad87c5c262ba5524183994727e572079/workspace/backend/app/mods/auth.py#L31-L65)
- Node pairing code 短期、单次使用；Agent join 时旋转 session id，能排除同名 Agent 的旧连接。这解决重复 daemon/ghost adapter 的操作一致性，但 session id 仍依赖共享 workspace token 建立初始信任。[Node redeem](https://github.com/openagents-org/openagents/blob/ffbd0c92ad87c5c262ba5524183994727e572079/workspace/backend/app/routers/nodes.py#L112-L167) [session 检查](https://github.com/openagents-org/openagents/blob/ffbd0c92ad87c5c262ba5524183994727e572079/workspace/backend/app/mods/workspace_mod.py#L138-L165)
- 旧 SDK 会为注册 Agent 生成 64 字符随机 secret，并用 constant-time compare 验证后续事件；但 secret 仅保存在进程内存。[SecretManager](https://github.com/openagents-org/openagents/blob/ffbd0c92ad87c5c262ba5524183994727e572079/sdk/src/openagents/sdk/secret_manager.py#L15-L70)

### 对目标系统不可接受的缺口

1. **workspace token 是共享的全能机器凭据。** 服务端明确把正确 token 当作 owner-equivalent，绕过身份 role check；Node redeem 返回的也是同一个 `workspace.password_hash`。这意味着任一 Agent、任一 Node 或泄露 token 的日志/prompt 都获得整个空间的权限，无法做最小授权、单 Agent 吊销和审计归因。[访问规则](https://github.com/openagents-org/openagents/blob/ffbd0c92ad87c5c262ba5524183994727e572079/workspace/backend/app/access.py#L247-L280) [Node 返回共享 token](https://github.com/openagents-org/openagents/blob/ffbd0c92ad87c5c262ba5524183994727e572079/workspace/backend/app/routers/nodes.py#L157-L166)
2. **凭据直接进入不可信模型上下文。** 非 MCP adapter 生成的 workspace prompt 内含明文 `X-Workspace-Token` 和可执行 curl 示例，模型输出、prompt injection 或被调用的 shell 都可能外泄它。[prompt 源码](https://github.com/openagents-org/openagents/blob/ffbd0c92ad87c5c262ba5524183994727e572079/packages/agent-connector/src/adapters/workspace-prompt.js#L210-L245)
3. **本地执行默认权限过高。** Codex adapter 使用 `--dangerously-bypass-approvals-and-sandbox`，并在用户工作目录运行；远端共享空间中的一条恶意消息可转化为本机高权限 Agent 输入。[Codex 命令](https://github.com/openagents-org/openagents/blob/ffbd0c92ad87c5c262ba5524183994727e572079/packages/agent-connector/src/adapters/codex.js#L283-L313)
4. **visibility 目前不是强制读取边界。** EventRecord 保存 visibility，但通用 `GET /v1/events` 在通过 workspace 级认证后，仅在调用者主动传 `member`、`conversation` 等过滤参数时限制范围；默认查询可返回 workspace 全事件。也就是说 channel/direct 的机密性不能只依赖当前 `visibility` 字段。[poll 查询构造](https://github.com/openagents-org/openagents/blob/ffbd0c92ad87c5c262ba5524183994727e572079/workspace/backend/app/routers/events.py#L270-L455)
5. **旧 SDK 身份与重连也不足以作为安全基线。** `AgentIdentityManager.validate_agent()` 当前无条件返回 `True`，HTTP 注册又总是提交 `force_reconnect=True`；这套逻辑更像开发便利设施，不是所有者绑定的设备/Agent 身份系统。[identity 验证](https://github.com/openagents-org/openagents/blob/ffbd0c92ad87c5c262ba5524183994727e572079/sdk/src/openagents/sdk/agent_identity.py#L86-L94) [HTTP 注册](https://github.com/openagents-org/openagents/blob/ffbd0c92ad87c5c262ba5524183994727e572079/sdk/src/openagents/sdk/transports/http.py#L701-L732) [重连处理](https://github.com/openagents-org/openagents/blob/ffbd0c92ad87c5c262ba5524183994727e572079/sdk/src/openagents/sdk/network.py#L505-L525)

## 7. 对“多人 + 各自本地 Agent + 多 runtime”的适配度

| 维度 | 评价 | 依据 |
|---|---|---|
| 人与 Agent 共处一个空间 | 强 | 统一事件流、human/agent 地址、线程、成员、文件/知识/浏览器投影均已形成产品闭环。 |
| 本地执行、中央协作 | 强 | daemon/adapter 留在用户机器，服务端只分发任务与共享状态。 |
| 多 runtime | 中强 | 已覆盖多种 CLI，BaseAdapter 抽取了高价值公共逻辑；但插件是静态映射。 |
| 离线/断连恢复 | 中弱 | heartbeat、cursor、session rotation 完整；启动跳过历史且无 durable claim/ack。 |
| 大规模实时性 | 中 | Redis/SSE 和服务端 target filter 降低读放大；Agent 主路径仍是 2–15 秒轮询。 |
| 多租户权限与秘密隔离 | 弱 | workspace 共享全权 token，visibility/频道读取边界不足，凭据进入模型 prompt。 |
| 跨网络/去中心化 | 弱到实验性 | ONM 文档定义完整，但旧 SDK 的 WebSocket 与 decentralized discovery 尚未完成。 |
| 架构一致性 | 中弱 | 新 Workspace ONM 与旧 SDK Event/transport 并存，部署与文档也有两条路径。 |

## 8. 可借鉴 / 不应照搬

### 可借鉴

1. **控制面与执行面分离。** 中心只承载身份、共享状态、事件路由、策略与观察；代码执行和模型凭据留在个人 Node。这个边界正好满足隐私、本地资源利用和 runtime 多样性。
2. **Node、Agent、Runtime、ThreadSession 分层建模。** 一台机器可运行多个 Agent；同一 Agent 在不同 thread 有独立 runtime session；heartbeat 与 session fencing 分开。
3. **统一、版本化 Event envelope。** `type/source/target/payload/metadata/id/timestamp` 足够表达消息、状态、任务与资源操作；领域 schema 应放在 type registry 中，而不是不断增加顶层 message 类。
4. **Guard → Transform → Observe pipeline。** 鉴权/限流先于路由，持久化与审计最后观察；这是很好的深模块 seam。但应让 transform 不能拒绝，源码中的 `WorkspaceMod` 实际会抛 `EventRejected`，需要在自己的类型系统中严格约束。
5. **Runtime adapter 只负责翻译。** 公共 supervisor 统一 cursor、心跳、并发、取消、状态；adapter 只处理 runtime install/auth/invoke/stream/session/stop。能力差异显式协商，不把所有 runtime 强行压成最低公共功能。
6. **事件日志 + 物化投影。** event log 用于历史、同步和审计；关系投影用于成员、线程、任务、presence 等高效查询。不要纯 event sourcing，也不要让聊天表成为系统唯一事实。
7. **按 thread 串行、跨 thread 并行。** 这是本地 Agent 并发的合理默认，能保护 session 上下文，同时让一个 Agent 在多个共享任务中并行工作。
8. **确定性路由优先，LLM 路由可选。** `@mention`、owner/master、显式 workflow 应是可解释规则；只在语义歧义时调用小模型，且必须有预算、循环上限与 fallback。

### 不应照搬

1. **不要发放 workspace-wide bearer token。** 用短期 device credential 换取每个 AgentInstance 的独立 key/token；权限绑定 `principal + workspace + capability + resource scope`，可单独吊销和轮换。
2. **不要让模型看到凭据。** Node 提供本地 broker/tool proxy，Agent 只调用有 schema 的本地工具；broker 注入认证并执行策略。绝不把 token、签名 key 或 raw curl auth 放进 prompt。
3. **不要默认关闭 runtime sandbox/approval。** 远端输入必须经过本地 owner policy：工作目录、工具 allowlist、网络/secret scope、预算和人类审批点都由 Node enforcement 决定，中心不能提升本地权限。
4. **不要把 `visibility` 当装饰字段。** 每次写入和读取都做强制 authorization；channel membership、direct participants、resource ACL 必须进入 SQL predicate/row-level policy，而不是依赖客户端过滤。
5. **不要把 chat delivery 等同于 task execution。** 对需要保证的工作引入 durable `WorkItem/Attempt/Lease`：claim、ack、heartbeat、timeout、retry、cancel、result 和 idempotency key 都是服务端状态机。
6. **不要同时维护两套事件模型。** 从第一天定义单一 wire schema、版本策略、兼容测试与 conformance suite；所有语言 SDK 从 schema 生成或至少共享 golden fixtures。
7. **不要把 runtime adapter 编进中央 registry。** adapter 应是 out-of-process provider/plugin，通过稳定的 local RPC（例如 JSON-RPC over stdio/Unix socket）注册 manifest 与 capabilities；主 daemon 不因新增 runtime 而发布新版本。
8. **不要先做 P2P/federation。** OpenAgents 的 decentralized 代码仍暴露出复杂度。第一阶段把 Network 定义为中心化有界上下文，只有明确的跨空间桥接 Agent；在权限、投递与审计成熟后再引入 federation。

## 9. 对自研代码组织的直接启示

如果以 OpenAgents 的经验为参照，新框架应按稳定边界而不是 UI 功能堆目录：

```text
apps/
  control-plane/       # identity, workspace, policy, event/work APIs
  web/                 # human collaboration client
  node/                # local supervisor; owns local authority
packages/
  protocol/            # canonical schemas, versioning, generated clients
  policy/              # shared decision model; server/node evaluators
  runtime-provider-sdk/# out-of-process adapter contract + conformance kit
  projections/         # event -> workspace/thread/task/presence projections
providers/
  codex/
  claude-code/
  openclaw/
services/
  event-store/
  object-store/
  realtime-gateway/
tests/
  conformance/
  e2e/
```

最小可工作纵切应只有：一个 workspace、一个人、两台 Node、每台一个 runtime provider、一个 thread、durable event/work delivery、独立 Agent credential 与一个共享 artifact。先证明断连恢复、单 Agent 吊销和跨 runtime 协作，再增加 LLM router、任务看板、共享浏览器或 federation。

