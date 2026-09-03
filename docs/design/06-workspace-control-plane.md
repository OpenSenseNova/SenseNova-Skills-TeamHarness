# Workspace 控制面与恢复契约

> 状态：Implemented
> 技术栈：Node.js 24、TypeScript、Fastify、TypeBox、SQLite
> 契约版本：1.0.0

## 1. 模块职责

Workspace 是组织、身份、邀请、Agent 目录、唯一全员大群、一对一私聊和共享变化的控制平面。Project 才是私有文件、工作与项目协作边界。Workspace Membership 只说明身份属于组织，不自动授予任何 Project 内容权限；本模块也不把 Workspace Owner 的恢复治理能力解释为 Project 消息、文件或 WorkItem 读取权。

## 2. 三类版本

```text
workspace_changes.position       所有可观察状态变化的同步游标
workspaces.context_version       Workspace 协作目录内容版本
conversations.context_version    单个 Conversation 内容版本
entity.revision                  单实体治理命令的乐观并发版本
```

Workspace context 包含名称、当前成员、Agent 目录和可发现 Project 治理元数据。Conversation context 包含标题、参与者、Message、Thread 和 Agent Request 内容状态。Computer、Token、Runtime Binding 与 delivery lease 属于运维状态，不推进 Agent context version。

Run Context Snapshot 在 claim 时冻结 Workspace/Conversation version 与结果 Discussion Scope。Runtime 通过 `message check` 取得自上次成功处理 position 以来的准确 Scope 增量，并在发送 Message 或 Discussion no-output 前再次检查。最终提交由 Workspace 在同一事务中比较精确 Scope frontier；同步 cursor 不进入 Runtime Prompt，也不能代替精确 Scope position。

## 3. 恢复流程

客户端进入 Workspace 时按固定顺序恢复：

```text
GET /v1/workspaces/{workspaceId}/bootstrap
→ 记录 changeCursor
→ 并行读取 members / agents / conversations 当前投影
→ GET /v1/workspaces/{workspaceId}/changes?after={changeCursor}
→ 按资源 ID 幂等应用变化；正文通过资源 API 重新读取
```

先记录 cursor 再读取当前投影，使加载期间提交的变化可以安全重放。变化流是 signal plane，只携带安全的类型、资源引用与必要状态，不承担 Message 正文权威。

`workspace_change_recipients` 在变化提交时冻结 content audience：public 使用当时 active scope Membership，private 使用当时精确 audience，DM 使用固定 participants。变化跟随和正文读取都再按当前权限过滤，governance-only 管理员不接收内容 signal。

## 4. HTTP 契约

### Workspace 与目录

```text
GET   /v1/workspaces
GET   /v1/workspaces/{workspaceId}
GET   /v1/workspaces/{workspaceId}/bootstrap
PATCH /v1/workspaces/{workspaceId}

GET   /v1/workspaces/{workspaceId}/members
GET   /v1/workspaces/{workspaceId}/agents
GET   /v1/workspaces/{workspaceId}/agents/{agentId}
GET   /v1/workspaces/{workspaceId}/conversations
```

Workspace、Member、Agent 和 Conversation 列表使用稳定 cursor pagination，返回 `{ items, nextCursor }`。Workspace 创建时自动建立且只建立一个 `workspace_general`；所有 active Human 自动参与，Agent 只有在 Owner 显式加入时才参与。其余 Workspace Conversation 只允许固定一对一 `direct_message`，不提供创建任意 Workspace Channel 的接口。

### Workspace Join Link 与 Membership

```text
GET    /v1/workspaces/{workspaceId}/join-links
POST   /v1/workspaces/{workspaceId}/join-links
GET    /v1/workspace-join-links/{token}
POST   /v1/workspace-join-links/{token}/accept
POST   /v1/workspace-join-links/{joinLinkId}/revoke
PATCH  /v1/workspaces/{workspaceId}/members/{membershipId}
DELETE /v1/workspaces/{workspaceId}/members/{membershipId}
POST   /v1/workspaces/{workspaceId}/leave
```

Join Link 不绑定任何 normalized verified email 或预选 Human；完整高熵 URL 本身是可撤销 bearer capability。只有 Workspace Owner 可以生成或停用链接，所有 active Human Workspace Member 都可列出并复制有效链接；任何 authenticated Human 都可亲自确认，并以固定 `member` 角色创建新的 Membership、进入全员大群，但不会自动加入任何 Project、DM 或执行授权。同一 active 链接可供多人使用。数据库保留 token digest 与 AES-256-GCM 密文，密文由数据目录独立密钥保护并绑定 Workspace/Link identity，停用时删除。

