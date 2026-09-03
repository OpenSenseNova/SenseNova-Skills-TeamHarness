# 模块一：数据基础与联调契约

> 状态：Implemented
> 技术栈：Node.js 24、TypeScript、Fastify、TypeBox、SQLite
> 契约版本：1.0.0

> 本文保留模块一的数据基础边界。模块二已经把 Agent Request 骨架替换为正式 Mention Outcome / Agent Request 模型，当前联调请继续阅读 `04-module-2-collaboration-requests.md`。

## 1. 模块职责

模块一提供其他模块共同依赖的持久化与 HTTP 边界：

- 稳定 Human/Agent identity、Workspace Membership 与 Agent Runtime Binding；
- Workspace、Conversation、Message 的最小协作闭环；
- Workspace/Conversation 上下文版本、Agent Inbox、可重放 claim receipt 与只追加变化流；
- Bearer 身份绑定、命令幂等、复合 Workspace 外键、哈希审计链；
- 共享权威状态与 Local Node 私有执行状态的物理分库。

模块一不实现 WorkItem、Result Submission、Completion Policy 或 Review，也不为这些对象建立空表。模块一最初只提供 Agent Request、Run 与 Attempt 的上下文关联；模块二已经正式实现 Mention Outcome 和 Agent Request，Run/Attempt 的完整调度状态机仍由执行模块继续实现。

## 2. 权威与数据库边界

```text
workspace.sqlite                     local-node.sqlite
共享事实唯一逻辑权威                 单台设备的可恢复执行状态
├── identity / membership           ├── local_runtime_executions
├── workspace / agent               ├── wake_hints
├── conversation / message          ├── held_drafts
├── request / inbox / run / attempt├── held_artifact_drafts
├── run context / claim receipt     ├── runtime_sessions
├── workspace_changes              └── local receipts
├── delivery_jobs
└── audit_events
```

两个数据库不能共享外键或假装拥有分布式事务。共享事实先在 `workspace.sqlite` 成立；Local Node 通过幂等操作保存对应引用，并在崩溃后按共享事实对账。两类数据库各自使用独立 `application_id`，并分别验证各自的 v1 基线，不能被误开为另一类数据库。

启动配置：

```text
PRAGMA foreign_keys = ON
PRAGMA journal_mode = WAL
PRAGMA synchronous = NORMAL
PRAGMA busy_timeout = 5000
```

当前完整建库结构是 Workspace 与 Local Node 各自的 schema v1；URL Artifact、persistent Message Artifact references、Conversation visibility 与 Agent held drafts 都属于这份基线。`schema/manifest.json` 是数据库族与建库版本的唯一来源，两份完整建库 SQL 是唯一权威结构。启动时严格校验 `application_id`，并验证当前程序依赖的表、字段和触发器是实际数据库的子集；额外对象不会阻止启动，非契约性的性能索引也不作为启动门禁，只有缺少或改变必需能力才会明确拒绝。当前实现不保留旧字段查询、迁移、双写、表名探测或字段 fallback。

## 3. 身份、角色与 Agent 责任

Human 与 Agent 都有稳定 Actor identity。Workspace Membership 表示某 Actor 在一个 Workspace 中的一段连续参与期，而不是 Actor 本身。

```text
membership_role     owner | member   Workspace 基础角色
```

不变量：

- 只有 active Human Membership 可以是 `owner`；
- 不存在独立的 `admin | normal` 权限维度；
- Workspace 始终至少有一个 active Human Owner；
- Agent Membership 固定为 `member`；
- Agent 是独立 Actor，`created_by_human_id` 永久不可修改，但当前授权使用可转移的 `owner_membership_id`；
- 每个 Agent 始终引用一个同 Workspace 的 active Human Owner Membership，转移写入不可改写的 ownership history；
- Human Membership 仍拥有 Agent 时不能终止；
- 同一 Actor 在同一 Workspace 最多一个 active Membership，重新加入必须创建新 Membership。

所有共享业务对象使用全局 UUID 主键，同时声明 `(workspace_id, id)` 复合唯一键。所有 Workspace 内引用使用 `(workspace_id, referenced_id)` 复合外键，从数据库层拒绝跨 Workspace 关联。

## 4. 上下文版本与 Agent Inbox

版本号只回答“Agent 运行期间上下文是否变化”，不直接决定取消、权限或最终回复内容。Discussion Frontier 才是 Timeline 或单个 Thread 的精确消息边界。

