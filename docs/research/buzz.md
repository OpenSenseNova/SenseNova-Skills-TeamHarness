# Buzz 原理、架构与代码组织调研

> 调研对象：[`block/buzz`](https://github.com/block/buzz)  
> 调研基线：commit [`be48ce98bd163899197b79a82ad5b2bcf0bc9b54`](https://github.com/block/buzz/commit/be48ce98bd163899197b79a82ad5b2bcf0bc9b54)，提交时间 2026-08-11 03:27:30 UTC  
> 调研日期：2026-08-11（Asia/Shanghai）  
> 资料范围：该提交的 README、架构/愿景文档、Cargo 清单、部署文件及实际 Rust/TypeScript 源码。以下“已实现”判断以源码优先；愿景文档只用于解释设计意图。

## 结论摘要

Buzz 是这组参考项目中与“多人及其本地 Agent 在同一共享空间协作”最直接同构的一类系统：中心是自托管 relay；人、Agent、工作流和 Git 操作都以带签名的事件进入同一个社区事件空间；Agent 的计算则留在用户机器上，由 `buzz-acp` 启动本地 Agent 子进程并通过 ACP/stdio 驱动，再通过 Buzz CLI/MCP 操作共享空间。Buzz 自己把它描述为“人和 Agent 共用房间”，并明确让 Agent 拥有独立密钥、频道成员关系和审计轨迹，而不是把 Agent 当成某个人的隐形后台任务。[README：产品定位与身份模型](https://github.com/block/buzz/blob/be48ce98bd163899197b79a82ad5b2bcf0bc9b54/README.md#L27-L51)

最值得借鉴的核心不是 Nostr 本身，而是三个分离：

1. **共享协作状态与执行环境分离**：relay 保存团队可见的事实；本地 Agent 进程只是可替换的执行体。
2. **协作协议与 Agent runtime 分离**：共享空间说 Nostr/HTTP，Agent harness 对 runtime 说 ACP，runtime 对工具说 MCP/CLI。
3. **人和 Agent 的授权模型统一**：两者都是签名主体，访问同一频道 ACL，事件按主体可追责。

但不应照搬它的“所有东西都是 Nostr event”、庞大的 kind 注册表、内存 Agent 队列和“先提交事件、再尽力完成副作用”的一致性模型。对一个从零构建的框架，这些会过早带来协议膨胀、恢复语义不清和运维复杂度。

## 1. 系统边界与执行模型

### 1.1 共享空间

一个 Buzz `community` 是由访问 URL/Host 选择的工作空间。Host 在任何 AUTH、EVENT、REQ、REST、媒体、Git、搜索、工作流或 pub/sub 处理之前解析成服务端 `TenantContext`；未知 Host 默认拒绝，不接受客户端标签覆盖租户归属。[架构说明：community 与 row-zero 绑定](https://github.com/block/buzz/blob/be48ce98bd163899197b79a82ad5b2bcf0bc9b54/ARCHITECTURE.md#L3-L17) [实际 `bind_community`：规范化、查表、无默认租户](https://github.com/block/buzz/blob/be48ce98bd163899197b79a82ad5b2bcf0bc9b54/crates/buzz-relay/src/tenant.rs#L61-L89)

relay 是单一事实来源：客户端不互相同步，没有 P2P、gossip 或客户端侧多主复制；它验证身份和签名、持久化事件、向订阅者 fan-out、执行搜索和自动化。[ARCHITECTURE：relay single source of truth](https://github.com/block/buzz/blob/be48ce98bd163899197b79a82ad5b2bcf0bc9b54/ARCHITECTURE.md#L3-L15)

### 1.2 本地 Agent 执行路径

典型链路如下：

```text
Human/Desktop ──WS/REST──┐
                        ├── Buzz Relay ── Postgres / Redis / S3
Local Agent Runtime      │
  Goose/Codex/Claude/... │
          ▲ ACP/stdio    │
       buzz-acp ──WS─────┘
          │
          └── Buzz CLI / MCP tools ── REST/NIP-98 ── Relay
```

`buzz-acp` 不是模型/runtime，而是边缘 harness。它启动 1–32 个本地 Agent 子进程，先执行 ACP `initialize`，为频道创建/复用 session，再把频道事件批量转成 `session/prompt`；Agent 通过 Buzz CLI 读取或写回共享空间。一个频道同一时刻最多一个 prompt，多个频道可由 worker pool 并行处理；同一 harness 的 N 个 worker **共享同一 Nostr 身份**，不是 N 个独立 Agent 身份。[buzz-acp README：工作流程](https://github.com/block/buzz/blob/be48ce98bd163899197b79a82ad5b2bcf0bc9b54/crates/buzz-acp/README.md#L251-L260) [worker pool 的共享身份语义](https://github.com/block/buzz/blob/be48ce98bd163899197b79a82ad5b2bcf0bc9b54/crates/buzz-acp/README.md#L204-L221)

进程边界是真实的 OS 子进程边界：harness 用命令和参数启动 runtime，接管 stdin/stdout，以 NDJSON JSON-RPC 通信；Unix 下创建独立进程组，Drop/关闭时尝试杀整个进程组，避免 Agent 派生的 MCP/工具进程遗留。[`AcpClient::spawn`](https://github.com/block/buzz/blob/be48ce98bd163899197b79a82ad5b2bcf0bc9b54/crates/buzz-acp/src/acp.rs#L443-L553) [`Drop` 与进程组清理](https://github.com/block/buzz/blob/be48ce98bd163899197b79a82ad5b2bcf0bc9b54/crates/buzz-acp/src/acp.rs#L2213-L2247)

runtime 适配面是 ACP：`session/new` 携带绝对工作目录和 MCP server 描述，`session/prompt` 有静默超时与硬性总时长上限；普通 RPC、stdin 写入也有边界超时。[ACP session 创建](https://github.com/block/buzz/blob/be48ce98bd163899197b79a82ad5b2bcf0bc9b54/crates/buzz-acp/src/acp.rs#L619-L689) [turn timeout](https://github.com/block/buzz/blob/be48ce98bd163899197b79a82ad5b2bcf0bc9b54/crates/buzz-acp/src/acp.rs#L738-L818) [RPC/write timeout](https://github.com/block/buzz/blob/be48ce98bd163899197b79a82ad5b2bcf0bc9b54/crates/buzz-acp/src/acp.rs#L1054-L1115)

### 1.3 事件到 Agent 的调度

每个频道有独立队列与 in-flight 标记，公平性按各频道最早待处理事件决定；单批最多 50 个事件，单频道最多积压 500 个，失败指数退避并在 10 次后 dead-letter。`Drop` 模式下，一个频道已有 turn 在执行时，新事件会直接丢弃；`Queue` 模式才会继续累积。[EventQueue 状态机与上限](https://github.com/block/buzz/blob/be48ce98bd163899197b79a82ad5b2bcf0bc9b54/crates/buzz-acp/src/queue.rs#L1-L42) [状态转移](https://github.com/block/buzz/blob/be48ce98bd163899197b79a82ad5b2bcf0bc9b54/crates/buzz-acp/src/queue.rs#L92-L170)

断线重连使用每频道 `since` 水位并减去时间偏移来补抓断线窗口；首次订阅默认 `since=now`，不会回放全部历史。[`send_subscribe` 的 since 规则](https://github.com/block/buzz/blob/be48ce98bd163899197b79a82ad5b2bcf0bc9b54/crates/buzz-acp/src/relay.rs#L3170-L3211) 队列、水位和 dedup 集合都是进程内集合；从源码结构可推断，进程崩溃时没有 durable inbox/checkpoint，因此它提供的是“连接内恢复 + 有界重放”，不是持久化至少一次任务队列。

## 2. 协议、状态和存储

### 2.1 协作协议

Buzz 的共享协议是 Nostr NIP-01。事件包含 `id/pubkey/kind/tags/content/sig`；`id` 来自规范化序列化的 SHA-256，`sig` 是 Schnorr 签名，`kind` 是主分派键。客户端通过 WebSocket 的 `EVENT/REQ/CLOSE/AUTH` 写入、订阅、取消和认证，relay 回 `EVENT/EOSE/OK/CLOSED/NOTICE/AUTH`。[事件形状与 wire message](https://github.com/block/buzz/blob/be48ce98bd163899197b79a82ad5b2bcf0bc9b54/ARCHITECTURE.md#L101-L161)

业务能力通过 kind 扩展：标准消息/反应、频道消息、Agent profile/engram、任务、论坛、workflow、Git、presence 等都进入同一注册表。`buzz-core/src/kind.rs` 是号码的权威来源，并利用 Nostr 的 ephemeral、replaceable、parameterized-replaceable 范围决定持久化/替换语义。[kind 注册表定义](https://github.com/block/buzz/blob/be48ce98bd163899197b79a82ad5b2bcf0bc9b54/crates/buzz-core/src/kind.rs#L1-L83) [Agent Engram 定义](https://github.com/block/buzz/blob/be48ce98bd163899197b79a82ad5b2bcf0bc9b54/crates/buzz-core/src/kind.rs#L85-L102) [range 判断函数](https://github.com/block/buzz/blob/be48ce98bd163899197b79a82ad5b2bcf0bc9b54/crates/buzz-core/src/kind.rs#L769-L790)

### 2.2 写入与读取路径

持久事件的共同 ingest 路径同时服务 WebSocket 和 HTTP。它先拒绝 AUTH/relay-only kind，再验证签名、事件 ID、时间漂移、内容大小、签名主体与认证主体、每 kind scope，随后解析频道并检查 token 范围及频道成员资格，最后写数据库。[共享 ingest 入口和基础验证](https://github.com/block/buzz/blob/be48ce98bd163899197b79a82ad5b2bcf0bc9b54/crates/buzz-relay/src/handlers/ingest.rs#L1850-L2029) [频道归属和 membership gate](https://github.com/block/buzz/blob/be48ce98bd163899197b79a82ad5b2bcf0bc9b54/crates/buzz-relay/src/handlers/ingest.rs#L2204-L2303)

普通事件使用 `ON CONFLICT DO NOTHING` 去重；replaceable/parameterized replaceable 事件走原子替换路径。数据库提交后，relay 发布 Redis topic、做本机 fan-out、进入审计队列并异步触发 workflow；Postgres 的 generated `tsvector` 让事件插入同时完成全文索引，不存在独立搜索索引队列。[事件写入与去重](https://github.com/block/buzz/blob/be48ce98bd163899197b79a82ad5b2bcf0bc9b54/crates/buzz-db/src/event.rs#L265-L318) [post-commit dispatch](https://github.com/block/buzz/blob/be48ce98bd163899197b79a82ad5b2bcf0bc9b54/crates/buzz-relay/src/handlers/event.rs#L395-L557) [FTS 与访问边界](https://github.com/block/buzz/blob/be48ce98bd163899197b79a82ad5b2bcf0bc9b54/crates/buzz-search/src/lib.rs#L3-L22)

REQ 在注册实时订阅前先解析调用者可访问频道并确认指定频道 membership；历史查询和搜索都带 `community_id`，搜索结果还要回表并逐条重新授权。这样避免了先注册、后鉴权的短暂泄露窗口。[REQ 的认证、频道范围和先鉴权后注册](https://github.com/block/buzz/blob/be48ce98bd163899197b79a82ad5b2bcf0bc9b54/crates/buzz-relay/src/handlers/req.rs#L42-L170) [搜索不是访问控制边界](https://github.com/block/buzz/blob/be48ce98bd163899197b79a82ad5b2bcf0bc9b54/crates/buzz-search/src/lib.rs#L12-L22)

### 2.3 持久与短暂状态

| 状态 | 存储/位置 | 语义 |
|---|---|---|
| 事件、频道、成员、workflow/run、审计、Git 元数据 | Postgres | durable shared truth；所有查询显式带 `community_id` |
| 全文搜索 | Postgres generated `search_tsv` + GIN | 与事件行同事务更新，没有异步一致性窗口 |
| 跨 relay 实例 fan-out、presence、typing、限流/失效通知 | Redis | topic 按 community/channel 分区；presence 是 TTL lease |
| 媒体 | S3/MinIO（Blossom API） | 大对象与事件元数据分离 |
| ACP session history、频道 inbox、in-flight/retry | 本地 Agent/harness 内存 | 执行体状态；进程消失即丢失 |
| Agent durable memory | relay 上的 Agent Engram 事件 | 与本地 scratch/session 区分 |

Postgres/Redis/S3 的官方部署图和 crate 职责见 [README 架构图与 crate map](https://github.com/block/buzz/blob/be48ce98bd163899197b79a82ad5b2bcf0bc9b54/README.md#L194-L236)；Redis 使用专用订阅连接、动态订阅 `buzz:{community}:channel:{id}` / `global`，并以本地 broadcast channel 分发给 WS 连接。[PubSubManager 架构](https://github.com/block/buzz/blob/be48ce98bd163899197b79a82ad5b2bcf0bc9b54/crates/buzz-pubsub/src/lib.rs#L3-L22) [动态 topic 引用计数](https://github.com/block/buzz/blob/be48ce98bd163899197b79a82ad5b2bcf0bc9b54/crates/buzz-pubsub/src/lib.rs#L183-L245)

审计不是简单日志表，而是每 community 独立的 SHA-256 hash chain；写入用按 community 派生的 Postgres advisory lock 串行化，`verify_chain` 重算 hash 并检查 `prev_hash`。[审计链设计](https://github.com/block/buzz/blob/be48ce98bd163899197b79a82ad5b2bcf0bc9b54/crates/buzz-audit/src/lib.rs#L3-L18) [append/verify 实现](https://github.com/block/buzz/blob/be48ce98bd163899197b79a82ad5b2bcf0bc9b54/crates/buzz-audit/src/service.rs#L25-L80) [链验证](https://github.com/block/buzz/blob/be48ce98bd163899197b79a82ad5b2bcf0bc9b54/crates/buzz-audit/src/service.rs#L154-L205)

## 3. Runtime 扩展机制

Buzz 的“适应不同 runtime”是**协议适配**而不是把各 runtime 逻辑编入 relay：任何实现 ACP `initialize`、`session/new`、`session/prompt` 和 `stopReason` 的程序，都可作为本地 harness；Goose、Claude、Codex 等只是在此协议层的内置或适配器。[ACP 最小兼容面](https://github.com/block/buzz/blob/be48ce98bd163899197b79a82ad5b2bcf0bc9b54/crates/buzz-acp/README.md#L323-L332)

Desktop 把 runtime 分成三层：编译内置 runtime、静态 preset catalog、用户 JSON 自定义 harness。自定义定义只描述 `id/label/command/args/env`，从 PATH 或绝对路径启动，不需要改 relay，也不允许定义安装脚本；Buzz 保留的身份环境变量会在合并时剥离。[BYOH 三层和 JSON schema](https://github.com/block/buzz/blob/be48ce98bd163899197b79a82ad5b2bcf0bc9b54/crates/buzz-acp/README.md#L264-L302) [自定义 harness 的安全约束](https://github.com/block/buzz/blob/be48ce98bd163899197b79a82ad5b2bcf0bc9b54/crates/buzz-acp/README.md#L304-L321)

`buzz-agent` 又把 Agent 与工具拆开：ACP client ↔ `buzz-agent` ↔ MCP server；每个 session 有独立 MCP server、history 和 context，tool timeout 会杀掉对应 MCP server 进程，随后可惰性重启。这个方向实现了“runtime 可替换、tool provider 可替换、共享空间不关心模型供应商”。[Agent/MCP 分层](https://github.com/block/buzz/blob/be48ce98bd163899197b79a82ad5b2bcf0bc9b54/VISION_AGENT.md#L9-L51) [协议化而非 import 耦合](https://github.com/block/buzz/blob/be48ce98bd163899197b79a82ad5b2bcf0bc9b54/VISION_AGENT.md#L53-L69)

边界也很明确：不说 ACP 的 runtime 仍需一个 adapter；Gateway 型 runtime 的真正执行位置可能不在 Desktop 进程，所以 Desktop 注入的 `BUZZ_*` 环境变量未必能到达工具执行处。[OpenClaw/Gateway 执行位置说明](https://github.com/block/buzz/blob/be48ce98bd163899197b79a82ad5b2bcf0bc9b54/crates/buzz-acp/README.md#L270-L276) 因此 ACP 是一个可用的本地 runtime SPI，但不是“任何 runtime 自动兼容”的魔法层。

## 4. 权限与安全模型

1. **身份与不可抵赖性**：每个独立 Agent 应有独立 Nostr keypair，公钥注册为 relay member；消息由 Agent 自己签名。一个 harness 的 worker pool 共用一个 key，因此“Agent 身份”应部署为 harness 实例级，而非 worker 级。[Agent 密钥注册与一 Agent 一 key](https://github.com/block/buzz/blob/be48ce98bd163899197b79a82ad5b2bcf0bc9b54/crates/buzz-acp/README.md#L26-L45)

2. **传输认证**：WS 使用 NIP-42 challenge-response，HTTP 使用 NIP-98 签名；AUTH event 永不存储。当前纯 Nostr 路径认证成功后直接获得全部已知 scope，细粒度隔离主要依赖 relay/community 成员与频道 membership，而不是 OAuth scope。[AuthService 的实际行为](https://github.com/block/buzz/blob/be48ce98bd163899197b79a82ad5b2bcf0bc9b54/crates/buzz-auth/src/lib.rs#L3-L16) [NIP-42 获得 full scopes](https://github.com/block/buzz/blob/be48ce98bd163899197b79a82ad5b2bcf0bc9b54/crates/buzz-auth/src/lib.rs#L115-L142)

3. **频道 ACL**：频道有 open/private；角色为 Owner、Admin、Member、Guest、Bot，其中 Bot 不参与线性权限层级，要用显式授权。写入和订阅都在 relay 再查 membership，不能只信客户端事件标签。[频道 visibility 与 role](https://github.com/block/buzz/blob/be48ce98bd163899197b79a82ad5b2bcf0bc9b54/crates/buzz-core/src/channel.rs#L20-L68) [角色层级](https://github.com/block/buzz/blob/be48ce98bd163899197b79a82ad5b2bcf0bc9b54/crates/buzz-core/src/channel.rs#L102-L158)

4. **Agent 入站控制**：harness 默认 `owner-only`，还支持 allowlist/anyone/nobody；所有 mention、DM、thread reply 都先过 author gate，owner 可用签名频道消息执行 `!cancel/!rotate/!shutdown` 等控制命令。[Inbound Author Gate](https://github.com/block/buzz/blob/be48ce98bd163899197b79a82ad5b2bcf0bc9b54/crates/buzz-acp/README.md#L132-L162)

5. **自动化权限**：workflow 在每次运行前重新检查 owner 当前仍为频道成员；包含 `call_webhook` 的定义要求 owner/admin，查询错误 fail closed。[Workflow owner authority gate](https://github.com/block/buzz/blob/be48ce98bd163899197b79a82ad5b2bcf0bc9b54/crates/buzz-workflow/src/lib.rs#L135-L170)

6. **本机风险**：`BUZZ_PRIVATE_KEY` 作为环境变量交给 harness；Buzz 的 shell/MCP 按操作者权限运行，并不提供 OS 沙箱。愿景文档明确写着“shell runs at the operator's trust level”。所以事件签名能回答“谁做了”，不能限制本地 runtime 能读哪些文件或调用哪些凭据。[私钥环境变量](https://github.com/block/buzz/blob/be48ce98bd163899197b79a82ad5b2bcf0bc9b54/crates/buzz-acp/README.md#L101-L118) [本地工具信任边界](https://github.com/block/buzz/blob/be48ce98bd163899197b79a82ad5b2bcf0bc9b54/VISION_AGENT.md#L53-L61)

7. **远程执行的诚实成本**：Kubernetes/provider 方向把执行体视为一次性“body”，但必须把 Agent key 交给 provider/cluster；官方文档承认 Kubernetes Secret 读取者可取得身份，并且 Desktop 不保留紧急 substrate control channel。[远程 provider 合约](https://github.com/block/buzz/blob/be48ce98bd163899197b79a82ad5b2bcf0bc9b54/VISION_REMOTE_AGENTS.md#L19-L35) [密钥、kill switch、临时工作区的限制](https://github.com/block/buzz/blob/be48ce98bd163899197b79a82ad5b2bcf0bc9b54/VISION_REMOTE_AGENTS.md#L47-L61)

## 5. 代码组织

项目是 Rust monorepo，根 workspace 当前列出 29 个成员（28 个 crate 加 1 个示例）；Desktop Tauri crate 被单独排除。公共依赖在根 `Cargo.toml` 集中锁定，`buzz-core` 明确禁止 tokio/sqlx/redis/axum，维持零 I/O domain/protocol core。[workspace 成员](https://github.com/block/buzz/blob/be48ce98bd163899197b79a82ad5b2bcf0bc9b54/Cargo.toml#L1-L40) [共享依赖与内部 crate](https://github.com/block/buzz/blob/be48ce98bd163899197b79a82ad5b2bcf0bc9b54/Cargo.toml#L43-L145) [buzz-core 零 I/O 约束](https://github.com/block/buzz/blob/be48ce98bd163899197b79a82ad5b2bcf0bc9b54/crates/buzz-core/Cargo.toml#L13-L30)

| 层 | 主要目录/crate | 职责与接口 |
|---|---|---|
| Protocol/domain core | `buzz-core` | event wrapper、filter、kind、频道角色、tenant、签名验证；无 I/O |
| Application/orchestrator | `buzz-relay` | Axum WS/REST；唯一跨 DB/auth/pubsub/search/audit/workflow 编排层 |
| Infrastructure services | `buzz-db`, `buzz-auth`, `buzz-pubsub`, `buzz-search`, `buzz-audit`, `buzz-media` | Postgres、认证、Redis、FTS、审计、S3；服务之间不横向互调 |
| Automation | `buzz-workflow` | YAML schema、trigger、sequential executor、ActionSink |
| Agent edge | `buzz-acp`, `buzz-agent`, `buzz-dev-mcp`, `buzz-persona` | relay→runtime bridge、ACP agent、MCP tools、persona pack |
| Client API | `buzz-sdk`, `buzz-ws-client`, `buzz-cli` | typed event builder、WS client、JSON CLI/REST client |
| Collaboration extensions | Git/voice/pair/mesh/Kubernetes crates | Git 签名/凭证、语音、设备配对、relay mesh、远程 body provider |
| Product clients | `desktop/`, `web/`, `mobile/`, `admin-web/` | Tauri/React、Web、Flutter、管理 UI |

这种代码组织的好处是边界清楚：`buzz-relay` 依赖所有服务并负责跨服务协调，其他服务 crate 彼此隔离；`buzz-core` 让客户端与服务端共享同一协议类型而不引入运行时。[架构中的 crate dependency 原则](https://github.com/block/buzz/blob/be48ce98bd163899197b79a82ad5b2bcf0bc9b54/ARCHITECTURE.md#L75-L98) 代价是功能面扩张后 crate 数量和协议 kind 数量都很大，新参与者需要同时理解 Nostr、relay、REST bridge、ACP、MCP 与多个持久化模型。

生产单节点/VPS bundle 使用 relay + Postgres + Redis + MinIO + Git volume，可选 Caddy/TLS；根 `docker-compose.yml` 只是开发环境。多 relay 实例共享 Postgres/Redis/S3 时，Redis 负责跨实例事件 fan-out。[生产 Compose 说明](https://github.com/block/buzz/blob/be48ce98bd163899197b79a82ad5b2bcf0bc9b54/deploy/compose/README.md#L1-L45) [跨实例 pub/sub 路径](https://github.com/block/buzz/blob/be48ce98bd163899197b79a82ad5b2bcf0bc9b54/crates/buzz-pubsub/src/lib.rs#L99-L185)

## 6. 设计优势

- **身份、协作记录和执行体真正解耦**：Agent 本地进程可重启/替换，团队事实仍在 relay；共享空间不绑定某个模型厂商或桌面生命周期。[Agent durable identity 与 disposable body](https://github.com/block/buzz/blob/be48ce98bd163899197b79a82ad5b2bcf0bc9b54/VISION_REMOTE_AGENTS.md#L11-L25)
- **人与 Agent 使用同一事实模型**：同样的 event、频道和审计链减少 bot webhook、聊天消息、工作流记录之间的胶水与身份错位。[统一 identity/event log](https://github.com/block/buzz/blob/be48ce98bd163899197b79a82ad5b2bcf0bc9b54/README.md#L78-L84)
- **协议边界明确**：共享空间、runtime、tools 三层分别可演进；对接新 runtime 通常只需要 ACP adapter，不改 relay。[ACP/MCP 无 runtime coupling](https://github.com/block/buzz/blob/be48ce98bd163899197b79a82ad5b2bcf0bc9b54/VISION_AGENT.md#L28-L51)
- **多租户和私有频道采用服务端来源的 scope**：Host→TenantContext、community_id 查询条件和 membership-before-register 组成了比较完整的 fail-closed 路径。[TenantContext 绑定](https://github.com/block/buzz/blob/be48ce98bd163899197b79a82ad5b2bcf0bc9b54/crates/buzz-relay/src/tenant.rs#L61-L89) [REQ 鉴权顺序](https://github.com/block/buzz/blob/be48ce98bd163899197b79a82ad5b2bcf0bc9b54/crates/buzz-relay/src/handlers/req.rs#L119-L170)
- **可审计性强**：每个动作有签名主体，审计链可验篡改；对多用户多 Agent 协作尤其有价值。[审计链实现](https://github.com/block/buzz/blob/be48ce98bd163899197b79a82ad5b2bcf0bc9b54/crates/buzz-audit/src/service.rs#L93-L151)
- **边缘故障是有界的**：子进程组清理、队列/批次/重试上限、idle/hard timeout 避免一个 Agent 无限占住频道或遗留进程。[队列边界](https://github.com/block/buzz/blob/be48ce98bd163899197b79a82ad5b2bcf0bc9b54/crates/buzz-acp/src/queue.rs#L23-L42) [进程组清理](https://github.com/block/buzz/blob/be48ce98bd163899197b79a82ad5b2bcf0bc9b54/crates/buzz-acp/src/acp.rs#L2213-L2247)

## 7. 局限与风险

### 7.1 一致性与交付语义

数据库事件是 durable truth，但 Redis fan-out、审计和 workflow 属于 post-commit 路径；workflow 是异步任务，部分业务 side effect 失败只记录 error，客户端仍可能收到事件已接受。源码甚至明确承认这会形成“客户端认为的状态与 relay 实际状态不一致”。[side effect 失败仍接受](https://github.com/block/buzz/blob/be48ce98bd163899197b79a82ad5b2bcf0bc9b54/crates/buzz-relay/src/handlers/ingest.rs#L2937-L2956) [post-commit 的异步 workflow](https://github.com/block/buzz/blob/be48ce98bd163899197b79a82ad5b2bcf0bc9b54/crates/buzz-relay/src/handlers/event.rs#L508-L557) 对“任务领取、patch 提交、人工批准”这类必须 exactly-once/可恢复的协作，单纯 event insert + best-effort side effect 不够，应增加 durable command/outbox/inbox 和幂等状态机。

### 7.2 Agent inbox 不是 durable queue

`EventQueue` 是 `HashMap/HashSet/VecDeque` 的本地内存状态，有容量丢弃和 dead-letter 日志但没有持久化存储；首次订阅又默认跳过历史。由此推断，harness 进程崩溃可能丢失已收未处理事件，不能把它作为可靠任务调度器。Buzz 更适合“频道驱动的协作助手”，而非无需补强即可承担关键任务队列。

### 7.3 Runtime 可插拔但信任边界宽

ACP 只规范了调用协议，没有规范 capability、安全沙箱、文件系统挂载和凭据传递。自定义 harness 是任意本地可执行文件；shell 继承操作者权限。若目标系统允许“每个人安装任意 Agent runtime”，必须把 runtime SPI 与 capability broker 分开，默认不给 runtime 共享空间私钥、宿主凭据和全文件系统访问。

### 7.4 授权粒度与密钥生命周期

NIP-42 直连身份获得全部 scope，真正的最小权限主要落在频道 membership；这不足以表达“Agent 可读但不可发消息”“只能创建 patch、不能改成员”“单任务临时授权”等细粒度 capability。长期私钥通过环境变量进入本地/远程进程，也使泄露后的撤销、轮换、设备绑定和恢复成为框架必须单独解决的问题。Buzz 的 sovereign 文档也承认丢失私钥没有传统找回流程。[密钥恢复取舍](https://github.com/block/buzz/blob/be48ce98bd163899197b79a82ad5b2bcf0bc9b54/VISION_SOVEREIGN.md#L206-L228)

### 7.5 Nostr `kind` 扩展的复杂度

“新增能力=新增 kind”提供了向前忽略未知事件的能力，却不自动解决 payload schema/version、跨 kind 事务、不变量、事件迁移和权限矩阵。当前 `kind.rs` 已覆盖大量标准与自定义种类，ingest 中也形成很长的 per-kind scope、global/channel、validator 和 side-effect 分支。对新项目直接采用这个模型，容易把应用服务变成巨大的协议交换机。

### 7.6 中心 relay 的可用性与信任

签名保证作者和内容完整性，但 relay 仍控制可见性、排序、拒绝、搜索索引和 durable availability。默认没有客户端/relay 间的 P2P 或多主复制，所以 relay/数据库故障仍是共享空间故障；Redis 多实例 fan-out 解决横向扩展，不解决跨管理域容灾。[relay 无 P2P/replication](https://github.com/block/buzz/blob/be48ce98bd163899197b79a82ad5b2bcf0bc9b54/ARCHITECTURE.md#L3-L15)

### 7.7 已知未完成能力和文档漂移

Workflow approval gate 在当前源码遇到 approval token 时仍明确标记失败，而不是进入可恢复等待态。[`finalize_run` 的 WF-08 分支](https://github.com/block/buzz/blob/be48ce98bd163899197b79a82ad5b2bcf0bc9b54/crates/buzz-workflow/src/lib.rs#L205-L240) Workflow cache 也说明跨 pod 不做即时失效，允许最长约 10 秒的删后仍触发/建后漏触发窗口。[workflow cache consistency](https://github.com/block/buzz/blob/be48ce98bd163899197b79a82ad5b2bcf0bc9b54/crates/buzz-workflow/src/lib.rs#L90-L121)

此外，`ARCHITECTURE.md` 在同一提交里仍写 `ALL_KINDS` 为 127、旧 search worker、API token 等历史描述，而实际 `kind.rs` 和 event/auth 源码已演进；根 `Cargo.toml` 的 repository 仍指向旧 `block/sprout`。[文档中的 kind 数](https://github.com/block/buzz/blob/be48ce98bd163899197b79a82ad5b2bcf0bc9b54/ARCHITECTURE.md#L128-L144) [Cargo repository 元数据](https://github.com/block/buzz/blob/be48ce98bd163899197b79a82ad5b2bcf0bc9b54/Cargo.toml#L36-L42) 这说明它是高速演进项目，做架构决策时必须核源码，不能只读愿景文档。

## 8. 对自研框架：可借鉴 / 不应照搬

### 可借鉴

1. **共享空间只保存可协作、可恢复的事实；Agent body 留在本地。** 共享层保存消息、任务、artifact reference、decision、receipt、checkpoint；模型上下文、临时 checkout 和进程属于本地执行体。
2. **给每个人和每个 Agent 独立 principal。** 人与 Agent 走同一 ACL/audit 模型，但 Agent 还应绑定 owner、device/runtime instance，并支持短期 session key。
3. **relay/hub 是唯一跨域编排层，domain core 零 I/O。** Buzz 的 `core → services → relay orchestrator` 分层值得保留；初期可只做 `core + server + store + runner` 四层，不要一开始拆二十多个包。
4. **把 runtime SPI 与 workspace protocol 分开。** 本地 runner 对上实现稳定的 `AgentRuntime` 协议；ACP 可以作为一个 adapter，但框架内部不要把 ACP 特性当领域模型。
5. **每 space/channel 串行、跨 space 并行。** 它天然减少同一对话/工作区的竞态；同时必须把 cursor、claim、lease 和 retry 持久化。
6. **Host/space scope 服务端派生并贯穿所有端口。** 不信客户端声明的 tenant；DB key、cache key、pubsub topic、object path、audit chain 都带 space id。
7. **所有外部副作用使用 durable outbox + receipt event。** Agent/tool/workflow 的“意图”和“完成结果”分别落盘，重试幂等，人工能看见 pending/failed，而不是吞进后台日志。
8. **边缘执行必须有硬边界。** timeout、output budget、process-tree cleanup 值得直接吸收；再加 filesystem/network/secret capability broker。

### 不应照搬

1. **不要把所有领域对象压成 `kind + tags + string content`。** 对核心状态使用显式 versioned schema/command/event；只在扩展插件事件上采用开放 envelope。
2. **不要把 ACP 设为唯一 runtime 真相。** 定义更小的内部 runtime contract，再提供 ACP、MCP、HTTP、CLI/stdio、SDK 等 adapter。
3. **不要使用内存队列承载任务可靠性。** 共享存储中保存 inbox、claim lease、attempt、checkpoint 和 dedup key；本地内存队列只做预取。
4. **不要让签名身份等于所有能力。** 使用短期 capability token，按 space/resource/action/expiry/approval 限权；Agent 长期私钥不直接下发给任意 runtime。
5. **不要把“事件已存储”与“业务已完成”混成一个 ACK。** 明确 `accepted → claimed → running → awaiting_approval → succeeded/failed/cancelled` 状态机。
6. **不要一开始复制 Buzz 的完整依赖拓扑。** MVP 可先单节点 Postgres（事件、任务、LISTEN/NOTIFY 或 polling）+ object storage；真正需要多节点 fan-out 时再引入 Redis。
7. **不要假设签名事件等于分布式/去中心化。** 若需要离线、多 relay 或跨组织协作，必须另行设计 replication、conflict resolution、availability 和 trust policy。

最终可以把 Buzz 视为一个很有价值的“共享协作 relay + 本地 runtime harness”实例，而不是完整模板。它证明了边界可行：共享空间不必托管模型，本地 Agent 也不必与 UI/服务器同 runtime；但自研方案应在 durable task protocol、capability security 和最小模块化上比 Buzz 更严格、更简单。
