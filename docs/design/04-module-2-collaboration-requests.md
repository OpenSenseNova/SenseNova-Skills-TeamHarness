# 模块二：协作请求与联调契约

> 状态：Implemented
> 技术栈：Node.js 24、TypeScript、Fastify、TypeBox、SQLite
> 契约版本：1.0.0
> 上游：`02-conversation-and-work.md`、ADR-0024～0027、ADR-0040

## 1. 模块职责

模块二把 Human 的 Conversation 协作意图可靠地交给后续执行模块：

- 发布 Timeline Message，或从顶层 Message 的首条 reply 原子创建 Thread；
- 解析调用方提交的结构化 `mentionedActorIds`，验证每个 actor 都是当前 Conversation 参与者并写入 `message_mentions`；
- Human 在固定 Human–Agent DM 中发言时，将唯一的 direct Agent 参与者追加为隐式结构化目标；无需输入 `@`，显式重复选择同一 Agent 仍只保留一个目标；
- 只为其中的 distinct Agent mention 记录 Mention Outcome，Human mention 不触发 Agent Request；
- 只为 `requested` Outcome 创建一个持久 `pending` Agent Request；
- 保存请求的准确结果 Discussion Scope：Conversation Timeline 或具体 Thread；
- 派生 `ready | waiting | blocked` intake，不把临时条件写成 Request 生命周期；
- 允许 Human requestor、当前 Workspace Owner 或目标 Agent 的当前 Owner 显式取消 pending Request；
- 管理 Channel 当前参与者，并在参与者撤权时取消受影响的 pending Request；
- 将 Message、Request 和参与者变化写入 context version、`workspace_changes`、可靠投递任务和审计链。

模块二不接受正文字符串解析结果作为权威 mention。正文中的 `@name` 仅用于展示；目标只能来自同一命令里的稳定 actor ID，或 Human–Agent DM 中由固定 direct Membership 推导出的唯一 Agent actor ID。若 actor 是 Agent，才继续建立 Mention Outcome。这避免重名、改名、转义和富文本解析差异改变共享事实。

模块二自身不负责以下执行行为；这些行为现在由已实现的执行与上下文模块接续：

- 接受 Request 并原子创建 Run；
- Run、Attempt、Execution Lease、并发调度、重试和停止 active Run；
- Agent-authored Message 发布；
- WorkItem、Result Submission、Completion Policy 或 Review；
- 根据“不要查了”等自然语言自动修改结构化状态。

前三项由执行与 Workspace Interaction 模块负责。自然语言消息通过 Agent Inbox 提醒，Runtime 使用 `teamctl message check/read/resolve` 主动拉取当前 Discussion Scope；显式取消命令则直接推进 Request 状态。

## 2. 领域边界

```text
Human publish intent
├── immutable Message
├── Message Mention[Human A] ── no Agent Request
├── Mention Outcome[target A]
│   └── requested ──────── Agent Request A (pending)
├── Mention Outcome[target B]
│   └── not_requested ──── authoritative reason; no Request
└── Mention Outcome[target C]
    └── requested ──────── Agent Request C (pending)
```

一条 Message、全部 distinct actor 的 Message Mention、Agent Outcome，以及全部合法 Request 在同一个 `BEGIN IMMEDIATE` 事务提交。调用方提交的 actor 不属于当前 Conversation 时是 Message 级错误，整条命令回滚；已通过参与者校验的 Agent 在事务竞态中变得不可请求时，只影响该 Agent Outcome。

重复出现的同一 actor ID 只产生一个 Message Mention。Mention 顺序按 `mentionedActorIds` 首次出现顺序保存；Agent Outcome 顺序按其中 Agent 的相对顺序保存。

Human–Agent DM 是显式的一对一 Agent 交互入口：Human 发布 Timeline Message 或 Thread reply 时，唯一 direct Agent 自动成为结构化目标。Human–Human DM 不产生隐式目标；Channel 仍要求调用方提交明确的 `mentionedActorIds`。

### 2.1 结果 Scope

```text
Timeline Message  → result_conversation_id + result_thread_id = null
Thread reply      → result_conversation_id + exact result_thread_id
```

第一条 reply 只能指向顶层 Message，并原子创建 Thread 和 reply；后续 reply 复用同一 Thread。Thread 不能嵌套。后续执行模块不得根据“最近打开的位置”猜结果目标。

### 2.2 Outcome 建立规则