```text
workspaces.context_version
  Workspace Memory、共享 Artifact、Decision、Agent 等 Workspace 级上下文变化时推进

conversations.context_version
  Conversation 的任一共享上下文变化时推进

conversations.timeline_frontier
  只由 top-level Message 推进

threads.reply_frontier
  只由该 Thread reply 推进；Thread Snapshot 另包含 immutable root Message
```

版本推进、对应领域事实、`workspace_changes` 和审计记录必须在同一个 `BEGIN IMMEDIATE` 事务提交。`workspace_changes.position` 是跨版本的稳定跟随游标；版本用于快速比较，变化流用于获取准确增量。

一次 Runtime 消息处理分为：

```text
Agent Inbox wake（不含正文）
→ inbox check 发现待处理 Discussion Scope
→ message check 原子 claim 当前 Scope 的 pending attention
→ 返回 attention 引用与从上次成功位置开始的完整消息增量
→ Runtime 按需 read / resolve 历史
→ message send 或 return no-output
→ Run / Attempt terminal
```

每个 Run 在 `run_context_snapshots` 中恰好一条执行事实快照。`agent_inbox_items` 不复制 Message 正文，只记录 attention 来源和状态；`agent_inbox_claim_receipts` 固定 Agent、Run、Attempt、Binding revision、Discussion Scope 与 position 范围。`run_agent_requests` 保存一个 Run 批量处理的有序请求。零 Message 是合法回传结果，由执行模块记录为 `no_output`，不能创建空 Message。

`run_context_sources` 只保存强类型稳定来源引用、opaque source version、digest、顺序与元数据，不保存完整 Runtime Prompt 或 Conversation 副本。Message 正文由 Runtime 通过 `teamctl message check/read/resolve` 从 Workspace Authority 读取。

## 5. 事务规则

### 5.1 创建 Workspace

一个事务中完成：

1. 创建 Workspace，`context_version = 1`；
2. 创建 creator 的 `owner` Membership；
3. 追加 `workspace_created` change；
4. 追加哈希审计事件；
5. 保存幂等结果。

任何步骤失败则全部不存在。

### 5.2 发布 Message

一个事务中完成：

1. 重新验证当前 public scope Membership、private 精确 audience 或 fixed DM participant；
2. `conversations.context_version += 1`；
3. 插入不可变 Message，并记录本次 `conversation_version`；
4. 追加 `message_created` change；
5. 创建独立 `delivery_jobs` 投递任务；
6. 追加哈希审计事件；
7. 保存幂等结果。

`workspace_changes` 是已提交事实流，`delivery_jobs` 是可重试工作队列，两者不能合并。投递失败不会回滚已经成立的 Message。

### 5.3 审计链

每个 Workspace 独立维护：

```text
seq
prev_hash
hash = SHA-256(canonical event fields)
actor_id / actor_membership_id
action / target / details / created_at
```

SQLite 单写事务负责读取上一条 hash 并追加下一条。`verifyAuditChain()` 可以检测事件字段被修改、事件删除或顺序破坏。

## 6. HTTP 联调契约

完整机器可读契约由路由 TypeBox schema 生成到 `docs/contracts/openapi.json`。

### 6.1 身份

Human 通过 `/v1/auth/register` 创建待验证身份，再使用开发终端输出的 6 位验证码调用 `/v1/auth/verify-email`。验证或登录成功后，浏览器使用 HttpOnly `anc_session` Cookie；非浏览器客户端也可使用返回的一次性 Bearer token。数据库只保存 session/token 的 SHA-256 hash 和 Argon2id 密码摘要。

所有公开写命令还必须提供：

```http
Idempotency-Key: caller-stable-command-id
```

同一 key 和同一请求返回原逻辑结果；同一 key 携带不同请求返回 `IDEMPOTENCY_CONFLICT`。唯一例外是 Human/Computer Token 原文：它绝不写入幂等记录，Computer 注册重放返回 `TOKEN_ALREADY_ISSUED` 与已创建的 Computer 元数据，调用者必须保存首次响应中的 Token。

### 6.2 Human API

```text
POST /v1/workspaces
GET  /v1/workspaces/{workspaceId}

POST /v1/computers
GET  /v1/computers
PUT  /v1/computers/self/runtime-catalog
POST /v1/computers/self/heartbeat
POST /v1/workspaces/{workspaceId}/agents
POST /v1/workspaces/{workspaceId}/agents/{agentId}/runtime-bindings

POST /v1/workspaces/{workspaceId}/conversations
GET  /v1/conversations/{conversationId}
GET  /v1/conversations/{conversationId}/participants
PUT  /v1/conversations/{conversationId}/participants/{scopeMembershipId}
DELETE /v1/conversations/{conversationId}/participants/{scopeMembershipId}
POST /v1/conversations/{conversationId}/messages
GET  /v1/conversations/{conversationId}/messages?afterVersion=&limit=

GET  /v1/workspaces/{workspaceId}/changes?after=&limit=
```

