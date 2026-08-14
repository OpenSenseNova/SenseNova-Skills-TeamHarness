# Message、Run 与 WorkItem 完成语义调研

> 调研日期：2026-08-12（Asia/Shanghai）
> 资料范围：仅使用项目官方仓库、官方文档和源码。文中明确区分“源码/文档事实”与“设计推论”。

## 调研问题与结论

本次核查围绕五个问题：

1. Conversation 中是否需要 `final` / `result` Message 类型；
2. Agent Runtime 或 Run 的结束事实如何记录；
3. Work/Task 状态是否由消息隐式改变，还是由显式命令改变；
4. Agent 执行期间出现新消息时，旧结果与新输入如何处理；
5. 本项目应采用什么边界。

结论是：**用户提出的“Message、Run 和 WorkItem 状态分离”方向合理；但不应因此删除 Agent Message 发布前的 freshness hold。** `Final Message` 与 Run completion 的耦合应该删除，Discussion Frontier 与 Held Draft 则应作为独立的发布协调机制保留。

推荐删除领域概念 `Final Message`、`Run Result Message` 和 `CompleteRunWithMessage`。Conversation 中只保留一种不可变 Message；Run 由执行层独立结束；WorkItem、Result Submission、Review 由显式 Workspace 命令独立改变。Message 可以保留 `produced_by_run_id` 之类的来源关系，但这只是 provenance，不赋予它 `final` 或 `result` 身份。Agent 发布基于旧 Discussion Frontier 生成的候选内容时，Workspace 只检测“同一 Scope 是否推进”，暂缓首次提交并要求 Agent 复核；它不判断内容必然过期，也不永久禁止发布。

同时，不建议简单地忽略“Run 成功但没有回复”问题。最佳做法是把它建模为独立的**响应义务检查**，而不是强迫某一条 Message 与 Run 完成原子绑定：

```text
Message            = 共享讨论内容
Run outcome         = 一次逻辑执行的技术/执行结果
Response obligation = 本次请求是否要求可见回复，以及是否已经满足
WorkItem state      = 长期工作的领域状态
Submission/Review   = 候选结果与评价事实
```

## 核查基线