| 当前事实 | Outcome | 权威原因 | Request |
|---|---|---|---|
| 同 Workspace Agent、active Membership、可读结果 Conversation | `requested` | 无 | 创建一个 `pending` Request |
| actor 不属于当前 Conversation | Message 命令拒绝 | `MENTION_TARGET_NOT_IN_CONVERSATION` | 不创建 |
| 当前参与者是 Human | 只保存 Message Mention | 无 | 不创建 |
| 已通过选择但事务提交前不再属于 Workspace Agent | `not_requested` | `target_not_in_workspace` | 不创建 |
| Agent 已删除或无 active Membership | `not_requested` | `target_not_requestable` | 不创建 |
| DM 显式提及非 direct participant Agent | `not_requested` | `target_cannot_access_scope` | 不创建 |
| Agent suspended，但其他建立条件成立 | `requested` | 无 | 创建；intake 为 blocked |

`not_requested` 永久不重新求值。后来把 Agent 加入 Project 或创建新的 DM 只影响新的 mention；旧 Outcome 不补建 Request。

### 2.3 原因投影

数据库只保存一份精确权威原因：

```text
current Workspace Owner or target Agent Owner → exact reason code
other Message reader                           → target_unavailable
```

权限每次读取时重新计算。Message 写命令的幂等记录只缓存 `messageId`，不缓存带权限的 Outcome 投影，因此调用者权限变化后重试也不会泄漏旧的精确原因。`workspace_changes` 只包含 Outcome 状态和 Request ID，不包含精确拒绝原因。

Workspace Owner 与 Agent Owner 是不同权威：前者治理 Workspace，后者承担目标 Agent 责任；两者都可查看该 Agent 的精确治理原因。Channel 不存在独立参与者治理或恢复路径，其访问始终由所属 Workspace 或 Project 的 active Membership 决定。

## 3. Agent Request 生命周期

```text
pending ── execution intake accepts ──> accepted  (模块三)
pending ── hard intake refusal ───────> rejected  (模块三)
pending ── explicit/revocation ───────> cancelled (模块二已实现)
```

四个状态里，只有 `pending` 可继续转换。`accepted`、`rejected`、`cancelled` 是 intake 终态；Run 的执行结果不反写 Agent Request。

每个 Request 有从 1 开始递增的 `version`。显式取消必须提交 `expectedVersion`，并以条件更新保证取消与未来 accept/reject 的 first-commit-wins 语义。

### 3.1 派生 intake

`status = pending` 时，读取投影实时计算：

| 当前事实 | disposition | reasons |
|---|---|---|
| target authority 已失效 | `blocked` | `authority_revoked` |
| Agent suspended | `blocked` | `agent_suspended` |
| 无 active Runtime Binding 或 Computer disabled | `waiting` | `runtime_unavailable` |
| 上述条件均不存在 | `ready` | `[]` |

这些字段不写入 `agent_requests`，Runtime 上线或 Agent 恢复后不需要修表。模块三在 accept 事务内重新验证全部当前事实，不能信任先前读取的 intake 投影。

### 3.2 取消

Human requestor、当前 Workspace Owner 或目标 Agent 的当前 Owner 可以取消 pending Request：

```text
POST /v1/agent-requests/{agentRequestId}/cancel
{ expectedVersion }
```

事务同时完成：

1. 重新验证当前 Membership、取消权限、pending 状态和 version；
2. 请求者取消时设置 `cancelled + requestor_cancelled`；Agent Owner 或 Workspace Owner 以治理权限取消时设置 `cancelled + authority_revoked`，并推进 Request version；
3. 推进 Conversation context version；
4. 追加 `agent_request_cancelled` change；
5. 创建 `agent-request.cancelled` delivery job；
6. 追加审计和幂等结果。

取消 Request 不改写其 `requested` Mention Outcome。若 Request 已被模块三接受，取消入口返回冲突；此时应由执行模块对非终态 Run 发出 stop intent。

## 4. Conversation 参与者

- Workspace Channel：参与者等于全部 active Workspace Membership；
- Project Channel：参与者等于全部 active Project Membership，且 backing Workspace Membership 也必须 active；
- DM：参与者固定为创建时的两个 direct Workspace Membership；
- `GET participants` 是只读投影，不存在 Conversation participant 写命令；
- Project/Workspace Membership 移除立即阻止后续读取，并把受影响的 pending Request 原子取消为 `authority_revoked`；
- Membership 重新加入会恢复 Channel access，但不会恢复已取消 Request、固定 DM 或旧 `not_requested` Outcome。

## 5. 数据库模型

模块二在 `workspace.sqlite` 中正式接管模块一的 Request 骨架：

