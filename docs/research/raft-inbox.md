# Raft Agent Inbox 策略调研

> 调研对象：[Raft](https://raft.build/zh-cn/) 的 Agent Inbox  
> 调研日期：2026-08-11（Asia/Shanghai）  
> 证据范围：Raft 官方博客/文档、Botiverse 官方公开仓库，以及官方发布的 CLI 包。文中“**官方明确**”是产品材料直接表述；“**分析推断**”是基于材料的归纳，不代表官方承诺。

## 结论

Raft Inbox 解决的不是“如何让 Agent 收到更多消息”，而是：**一个按 turn 运行、上下文有限的 Agent，怎样待在持续流动的多人频道里，又不让频道流量控制自己的注意力。**

传统群聊把频道消息直接 push 给 Agent，只有两个坏选项：全部处理，让闲聊挤占任务、指令和中间推理；或只响应 @mention，虽然安静，却失去发现错误假设、误路由指令和主动介入的能力。Raft 在频道与工作 prompt 之间加入可查询 Inbox：消息先积累为待处理信号，Agent 有带宽时再拉取、判断、摄取；未拉取的信号不进入当前上下文，但以后仍可查询。[官方博客：Agent 收件箱][blog]

一句话说，它把**不可控的 prompt push**改成了**可查询信号 + 可恢复唤醒 + Agent 主动 pull**。

## 为什么需要它

**官方明确：**人类在房间里有连续感知，能感到对话节奏和他人是否已回答；Agent 通常是“读取快照 → 推理 → 提交动作 → 等待下一次调用”。推理期间房间仍在变化，因此容易重复回复、重复领任务或基于过期状态发言。[官方博客：为什么会这样][blog]

规则式过滤并未消除这个缺口。只允许被 @ 的 Agent 行动，会把它重新变成等待调用的工具；放开限制，又会让多个 Agent 同时响应。Inbox 的选择是：**保留较宽的可见性，但延迟正文进入上下文，由 Agent 在当前任务语境下做软判断。**前半句是官方设计，后半句是本文的分析归纳。[官方博客：AX 与 Inbox][blog]

## 核心机制

```text
频道 / 线程 / DM / 任务信号
          │
          ▼
  可查询的 Agent Inbox
          │
          ├── content-free wake hint ──→ 唤醒 runtime
          │
          └── Agent 主动 check ───────→ 拉正文、推进投递进度
                                         │
                                         ├── 处理 / 回复
                                         ├── 稍后再看
                                         └── 保持沉默
```

1. **信号先累积，不直接注入 prompt。** Inbox 覆盖 @mention、thread 更新和其他通知；公共 Activity 文档还说明，Agent 检查时会看到自上次检查以来累积的消息。[官方博客][blog] [Activity 文档][activity]
2. **先 peek，再 drain。** 官方 CLI `raft inbox check` 只返回按 target 聚合的 pending 摘要，不读取正文；`raft message check` 才 drain Inbox，并在返回前确认已投递序号。当前 `inbox check` 仅用于 managed daemon runner，外部 Agent 使用 `message check`。[官方 CLI `@botiverse/raft@0.0.17`][cli]
3. **唤醒与正文分离。** 外部 Agent 的 bridge 接收不含正文的 wake hint；runtime 只得到一条固定提醒，随后 Agent 以自身身份运行 `raft message check` 拉取正文。wake contract 明确禁止携带正文、频道名、发送者或 snippet。[External Agents 文档][external] [wake contract：职责和请求][contract]
4. **唤醒成功不等于消息已消费。** 成功 POST 只证明提醒已进入或排队进入 Agent 可见上下文，不证明模型处理了它，也不推进 delivery、read 或 `model_seen` cursor；失败的 hint 会保留供回放和 reconciliation 重试。[插件 README][plugin] [wake contract：响应][contract]
5. **合并 wake，而不是合并业务消息。** Claude Code 插件对突发 wake 做 leading-edge debounce：第一条立即注入，窗口内后续提醒合并；一次 `message check` 再 drain 全部待处理项。这样减少重复模型 turn，同时不把提醒合并误当成正文消费。[插件 README][plugin] [`DebouncedWakeNotifier` 源码][debounce]

Inbox 处理入站注意力；Raft 的 Held Draft 处理出站竞态：发送时若房间已变化，草稿会被 hold，Agent 可修改、原样重试、沉默或显式绕过。两者共同把“读不读、发不发”的隐式判断做成 Agent 可操作的界面。[官方博客：Held Draft][blog]

## Held Draft 实施细节

### 先说结论：它是“乐观并发检查 + 本地草稿状态”，不是服务端草稿编辑器

**官方明确：**每次发送都带一个“这份草稿基于房间哪个版本写成”的 marker；消息到达时比较 marker 和当前状态，未变化则提交，变化则 hold，并把撰写期间到达的新内容摘要交回 Agent。直接发送旧稿仍会再次检查；只有 informed override 才绕过检查。[官方博客：Held Draft][blog]

**公开实现证据：**当前 Agent API 把这个 marker 具体化为 target 级消息序号 `seenUpToSeq`。发送体还可含 `sendDraft`、`continueAnyway`、`draftReholdCount`、`draftReplacedExisting` 和可选的 `idempotencyKey`。最新版公开 daemon 在把 `/internal/agent-api/send` 转发到上游前，先运行本地 Inbox side-effect preflight；若判定应 hold，它直接返回 HTTP 200 的 `state: "held"`，本次发送根本不会转发到上游。[`@botiverse/raft-daemon@1.0.16` Inbox 状态机][daemon-state] [daemon 内嵌 CLI/Agent API schema][daemon-cli]

因此，博客所说的“服务器比较”是产品语义；公开的当前 managed-agent 路径至少有一层比较发生在本机 daemon。上游 Raft 服务是否还执行同样或更强的原子 compare-and-commit，源码未公开。

```text
message check / message read / 上一次 hold
                 │
                 └── target 的 seenUpToSeq
                              │
Agent 生成正文 ──→ CLI 预存本地 draft ──→ POST /send
                                             │
                                      daemon freshness preflight
                                      ├─ 无未看变化 → 转发并发送
                                      └─ 有未看变化 → 不转发，返回 held
                                                               │
                                    保存新边界 + 最多 3 条上下文 + 四种后续选择
```

### 1. 比较的到底是什么

公开 daemon 的判定粒度是**精确 target**，即某个频道、DM 或线程，而不是把整个 workspace 做一次版本相等比较：

1. 取该 target 在 daemon Inbox 缓存中的 pending 消息。
2. 每条消息若由 Agent 自己发送，或其 `seq` 不高于 daemon 记录的 model-visible 连续边界，或其 message id 已被记录为可见，则视为已看过。
3. 有未看 pending 消息时返回 `local_hold`；hold 上下文默认只展示最新 3 条。
4. 没有 pending 且已有 `seenUpToSeq`/model-visible 边界时直接 forward。
5. 第一次触达某 target、既无边界又无 pending 时，daemon 会向历史接口读取最近 3 条；若仍有未看内容，返回 `syncing_hold`，要求先审阅同步上下文。
6. 如果 pending 消息缺少可形成边界的有效 `seq`，公开状态机会 fail open、继续 forward，而不是无限阻断。[daemon Inbox 状态机：`planAgentInboxSideEffect`、`planFirstTouchRecentContext`][daemon-state]

这里有两个容易混淆的 cursor：`seenUpToSeq` 是 CLI 随发送携带的“我写草稿时已审阅到哪里”；Inbox 的 delivery/ack cursor 证明消息已被接口投递，不等价于模型已看到。daemon 另外维护 Agent-visible ledger，用 target 的连续 seq 边界和离散 message-id 集合作为 freshness 证据。[daemon `AgentVisibleDeliveryLedger`][daemon-state] [wake contract：cursor 边界][contract]

### 2. hold 返回什么，草稿保存在哪里

一次 freshness hold 的公开响应可包含：

- 判定：`state: "held"`、`subtype: "freshness"`、`decision`（`local_hold`/`syncing_hold`）、`reason`、`producerFactId`；
- 上下文：`heldMessages`、`newMessageCount`、`shownMessageCount`、`omittedMessageCount`，以及 mention 计数；
- 新边界：`seenUpToSeq`（schema 还接受 `seenUpToMessageId`）；
- 操作提示：`available_actions`、`continueAnywaySuggested`。[daemon held-response schema 与 projector][daemon-state]

但正文草稿不是以 `draftId` 保存到公开服务端 API。当前 CLI 在本机 JSON 中按 `agentId → target` 保存一份草稿，字段是 `content`、`attachmentIds`、`savedAt`、`reholdCount`、`seenUpToSeq`；默认路径位于系统临时目录下的 `slock-cli-attested-send/<agentId>/continue-state.json`，也可用 `SLOCK_CLI_DRAFT_STATE_DIR` 改根目录。每个 target 只有一份，TTL 为 10 分钟，过期检查是下次读取时惰性执行。[daemon 内嵌 CLI：`_continueDraftState`][daemon-cli]

当前 daemon 内嵌 CLI 会在普通发送发起网络请求**之前**先落这份本地草稿；hold 时更新边界并把 `reholdCount` 加一；收到 `state: "sent"` 后删除。这样网络超时留下的是“结果未知但正文仍在”的可恢复状态。独立发布的 `@botiverse/raft@0.0.17` tarball 较早构建只在收到 hold 后保存；两者虽都标为 CLI 0.0.17，managed daemon 的内嵌构建包含较新的预存与诊断逻辑。本文描述实际 managed 路径时以 `@botiverse/raft-daemon@1.0.16` 的内嵌 CLI 为准。[独立 CLI 0.0.17][cli] [daemon 1.0.16 内嵌 CLI][daemon-cli]

### 3. 四条后续路径如何触发

| 选择 | CLI 触发 | 实际重试语义 |
|---|---|---|
| 修改（revise） | 用新正文再次执行普通 `raft message send --target <target>` | 旧 draft 被同 target 的新正文替换；请求继承旧 draft 的 `seenUpToSeq` 和 `reholdCount`，并标记 `draftReplacedExisting`。仍可能再次 hold。 |
| 原样发送（send as-is） | `raft message send --send-draft --target <target>`，不传 stdin | 从本地恢复正文和附件 id，发送 `sendDraft: true`，仍走 freshness preflight；房间又变化就再次 hold、刷新 `savedAt`、递增 `reholdCount`。`--send-draft` 不能同时加新附件。 |
| 沉默（stay silent） | 不再执行命令 | 没有“silence” API，也没有公开的 `draft discard` 命令；10 分钟后 draft 在下次读取时过期并被清掉。 |
| 强制发送（send anyway） | `raft message send --send-draft --anyway --target <target>` | 发送 `continueAnyway: true`；daemon 状态机首先走 `continue_anyway_bypass` 并转发。它要求已有 saved draft，但 CLI 本身不强制“至少 hold N 次”。 |

命令和字段均来自公开 CLI；“反复 hold 后才建议强制发送”是官方产品指导，不是当前 CLI 的本地硬门槛。`draftReholdCount` 会上传，response schema 也有 `continueAnywaySuggested`，但公开 daemon 的本地判定没有使用前者，也没有公开后者的阈值；该策略可能位于未公开的上游服务。[官方博客][blog] [daemon 内嵌 `message send`][daemon-cli] [daemon Inbox 状态机][daemon-state]

### 4. 持续活跃房间为什么不会把 Agent 永远锁死

Raft 没有承诺“重试若干次必然成功”。只要 send-as-is 前又到一条相关消息，就可以再次 hold。它采用三层 liveness 手段：

1. 每次只把**最新 3 条**作为 bounded context 交给 Agent，避免一次 hold 把长房间历史全部注入上下文；公开 CLI 的 hold 文案还明确把未展示的更早同 target 消息标为“不再阻断本次动作”，但上游如何裁剪/消费这些 omitted 消息没有公开；
2. hold 返回新的 `seenUpToSeq`，CLI 把它和草稿一起保存，后续重试不再从旧 marker 起步；
3. 如果房间一直移动，`--anyway` 是显式的最终逃生口，直接绕过 daemon freshness 判定。[daemon Inbox 状态机][daemon-state] [官方博客：反复 hold 与 informed override][blog]

所以真正保证“不无限 hold”的是**可审计的人工/Agent 决策式 override**，不是隐藏的自动超时提交。TTL 只会让未处理草稿消失，不会自动发送。

### 5. 与 Inbox / `message check` 的关系

`raft message check` drain Inbox 并把返回消息按 target 归组；`raft message read` 也从所读历史中取最大 seq。独立 CLI 将这些最大值写入本地 `consumed-seqs.json`，普通发送若没有 draft 自带边界，就用目标的已消费 seq 作为 `seenUpToSeq`。hold 返回并展示的消息也会推进这一发送边界。daemon 同时从 wake、stdin 注入、check、read 和 held preflight 维护更细的可见消息 ledger，以免同一消息稍后又从本地 pending 队列重复注入。[独立 CLI：`message check`/`message read`/`_consumedSeqState`][cli] [daemon visible-delivery ledger][daemon-state]

这不等于 exactly-once 或严格 `model_seen`：CLI 通常在 API 已返回并准备打印后就记录边界，无法从公开代码证明模型真正理解了正文。Held Draft 使用的是“已进入 Agent 可见表面”的操作性证据，而不是认知证明；这是与 wake contract 中 delivery、read、model-seen 必须分开的原则一致的实现折中。[wake contract][contract]

### 6. 幂等、竞态和安全边界

**公开实现证据：**Agent API schema 接受可选 `idempotencyKey`，但当前 `message send` 命令构造的请求体没有设置它。因此不能从公开 CLI 推导出发送重试具备幂等保证。新版内嵌 CLI 为此先保存 draft；请求失败时明确要求先用 read/check 验证消息是否已经落地，读取表面不稳定时不要重发，确认未落地后才用 saved draft 重试。[daemon 内嵌 CLI：request body 与失败恢复提示][daemon-cli]

**边界：**freshness check 是减少“基于旧上下文发言”的乐观并发机制，不是任务锁、ownership lease 或消息 exactly-once。daemon 本地 preflight 与上游 commit 之间仍存在网络/时间窗口；上游是否以事务方式再次 compare-and-commit 未公开。`--anyway` 有意放弃 freshness 阻断，但不会绕过 Agent 凭据、目标可见性、发送权限和上游内容校验。

本地 draft 文件包含正文和附件 id，公开代码使用普通 JSON 文件、未显式设置文件权限或文件锁；并发 CLI 进程、临时目录清理、同机其他主体可见性由 OS、umask 和运行环境决定。因而它是单机恢复机制，不应被当作跨设备、跨 runtime 的持久草稿或互斥存储。后两句是基于公开文件实现的安全分析，不是 Raft 官方承诺。

另有一个明确的敏感场景保护：blind-review seat 可启用 `--reviewer-isolation`/`RAFT_REVIEWER_ISOLATION=1`，此时 hold 只暴露状态和数量，不返回消息正文、发送者、元数据或 model-seen cursor；若仍要发旧稿，只能显式使用 reviewer-isolation 下的 `--send-draft --anyway`。[daemon 内置 Agent Manual 与 reviewer-isolation projector][daemon-state] [daemon 内嵌 CLI][daemon-cli]

### 7. 公开材料没有告诉我们的部分

以下实现细节仍未公开，不能从博客的示意图或 CLI 字段名反推为承诺：

- 上游服务端的数据库结构、事务隔离级别，以及 compare 与 message commit 是否原子；
- `seq` 在上游究竟是 workspace、频道还是其他范围的单调序列，以及编辑、删除、reaction 是否会触发 freshness；
- `continueAnywaySuggested` 的准确 rehold 阈值，及服务端是否会拒绝过早的 `continueAnyway`；
- `idempotencyKey` 的服务端去重窗口、作用域和冲突响应；
- 是否存在独立的服务端 draft 实体、服务端 TTL、跨机器恢复或多进程并发控制。公开请求/响应没有 `draftId`，只能确认 canonical CLI 使用本地草稿；
- daemon 不在、daemon 状态丢失或多个 runtime 同用一个 Agent credential 时，所有 freshness 状态如何合并。

这也是理解 Held Draft 的正确边界：**公开证据足以说明 Agent 端怎样携带边界、怎样 hold 和恢复，但不足以把它描述成一个有强一致性保证的服务端草稿协议。**

## 产品取舍与边界

| 取舍 | 收益 | 代价/边界 |
|---|---|---|
| pull 正文而非直接 push prompt | 控制上下文成本，忙时可积压 | 响应可能更慢，Agent 要自己 triage |
| 广泛消息信号进入 Inbox，而非只收 @mention | 保留频道内主动发现和纠错 | Message Inbox 会积压，相关性仍依赖模型判断 |
| wake、正文、cursor 分离 | 可独立去重、合并、重试，避免假消费 | 状态和可观测性更复杂 |
| Agent 最终决定是否介入 | 能结合动态任务语境行动或沉默 | 不提供确定性的业务优先级保证 |

表中收益来自官方设计，代价为分析推断。另有几条边界是官方明确的：Inbox/Held Draft 没有解决所有问题，协调、ownership 和实时感知仍是开放问题；Agent 没有工作时会 idle，而不是持续推理；外部 Agent 的 activity 状态也可能不准确。[官方博客：开放问题][blog] [Lifecycle 文档][lifecycle] [External Agents 文档][external]

因此不应把 Inbox 理解为：

- **语义优先级队列**：公开材料没有证明服务端会用 LLM 自动评分或按 SLA 排序；
- **exactly-once 处理**：外部 wake 是 at-least-once-until-consumed，依赖重试与去重；
- **任务互斥/ownership 协议**：它降低同时反应的概率，但不能防止两个 Agent 领取同一工作；
- **强实时总线**：pull、idle/active 和 debounce 明确选择了注意力可控，而非把每个事件即时注入模型；
- **全路径统一实现**：公开仓库能核验外部 Agent bridge/plugin；托管 Agent 的服务端内部结构并未整体公开。

## 对本项目的启示

以下均为分析建议：

1. **拆分 signal plane 与 content plane。** 通知只表达“有事”，正文通过有权限的协作 API 拉取，避免消息内容被动污染 Agent 上下文。
2. **分开记录 pending、wake delivered、content delivered、model seen。** 网络 ACK 不能清除模型尚未真正处理的工作。
3. **提供低成本 peek 与显式 drain。** 先按 work item/channel 看积压和标记，再决定读哪些正文。
4. **合并唤醒次数，不合并业务事件。** burst 可触发一个 turn，但每条消息仍保持独立、可查询、可审计。
5. **入站 pull 与出站 freshness check 成对建设。** 前者防上下文噪声，后者防基于旧状态发言。
6. **把沉默建模成合法结果。** 多 Agent 房间若只有“收到 → 必须回复”，重复与打断会自然出现。

## 一手来源

- [Raft 官方博客：房间里有了 Agent，就一定会混乱吗？][blog]
- [Raft Docs：Activity][activity]、[Lifecycle][lifecycle]、[External Agents][external]
- [`botiverse/raft-external-agents@72c3189`][plugin-root]：插件边界、wake contract 与 debounce 源码
- [`@botiverse/raft@0.0.17`][cli]：`inbox check`、`message check` 与 delivery cursor 的公开发布实现
- [`@botiverse/raft-daemon@1.0.16`][daemon-package]：managed-agent 本地 freshness preflight、Agent-visible ledger 与内嵌 CLI

[blog]: https://raft.build/zh-cn/resources/blog/is-having-agents-in-the-room-meant-to-be-chaotic/
[activity]: https://docs.raft.build/features/messaging/activity/
[lifecycle]: https://docs.raft.build/features/agents/lifecycle/
[external]: https://docs.raft.build/features/agents/external/
[plugin-root]: https://github.com/botiverse/raft-external-agents/tree/72c31894f933b9aa9243195d038d66ee79589593
[plugin]: https://github.com/botiverse/raft-external-agents/blob/72c31894f933b9aa9243195d038d66ee79589593/README.md#L5-L57
[contract]: https://github.com/botiverse/raft-external-agents/blob/72c31894f933b9aa9243195d038d66ee79589593/docs/wake-endpoint-contract.md#L14-L105
[debounce]: https://github.com/botiverse/raft-external-agents/blob/72c31894f933b9aa9243195d038d66ee79589593/plugins/raft-channel/src/wake.ts#L146-L231
[cli]: https://unpkg.com/@botiverse/raft@0.0.17/dist/index.js
[daemon-package]: https://unpkg.com/@botiverse/raft-daemon@1.0.16/package.json
[daemon-state]: https://unpkg.com/@botiverse/raft-daemon@1.0.16/dist/chunk-J5Y72PN7.js
[daemon-cli]: https://unpkg.com/@botiverse/raft-daemon@1.0.16/dist/dist-OIRVO6Q2.js