读取 Conversation 和 Message 时重新验证当前 public scope、private 精确 audience 或 fixed DM reference。scope 管理员的 governance access 只允许基本信息和 participant 治理。变化流要求 active Workspace Membership，按提交时的 content audience 冻结 recipients，并在读取时再次过滤已失权 Conversation signal；任何正文仍必须回到当前权限的资源 API 读取。

### 6.3 Local Node API

Human 调用 `POST /v1/computers` 注册自己的 Computer；原始 Computer Token 同样只返回一次。Local Computer 常驻进程使用该 Token 主动连接，通过完整 Runtime Catalog report 上报本机各 `runtimeId` 的安全可用性投影，并定期 heartbeat。Workspace 只保存 `runtimeId`、可用性、版本和检测时间；本地绝对路径、启动命令、环境和登录凭据不得上报。Human 通过 `GET /v1/computers` 读取自己 Computer 的 online 状态和 Runtime Catalog。

Runtime Binding 只能引用该 Computer 最新 Catalog 中 `availability=ready` 的显式 `runtimeId`。Agent provisioning 可把 Agent 创建与此 Binding 放进同一个事务；Computer 或 Runtime 校验失败时不得留下未绑定的半成品 Agent。Computer 必须是目标 Agent 当前 active Runtime Binding 才能访问对应 Attempt：

```text
POST /v1/attempts/{attemptId}/context-snapshots/initial
GET /v1/attempts/{attemptId}/addenda?after={cursor}
PUT /v1/attempts/{attemptId}/addenda/ack
POST /v1/attempts/{attemptId}/context-reads
POST /v1/attempts/{attemptId}/return
```

Human Token 不能调用 Local Node API，Computer Token 不能调用 Human Workspace API。Runtime 本身永远不持有长期 Workspace Token，也不能通过请求体自报 Agent、Workspace、Run 或权限。

### 6.4 错误结构

```json
{
  "error": {
    "code": "STABLE_CODE",
    "message": "Human-readable summary",
    "details": null
  }
}
```

核心错误码包括 `UNAUTHORIZED`、`HUMAN_PRINCIPAL_REQUIRED`、`COMPUTER_PRINCIPAL_REQUIRED`、`WORKSPACE_MEMBERSHIP_REQUIRED`、`CONVERSATION_NOT_FOUND`、`IDEMPOTENCY_KEY_REQUIRED`、`IDEMPOTENCY_CONFLICT`、`TOKEN_ALREADY_ISSUED`、`INBOX_RECEIPT_NOT_CLAIMED` 和 `CONSTRAINT_VIOLATION`。

## 7. 其他模块接入规则

- Identity/UI 模块只保存 Human Token，不能把 `actorId` 当成调用凭证；
- Conversation UI 使用 `conversationVersion` 做增量读取，使用 `workspace_changes.position` 做断线跟随；
- 协作请求模块原子创建 Agent Request 与 Agent Inbox Item；持久聊天 Session 的 `message check` claim 不创建 Run/Attempt；
- Local Agent 模块只发送轻量 wake，Runtime 通过 Agent 级 `teamctl` 主动领取 Scope 增量；候选正文先在 Local Computer 耐久保存，再由 Workspace 对精确 Discussion frontier 原子检查并发布普通 Message；
- Delivery 模块只消费 `delivery_jobs`，通过 lease、fencing 和 dedupe 推进任务，不修改 Message；
- Audit/运维模块按 Workspace 验证哈希链，并将校验失败视为数据完整性事件；
- 后续模块不得绕过 Workspace Service 直接组合“领域写入 + version + change + audit”四步。

## 8. 验收基线

- 两个 SQLite 文件可独立重启并恢复；
- Owner/Permission、Agent creator、active Membership 和跨 Workspace 外键约束由数据库验证；
- Message、版本、变化、投递任务和审计要么全部提交，要么全部回滚；
- Bearer Token 原文不落库；
- 重复命令不产生重复 Workspace、Message、Inbox Item 或 Run；
- Runtime 期间新增的“不要查了”等内容只设置 wakePending，并在下一次 `message check` 进入同一 Scope 增量；
- claim receipt 可重放，Local Computer 或 Runtime 崩溃不会丢消息或重复创建 Run；
- OpenAPI、类型检查、数据库测试和真实 HTTP 注入测试全部通过。
