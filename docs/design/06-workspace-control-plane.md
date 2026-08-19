# Workspace 控制面与恢复契约

> 状态：Implemented
> 技术栈：Node.js 24、TypeScript、Fastify、TypeBox、SQLite
> 契约版本：1.0.0

## 1. 模块职责

Workspace 是成员、Agent、Conversation 和共享变化的唯一逻辑权威。本模块补齐应用刷新或重启后的资源发现、Human 加入与治理、Agent 目录治理和变化追赶能力；它不接受或执行 Agent Request，也不实现 Runtime Inbox、wake 或 Execution Lease。

## 2. 三类版本

```text
workspace_changes.position       所有可观察状态变化的同步游标
workspaces.context_version       Workspace 协作目录内容版本
conversations.context_version    单个 Conversation 内容版本
entity.revision                  单实体治理命令的乐观并发版本
```

Workspace context 包含名称、当前成员/权限和 Agent 目录。Conversation context 包含标题、参与者、Message、Thread 和 Agent Request 内容状态。Computer、Token、Runtime Binding 与 delivery lease 属于运维状态，不推进 Agent context version。

Run Context Snapshot 在 claim 时冻结 Workspace/Conversation version 与结果 Discussion Scope。Runtime 通过 `message check` 取得自上次成功处理 position 以来的准确 Scope 增量；不存在回传前统一刷新。同步 cursor 不进入 Runtime Prompt，也不能代替精确 Scope position。

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

`workspace_change_recipients` 在变化提交时冻结可观察 Membership。Workspace Channel 变化发送给当时的 active Workspace Members，Project Channel 发送给 active Project Members，DM 发送给 fixed direct participants。正文读取始终按当前 scope Membership 或 direct reference 重新鉴权。

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

Workspace、Member、Agent 和 Conversation 列表使用稳定 cursor pagination，返回 `{ items, nextCursor }`。Conversation 列表返回调用者当前 Workspace/Project scope 中的 Channel与其固定参与的 DM。

### Invitation 与 Membership

```text
GET    /v1/workspaces/{workspaceId}/invitations
POST   /v1/workspaces/{workspaceId}/invitations
POST   /v1/invitations/{invitationId}/accept
POST   /v1/invitations/{invitationId}/revoke
PATCH  /v1/workspaces/{workspaceId}/members/{membershipId}
DELETE /v1/workspaces/{workspaceId}/members/{membershipId}
POST   /v1/workspaces/{workspaceId}/leave
```

Invitation 绑定规范化 verified email；Invitation ID 本身没有权限。只有当前认证 Human 的 verified email 精确匹配时才能接受。接受创建新的 Membership并立即授予 Workspace Channel access，但不复活旧 DM 或执行授权。

Workspace 基础角色只有 `owner | member`，不设置 admin。只有 Human Membership 可以是 Owner，Agent 固定为 member。只有 Workspace Owner 可治理邀请、Human Membership、Agent Membership 和 Agent ownership，且所有路径必须保留至少一个 active Human Owner。

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

任一 active Human Member 可以创建 Agent，并在同一事务成为其唯一 Agent Owner。只有 Workspace Owner 可转移 Agent ownership、终止或重新准入 Agent Membership。终止会关闭 Channel/DM access、禁用 Runtime Binding、取消未决 Request 并 fence active Run；重新准入创建新的 member Membership并恢复 Workspace Channel access，但不恢复旧 DM 或执行权限。

Membership 终止不物理清除 Agent identity。`actors`、Agent、ownership history、历史 Message、Request、Run 与 audit 保留，用于正确显示既有内容并验证审计链。原 DM 仍可由剩余参与者按 ID 读取历史，但不再出现在会话列表中，也不能继续发送 Message 或 Thread reply。

删除 Agent 是独立且不可恢复的 Workspace Owner 操作。Web 的一次删除确认会先终止仍 active 的 Agent Membership，再永久移除 Agent 的目录存在、参与资格与任务认领；删除后不能重新准入，也不能通过详情 API 访问。既有 Channel/DM Message 不连带删除，继续显示原作者名称并附“已删除”标记。

### Computer 与 Runtime Catalog

Local Computer 是 Runtime 可用性的权威观察者。它以 Computer Token 调用 `PUT /v1/computers/self/runtime-catalog` 上报完整 Catalog，并通过 `POST /v1/computers/self/heartbeat` 保持 online 状态。Human 的 `GET /v1/computers` 只返回自己的 Computer、安全 Runtime 可用性与检测版本，不返回 Token、可执行文件路径、Runtime 凭据或本地配置。

Workspace Runtime Binding 使用稳定 `runtimeId`，不得从 command 名称推断 Profile。绑定与 Agent 显式 provisioning 都重新检查目标 Computer 归属及 Catalog 的 `ready` 状态；Catalog 仅是新的绑定权，已接受的 Run 仍固定其 binding revision。

## 5. 原子性与错误

所有公开写命令要求 `Idempotency-Key`。治理命令同时提交领域状态、entity revision、适用的 context version、change recipient、delivery job、audit 和幂等结果。旧 revision 返回 `409 STALE_REVISION`；Agent 生命周期竞态返回 `409 AGENT_LIFECYCLE_CONFLICT`。

Workspace 与 Local Node 在 V1 使用各自独立的 schema 基线。后续升级按数据库和受影响表执行事务化前向迁移；迁移完成后仅当前 schema 可被领域代码访问，不保留旧结构兼容分支，也不重建无关数据。

## 6. 验收基线

- 重启后能通过标准 API 找回 Workspace、成员、Agent 和有权 Conversation；
- bootstrap 期间发生的变化不会漏失；
- 撤权 Membership 能收到移除 signal，但不能继续读取 Conversation；
- Workspace 与 Conversation context version 独立推进；
- Runtime Binding 等运维变化不触发 Agent 上下文刷新；
- Invitation、成员治理、最后 Owner、Agent 暂停/恢复/删除和 stale revision 均有 HTTP/领域测试；
- OpenAPI 1.0.0、类型检查、构建、数据库重启和完整测试通过。
