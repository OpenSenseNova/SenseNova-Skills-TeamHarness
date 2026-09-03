# Agent Inbox 与上下文拉取契约

> 状态：Implemented
> 契约版本：1.0.0
> 实现：`schema/workspace.sql`、`src/domain/workspace-service.ts`、`src/runtime/local-computer-worker.ts`、`src/runtime/agent-workspace-gateway.ts`

## 1. 两条相互独立的执行通道

聊天 Message 由对应的 Mention/WorkItem Logical Session 处理，不创建 Workspace Run 或 Attempt；ACP process/session 只是该 Logical Session 的可丢弃 cache：

```text
Message
  → durable Agent Inbox Item
DM / explicit mention
  → separate agent.inbox_changed { agentId, wakeSequence }
  → Local Computer 按 agentRequestId 找到 Mention Session
  → Runtime cache 使用该 Session 的 JSONL 与 teamctl 处理 Message
```

Run/Attempt 只用于真正需要独立执行事实的任务，例如固定 Project Repository base commit、创建隔离 worktree、施加一次性预算或权限、记录可取消的长任务。它们不是聊天消息的容器，也不负责把上下文送进 Runtime。

系统没有 Attempt Addendum、context manifest 或 context-feed。每个 Mention/WorkItem 都有独立 Logical Session；Runtime 的本地连续性只是可丢弃 cache，共享事实由 Workspace API 动态重建为确定性 JSONL；Message 的最后竞态窗口由 Discussion freshness compare 保护，Artifact 更新窗口由 resource state-hash CAS 保护。

## 2. Inbox 来源

Agent Inbox 接收：

- Agent 有权访问的普通 Channel/Thread Message，作为不产生 wake 的 Discussion delivery；
- Human 在固定 Human–Agent DM 中发送的 Message；
- Channel 或 Thread 中明确结构化 `@Agent` 的 Message。

普通 Channel/Thread Message 会为每个有权访问该 scope 的 Agent 创建静默 Inbox Item，但不主动唤醒。`@` 通常产生一个以 `agentRequestId` 为 key 的 Mention Session：`message check` 只领取该请求及触发点之前的 Discussion change，后续 Mention 保持 pending 并进入新 Session。若该 Message 随后创建了一个分配给同一 Agent 的 WorkItem，则这两个 attention 会合并到以 `workItemId` 为 key 的复合 WorkItem Session；该 Session 同时读取 WorkItem 与来源 Discussion，并分别完成任务处理和群聊回复。

Message、Mention Outcome、Agent Request、Message Inbox Item 与 Change/Audit 在一个事务内提交。Workspace Change 仍写 `workspace_changes` 和按权限计算的 recipients，但只有 `message_created` 投影成 Agent Inbox Item。Project、成员、File、Document、Artifact 和 Runtime Binding 等变化不进入 Agent Inbox。

## 3. Logical Session 与 Runtime cache 隔离

Local Computer 按 `Agent × (Mention agentRequestId | WorkItem workItemId)` 维护活动 ACP process/session。首次启动发送一次完整的 Agent 身份、Session JSONL 与 `teamctl` CLI 说明；服务端 wake 的后续输入只针对当前 Session：

```text
Agent Inbox changed.
```

轻量 wake 不包含 Message 正文、Agent ID、绝对上下文路径、manifest 或 cursor。Agent Runtime 忙碌时只记录当前 Session 的 `wakePending`；不同 Mention/WorkItem 不共享 process、工作目录、receipt 或 held draft。

Local Held Draft 的 freshness hold 不是服务端 Inbox wake；它会在同一 Session 生成显式 freshness-review 输入。Message hold 要求复核 Discussion delta；Artifact hold 要求 `artifact read` 当前资源后重新决策。

Agent Restart 会关闭本机旧 Runtime cache、使旧 IPC capability 与 receipt 失效并递增 Runtime Binding revision；它不会删除 Message、Inbox 历史、Artifact 或 Agent 配置。cache 丢失后按 Session key 和 context hash 从 Workspace 事实重建。

WorkItem Session 以 `workItemId` 为 key，JSONL 包含 Workspace、Project、当前 WorkItem、活动 Repository（若有）以及全部 WorkItem comments。普通 WorkItem Session 不读取 Discussion receipt；但由 Conversation Message 创建且分配给该 Message 所请求 Agent 的 WorkItem 会获得一个 linked Discussion capability，JSONL 同时包含来源 Conversation/Message，且 `message check/send` 与 `work-item submit/block/comment` 共用同一 Session。Agent 对同一 Project 内任意 WorkItem 的 read/list 权限由 Project membership 决定，而非当前 Session；Mention、WorkItem 和复合 Session 的本地 work/held-artifact 目录及 Runtime cache 彼此隔离。

## 4. Discussion Scope 与消息拉取

Discussion target 固定为：

```text
conversation:<conversation-id>
conversation:<conversation-id>:thread:<thread-id>
```

