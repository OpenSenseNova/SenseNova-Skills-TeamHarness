# Buzz、Raft、Multica：Agent 触发、调度与结果回传对比

> 调研日期：2026-08-11（Asia/Shanghai）  
> 资料范围：仅使用项目官方仓库、官方文档、官方发布包与源码。本文中的“文档明确”与“源码实现”分开标注；没有公开源码的部分不作内部实现推断。

## 核查基线

- **Buzz**：[`be48ce98bd163899197b79a82ad5b2bcf0bc9b54`](https://github.com/block/buzz/commit/be48ce98bd163899197b79a82ad5b2bcf0bc9b54)，提交时间 2026-08-11 03:27:30 UTC；当时最新 release 为 `desktop-v0.5.9`。
- **Raft docs**：[`f6ea2ad3a640c54fd7044103e936f4c156461a46`](https://github.com/botiverse/raft-docs/commit/f6ea2ad3a640c54fd7044103e936f4c156461a46)，提交时间 2026-08-11 08:44:27 +08:00；**external agent bridge**：[`72c31894f933b9aa9243195d038d66ee79589593`](https://github.com/botiverse/raft-external-agents/commit/72c31894f933b9aa9243195d038d66ee79589593)；官方 CLI `@botiverse/raft@0.0.17`（2026-07-09，npm shasum `cedd5c23255288db1636a3248310fcea331aecbf`）。Raft 的 managed server/daemon 核心源码未公开，因此该部分只能依据官方文档和发布版 CLI。
- **Multica**：[`84a02cc2acb2b21cfa04a58c6adc141c769000da`](https://github.com/multica-ai/multica/commit/84a02cc2acb2b21cfa04a58c6adc141c769000da)，提交时间 2026-08-11 16:22:51 +08:00。

## 结论总览

| 项目 | `@` 之外的主要触发 | 触发后的承载模型 | 明确的处理顺序 | 完成结果如何进入共享 workspace |
|---|---|---|---|---|
| **Buzz** | DM、thread reply；配置为订阅全部/关闭 mention filter 后的频道或任意选定 event kind；论坛事件；周期 heartbeat | **本机 harness 内存队列**，不是 durable inbox/task queue | 每频道串行；跨频道选 head `received_at` 最早者；单批最多 50，批内按 event `created_at` 稳定排序；多 worker 时跨频道并行 | 正常成功必须由 agent 用 Buzz CLI/工具发布签名消息；ACP 的 final/`stopReason` 不会自动变成频道消息 |
| **Raft** | 已加入频道的新消息、DM、followed thread reply、reminder、task/request；human start/restart 属于进程控制 | **可查询 inbox**；wake 与正文分离，agent 主动 `message check` 拉取/ack | 拉取结果按全局 `seq` 升序；没有公开的 `mention > DM > thread > task` 硬优先级；task 还要先 claim | 显式发回原 channel/thread/DM；external agent 明确用 Raft CLI/API；不会自动把 runtime 最后一段输出当 workspace 结果 |
| **Multica** | issue 分配/创建、`backlog` 提升、无 `@` 的评论隐式路由、direct chat、autopilot 的 schedule/webhook/manual，以及 retry/rerun/阶段完成等系统唤醒 | **PostgreSQL durable task queue**；daemon claim，不是 agent inbox | 先 stale recovery，再 claim；同 agent 内 `priority DESC, created_at ASC, id ASC`；同 issue+agent 串行，不同 agent 可并行 | Issue run 的规范路径是 agent 用 `multica issue comment add`；当前实现若 agent 沉默，会从 final output 自动补一条 comment。Chat final 自动写 assistant message |

一句话概括：**Buzz 是 event-driven local harness，Raft 是 inbox-driven conversation agent，Multica 是 durable task-queue-driven work agent。**

## 1. Buzz

### 1.1 Agent 有哪些触发形式

**文档明确：** 默认监听的是带该 agent Nostr pubkey `p` tag 的 relay event，也就是产品层的 `@mention`。默认 event kinds 包括 stream message `9`、workflow approval requested `46010`、stream reminder `40007`；收到后会形成一次 ACP prompt。[默认工作流与 event kinds](https://github.com/block/buzz/blob/be48ce98bd163899197b79a82ad5b2bcf0bc9b54/crates/buzz-acp/README.md#L251-L262) [配置默认值](https://github.com/block/buzz/blob/be48ce98bd163899197b79a82ad5b2bcf0bc9b54/crates/buzz-acp/src/config.rs#L1262-L1279)

除基本 `@` 外，可确认的入口是：

1. **DM 和 thread reply**。它们会触发，但协议上通常仍由客户端自动添加 `p` tag，所以不是另一套 dispatcher。DM 还有更严格的 owner/same-owner sibling gate。[author gate 覆盖范围](https://github.com/block/buzz/blob/be48ce98bd163899197b79a82ad5b2bcf0bc9b54/crates/buzz-acp/README.md#L132-L160) [DM gate 源码](https://github.com/block/buzz/blob/be48ce98bd163899197b79a82ad5b2bcf0bc9b54/crates/buzz-acp/src/lib.rs#L218-L257)
2. **无需 mention 的 event subscription**：`--subscribe all`、`--no-mention-filter`，或规则中设置 `require_mention=false`，再按 channel、kind 和表达式筛选。[订阅模式与规则配置](https://github.com/block/buzz/blob/be48ce98bd163899197b79a82ad5b2bcf0bc9b54/crates/buzz-acp/src/config.rs#L50-L55) [CLI flags/defaults](https://github.com/block/buzz/blob/be48ce98bd163899197b79a82ad5b2bcf0bc9b54/crates/buzz-acp/src/config.rs#L324-L359)
3. **论坛事件**：可显式订阅 post、vote、comment reply 等 kinds；官方示例特别说明它们通常不带 agent mention，因此要关闭 mention filter。[forum subscription](https://github.com/block/buzz/blob/be48ce98bd163899197b79a82ad5b2bcf0bc9b54/crates/buzz-acp/README.md#L223-L249)
4. **周期 heartbeat self-prompt**：没有外部消息也能定时唤醒；heartbeat 低于真实 event，所有 worker 忙时会丢弃，并限制全局一个 in-flight。[heartbeat](https://github.com/block/buzz/blob/be48ce98bd163899197b79a82ad5b2bcf0bc9b54/crates/buzz-acp/README.md#L204-L217)

`!cancel`、`!rotate`、`!shutdown` 是 owner 发给 harness 的控制命令，会被 harness 消费，不应算作 agent 任务。[control commands](https://github.com/block/buzz/blob/be48ce98bd163899197b79a82ad5b2bcf0bc9b54/crates/buzz-acp/README.md#L150-L160) Buzz 的 YAML workflow 还支持 message/reaction/schedule/webhook triggers，但它们是 workflow 触发器；只有 workflow 产出的 event 再命中 agent subscription 时，才构成 agent trigger，不能直接等同。

### 1.2 直接执行还是 inbox；顺序是什么

Buzz **有队列，但没有 durable agent inbox/task object**。源码路径是：relay event → author gate → subscription/rule filter → per-channel `EventQueue` → worker → ACP `session/prompt`。[gate、match、enqueue、dispatch](https://github.com/block/buzz/blob/be48ce98bd163899197b79a82ad5b2bcf0bc9b54/crates/buzz-acp/src/lib.rs#L2437-L2567)

队列和顺序的源码实现为：

1. 每个 channel 一条 `VecDeque`，同一 channel 最多一个 in-flight prompt；
2. 空闲 worker 从各 channel 的 head 中选择 `received_at` 最早者；
3. 从这个 channel 一次取最多 50 个 event；
4. 批内按 event `created_at` 做稳定升序排序，再合并成一个 prompt；
5. 失败指数退避，10 次后 dead-letter，并由 harness 发可见失败通知。

[queue 状态机](https://github.com/block/buzz/blob/be48ce98bd163899197b79a82ad5b2bcf0bc9b54/crates/buzz-acp/src/queue.rs#L92-L135) [选择 channel、批处理与排序](https://github.com/block/buzz/blob/be48ce98bd163899197b79a82ad5b2bcf0bc9b54/crates/buzz-acp/src/queue.rs#L254-L360) 多 worker 可跨 channel 并行，所以不保证跨 channel 顺序。[worker pool 语义](https://github.com/block/buzz/blob/be48ce98bd163899197b79a82ad5b2bcf0bc9b54/crates/buzz-acp/README.md#L204-L206)

这是**进程内内存队列**：queue、in-flight、dedup/cursor 都不构成持久 task claim。首次订阅默认从 `now` 开始，重连靠时间水位回看，但进程崩溃后不能把它视为有 durable lease/attempt 的任务队列。[重连水位](https://github.com/block/buzz/blob/be48ce98bd163899197b79a82ad5b2bcf0bc9b54/crates/buzz-acp/src/relay.rs#L3170-L3211)

当前 mid-turn 默认策略还不是简单“等当前做完”：默认 `steer`，能原生 steer 就把新消息注入当前 turn；不支持时 cancel 当前 turn，再把旧+新内容合并重发。另有 `queue`、`interrupt`、`owner-interrupt`。[策略定义与默认值](https://github.com/block/buzz/blob/be48ce98bd163899197b79a82ad5b2bcf0bc9b54/crates/buzz-acp/src/config.rs#L63-L85) [运行分支](https://github.com/block/buzz/blob/be48ce98bd163899197b79a82ad5b2bcf0bc9b54/crates/buzz-acp/src/lib.rs#L2518-L2560)

### 1.3 完成后如何返回结果

正常成功时，**ACP final/`stopReason` 只表示本地 turn 结束，不会被 harness 自动镜像成 Buzz 频道消息**。官方流程明确要求 agent 通过 Buzz CLI 的 `send_message` 等能力操作 Buzz。[How It Works](https://github.com/block/buzz/blob/be48ce98bd163899197b79a82ad5b2bcf0bc9b54/crates/buzz-acp/README.md#L251-L258) 基础 prompt 更明确要求“值得共享的内容必须 publish”，使用 `buzz messages send`；reasoning、tool calls 和仅留在 runtime 的 final 都对频道不可见。[base prompt](https://github.com/block/buzz/blob/be48ce98bd163899197b79a82ad5b2bcf0bc9b54/crates/buzz-acp/src/base_prompt.md#L58-L78)

因此 Buzz 的成功交付是：**agent 主动用 CLI/等价 Buzz-facing tool 发布签名 relay event**。例外是终止性失败或重试耗尽，harness 自己会发 failure notice；这不是正常结果的自动回传。

## 2. Raft

### 2.1 Agent 有哪些触发形式

官方文档可确认：

1. **已加入频道的任意新消息**，不是只有 `@`；`@` 是 attention signal，不是 delivery filter。[messages](https://github.com/botiverse/raft-docs/blob/f6ea2ad3a640c54fd7044103e936f4c156461a46/content/features/messaging/messages/index.md#L11-L17) [agent lifecycle](https://github.com/botiverse/raft-docs/blob/f6ea2ad3a640c54fd7044103e936f4c156461a46/content/features/agents/lifecycle/index.md#L24-L31)
2. **公开频道中的 `@mention`**：agent 即使尚未 join，也能收到 mention，但 mention 本身不自动 join；join 后才持续收到普通消息。[channels](https://github.com/botiverse/raft-docs/blob/f6ea2ad3a640c54fd7044103e936f4c156461a46/content/features/messaging/channels/index.md#L84-L86)
3. **DM**：human→agent 和 agent→agent 均支持，DM always notify。[DMs](https://github.com/botiverse/raft-docs/blob/f6ea2ad3a640c54fd7044103e936f4c156461a46/content/features/messaging/dms/index.md#L19-L24)
4. **followed thread 的 reply**：参与 thread 或在 thread 被 mention 后会 follow，后续 reply 继续通知。[threads](https://github.com/botiverse/raft-docs/blob/f6ea2ad3a640c54fd7044103e936f4c156461a46/content/features/messaging/threads/index.md#L24-L32)
5. **reminder 到点**：支持一次性和周期性 reminder，只唤醒创建它的 agent，并在锚定 message/thread 上产生 system notification。[reminders](https://github.com/botiverse/raft-docs/blob/f6ea2ad3a640c54fd7044103e936f4c156461a46/content/features/agents/reminders/index.md#L7-L38)
6. **task/request**：task 是带 number/status/owner 的 message，进入协作流；agent 看到后还需 claim。不能把“新建任意未认领 task”理解为无条件广播执行给所有 agent。[tasks](https://github.com/botiverse/raft-docs/blob/f6ea2ad3a640c54fd7044103e936f4c156461a46/content/features/collaboration/tasks/index.md#L51-L61)

human 手动 start/restart 也能激活进程，但属于生命周期控制，不是 workspace 工作信号。发布版 CLI 的 managed inbox flag 枚举是 `mention | thread | dm | task`，可在固定发行包 [`@botiverse/raft@0.0.17`](https://unpkg.com/@botiverse/raft@0.0.17/dist/index.js) 中的 `daemonApiContract.ts` bundle 段核验。

### 2.2 直接执行还是 inbox；顺序是什么

Raft **明确有 inbox**。官方设计说明把 mention、thread update 和其他 notification 变成 queryable inbox item；agent 空闲时主动 pull，判断哪些与当前任务有关、哪些应该进入 context，未 pull 的仍可查询。[Agent Inbox](https://raft.build/resources/blog/is-having-agents-in-the-room-meant-to-be-chaotic/#the-agent-inbox) Activity 文档也说明 check 时看到上次 check 后累积的内容。[activity](https://github.com/botiverse/raft-docs/blob/f6ea2ad3a640c54fd7044103e936f4c156461a46/content/features/messaging/activity/index.md#L46-L53)

可确认的执行链是：

1. 消息/通知成为 inbox target，runtime 收到 wake；
2. wake 不携带正文；external plugin 只注入“请运行 `raft message check`”的提醒；
3. `message check` 分批 drain `/events`、ack delivered seq，汇总后按 message `seq` 升序交给 agent；
4. agent 自己判断是否相关、是否回应；官方没有定义 `mention > DM > thread > task` 的硬编码执行优先级；
5. task 要先 claim；claim 成功才开工，失败说明被别人抢先，继续处理别项；完成后进入 `in review`，human 验收后才 `done`。

[content-free wake contract](https://github.com/botiverse/raft-external-agents/blob/72c31894f933b9aa9243195d038d66ee79589593/docs/wake-endpoint-contract.md#L14-L33) [plugin wake 注入](https://github.com/botiverse/raft-external-agents/blob/72c31894f933b9aa9243195d038d66ee79589593/plugins/raft-channel/src/index.ts#L31-L47) [wake 文本要求 check](https://github.com/botiverse/raft-external-agents/blob/72c31894f933b9aa9243195d038d66ee79589593/plugins/raft-channel/src/wake.ts#L208-L231) [task claim 流程](https://github.com/botiverse/raft-docs/blob/f6ea2ad3a640c54fd7044103e936f4c156461a46/content/features/collaboration/tasks/index.md#L77-L90)

External plugin 对 burst 的第一条 wake 立即注入，随后窗口内合并；默认 debounce 1000 ms、最多 20 条。[batch/debounce](https://github.com/botiverse/raft-external-agents/blob/72c31894f933b9aa9243195d038d66ee79589593/plugins/raft-channel/src/wake.ts#L151-L205) 这只是 wake 合并，不是业务任务优先级。Raft managed 内部 scheduler 没有公开源码，不能进一步声称它如何持久化 inbox、如何选择进程或是否有额外优先级。

### 2.3 完成后如何返回结果

Raft 的协作契约是**显式把结果提交回 conversation surface**：task 的讨论、进度和结果都写在 task thread；agent 完成后 post result 并置为 `in review`，human review 后才 `done`。[task thread](https://github.com/botiverse/raft-docs/blob/f6ea2ad3a640c54fd7044103e936f4c156461a46/content/features/collaboration/tasks/index.md#L59-L61) [handoff walkthrough](https://github.com/botiverse/raft-docs/blob/f6ea2ad3a640c54fd7044103e936f4c156461a46/content/hand-off-your-first-task/index.md#L60-L80)

External agent 必须用 `raft message send --target ...` 或等价 API；wake adapter 明确不负责 outbound。[external wake contract](https://github.com/botiverse/raft-external-agents/blob/72c31894f933b9aa9243195d038d66ee79589593/docs/wake-endpoint-contract.md#L20-L33) [external agent CLI workflow](https://github.com/botiverse/raft-docs/blob/f6ea2ad3a640c54fd7044103e936f4c156461a46/content/features/agents/external/index.md#L88-L108) Managed agent 对用户表现为直接在 workspace 回消息，但其内部是否调用 CLI 未公开；准确说法是使用 Raft 的消息能力/API，而不是“必然 CLI”。Raft 没有公开契约说会自动截取 runtime 最后一段 stdout/final 作为共享结果。

## 3. Multica

### 3.1 Agent 有哪些触发形式

官方 README 把核心入口直接列为 **assign issue、autopilot、chat**，并说明 agent 会自行 pick up、评论和交回 review。[README](https://github.com/multica-ai/multica/blob/84a02cc2acb2b21cfa04a58c6adc141c769000da/README.md#L43-L76)

结合当前源码，可确认以下入口：

1. **Issue 分配/创建**：创建时已分给 agent/squad 且不是 `backlog`，或把 assignee 改成 agent/squad，会 enqueue；`backlog` 只是停车场。
2. **Issue 状态提升**：已分配 issue 从 `backlog` 进入非 `done/cancelled` 状态才启动。[统一 issue trigger predicate](https://github.com/multica-ai/multica/blob/84a02cc2acb2b21cfa04a58c6adc141c769000da/server/internal/service/issue_trigger.go#L64-L134)
3. **显式 `@agent` / `@squad` comment**：agent 直接跑，squad 解析为 leader 跑；`@member`、`@issue` 不跑 agent，`@all` 本身不跑任何 agent。
4. **没有 `@` 的 comment 隐式路由**：member 顶层评论可唤醒 issue assignee；直接回复 agent 可唤醒 parent author；已有 agent conversation owner 的 thread 会续接。member→member reply 且没有 agent owner 时不 fallback 到 assignee；`@all` 抑制这些隐式路由。[comment routing](https://github.com/multica-ai/multica/blob/84a02cc2acb2b21cfa04a58c6adc141c769000da/server/internal/handler/comment.go#L2594-L2693)
5. **Direct chat**：用户发 chat turn 会创建 chat task；它不是 issue comment 的一个别名。[Chat 产品入口](https://github.com/multica-ai/multica/blob/84a02cc2acb2b21cfa04a58c6adc141c769000da/README.md#L65-L67)
6. **Autopilot**：`schedule`、`webhook`、`manual`；先生成 durable `autopilot_run`，`create_issue` 模式再走 issue/task，`run_only` 直接创建 task。[官方内建 autopilot 契约](https://github.com/multica-ai/multica/blob/84a02cc2acb2b21cfa04a58c6adc141c769000da/server/internal/service/builtin_skills/multica-autopilots/SKILL.md#L12-L38)
7. **系统性后续运行**：自动 retry、human rerun、评论在执行期间漏交付后的 completion reconciliation、squad member 结果唤醒 leader、child/stage 完成唤醒 parent assignee。它们是已有工作状态机产生的 follow-up，不是新的用户触发语法。

Slack/Lark/DingTalk/WeCom 等 channel、quick action/quick create 是外部或 UI 入口；最终仍汇入 issue/comment/chat/autopilot 的 task enqueue，不形成另一套执行顺序。

### 3.2 直接执行还是 inbox；顺序是什么

Multica 不是“发消息后直接调用 agent”，也不是给 agent 一个可自行挑选的 inbox；它会持久化 `agent_task_queue`，再通知 runtime 所在 daemon 去 claim。enqueue 后的观察顺序也被源码固定为：**先 broadcast `task:queued`，再 notify daemon**，避免 UI 先看到 dispatch。[enqueue 顺序](https://github.com/multica-ai/multica/blob/84a02cc2acb2b21cfa04a58c6adc141c769000da/server/internal/service/task.go#L1165-L1182)

Claim 的核心逻辑：

1. daemon poll/WS RPC 到来时先 promote 到期 deferred task；
2. 优先 reclaim 丢失 claim response、lease 已过期的 stale `dispatched` task；
3. 检查 agent 的 `max_concurrent_tasks`；
4. 对该 agent 的 claimable task 按 `priority DESC, created_at ASC, id ASC` 选一个，并用 `FOR UPDATE SKIP LOCKED` 原子改为 `dispatched`；
5. daemon 准备本地目录/上下文后标 `running`，执行本地 CLI；完成后回调 `completed`/`failed`/`cancelled`。

[runtime claim/recovery](https://github.com/multica-ai/multica/blob/84a02cc2acb2b21cfa04a58c6adc141c769000da/server/internal/service/task.go#L2856-L3068) [SQL 选择顺序与锁](https://github.com/multica-ai/multica/blob/84a02cc2acb2b21cfa04a58c6adc141c769000da/server/pkg/db/queries/agent.sql#L598-L636)

并发规则不是全局 FIFO：同一 **agent + issue** 串行，同一 chat session 串行；不同 agent 可以并行处理同一 issue。agent 自身还受 `max_concurrent_tasks` 限制。重复 mention/comment 可能 coalesce 到已有 pending task，而不是再开一条 run。

Multica 的 **Inbox 是给 human 的通知面**；Agent 的工作承载是 DB task queue。WebSocket/本机通知负责低延迟唤醒，数据库 row + claim/lease 才负责正确性。

### 3.3 完成后如何返回结果

需要分 surface 回答：

- **Issue task 的规范路径**：runtime prompt 明确要求 agent 在 turn 退出前用 `multica issue comment add` 发布最终结果；terminal output/run log 对用户不可见。[runtime workflow](https://github.com/multica-ai/multica/blob/84a02cc2acb2b21cfa04a58c6adc141c769000da/server/internal/daemon/execenv/runtime_config_sections.go#L546-L558) [output contract](https://github.com/multica-ai/multica/blob/84a02cc2acb2b21cfa04a58c6adc141c769000da/server/internal/daemon/execenv/runtime_config_sections.go#L719-L727)
- **当前实现有 safety net**：daemon 仍把 final output 存入 task result；若一次 completed issue task 从 started_at 起没有任何该 agent comment，server 会从 final output 自动合成一条 comment。comment-triggered task 会回到原 thread，assignment-triggered task 发 top-level；若 agent 已经用 CLI 发过，就不重复。[completion fallback](https://github.com/multica-ai/multica/blob/84a02cc2acb2b21cfa04a58c6adc141c769000da/server/internal/service/task.go#L3585-L3634)
- **Chat task**：completion transaction 自动写唯一 assistant outcome row，再广播 `chat:done`，所以 chat 是 runtime final 自动进入共享 chat surface。[chat completion](https://github.com/multica-ai/multica/blob/84a02cc2acb2b21cfa04a58c6adc141c769000da/server/internal/service/task.go#L3490-L3550)
- **Issue status** 不由 `CompleteTask` 自动改；agent 按 ownership workflow 用 CLI 改 `in_progress`/`in_review`/`blocked`。因此 task completed 不等于 issue done/review accepted。

所以对问题 3 最准确的回答不是二选一：**Multica 以 CLI comment 为主交付契约，同时在当前版本对 silent issue run 自动补 final-output comment；chat 则原生自动回传。**

## 最终判断

如果关注“agent 被叫到之后系统到底做什么”，三者可以归为三种不同协议：

1. **Buzz**：event 命中规则就进入本机有界队列，随后直接驱动 ACP turn；协作输出必须再次 publish 为共享 event。
2. **Raft**：notification 只负责 wake，正文留在 inbox；agent check、判断、必要时 claim，再把结果显式写回 conversation。
3. **Multica**：每次触发先形成 durable task；daemon 按明确优先级、并发和 serialization 规则 claim/执行；issue 结果以 comment 为交付面，并有 final-output fallback。

如果要设计“共享 workspace 中的可靠 agent 工作协议”，**Raft 的 inbox 适合开放式会话注意力，Multica 的 durable queue 适合可恢复任务，Buzz 的 queue 适合低延迟事件助手但不能直接当可靠任务队列。**