```text
messages
  └── agent_mention_outcomes
        └── agent_requests
              └── runs (模块三接续)

threads.root_message_id ──> top-level messages.id
agent_requests.result_thread_id ──> threads.id | null
```

关键约束：

- `(workspace_id, message_id, target_reference)` 唯一；
- requested Outcome 必须同时拥有 `target_agent_id + agent_request_id`，且没有 reason；
- not_requested Outcome 必须拥有 reason，且没有 Request；
- deferred FK 允许同一事务先写 Outcome、再写 Request，提交时不允许断链；
- trigger 验证 Request、Outcome 和 target Agent 一致；
- 每个 Request 最多一个 Run；
- Thread、Message、Membership、Agent、Outcome、Request 的 Workspace 关系均由复合外键约束；
- Agent Request 的终态字段与状态由 CHECK 约束一致。

本模块运行时只读取仓库内当前 schema；旧持久数据由数据库启动层的编号化前向迁移一次性转换，领域代码不维护旧结构分支。

## 6. HTTP 联调契约

所有写命令都需要 Human Session（Cookie 或 Bearer Token）和 `Idempotency-Key`。

### 6.1 Message 与 Thread

```text
POST /v1/conversations/{conversationId}/messages
POST /v1/messages/{topLevelMessageId}/replies
GET  /v1/conversations/{conversationId}/messages?afterVersion=&limit=
```

发布请求体：

```json
{
  "body": "@Researcher 查一下 xxx",
  "mentionedActorIds": ["agent-uuid"]
}
```

响应 Message 内含完整 `mentions` 和 Agent `mentionOutcomes`。只写正文、不提交 `mentionedActorIds` 时，不创建结构化 Mention、Outcome 或 Request。

### 6.2 Agent Request

```text
GET  /v1/conversations/{conversationId}/agent-requests?threadId=&limit=
GET  /v1/agent-requests/{agentRequestId}
POST /v1/agent-requests/{agentRequestId}/cancel
POST /v1/agent-requests/{agentRequestId}/accept
```

Conversation 列表需要当前内容访问权。单 Request 元数据只按当前 Conversation access 与明确的 Workspace/Agent Owner 治理投影返回；接口不返回源 Message 正文。

### 6.3 Conversation participant

```text
GET    /v1/conversations/{conversationId}/participants
PUT    /v1/conversations/{conversationId}/participants/{membershipId}
DELETE /v1/conversations/{conversationId}/participants/{membershipId}
```

PUT/DELETE body：

```json
{ "expectedContextVersion": 4 }
```

机器可读的完整字段、枚举与错误响应见 `docs/contracts/openapi.json`。

## 7. 下游模块接入规则

- 模块三从持久 Agent Request 或 `agent-request.available` wake 开始工作，不能从实时 Message 事件或正文直接启动 Runtime；
- accept 必须在一个事务内把 `pending → accepted` 与唯一 Run 创建绑定，并重新验证 target、scope、版本、容量和权限；
- 多个 requested Outcome 是多个独立 Request。模块二允许它们共存，但是否并发执行由模块三的 Agent/Workspace 并发策略决定；
- Local Agent 即使丢失 wake，也必须通过 Assigned Request Inbox 恢复 pending/accepted 工作；
- Runtime 活跃期间从 Initial cursor 后顺序读取并确认 Addenda。新增 Message 与 `agent_request_cancelled` 都会出现在变化流中；
- 模块三实现 active Run stop 后，不得把 Request 从 `accepted` 改回 `cancelled`；
- WorkItem 层未来通过新的 tagged trigger 接入 Agent Request，不能复用或伪造 mention Outcome。

## 8. 验收基线

- 多 target 独立产生完整 Outcome，重复 target 去重，局部失败不阻止 Message；
- Message、Outcome、Request、change、delivery、audit 和 idempotency 同成同败；
- 精确 not_requested 原因只对当前 Workspace Owner 或目标 Agent 的当前 Owner 投影；
- suspended 是 requested + blocked，Runtime 不可用是 requested + waiting；
- 纯正文 `@name` 不启动 Agent；
- Thread 首 reply 原子建 Thread，Request 保存准确 Thread；
- pending Request 取消使用 version，Mention Outcome 保持 requested；
- scope Membership 新增不追溯激活旧 Outcome，移除立即取消受影响 pending Request，重新加入不恢复旧 Request；
- schema 级跨 Workspace、错误作者、嵌套 Thread、Request/Outcome target 不一致都被拒绝；
- HTTP、类型检查、数据库重启、OpenAPI 和完整测试通过。