Workspace 基础角色只有 `owner | member`，不设置 admin。只有 Human Membership 可以是 Owner，Agent 固定为 member。Workspace Owner 管理 Human Membership、Workspace 级 Agent identity/ownership 和 Project 恢复治理，且所有路径必须保留至少一个 active Human Owner。Agent 由一个 Human Owner 拥有；该 Human 离开 Workspace 时，其 Agent 会停用并退出 Project 与 Conversation。

### Agent 治理

```text
PATCH /v1/workspaces/{workspaceId}/agents/{agentId}
DELETE /v1/workspaces/{workspaceId}/agents/{agentId}
POST  /v1/workspaces/{workspaceId}/agents/{agentId}/suspend
POST  /v1/workspaces/{workspaceId}/agents/{agentId}/resume
POST  /v1/workspaces/{workspaceId}/agents/{agentId}/ownership
DELETE /v1/workspaces/{workspaceId}/agents/{agentId}/membership
POST  /v1/workspaces/{workspaceId}/agents/{agentId}/membership/readmit
```

任一 active Human Member 可以创建 Agent，并在同一事务成为其唯一 Agent Owner。只有 Workspace Owner 可转移 Agent ownership、终止或重新准入 Agent Membership。终止会关闭 public/private Channel 和 DM access、禁用 Runtime Binding、取消未决 Request 并 fence active Run；重新准入创建新的 member Membership并仅恢复 public Workspace Channel access，不恢复 private Channel、旧 DM 或执行权限。

Membership 终止不物理清除 Agent identity。`actors`、Agent、ownership history、历史 Message、Request、Run 与 audit 保留，用于正确显示既有内容并验证审计链。原 DM 仍可由剩余参与者在会话列表与详情中读取历史，但因另一固定 Membership 已失效而不能继续发送 Message 或 Thread reply。

删除 Agent 是独立且不可恢复的 Workspace Owner 操作。Web 的一次删除确认会先终止仍 active 的 Agent Membership，再永久移除 Agent 的目录存在、参与资格与任务认领；删除后不能重新准入，也不能通过详情 API 访问。既有 Channel/DM Message 不连带删除，继续显示原作者名称并附“已删除”标记。

### Computer 与 Runtime Catalog

Local Computer 是 Runtime 可用性的权威观察者。它以 Computer Token 调用 `PUT /v1/computers/self/runtime-catalog` 上报完整 Catalog，并通过 `POST /v1/computers/self/heartbeat` 保持 online 状态。Human 的 `GET /v1/computers` 只返回自己的 Computer、安全 Runtime 可用性与检测版本，不返回 Token、可执行文件路径、Runtime 凭据或本地配置。

Workspace Runtime Binding 使用稳定 `runtimeId`，不得从 command 名称推断 Profile。绑定与 Agent 显式 provisioning 都重新检查目标 Computer 归属及 Catalog 的 `ready` 状态；Catalog 仅是新的绑定权，已接受的 Run 仍固定其 binding revision。

## 5. 原子性与错误

所有公开写命令要求 `Idempotency-Key`。治理命令同时提交领域状态、entity revision、适用的 context version、change recipient、delivery job、audit 和幂等结果。旧 revision 返回 `409 STALE_REVISION`；Agent 生命周期竞态返回 `409 AGENT_LIFECYCLE_CONFLICT`。

Workspace 与 Local Node 都以稳定 schema v1 建库，不提供 migration、兼容视图、双写或字段 fallback。运行时允许数据库包含额外对象，也不要求非契约性的性能索引；只在当前程序必需的表、字段或触发器缺失或不兼容时拒绝启动。

## 6. 验收基线

- 重启后能通过标准 API 找回 Workspace、成员、Agent 和有权 Conversation；
- bootstrap 期间发生的变化不会漏失；
- 撤权 Membership 能收到移除 signal，但不能继续读取 Conversation；
- Workspace 与 Conversation context version 独立推进；
- Runtime Binding 等运维变化不触发 Agent 上下文刷新；
- Join Link 创建/复用/撤销、成员治理、最后 Owner、Agent 暂停/恢复/删除和 stale revision 均有 HTTP/领域测试；
- OpenAPI 1.0.0、类型检查、构建、数据库重启和完整测试通过。