- **Block Buzz**：[`4b3570671eb2786594267758af18784ac6e82972`](https://github.com/block/buzz/commit/4b3570671eb2786594267758af18784ac6e82972)
- **Multica**：[`0c69f1f95fd807a75ca119a52862835c569fb0d8`](https://github.com/multica-ai/multica/commit/0c69f1f95fd807a75ca119a52862835c569fb0d8)
- **Paperclip**：[`67001ec6eb96ae601aa27bc91d9b2415d665334a`](https://github.com/paperclipai/paperclip/commit/67001ec6eb96ae601aa27bc91d9b2415d665334a)
- **Raft 文档**：[`f6ea2ad3a640c54fd7044103e936f4c156461a46`](https://github.com/botiverse/raft-docs/commit/f6ea2ad3a640c54fd7044103e936f4c156461a46)；External Agent Bridge：[`72c31894f933b9aa9243195d038d66ee79589593`](https://github.com/botiverse/raft-external-agents/commit/72c31894f933b9aa9243195d038d66ee79589593)

## 对比总览

| 系统 | 共享消息有特殊 final/result 类型吗 | Run/turn 如何结束 | Work 状态如何变化 | 执行中有新消息时 |
|---|---|---|---|---|
| Buzz | 没有；`buzz messages send` 发布普通事件 | ACP `stopReason` 独立结束 turn | 共享 issue 状态由显式 CLI 状态事件改变 | 默认 steer 进当前 turn，也可 queue/interrupt；不做 frontier hold |
| Multica issue | 没有；结果是普通 comment | Runtime turn 退出，daemon 独立回报 task terminal 状态 | `multica issue status` 显式改变 issue；task 完成不改变 issue | 未交付的新评论在完成后形成一个后续 task；旧回复不被抑制 |
| Multica direct chat | Message 仍是普通 assistant row，但有 `no_response` outcome | task 完成与唯一 assistant outcome 同事务 | 不涉及 issue 状态 | 每次发送创建独立、密封的输入 task，排在当前 turn 后面 |
| Paperclip | comment 是普通行，可用 `created_by_run_id` 追踪来源 | Adapter 结果独立写入 heartbeat run 的 terminal 状态 | Issue 状态通过显式 `PATCH` / CLI 更新 | Run 有稳定 context；缺评论时另记 response obligation 并有限重试 |
| Raft | Conversation 只有普通 Message；Task 是带 tracking metadata 的顶层 Message | Managed runtime 内部实现未公开，不作推断 | Agent 显式 claim、发结果、置 `in review`，Human 再置 `done` | Inbox 累积输入；Held Draft 在同一 target 出现未观察新消息时要求发布前复核 |

## 1. Buzz

### 1.1 源码与文档事实

Buzz 的 Message 发布与 turn 完成是两条独立路径：

- `buzz messages send` 构造、签名并提交普通 Nostr message/forum event。其参数包括 channel、content、kind、reply、broadcast、files 和 mentions，没有 Run、final 或 result 字段。[消息命令源码](https://github.com/block/buzz/blob/4b3570671eb2786594267758af18784ac6e82972/crates/buzz-cli/src/commands/messages.rs#L564-L692)
- Buzz 的愿景文档明确把 tool calls 视为 Agent 对真实世界的操作，而 assistant text 更接近 reasoning；共享结果需要通过工具发布。[VISION_AGENT](https://github.com/block/buzz/blob/4b3570671eb2786594267758af18784ac6e82972/VISION_AGENT.md#L51-L61)
- ACP turn 使用 `end_turn`、`cancelled`、`max_tokens`、`max_turn_requests`、`refusal` 等 `stopReason` 独立结束。[StopReason 定义](https://github.com/block/buzz/blob/4b3570671eb2786594267758af18784ac6e82972/crates/buzz-acp/src/acp.rs#L42-L74) [prompt/response 处理](https://github.com/block/buzz/blob/4b3570671eb2786594267758af18784ac6e82972/crates/buzz-acp/src/acp.rs#L738-L824)
- Worker pool 收到 `Ok(stop_reason)` 后记录 metric 并结束本次处理，不查询或绑定某一条 Message。[pool 完成路径](https://github.com/block/buzz/blob/4b3570671eb2786594267758af18784ac6e82972/crates/buzz-acp/src/pool.rs#L2297-L2363)

Buzz 明确允许“执行成功但沉默”：

- Base prompt 要求有值得共享的结果时发布、Human 提问时回复；其他场景 publication 是可选的，silence 可以是成功结果。[base prompt](https://github.com/block/buzz/blob/4b3570671eb2786594267758af18784ac6e82972/crates/buzz-acp/src/base_prompt.md#L73-L81)
- Reply guard 用来减少“做了工作但没 post”的静默失败，但只是 advisory：最多提醒两次，此后 turn 仍可结束；它检测 publish-shaped tool attempt，并不验证发送最终成功。[Reply Guard 契约](https://github.com/block/buzz/blob/4b3570671eb2786594267758af18784ac6e82972/crates/buzz-agent/README.md#L169-L219) [实现](https://github.com/block/buzz/blob/4b3570671eb2786594267758af18784ac6e82972/crates/buzz-agent/src/agent.rs#L700-L747)

Buzz 不使用 Discussion Frontier 阻止旧回复：

- Mid-turn policy 支持 `Queue`、`Steer`、`Interrupt`、`OwnerInterrupt`，默认 `Steer`。[策略定义](https://github.com/block/buzz/blob/4b3570671eb2786594267758af18784ac6e82972/crates/buzz-acp/src/config.rs#L63-L86)
- Agent 在下一 LLM round 前 drain 新的 steer input，把它追加成 user turn 后继续原执行。[steer drain](https://github.com/block/buzz/blob/4b3570671eb2786594267758af18784ac6e82972/crates/buzz-agent/src/agent.rs#L357-L369) [追加输入](https://github.com/block/buzz/blob/4b3570671eb2786594267758af18784ac6e82972/crates/buzz-agent/src/agent.rs#L760-L779)
- Buzz 的 late-ack fencing 用于防止旧 session 的 steer ack 污染替换 session，而不是阻止普通共享消息。[session ledger](https://github.com/block/buzz/blob/4b3570671eb2786594267758af18784ac6e82972/crates/buzz-acp/src/pool.rs#L52-L80) [ack 记录](https://github.com/block/buzz/blob/4b3570671eb2786594267758af18784ac6e82972/crates/buzz-acp/src/pool.rs#L740-L771)

共享 work 状态也不由 Message 改变。Buzz Git issue 状态通过独立 CLI 命令发布显式状态事件，支持 open/resolved/closed/draft。[issue status 命令](https://github.com/block/buzz/blob/4b3570671eb2786594267758af18784ac6e82972/crates/buzz-cli/src/commands/issues.rs#L87-L152) [状态值](https://github.com/block/buzz/blob/4b3570671eb2786594267758af18784ac6e82972/crates/buzz-cli/src/commands/patches.rs#L193-L206)

### 1.2 设计推论

Buzz 直接支持以下判断：Message 与 Run/turn completion 不需要绑定；Work 状态必须由显式命令改变；普通对话的交叉消息可以通过 steer/queue 处理，而不必拒绝旧回复。

Buzz 的局限也很明确：reply guard 是 prompt/runtime 级提醒，不是 durable response contract。目标系统如果要可靠识别“请求已执行但没有共享回复”，需要比 Buzz 更强的 provenance 与响应义务记录。

## 2. Multica

### 2.1 源码事实：三个独立状态面

Multica 的 schema 明确分开：

- `issue` 有 `backlog|todo|in_progress|in_review|done|blocked|cancelled` 工作状态；
- `agent_task_queue` 有 `queued|dispatched|running|completed|failed|cancelled` 执行状态；
- `comment` 是独立的普通协作记录。[初始 schema](https://github.com/multica-ai/multica/blob/0c69f1f95fd807a75ca119a52862835c569fb0d8/server/migrations/001_init.up.sql#L51-L139)

后续增加的 `comment.source_task_id` 只是普通 comment 到来源 task 的追踪指针，没有 `FinalMessage` 实体或 Message 类型。[source_task_id migration](https://github.com/multica-ai/multica/blob/0c69f1f95fd807a75ca119a52862835c569fb0d8/server/migrations/120_comment_source_task_id.up.sql#L1-L8)

### 2.2 Issue collaboration：消息、执行与工作状态分离

- Runtime instructions 要求 Agent 用普通 `multica issue comment add` 发布结果，同时用独立的 `multica issue status ... in_progress/in_review/blocked` 命令改变 issue 状态。[工作流指令](https://github.com/multica-ai/multica/blob/0c69f1f95fd807a75ca119a52862835c569fb0d8/server/internal/daemon/execenv/runtime_config_sections.go#L546-L568)
- 输出规则要求每个 issue run 通常只发一条最终结果 comment，但这是运行指令，不是 comment schema 中的 final 类型。[输出规则](https://github.com/multica-ai/multica/blob/0c69f1f95fd807a75ca119a52862835c569fb0d8/server/internal/daemon/execenv/runtime_config_sections.go#L734-L742)
- `CompleteTask` 源码明确说明“Issue status is NOT changed here — the agent manages it via the CLI”。[CompleteTask](https://github.com/multica-ai/multica/blob/0c69f1f95fd807a75ca119a52862835c569fb0d8/server/internal/service/task.go#L3474-L3482)
- task 完成时，只要 Agent 从本次运行开始后发布过任意普通 comment，系统就不补发；若一条都没有，才从 runtime final output 合成 fallback comment。[fallback comment](https://github.com/multica-ai/multica/blob/0c69f1f95fd807a75ca119a52862835c569fb0d8/server/internal/service/task.go#L3585-L3634)
- Top-level turn exit 是 task 的运行终点；后台工作不得越过这个边界。这仍是 runtime lifecycle，而不是某条 Message 的身份。[turn boundary](https://github.com/multica-ai/multica/blob/0c69f1f95fd807a75ca119a52862835c569fb0d8/server/internal/daemon/execenv/runtime_config_sections.go#L99-L103)

### 2.3 Direct chat：只在严格 request/response surface 上原子化

Multica 的 direct chat 采用更强的 UX 契约：

- 每次 web/mobile send 原子创建一个 queued task、把它标记为该 immutable input batch 的 owner，并插入归属于该 task 的 user message。[发送事务](https://github.com/multica-ai/multica/blob/0c69f1f95fd807a75ca119a52862835c569fb0d8/server/internal/service/task.go#L1921-L2017)
- 完成时，task 的 `running → completed` CAS 与 assistant outcome row 位于同一事务；任何一步失败都会回滚，重放不能产生第二个 outcome。[完成事务](https://github.com/multica-ai/multica/blob/0c69f1f95fd807a75ca119a52862835c569fb0d8/server/internal/service/task.go#L3474-L3552)
- Direct chat 每个 task 恰好得到一个可见 assistant outcome：普通 message，或显式 `no_response`。空输出可以表示合法的 tool-only turn，不自动重试。[chat outcome](https://github.com/multica-ai/multica/blob/0c69f1f95fd807a75ca119a52862835c569fb0d8/server/internal/service/task.go#L3680-L3705)

这说明“Message 与 Run 完成原子绑定”不是普遍不变量，而是严格一问一答 UI 的局部策略。Multica 自己没有把它应用到共享 issue collaboration。

### 2.4 执行中出现新消息

Multica 不会因为新 discussion content 出现而 suppress 旧 reply：

- Claim 会记录实际交付给本次运行的 comment IDs；运行期间新增或计划但未交付的有效输入，在完成后按时间顺序 replay，并合并成一个有界 follow-up task。[completion reconciliation](https://github.com/multica-ai/multica/blob/0c69f1f95fd807a75ca119a52862835c569fb0d8/server/internal/handler/daemon.go#L3156-L3203) [follow-up enqueue](https://github.com/multica-ai/multica/blob/0c69f1f95fd807a75ca119a52862835c569fb0d8/server/internal/handler/daemon.go#L3312-L3344)
- Direct chat 的后续 send 拥有独立的 sealed input task，排在当前 turn 后面；不会静默改写当前 Run 的上下文。[direct chat send](https://github.com/multica-ai/multica/blob/0c69f1f95fd807a75ca119a52862835c569fb0d8/server/internal/service/task.go#L1884-L1890)
- Cancel 与 complete 用状态 CAS 竞争；daemon 在 terminal 回报前重新检查 task，若已被取消就丢弃执行结果。[daemon pre-completion check](https://github.com/multica-ai/multica/blob/0c69f1f95fd807a75ca119a52862835c569fb0d8/server/internal/daemon/daemon.go#L4738-L4788)

### 2.5 设计推论

Multica 的 issue 模型最接近本项目：普通 Message/Comment、Run terminal fact 和 WorkItem status 三者分离。它同时说明：

- 新输入可靠性应该由 delivered input receipt + durable follow-up 保证，而不是通过 Publication Hold 删除或拒绝已经生成的普通回复；
- `source_task_id` / `produced_by_run_id` 足以建立追踪，无需 `Final Message` 类型；
- fallback 自动发布 runtime final output 只能作为 safety net，而且可能把运行日志或过时内容发布到共享空间。本项目不应默认复制这个行为。

## 3. Paperclip

### 3.1 源码事实

Paperclip 的数据模型也分开三类事实：

- `heartbeat_runs` 独立保存 `status`、`startedAt`、`finishedAt`、error、exit code、signal、usage、`resultJson`、session、log 与 retry lineage。[heartbeat run schema](https://github.com/paperclipai/paperclip/blob/67001ec6eb96ae601aa27bc91d9b2415d665334a/packages/db/src/schema/heartbeat_runs.ts#L7-L60)
- `issues` 独立保存 work status、assignee、review policy、execution run reference 以及 completed/cancelled timestamps。[issue schema](https://github.com/paperclipai/paperclip/blob/67001ec6eb96ae601aa27bc91d9b2415d665334a/packages/db/src/schema/issues.ts#L22-L77)
- `issue_comments` 是普通 comment，并用可选 `createdByRunId` 记录来源 Run。[comment schema](https://github.com/paperclipai/paperclip/blob/67001ec6eb96ae601aa27bc91d9b2415d665334a/packages/db/src/schema/issue_comments.ts#L15-L43)

Run 的 terminal outcome 由 adapter result 独立计算：exit code/error 映射为 succeeded/failed/timed_out/cancelled，并通过 `setRunStatusIfRunning` CAS 持久化；迟到的 finalization 如果 Run 已离开 running，会被跳过。[outcome mapping](https://github.com/paperclipai/paperclip/blob/67001ec6eb96ae601aa27bc91d9b2415d665334a/server/src/services/heartbeat.ts#L15737-L15747) [terminal CAS](https://github.com/paperclipai/paperclip/blob/67001ec6eb96ae601aa27bc91d9b2415d665334a/server/src/services/heartbeat.ts#L15797-L15889)

Paperclip 对“Run 成功但没有共享回复”的处理尤其有参考价值：

- 它按 `createdByRunId` 查询这个 Run 是否产生 issue comment，并把结果单独记录为 `issueCommentStatus` / `issueCommentSatisfiedByCommentId`。[comment lookup](https://github.com/paperclipai/paperclip/blob/67001ec6eb96ae601aa27bc91d9b2415d665334a/server/src/services/heartbeat.ts#L9721-L9748)
- 如果当前 wake policy 要求 comment 而本次没有，则创建一次有界的 missing-comment follow-up Run；重试后仍无 comment 会进入 `retry_exhausted`，不会无限自循环。[response policy](https://github.com/paperclipai/paperclip/blob/67001ec6eb96ae601aa27bc91d9b2415d665334a/server/src/services/heartbeat.ts#L9945-L10027)

Paperclip 的 Issue 状态和 comment 也通过显式 API/CLI 命令改变；官方 CLI 分别暴露 `issue update --status ...` 和 comment/update 能力。[CLI](https://github.com/paperclipai/paperclip/blob/67001ec6eb96ae601aa27bc91d9b2415d665334a/doc/CLI.md#L232-L235)

### 3.2 设计推论

Paperclip 给出了比 `Final Message` 更深的模型：保留普通 Message + Run provenance，并可另外记录 response obligation。它证明这类状态可以与 Run、Message 和 WorkItem 分离；是否把 obligation 引入本项目仍是独立产品选择，并不能从 Paperclip 的实现直接推出。

## 4. Raft 补充对照

Raft 的公开协作模型也没有特殊 final/result Message：

- 所有 Conversation 由 Message 构成，Message 发布后不可编辑或删除。[Messages](https://github.com/botiverse/raft-docs/blob/f6ea2ad3a640c54fd7044103e936f4c156461a46/content/features/messaging/messages/index.md#L7-L46)
- Task 是带 number/status/owner tracking metadata 的顶层 Message；讨论、进度和结果都进入它的 thread。[Tasks](https://github.com/botiverse/raft-docs/blob/f6ea2ad3a640c54fd7044103e936f4c156461a46/content/features/collaboration/tasks/index.md#L7-L61)
- Agent 完成后显式把 Task 置为 `in review` 并 post result，Human review 后再置为 `done`。[Agent task workflow](https://github.com/botiverse/raft-docs/blob/f6ea2ad3a640c54fd7044103e936f4c156461a46/content/features/collaboration/tasks/index.md#L77-L90)
- External Agent 必须通过 `raft message send`、`raft task claim` 等显式 CLI 操作共享空间；wake transport 只传内容为空的提示，不能假装已经回复。[External Agent](https://github.com/botiverse/raft-docs/blob/f6ea2ad3a640c54fd7044103e936f4c156461a46/content/features/agents/external/index.md#L137-L160) [wake-only contract](https://github.com/botiverse/raft-external-agents/blob/72c31894f933b9aa9243195d038d66ee79589593/docs/wake-endpoint-contract.md#L14-L33)

Raft managed runtime 的内部 Run 持久化和完成实现没有公开源码，所以不能据此声称其精确 terminal 状态机。可确认的是其公开领域语言仍然把 Message、Task status 和 runtime wake 分开。

## 5. 第一性原理分析

### 5.1 为什么不需要 Final Message

一条共享 Message 的本质是：某个 Principal 在某个 Discussion Scope 的权威顺序中发布了不可变内容。

“Final”不是 Message 自身的稳定性质：

- 同一 Run 可能先发布澄清、进度、结果或多个分段回答；
- Agent 认为是最后一次回复，不代表 Human 不会继续对话；
- WorkItem 是否完成由目标、依赖、Submission、Review 和 Completion Policy 决定；
- Runtime 是否结束由执行协议、进程或 adapter outcome 决定；
- 把“最后一条消息”升级为类型，会把会话内容、执行生命周期和工作完成三个边界耦合。

因此最小而稳定的 Message 模型是：

```text
Message {
  id
  discussion_scope_id
  position
  author_principal_id
  content
  created_at
  produced_by_run_id?   // provenance only
}
```

同一 Run 可以产生 0..N 条 Message；一条 Agent Message 至多有一个来源 Run。没有 `message.kind = final`，也没有 `run.result_message_id`。

### 5.2 Run 应由谁结束

Run 是执行事实，不是 Agent 在共享空间中的工作状态。最佳权威链是：

```text
Runtime 产生 stop/exit/result
→ Runtime Adapter 规范化
→ Local Node 结束 Attempt 并提交 terminal evidence
→ Workspace 以 active execution lease / epoch + CAS 接受或拒绝
→ Run 进入 succeeded / failed / cancelled
```

Agent 不需要调用 `CompleteRunWithMessage`，也不应通过自然语言声明 Run 成功。Local Node/Adapter 报告的至少包括 stop reason 或 exit、错误、Attempt、实际 Runtime、usage 和日志引用。Run 成功只表示“本次授权执行正常结束”，不表示 WorkItem 完成或结果被接受。

### 5.3 WorkItem 与 Review 为什么必须用显式命令

Message 是陈述；状态命令是领域意图。Agent 写“任务完成了”只产生 Message。只有调用被 Workspace 授权的 `SubmitResult`、`BlockAssignedWorkItem`、`DecideReview` 等命令，相关共享状态才改变。

状态命令必须校验：

- 当前 actor、权限与授权来源；
- WorkItem 当前状态与 assignee；
- assignment epoch / expected version；
- policy version；
- active Child、Review、Request/Run 等前置条件；
- 幂等键。

这类结构化写入需要 fencing；普通 Message 不需要。

### 5.4 新消息为何应触发 freshness review，而不是语义裁决

Conversation 天然允许交叉发言，但 Agent 与 Human 的感知模型不同：Agent 通常读取快照、生成候选内容，再提交共享动作；生成期间同一 Discussion Scope 可能已经出现推翻假设、解决问题或改变方向的新 Message。由于 Message 不可删除，直接提交可能留下本可避免的过时或重复回复。

Workspace 能权威判断的只有“同一 Scope 是否推进”，不能判断新增内容是否让草稿在语义上失效。因此更稳健的规则是：

1. Run Context Snapshot 保持不可变，并记录 Agent 实际观察的 Discussion Frontier；
2. 若 Agent 发布时 frontier 未推进，Workspace 原子提交普通 Message；
3. 若 frontier 已推进，Workspace 不提交 Message，而是返回准确增量并要求 freshness review；
4. 候选内容作为 Agent 的 Held Draft 保留，它不是 Message，不推进 frontier，也不改变 Run 或 WorkItem；
5. Agent 读取增量后可以 revise、discard、原样重试，或在知情后显式 publish anyway；
6. 原样重试仍检查新 frontier，持续活跃时允许审计化 override 保证 liveness；
7. hold 不重新执行整个 Run，避免重复工具调用和外部副作用；
8. Runtime 支持 steer 时可提前投递新输入，未实际投递的显式 `@Agent` 输入形成后续 Agent Request。steer/follow-up 减少 hold，但不能覆盖发布前最后一个竞态窗口。

这不是系统宣布内容“已过期”或永久阻止发布，而是 mandatory review point：Workspace 暴露变化，Agent 做语义判断。结构化状态命令仍使用对象版本、assignment epoch 和 fencing；普通 Message 的 informed override 不能绕过这些规则。

Raft 官方将该机制称为 Held Draft，并提供 revise、send as-is、stay silent、send anyway 四条路径。[Raft Held Draft](https://raft.build/resources/blog/is-having-agents-in-the-room-meant-to-be-chaotic/#the-held-draft) 当前公开 `@botiverse/raft-daemon@1.0.16` 至少实现 target 级 freshness preflight，`@botiverse/raft@0.0.17` 将草稿短期保存在本地；未公开的上游服务是否以事务方式再次 compare-and-append 无法核验。[Raft daemon 发布包](https://unpkg.com/@botiverse/raft-daemon@1.0.16/dist/chunk-J5Y72PN7.js) [Raft CLI 发布包](https://unpkg.com/@botiverse/raft@0.0.17/dist/index.js)

## 6. 推荐领域设计

### 6.1 Message

- 只有一种 Message；发布后不可编辑、不可删除。
- 每个 Discussion Scope 有 Workspace 权威全序。
- Message 状态与 WorkItem/Review 状态完全分开。
- Agent Message 记录可选 `produced_by_run_id`、`produced_by_attempt_id`，用于审计和响应义务检查。
- `PostMessage` 是独立显式 Workspace 命令；不结束 Run，不改变 WorkItem。
- Agent `PostMessage` 携带其 observed Discussion Frontier；Workspace 原子返回 `published` 或 `freshness_review_required`。
- Held Draft 是未发布的 Agent 私有候选内容，不属于 Conversation，也不改变 Run/WorkItem。MVP 由 Local Node 耐久保存，Workspace 只保留可审计的 hold 决定和幂等结果；出现跨 Node 恢复需求后再提升为 Workspace 协调对象。
- Agent 可显式 revise、discard、confirm unchanged；publish-anyway 只表示复核后仍保留旧候选内容。任何发布仍要求最后已复核 frontier 为当前值，并重新检查身份、Scope 权限和 run capability。

### 6.2 Run / Attempt

- Run terminal state 由 Local Node 根据 Runtime Adapter outcome 上报，不由某条 Message 决定。
- Run 至少支持 `running → succeeded|failed|cancelled`；超时可作为 `failed` reason 或独立 `timed_out`，留到 Execution Model 统一决定。
- terminal write 使用 active Attempt/Execution Lease fencing 和 CAS；迟到结果不能覆盖已取消或已替换的 Run。
- 取消后撤销 run-scoped Workspace capability；旧 Runtime 可能仍物理运行，但不能再发布 Message 或执行状态命令。
- Run 成功不改变 WorkItem，也不创建 Submission/Review。

### 6.3 不引入 Response Obligation

讨论后，本项目明确不增加 `response_policy`、`response_outcome` 或 `no_response` 状态。理由是：Run terminal outcome 和普通 Message 已经分别形成可查询事实；某个 Run 是否发布过 Message可以通过 provenance 派生观察，不需要再复制一套容易与真实消息流漂移的权威状态。

因此，Run 可以产生 0..N 条普通 Message。没有 Message 不自动成为失败、重试或新请求，也不触发系统替 Agent 发布 Runtime 输出。若未来真实产品问题证明仅靠查询不足，应以新的需求和 ADR 重新评估，而不是在当前模型预埋状态。

### 6.4 WorkItem / Submission / Review

- WorkItem 只通过已经确认的显式命令和 Completion Policy 改变。
- Agent 自然语言不触发状态变化。
- Result Submission 显式引用 1..N 个普通 Message 和/或 Artifact；Message 不因此变成 result 类型。
- Review 显式引用 Submission；Review feedback Message 与 Review decision 是否原子提交，仍可保持先前已确认的规则，因为那是一个闭合业务意图，而不是 Run completion。
- Reassign、Cancel、SubmitResult、DecideReview、automatic completion 使用 assignment/policy/version fencing。

## 7. 建议修改当前架构基线

以下是设计建议，不是本次调研已执行的文档修改：

1. 删除 `Final Message` 领域对象及“每个成功 Run 必须有 Final Message”不变量。
2. 修订 ADR 0021：删除 Final Message 与 Run success 的耦合，保留基于 Discussion Frontier 的 Agent Message freshness review。
3. 将 Publication Hold 重命名并收窄为 `Freshness Review Required`：只说明同一 Scope 已推进，不判断候选内容必然过期，也不永久禁止发布。
4. 将 Run success 改为“Local Node 依据 Runtime Adapter terminal outcome，经 Workspace fencing/CAS 提交”。
5. 增加 Message → Run/Attempt 的可选 provenance。
6. 不增加 response obligation 状态；仅允许通过 Message provenance 查询一个 Run 实际发布了什么。
7. 新显式 `@Agent` 输入在 active Run 期间采用 `steer if delivered, otherwise durable follow-up`；普通无 mention Message 只进入讨论，不自动触发执行。
8. WorkItem、Submission、Review、Assignment 等结构化命令继续使用各自版本与 fencing；不能用 Message 的 publish-anyway 绕过。
9. 删除 `ContinueWorkWithAgent`；新的明确 `@Agent` Message 仍是新协作轮次的统一入口。

## 最终判断

用户的判断成立：

> Agent 在 Conversation 中只发布普通 Message；Run 的结束由执行层记录；WorkItem、Submission 和 Review 只通过显式命令改变。无需 Final Message，也无需 CompleteRunWithMessage。

需要补上的不是“final 消息”，而是两个正交机制：

- 用 `produced_by_run_id` 观察一个 Run 实际发布的普通 Message，不另建 silent-completion 状态；
- 用 Inbox/steer/follow-up 处理运行期间的新输入，并用 Held Draft freshness review 覆盖发布前最后一个竞态窗口。

这样既保留 Conversation 的自然语义，也保留可靠执行、审计和并发安全，而且不会把 Runtime 成功、用户可见回复和团队工作完成错误地合并为同一个事实。
