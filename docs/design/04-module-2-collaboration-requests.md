# Collaboration Message、Mention 与 Agent Request

> 状态：Implemented
> 契约版本：1.0.0
> Inbox/Runtime 细节：`docs/design/08-context-and-privacy.md`

## 1. 模块边界

本模块负责：

- Human 发布 Message 或 Thread reply；
- 保存结构化 Human/Agent mention；
- 为每个可请求的 Agent mention 保存 Mention Outcome；
- 为 `requested` Outcome 创建 Agent Request 与 Message Inbox Item；
- Human–Agent DM 自动把 direct Agent 作为结构化目标；
- 支持 Request 在领取前取消；
- 查询 Conversation 内的 Agent Request 状态。

Agent Request 是“这条 Message 要求该 Agent 关注”的持久记录，不是 Runtime execution。领取 Request 不创建 Run/Attempt；通常 Agent 在该 `agentRequestId` 对应的 Mention Session 中拉取 Discussion Scope，并回复普通 Conversation Message。若该 Message 创建了分配给同一 Agent 的 WorkItem，则 Request 与 WorkItem assignment 共用一个以 `workItemId` 为 key 的复合 WorkItem Session；该 Session 必须分别完成 Discussion 回复和 WorkItem 处理，不再启动第二个 Runtime Session。

## 2. 发布事务

一次 Human Message 发布原子提交：

```text
Message
├─ message_mentions 0..N
├─ agent_mention_outcomes 0..N
│   └─ requested → agent_requests 1
│                  └─ agent_inbox_items 1
├─ Artifact snapshot references 0..N
├─ message_created Workspace Change
├─ agent.inbox_changed delivery 0..N
└─ audit event
```

任何一步失败都回滚。Message 正文中的字符 `@` 不具有权限或路由含义；只有编辑器提交的 `mentionedActorIds` 建立结构化 mention。Human mention 只记录显示信息，不创建 Agent Request。

Human–Agent DM 不要求用户手动输入 `@`：服务端将 DM 的 direct Agent 自动加入目标。普通 Channel/Thread Message 不包含 explicit Agent mention 时不创建 Agent Request，也不唤醒 Runtime。

## 3. Mention Outcome

每个 distinct Agent target 产生一个不可变 Outcome：

```text
requested
not_requested:
  target_not_in_workspace
  target_not_in_project
  target_not_requestable
  target_cannot_access_scope
```

`requested` Outcome 必须一对一关联 Agent Request。Outcome 保存发送时的结果，后续 Agent 被 suspend/delete 不改写历史 Outcome；当前能否处理由 Inbox claim 时的 Binding、Membership 和权限重新判断。

## 4. Agent Request 生命周期

```text
pending ── persistent Agent Inbox claim ──> accepted
   ├──── Human cancel ───────────────────> cancelled
   └──── authority/intake rejection ─────> rejected
```

- 每个 Request 从 `version = 1` 开始；显式 cancel 使用 `expectedVersion`；
- `pending`、`accepted`、`rejected`、`cancelled` 均是协作请求状态，不是 Runtime/Run 状态；
- `accepted` 表示持久 Agent Session 已领取对应 Message attention；
- Agent Message 发布或 no-output completion 不再二次改写 Request；完成位置由 Inbox receipt 记录；
- 一个 Message target 最多一个 Request，一个 Request 最多一个 Message Inbox Item。

## 5. Discussion Scope

Agent Request 固定 result scope：

```text
Timeline: conversationId + threadId null
Thread:   conversationId + threadId
```

`@Agent` 只触发 attention，不截断上下文。Agent 领取时，`message check` 返回该 Discussion Scope 自上次成功完成位置后的完整 Message delta，包括同一 scope 内未 mention Agent 的普通 Message。

Agent 最终回复由：

```text
teamctl message send --target <discussion-target> --body <text>
```

命令先在 Local Computer 保存候选正文，再由 Workspace 在同一事务中比较精确 Discussion frontier：未变化时发布普通 Agent Message并完成 receipt；变化时返回 `held` 与精确 delta，不创建 Message。它没有 `producingRunId` 或 `producingAttemptId`；其权限和审计 provenance 是 Agent、Membership、Computer、Runtime Binding revision、receipt 与 freshness decision。

## 6. HTTP 契约

### Message 与 Thread

```text
POST /v1/conversations/{conversationId}/messages
POST /v1/messages/{topLevelMessageId}/replies
GET  /v1/conversations/{conversationId}/messages
```

发布示例：

```json
{
  "body": "@Researcher 查一下 xxx",
  "mentionedActorIds": ["agent-uuid"]
}
```

### Human 查询与取消

```text
GET  /v1/conversations/{conversationId}/agent-requests
GET  /v1/agent-requests/{agentRequestId}
POST /v1/agent-requests/{agentRequestId}/cancel
```

不存在 Computer `accept Agent Request` 公开接口。Computer 只使用 Agent Inbox claim API；服务端在同一 claim 事务中把对应 pending Request 标为 accepted。

### Computer Agent Inbox

```text
GET  /v1/computers/self/agents/{agentId}/inbox
POST /v1/computers/self/agents/{agentId}/inbox/claim
POST /v1/computers/self/agents/{agentId}/inbox/complete
GET  /v1/computers/self/agents/{agentId}/messages
GET  /v1/computers/self/agents/{agentId}/messages/{messageId}
POST /v1/computers/self/agents/{agentId}/messages
```

机器可读字段由 TypeBox/OpenAPI 生成，见 `docs/contracts/openapi.json`；Web 和 Local Computer 不手写公开镜像字段。

## 7. 权限与约束

- 发布者必须是目标 Conversation 的 active Human member；
- Mention target 必须是当前 scope 可见的 Actor；
- Project Conversation 只能请求 active Project Agent member；
- DM 固定为 Workspace 级，Project 下没有 DM；
- Agent 领取、读历史和发送 Message 每次重新校验 active Runtime Binding 与 Conversation access；
- Agent Restart 使旧 Binding revision receipt 失效并把未完成 Inbox Item 退回 pending；
- Message immutable；Mention Outcome immutable；Request target/scope immutable；
- Computer Token、Runtime socket token、本机路径不进入 Message、Change、Audit 或公开 API。

## 8. 验收

- DM Message 自动产生一个 Agent Request/Inbox Item；
- Channel 普通 Message 不产生 Agent Request，explicit mention 才产生；
- 一个 Message 中重复 mention 同一 Agent 只产生一个 Outcome/Request；
- invalid target 产生可解释的 `not_requested`，不产生 Request；
- claim 原子把同 scope pending Item 与 Request 标为 claimed/accepted，不创建 Run/Attempt；
- cancel 与 claim first-commit-wins；
- receipt 重放不重复创建 Request、Message 或 Runtime execution；
- Agent 回复是普通 Message，UI 不渲染 mention 专用回复卡片。