Timeline 和每个 Thread 分别维护单调递增的 `scope_position`。`teamctl message check` 原子领取当前 Mention Session 的 Agent Request 以及触发点之前的 Discussion change，并返回：

- `attention`：Inbox Item、attention kind 与来源引用；
- `discussion`：从该 target 上一次成功完成位置之后到当前 frontier 的有序 Message；
- Thread 场景中的 immutable root Message。

同一 target 的多条消息在一次 check 中返回。Runtime 可以用 `message read` 补读更早或更晚的历史，用 `message resolve` 精确读取被引用的 Message。

## 5. Workspace Change 与 Agent Inbox 分离

`workspace_changes` 是共享历史与同步游标，不是 Agent 工作队列。非 Message 变化不投影成 Agent Inbox Item，也不产生 Runtime wake。需要 Agent 处理 Artifact 时，由 Human 或另一个 Agent 发送带 Artifact reference 的 Message；Agent 再显式 `artifact read`。

## 6. Claim receipt 与完成

每个 claim receipt 固定：

```text
agentId
bindingRevision
targetKind / target
fromPosition / throughPosition
```

receipt 不含 Run ID 或 Attempt ID。同一未完成 receipt 可以重放；Local Computer 或 Runtime 在 claim 后崩溃不会重复创建执行记录，也不会丢失已领取事件。

Discussion target 通过 `message send` 提交本地耐久候选：frontier 未变化时 Workspace 原子发布普通 Agent Message并完成 receipt，已变化时返回精确增量并保留本地 Held Draft。`return no-output` 也比较已复核 frontier；过期时返回 `review_required` 且不完成 receipt。未显式完成的 receipt 保持可恢复状态。

## 7. Agent 级 `teamctl`

Runtime 不获得 Computer Token、Human Session Cookie 或 Workspace 数据库访问权。Local Computer 通过绑定到 Agent 与 Binding revision 的 IPC gateway 暴露：

```text
teamctl inbox check
teamctl message check --target <discussion-target>
teamctl message read --target <discussion-target> [--before <position>|--after <position>] [--limit <count>]
teamctl message resolve <message-id> --target <discussion-target>
teamctl message send --target <discussion-target> --body <text> [--artifact-id <id> ...]
teamctl message draft get --target <discussion-target>
teamctl message send --target <discussion-target> --send-draft [--anyway]
teamctl message draft discard --target <discussion-target>
teamctl artifact read <artifact-id>
teamctl artifact publish --file <path> --name <name> --type markdown|file [--artifact-id <id> --base-hash <stateHash>]
teamctl artifact publish --url <http(s)> --name <name> --type url [--description <text>]
teamctl artifact update <artifact-id> --base-hash <stateHash> [--name <name>] [--description <text>]
teamctl artifact publish --send-draft --draft-id <id> [--anyway]
teamctl artifact draft get --draft-id <id>
teamctl artifact draft discard --draft-id <id>
teamctl return no-output --target <discussion-target>
```

`message read`、`resolve`、`send`、Artifact read/publish/update 每次都按当前 Agent Membership 与 Binding revision 重新鉴权，并由 Gateway 限定到当前 Session target。Artifact publish/update 在 Local Computer 独立持有草稿，并在 Workspace 写入前比较 Artifact state hash；held 时不创建或更新 Artifact，并在对应 Session 发起显式复核 turn。成功发布产生 Workspace change history，但不产生 Agent Inbox Item。Markdown/File read 物化 Current State；URL read 只返回 locator、描述和 metadata。Agent Message 和 Session 发布的 Artifact 记录 Agent/Binding provenance，不伪造 Run/Attempt provenance。

## 8. Runtime 首次说明

首次 developer instructions 包含：

- Agent 名称、可选描述和 Workspace 名称；
- 标准输出不会发送给用户；
- Logical Session、可丢弃 Runtime cache 和轻量 wake 语义；
- 上述所有 `teamctl` 命令、target 格式、claim/complete 规则；
- Message delta 与 Artifact state-hash conflict 的处理规则。

它不包含内部 Agent UUID、Message 正文、Workspace 数据快照或“你是某次 Attempt 中的 Codex”等临时身份描述。

## 9. 权威数据与验证

| 责任 | 权威数据 |
|---|---|
| attention queue | `agent_inbox_items` |
| replayable claim/checkpoint | `agent_inbox_claim_receipts` |
| Workspace event log | `workspace_changes`, `workspace_change_recipients` |
| Agent Runtime continuity | Local Node `runtime_sessions` |
| optional task execution | `runs`, `attempts`，不参与聊天 Inbox |

必须覆盖：DM 自动入 Inbox、普通 Channel 不唤醒、显式 mention 唤醒、完整 scope delta、非 Message Workspace Change 不入 Inbox、receipt 重放、同 Agent 不并行启动、Restart fencing、普通 Agent Message 发布、Artifact state-hash held，以及 wake/prompt 不含正文和旧 push-context 指令。
