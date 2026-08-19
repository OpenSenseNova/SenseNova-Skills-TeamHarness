# Agent Context 与 Privacy 权威契约

> 状态：Implemented
> 契约版本：1.0.0
> 上游：`CONTEXT.md`、`docs/ARCHITECTURE_V1.md`、ADR-0006、ADR-0011、ADR-0015、ADR-0020、ADR-0021、ADR-0028、ADR-0029
> 实现：`schema/workspace.sql`、`schema/local-node.sql`、`src/domain/workspace-service.ts`、`src/runtime/workspace-return-binding.ts`、`src/runtime/local-computer-worker.ts`

## 1. 上下文不是启动 Prompt

V1 使用 pull-based Agent context。Workspace 只发送轻量 Inbox wake，Runtime 自己通过 Agent 级 `teamctl` 拉取需要处理的 Discussion Scope、消息正文和历史。

```text
Human Message
  → Message / Mention Outcome / Agent Request / Inbox Item 原子提交
  → agent.inbox_changed { agentId, highestSequence }
  → Local Computer 合并同一 Agent 的 wake
  → Runtime 收到不含正文的 "Agent Inbox changed"
  → teamctl inbox check
  → teamctl message check --target <scope>
  → Runtime 按需 message read / resolve
  → teamctl message send 或 return no-output
```

系统不存在 Attempt Addendum、context manifest、context-feed 或“最终发送前刷新”。Runtime 的长期本地连续性由 ACP Session 负责，共享事实始终由 Workspace API 权威读取。

## 2. 进入 Inbox 的消息

V1 只为两类消息建立 Agent Inbox Item：

- Human 在固定 Human–Agent DM 中发送的 Message，自动请求该 direct Agent；
- Workspace/Project Channel 或 Thread 中明确结构化 `@Agent` 的 Message。

普通 Channel/Thread Message 不创建 Inbox Item，也不唤醒 Runtime。但是 `@` 只表示 attention，不是消息过滤器：当后续 mention 唤醒 Agent 时，`message check` 会返回该 Discussion Scope 自上次成功处理位置之后的完整消息增量，其中可以包含此前未 mention Agent 的普通消息。

同一 Message 的写事务同时提交：

```text
Message
Mention Outcome
Agent Request
Agent Inbox Item
wake delivery signal
workspace change
audit
```

任何一步失败都不能留下半条请求或无来源 Inbox Item。

## 3. Discussion Scope 与消息增量

`DiscussionScopeRef` 只有两种：

```ts
type DiscussionScopeRef =
  | { kind: "timeline"; conversationId: Id; threadId: null; rootMessageId: null }
  | { kind: "thread"; conversationId: Id; threadId: Id; rootMessageId: Id };
```

Timeline 和每个 Thread 分别维护单调递增的 position。Thread 拉取结果包含 immutable root Message 和当前 Thread replies；其他 Thread 的写入不进入该增量。

`message check` 的返回分两层：

- `attention`：本次领取的 Inbox Item，只包含 attention kind、Message ID、Agent Request ID 等提醒来源；
- `discussion`：真正给 Runtime 使用的 scope context，正文只在这里出现一次，并按 `scope_position` 排序。

服务端按同一 Agent、Binding revision 和 Discussion Scope 找到上一次成功 terminal receipt 的 `throughPosition`，将其作为下一次 pull 的起点。第一次 pull 从 scope 起点读取；Thread root 单独返回，不重复混入 replies。

## 4. Claim receipt 与 Run

`teamctl message check --target <scope>` 原子领取该 scope 当前所有 pending Inbox Item，并创建或复用 Run/Attempt。一个 receipt 固定：

```text
agentId
runId / attemptId
bindingRevision
conversationId / threadId
fromPosition / throughPosition
```

同一 receipt 可重放，直到对应 Run terminal。Local Computer 或 Runtime 在 claim 后崩溃时，不会重复创建 Run 或丢失已领取消息。

同一 Agent、同一 Discussion Scope 的多条 Agent Request 可由一个 Run 消费，顺序保存在 `run_agent_requests`。不同 scope 不合并。Runtime 忙碌时只记录 `wakePending`，不会启动第二个并行 Agent 进程；当前 turn 到安全边界后再检查 Inbox。

## 5. Agent 级 `teamctl`

Runtime 不获得 Computer Token、Session Cookie 或 Workspace 数据库访问权。Local Computer 为当前 Agent/Attempt 启动双向 IPC gateway，并只暴露：

```text
teamctl inbox check
teamctl message check --target <scope>
teamctl message read --target <scope> [--before <position>|--after <position>]
teamctl message resolve <message-id>
teamctl message send --target <scope> --body <text>
teamctl artifact publish ...
teamctl return no-output --run <run-id>
```

`message read` 与 `resolve` 每次按当前 Agent 的 Conversation/Project Membership 重新鉴权。`message send` 必须找到当前 scope 的有效 claim receipt，并校验 Agent、Run、Attempt 和 Binding revision；成功后直接发布普通 Agent Message。

## 6. Run Context 与执行目录

Run/Attempt 仍保存执行事实，而不是消息副本或 Runtime Prompt：

- 触发和结果 Discussion Scope；
- Agent Membership、Execution Policy、预算和 Binding revision；
- Workspace/Project context version；
- Project Repository identity 与 base commit；
- Run/Attempt 状态及 publication provenance。

Workspace/无 Repository Project 使用 Attempt scratch；Repository Project 使用从固定 base commit 创建的 detached worktree。Runtime `cwd` 是 Attempt 的 `work`，不会回退到 Home、服务端目录或用户主 checkout。

## 7. Private Context

Private Context Grant 只绑定一个 Run，记录 source category、read/disclosure 权限、Policy version、过期和撤销状态。Workspace 不保存私有正文、绝对路径或文件名。

- 未授权、撤销、过期或属于其他 Run的读取 fail closed；
- `disclosureAllowed=false` 时不能把来源于该 Grant 的内容发布为 Message 或 Artifact；
- Runtime 主动读取必须写 `runtime_context_reads` 审计；
- Runtime 的本地记忆不自动成为 Workspace 事实。

## 8. Runtime 首次说明与后续 wake

Agent session 第一次启动只接收 Agent 名称、描述、Workspace 身份、执行目录边界和 `teamctl` 使用说明。之后的 wake 固定为轻量提示，不包含：

- 用户 Message 正文；
- Workspace change 内容；
- 绝对 context path；
- manifest 或 cursor；
- Artifact 或 Document 的隐式更新。

Artifact/WorkItem 事件进入 Inbox 不属于 V1。Runtime 需要相关内容时通过明确工具读取；系统不猜测“当前任务引用”的对象，也不把 Workspace 所有变化广播进当前 turn。

## 9. 数据与验证

Workspace 权威表：

| 责任 | 表 |
|---|---|
| attention queue | `agent_inbox_items` |
| replayable claim | `agent_inbox_claim_receipts` |
| request batching | `run_agent_requests` |
| execution facts | `runs`, `attempts`, `run_context_snapshots` |
| explicit reads | `runtime_context_reads` |
| terminal return | `run_return_records` |

强制测试覆盖：DM 自动入 Inbox、普通 Channel 不唤醒、显式 mention 唤醒、同 scope 多消息一次领取、Thread root/reply、receipt 重放、下一次 pull checkpoint、忙碌时不并行启动、Agent Restart fencing、普通 Message publication，以及 wake/prompt 不含正文和已删除的 push-context 指令。
