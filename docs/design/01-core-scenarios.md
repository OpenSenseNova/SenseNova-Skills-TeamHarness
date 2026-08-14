# Core Scenarios and Acceptance Catalog

> 状态：Accepted Step 1 Baseline
>
> 上游：`docs/ARCHITECTURE_V2.md`、`CONTEXT.md`、`docs/design/TRACEABILITY.md`
>
> 范围：定义可观察的产品行为和失败结果；不规定协议字段、数据库结构、内部事件或 UI 布局。

## 1. 使用约定

本文是后续领域设计、Interface 设计和端到端验收测试的共同输入。场景中的名称表示领域身份，不表示进程或网络连接：

- `Human-H`：拥有相应 Workspace 权限的 Human 成员；
- `Owner-O`：目标 Agent 当前唯一的 Human Owner；
- `Agent-A`、`Agent-B`：稳定的 Workspace Agent 身份；
- `Node-A`、`Node-B`：承载对应 Agent 执行的 Local Node；
- `Workspace`：共享事实的唯一逻辑权威；
- “可见”表示调用者可通过授权快照、变化流或 UI 投影观察到，不要求特定界面形式；
- “审计可见”表示可追溯 actor、Agent Owner、Agent Request、Run、Attempt、Device/Runtime 和可选 WorkItem；
- 权限、策略或并发检查失败必须得到明确结果，不能静默改派、隐式创建工作或遗漏共享事实。彼此独立的 Agent Mention 目标可以得到不同结果，但每个结果都必须随 Message 持久提交。

每个场景包含正常结果与至少一个失败或冲突分支。场景编号是稳定引用；括号中的验收编号用于更细粒度的测试与追踪。

## 2. Conversation 与 Agent Request

### S-MENTION-CHANNEL-01：在 Channel 风格 Conversation 中请求 Agent

覆盖：`S-MENTION-REQUEST-01`、`S-MENTION-NO-WORKITEM-01`、`S-NOTIFICATION-LOSS-01`、`S-RUN-MESSAGE-INDEPENDENT-01`、`S-MENTION-PER-TARGET-OUTCOME-01`

- **参与者与身份**：Human-H 是 Conversation 成员；Agent-A 是可被提及的 Workspace Agent；Node-A 可执行 Agent-A。
- **初始共享状态**：存在一个 Channel 风格 Conversation，其顶层 Conversation Timeline 对 Human-H 和 Agent-A 可见；不存在相关 WorkItem。
- **意图**：Human-H 发布一条顶层 Message，并显式 `@Agent-A` 请求响应。
- **正常流程**：Workspace 原子提交 Human-authored Message、Agent-A 的 `requested` Mention Outcome 和持久 Agent Request；Human Message 没有 producing Run。请求被接受后形成 Run；Agent-A 基于触发时可见内容执行，可以在同一 Timeline 发布普通 Message；Workspace 从受信执行凭证把每条 Agent-authored Message 绑定到该 Run，执行层独立记录 Run terminal outcome。
- **失败与恢复**：若 Human-H 无权发消息，Message、Outcome 和 Request 均不提交；若 Human-H 可发消息但 Agent-A 不是合法请求目标，则提交 Message 与 `not_requested(reason)`，不创建 Request；若请求合法成立但受临时接单、暂停、Node、调度或并发条件影响，Outcome 保持 `requested` 且 Request 投影为 `waiting / blocked`；不可恢复的 intake 拒绝使 Request 进入 `rejected`；若实时通知丢失，Agent Request 仍可由 Node-A 恢复发现。
- **最终共享状态**：正常路径有原始 Human Message、一个 `requested` Outcome、一个不关联 WorkItem 的 Agent Request、一个具有独立 outcome 的 Run，以及零到多条必须关联该 Run 的 Agent Message；目标拒绝路径有 Message 和 `not_requested` Outcome 而没有 Request。始终没有隐式 WorkItem、Direct Assignment 或 Review。
- **可观察结果**：UI 分别显示消息和请求/运行结果；Node-A 可从稳定位置发现请求；审计从 Agent Message 的 producing Run 串联 Agent-A、请求、Attempt 和实际 Device/Runtime。
- **验证不变量**：I-01、I-03、I-04、I-05、I-16、I-23、I-25、I-27、I-30、I-32、I-34。

### S-MENTION-DM-01：在 DM 风格 Conversation 中请求 Agent

覆盖：`S-CONVERSATION-PRESETS-01`

- **参与者与身份**：Human-H 和 Agent-A 是 DM 风格 Conversation 的参与者；Node-A 可执行 Agent-A。
- **初始共享状态**：存在一个仅对双方可见的 Conversation；它使用 DM 参与和展示预设，但没有独立 DM 领域身份或状态机。
- **意图**：Human-H 在 Conversation Timeline 中 `@Agent-A`。
- **正常流程**：Message、Agent Request、Run 和可选 Agent Message 与 S-MENTION-CHANNEL-01 使用相同语义；发布目标仍是触发 Message 所在 Discussion Scope。
- **失败与恢复**：无关成员不能读取该 Conversation 或请求结果；若 Agent-A 在 Message 提交前已失去访问权，Message 保留且该目标记录 `not_requested(reason)`；若权限在 Request 创建后失去，则按 Request/Run 的授权撤销规则处理，不能因 DM 标签绕过权限。
- **最终共享状态**：成功结果与 Channel 风格一致，差异只体现在参与者、可发现性和展示策略。
- **可观察结果**：UI 可以呈现 DM 风格，但 Node-A 与审计观察到的请求和执行链不出现第二套 DM 专用事实。
- **验证不变量**：I-01、I-03、I-05、I-16、I-30、I-32。

### S-MENTION-PER-TARGET-OUTCOME-01：多个 Agent Mention 独立解析

- **参与者与身份**：Human-H 可在当前 Discussion Scope 发消息；Agent-A 是有效请求目标；Agent-B 当前无权访问该 Scope 或不可被请求。
- **初始共享状态**：Conversation 可写；尚无本次 Message、Mention Outcome 或 Agent Request。
- **意图**：Human-H 在同一 Message 中 `@Agent-A` 和 `@Agent-B`，并可能重复提及 Agent-A。
- **正常流程**：Workspace 在一次提交中保存 Message；为每个 distinct target 保存一个不可变 Outcome；Agent-A 得到 `requested` 及一个 Agent Request，Agent-B 得到 `not_requested(reason)` 且没有 Request。重复提及 Agent-A 不产生第二个 Outcome 或 Request。
- **失败与恢复**：Agent-B 的目标建立失败不能阻止 Message 或 Agent-A 的 Request；系统不能只创建 Agent-A 的 Request 而遗漏 Agent-B 的失败结果。若 Message 本身无权发布或事务失败，则 Message、所有 Outcome 和 Request 全部不提交；幂等重试返回同一组逻辑结果。
- **生命周期边界**：Agent-B 因无请求权限或无 Scope 访问权而不能合法建立请求时使用 `not_requested`；若请求已合法建立，则后续暂停、离线、策略或能力判断只能改变 Request 的 disposition/lifecycle，不能改写 Outcome。
- **后续变化**：如果 Agent-B 后来获得权限或 Scope 访问权，旧 Outcome 仍是 `not_requested`，系统不得由此补建 Request；Human-H 或另一授权 actor 必须发布新的显式 `@Agent-B` Message。已有 pending Request 的临时 blocker 消失时则可自动重新求值。
- **最终共享状态**：一条 Message、两个 per-target Outcome、一个 Agent Request；没有隐式 WorkItem。
- **可观察结果**：所有可读 Message 的成员都能看到每个目标是否已触发 Request；当前 Workspace Owner 或目标 Agent 的当前 Owner 看到权威精确治理原因，其他观察者只看到安全概括；Agent-A 可恢复发现 Request，Agent-B 不会收到虚假请求。不同投影来自同一原因事实。
- **验证不变量**：I-03、I-04、I-16、I-25、I-30、I-31、I-32、I-33。

### S-RUN-NO-MESSAGE-01：Runtime 正常结束但没有发布 Message

- **参与者与身份**：Agent-A、Node-A、Workspace；Human-H 是请求发起者。
- **初始共享状态**：Agent Request 已接受，Run 和当前 Attempt 正在执行，结果 Discussion Scope 可发布。
- **意图**：Runtime 报告正常 terminal outcome，但本次 Run 没有向 Workspace 发布 Message。
- **正常流程**：Node-A 确认没有待处理的 Message 发布意图后请求结束；Workspace 按执行层 outcome 结束 Run，同时关闭该 Run 首次发布新 Agent Message 的共享写入权，不创建隐式 Message、WorkItem、Submission、Review 或 `no_response` 状态。技术重试是否需要新 Attempt 由 Execution Model 决定。
- **失败与恢复**：Node-A 不得把 Runtime final text 自动冒充共享 Message，也不能因没有 Message 擅自失败或重启 Run；Runtime 本地结束不等同于 Workspace Run terminal，Message 只能在 terminal 前通过显式发布命令成为共享事实。
- **最终共享状态**：Run 有独立终态，相关 Discussion Scope 没有该 Run 的 Message；这可以通过 provenance 查询观察，但不是另一权威状态。
- **可观察结果**：UI 可分别展示 Run outcome 和实际 Message；审计记录 Attempt 和 terminal outcome，不伪造回复。
- **验证不变量**：I-05、I-12、I-23、I-25、I-27、I-35。

### S-RUN-TERMINAL-MESSAGE-RACE-01：Agent Message 发布与 Run terminal 并发

覆盖：`S-RUN-TERMINAL-CLOSES-PUBLICATION-01`

- **参与者与身份**：Agent-A、Node-A、Workspace；Node-A 已持有该 Run 的受信执行权。
- **初始共享状态**：Agent Request 已接受，producing Run 尚未 terminal；Node-A 有一个本地待发布候选及稳定幂等身份。
- **意图**：候选 Message 的首次发布与该 Run 的 terminal 转换并发到达 Workspace。
- **正常流程**：Workspace 在同一个 Run 并发裁决点给两者唯一提交顺序。若 Message 首次发布先提交，则它成为关联该 Run 的普通 Message，随后 Run 可以 terminal；若 terminal 先提交，则候选不能首次成为 Message。两种顺序都不以 Message 存在与否推断 Run outcome。
- **失败与恢复**：terminal 后新的发布意图创建不了 Message；terminal 前已经提交成功的同一幂等发布意图即使响应丢失、在 terminal 后重放，也只返回原逻辑结果，不重复创建 Message。Runtime 退出、WebSocket 通知或本地队列状态都不能自行关闭或延长共享写入权；取消、授权撤销或超时导致的强制 terminal 可以先于未提交候选并将其 fence。
- **最终共享状态**：权威历史只可能是“Message 提交后 Run terminal”或“Run terminal 且该候选未发布”，不存在“Run terminal 后首次新增该 Run 的 Message”，也不存在第二个 `RunWritePermission` 真相。
- **可观察结果**：Node-A 得到已发布、已提交结果的幂等重放，或 terminal 后发布被拒绝的确定结果；审计能显示唯一提交顺序，而不依赖本地进程时序。
- **验证不变量**：I-05、I-16、I-20、I-22、I-25、I-27、I-34、I-35。

## 3. 显式 WorkItem

### S-WORK-FROM-MESSAGE-01：从现有 Message 创建并分配 WorkItem

覆盖：`S-WORK-DIRECT-ASSIGN-01`、`S-WORK-REQUEST-01`、`S-MENTION-IN-WORK-01`、`S-WORK-ASSIGNEE-NO-ACCESS-01`

- **参与者与身份**：Human-H 可管理工作；Agent-A 是候选 assignee；双方可访问源 Message 所在 Discussion Scope。
- **初始共享状态**：Conversation 中已有一条由 Human-H 可引用的 Message；没有对应 WorkItem。
- **意图**：Human-H 显式选择“从消息创建工作”，并直接分配给 Agent-A。
- **正常流程**：Workspace 原子创建用户可见 WorkItem、建立 Agent-A 为唯一 assignee，并创建关联 Agent Request；保留该 Message 为 source Message，把选定 Scope 设为唯一 Primary Discussion Scope。Agent-A 可发布普通结果 Message，并通过独立命令提交 Result Submission。
- **失败与恢复**：若 Agent-A 无权读取或发布到 Primary Discussion Scope，“创建并分配”这一完整意图失败且不创建 WorkItem；Human-H 只有通过另一次明确的“创建未分配工作”意图才能建立未分配 WorkItem。系统不能静默扩大可见性；同一讨论中的普通新 Message 或 mention 不推进 WorkItem，也不自动关联它。
- **最终共享状态**：WorkItem、source Message、Primary Discussion Scope、assignee 和可选 Agent Request 均明确可见；Conversation 与 WorkItem 保持不同生命周期。
- **可观察结果**：UI 分别展示讨论、工作责任和执行状态；Node-A 只接收已授权的关联请求；审计记录创建者、分配者、assignee 和执行链。
- **验证不变量**：I-03、I-04、I-06、I-08、I-09、I-10、I-23、I-27。

### S-WORK-STANDALONE-ATOMIC-01：无 Conversation 时创建 WorkItem

- **参与者与身份**：Human-H 可创建工作；可选 Agent-A 是目标 assignee。
- **初始共享状态**：Human-H 没有为该工作选择现成 Conversation、Message 或 Discussion Scope。
- **意图**：Human-H 从独立工作入口创建 WorkItem，并提供作为初始讨论内容的工作描述。
- **正常流程**：Workspace 在一个权威用例中创建专用 Conversation、由 Human-H 署名的初始 Message 和 WorkItem；新 Conversation Timeline 成为 Primary Discussion Scope，初始 Message 成为 source Message；可选分配和 Agent Request 仅在权限成立时发生。
- **失败与恢复**：任一必要部分无法建立时，三项共享事实全部不创建；重试不能产生重复的 Conversation、Message 或 WorkItem；无权访问新 Scope 的 Agent 不能被静默分配。
- **最终共享状态**：要么三项全部存在并正确关联，要么全部不存在；不会出现无 source Message 或无 Primary Discussion Scope 的“无头任务”。
- **可观察结果**：UI 可从 WorkItem 进入专用讨论；Node-A 只在成功分配后看到请求；审计显示原子创建和后续分配。
- **验证不变量**：I-06、I-07、I-08、I-10、I-16、I-25、I-27。

### S-MENTION-VS-DELEGATION-01：普通 Agent mention 与显式委派不同

- **参与者与身份**：Agent-A 正在处理父 WorkItem；Agent-B 可参与讨论，并可能符合被委派策略。
- **初始共享状态**：父 WorkItem 由 Agent-A 负责；Agent-B 不是 assignee，也不存在 Child WorkItem。
- **意图**：先由 Agent-A 在讨论中普通 `@Agent-B` 征求意见，再由 Agent-A 显式执行“创建 Child WorkItem / 委派”。
- **正常流程**：普通 mention 只创建面向 Agent-B 的会话 Agent Request，不改变父 WorkItem，也不创建 Child WorkItem；显式委派才创建可追溯 Child WorkItem，并在授权和接单条件成立时分配给 Agent-B、创建关联请求。
- **失败与恢复**：自然语言中出现“帮我完成”不能替代显式委派动作；若委派权限、预算、递归深度或 Agent-B 接单策略不满足，Child WorkItem 不得被部分分配，请求不得绕过拒绝结果。
- **最终共享状态**：会话请求与委派责任链身份、状态和审计关系明确分离。
- **可观察结果**：UI 区分“请求意见”和“委派工作”；Node-B 能识别请求是否关联 Child WorkItem；审计显示显式委派 actor 与父子关系。
- **验证不变量**：I-03、I-04、I-10、I-17、I-20、I-22、I-27。

### S-CLAIM-RACE-01：多个 Agent 并发认领开放任务

覆盖：`S-WORK-OPEN-CLAIM-01`、`S-WORK-SINGLE-ASSIGNEE-01`

- **参与者与身份**：Agent-A 与 Agent-B 均符合 Claim Eligibility；Workspace 是认领结果权威。
- **初始共享状态**：存在一个未分配、可认领的 WorkItem，双方均可发现。
- **意图**：Agent-A 与 Agent-B 基于同一开放状态并发提交认领意图。
- **正常流程**：Workspace 原子决定唯一胜者；首个有效 Agent Claim 同时关闭 claimability、建立唯一 assignee，并为胜者创建 Agent Request。
- **失败与恢复**：另一认领得到确定冲突结果，不能成为第二 assignee，也不能因本地先执行而获得责任；不符合资格或权限已变化的认领被拒绝。
- **最终共享状态**：WorkItem 只有一个当前 assignee；失败方没有 Agent Claim 或面向该工作的执行请求。
- **可观察结果**：双方 UI/Node 最终看到相同 owner；审计保留成功与冲突尝试及其因果顺序。
- **验证不变量**：I-09、I-10、I-12、I-16、I-25、I-27。

### S-WORK-RELEASE-REASSIGN-01：Agent 释放后由 Human 重新分配

覆盖：`S-CLAIM-SURVIVES-DEVICE-FAILURE-01`

- **参与者与身份**：Agent-A 是当前 assignee；Human-H 有重分配权限；Agent-B 是可选新 assignee。
- **初始共享状态**：Agent-A 通过有效 Agent Claim 负责 WorkItem；其 Device 在线与否不改变该责任。
- **意图**：Agent-A 主动释放责任，随后 Human-H 显式把 WorkItem 分配给 Agent-B。
- **正常流程**：释放提交后 WorkItem 变为 `open + unassigned + claimability closed`。Human-H 的后续 Direct Assignment 原子建立 Agent-B 为唯一 assignee，并创建新的关联 Agent Request；若要重新开放认领，Human-H 必须另行显式发布。
- **失败与恢复**：仅 Device 断线、Attempt 失败或 Lease 到期不构成释放；无权主体不能释放他人责任或重分配；与释放并发的分配只能产生一个确定最终 assignee。
- **最终共享状态**：责任历史保留 Agent-A 的 Claim、显式释放和 Human-H 的重新分配；不会出现责任空窗被误记为 Agent-A 仍执行，也不会出现双 assignee。
- **可观察结果**：UI 显示当前 assignee 和责任历史；Node-A 停止获得新执行权，Node-B 只处理新请求；审计记录三次显式决策。
- **验证不变量**：I-09、I-10、I-11、I-12、I-16、I-27。

### S-AGENT-DELEGATION-01：Agent-A 委派 Agent-B 并汇总结果

- **参与者与身份**：Agent-A 是父 WorkItem assignee；Agent-B 在策略范围内可接收委派；两者由各自 Local Node 执行。
- **初始共享状态**：父 WorkItem、其 Primary Discussion Scope 和 Agent-A 的有效执行链已存在；没有子工作。
- **意图**：Agent-A 显式委派一个可独立验收的子结果给 Agent-B，并在返回后汇总父结果。
- **正常流程**：Workspace 原子提交委派 Message、创建关联父工作的 Child WorkItem、建立关系、分配 Agent-B 并创建请求；Agent-B 在 Primary Discussion Scope 发布普通结果 Message并按需 SubmitResult；Agent-A 通过父子关系读取结果，随后可由新的明确请求继续工作。
- **失败与恢复**：Agent-B 拒绝接单、预算不足或递归越界时，委派保持明确失败/阻塞且父 WorkItem 仍由 Agent-A 负责；Agent-B 的 Runtime 不能直接回调 Agent-A Runtime 来绕过 Workspace。
- **最终共享状态**：父子 WorkItem 各有唯一 assignee 和独立执行链，结果通过显式关系汇总，完整责任链可追溯。
- **可观察结果**：UI 展示父子关系及各自状态；两个 Node 只获得各自权限；审计可从父请求追到委派、子 Run、子结果和父汇总。
- **验证不变量**：I-10、I-15、I-17、I-20、I-22、I-27。

### S-WORK-REVIEW-01：需要 Review 的 Result Submission 被拒绝

覆盖：`S-CONVERSATION-NO-REVIEW-01`

- **参与者与身份**：Agent-A 是 WorkItem assignee；Reviewer-R 是指定 Reviewer；Human-H 可观察结果。
- **初始共享状态**：WorkItem 的 Completion Policy 要求 Review；Agent-A 已发布普通 Message，并显式形成引用该消息和可选 Artifact 的 Result Submission；Review 已显式创建。
- **意图**：Reviewer-R 判断提交结果不满足要求并拒绝。
- **正常流程**：Workspace 原子发布 Reviewer-R 的反馈 Message 并把 Review 置为 rejected；Submission 保持不可变且没有 rejected 状态，WorkItem 不完成。只有反馈中明确 `@Agent` 才创建新的 Agent Request。
- **失败与恢复**：Runtime 成功、Message 发布或 Artifact 上传均不能绕过 Completion Policy；非指定 Reviewer 不能决定；反馈 Message 与决定必须全成或全不成；普通 Conversation Run 不得生成 Review。
- **最终共享状态**：原提交、拒绝理由和后续返工历史保留；不会创建无关的新 WorkItem，也不会把拒绝伪装成 Run 失败。
- **可观察结果**：UI 区分 Run 成功、提交待审、拒绝和 WorkItem 完成；Node-A 收到明确返工请求；审计记录 policy 版本、Reviewer 和决定。
- **验证不变量**：I-05、I-06、I-10、I-23、I-27。

## 4. 治理、执行与上下文

### S-OWNER-SUSPEND-01：Owner 暂停 Agent

覆盖：`S-OWNER-ACCOUNTABILITY-01`、`S-AUTHORITY-SEPARATION-01`

- **参与者与身份**：Owner-O 是 Agent-A 当前唯一 Owner；Agent-A 可能存在等待或执行中的请求；Workspace 管理共享身份和权限。
- **初始共享状态**：Agent-A 处于可请求、可执行状态，历史行为和当前 Owner 可审计。
- **意图**：Owner-O 暂停 Agent-A，并请求停止其活跃执行。
- **正常流程**：Workspace 接受暂停，阻止新的 Agent Request 进入执行，并对活跃 Run 发出受控取消/停止意图；Local Custody 可立即停止本机 Runtime。已经提交的消息、责任和审计历史不被删除或改写。
- **失败与恢复**：非 Owner 且无治理权限的成员不能暂停 Agent-A；Owner-O 不能借暂停扩大权限、替 Agent-A 署名或抹除历史；设备离线时共享暂停仍成立，Node 重连后必须遵守。
- **最终共享状态**：Agent-A 为已暂停，未完成工作保持明确责任和状态，历史 Owner 与行为仍可追溯。
- **可观察结果**：UI 显示暂停和受影响运行；Node-A 在当前或重连后停止取得执行权；审计记录发起者、Owner-at-time 和取消结果。
- **验证不变量**：I-13、I-14、I-15、I-16、I-25、I-27。

### S-OFFLINE-RECONCILIATION-01：Local Node 断网、Lease 到期与重连

覆盖：`S-LEASE-FENCING-01`、`S-LOCAL-RESTART-01`

- **参与者与身份**：Agent-A、Node-A、Workspace；Agent-A 可关联一个已认领 WorkItem。
- **初始共享状态**：Agent Request、Run、Attempt 和有效 Execution Lease 已存在；Node-A 已取得稳定 Run Context Snapshot。
- **意图**：Node-A 断网后继续允许范围内的本地计算，Lease 在离线期间到期，随后 Node-A 重连。
- **正常流程**：离线期间仅进行预先授权边界内的纯本地计算，共享读取、写入和新的外部副作用暂停；本地输出保持候选。重连后 Node-A 重新验证 Agent Request、可选 WorkItem、Agent 状态、权限与执行权，再按 Workspace 结果恢复、提交、丢弃或进入 reconciliation。
- **失败与恢复**：过期 Lease 不能提交当前执行的权威结果；原 Agent Claim 不因断线或 Lease 到期自动释放；旧 Attempt 与新 Attempt 竞争时，旧执行被 fencing；本地重启后若恢复信息不完整，不得猜测成功。
- **最终共享状态**：只有重新授权后提交的内容成为共享事实；WorkItem assignee 与 Agent Claim 按显式责任动作保持或变化。
- **可观察结果**：UI 区分离线、Lease 失效、候选输出和重连决定；Node-A 能恢复待执行与待提交状态；审计记录离线边界、Lease 和 reconciliation。
- **验证不变量**：I-11、I-12、I-16、I-18、I-20、I-22、I-25、I-26、I-27。

### S-PRIVATE-CONTEXT-01：私有上下文的读取与披露分别授权

覆盖：`S-PRIVATE-CONTEXT-GRANT-01`、`S-PRIVATE-DISCLOSURE-DENIED-01`

- **参与者与身份**：Agent-A、Owner-O、请求者 Human-H、Node-A。
- **初始共享状态**：团队触发 Agent-A 的请求；Owner-O 设备上存在相关私有内容，但共享 Run Context Snapshot 不包含它。
- **意图**：Agent-A 尝试读取私有内容并在共享 Message 中使用信息。
- **正常流程**：未授予 Private Context Grant 时，读取被拒绝且 Run 只能使用共享上下文；Owner-O 授予特定类别的读取权后，Node-A 可在本地受控使用，但若披露权未授予，包含受保护信息的共享发布仍被阻止或要求修订。
- **失败与恢复**：Agent-A、Runtime 或请求者不能把 mention、工具参数或已有 Workspace 权限当作私有读取/披露授权；审计不得复制完整私有内容，只记录来源类别和 policy/grant 版本。
- **最终共享状态**：共享空间只出现授权可披露的内容；读取权、披露权和拒绝结果保持可解释。
- **可观察结果**：UI/Owner 控制面显示授权范围和发布阻止原因；Node-A 执行本地策略；审计显示 grant 与 policy，不泄露正文。
- **验证不变量**：I-15、I-18、I-19、I-20、I-22、I-27。

### S-EXTERNAL-ARTIFACT-DISAPPEARS-01：外部 Artifact 内容消失

- **参与者与身份**：Agent-A 提交 Artifact；Reviewer-R 或 Human-H 后续读取；Workspace 管理 lineage。
- **初始共享状态**：Workspace 已记录一个指向外部稳定版本的 Artifact，包括身份、版本、访问、来源以及与 Agent/Run/可选 WorkItem 的关系。
- **意图**：外部系统中的内容后来被删除或变得不可访问。
- **正常流程**：读取者得到“内容不可用”的明确结果，但 Workspace 保留 Artifact 身份、已提交版本、lineage 和历史验证事实。
- **失败与恢复**：Workspace 不把失效链接当作从未提交，也不伪造仍可读取；若 policy 原本要求归档副本但未满足，相关提交不能被错误验收。
- **最终共享状态**：内容可用性变化与历史事实分离；既有 Run、WorkItem 和 Review 历史不被重写。
- **可观察结果**：UI 显示内容不可用及保留的来源信息；Node 不把读取失败改写成新版本；审计保留提交和验证主体。
- **验证不变量**：I-23、I-24、I-27。

## 5. Discussion Scope 与并发发布

### S-CONVERSATION-WITHOUT-THREAD-01：Conversation 只有顶层 Message

覆盖：`S-CONVERSATION-INDEPENDENT-01`、`S-THREAD-OPTIONAL-BRANCH-01`、`S-THREAD-NO-WORK-STATE-01`

- **参与者与身份**：Human-H、Agent-A、Workspace。
- **初始共享状态**：存在一个不关联 WorkItem 的 Conversation，只有其 Conversation Timeline，没有 Thread。
- **意图**：Human-H 连续发布顶层 Message，并在其中一次请求 Agent-A。
- **正常流程**：所有顶层 Message 直接属于 Conversation Timeline；该 Timeline 本身作为 Discussion Scope 提供上下文和接收普通 Message，不创建默认或隐藏 Thread。
- **失败与恢复**：实现不能因需要统一消息流而自动创建 Thread；只有用户从一条顶层 Message 显式展开聚焦分支时才形成 Thread；即使形成 Thread，也不承载 WorkItem 责任或完成状态。
- **最终共享状态**：在未展开分支时 Thread 数量为零，Conversation、请求和消息仍可完整恢复。
- **可观察结果**：UI 不显示伪造 Thread；Node-A 观察到 Timeline frontier；审计中的结果 Scope 明确为 Conversation Timeline。
- **验证不变量**：I-01、I-02、I-03、I-04、I-05、I-25。

### S-CONVERSATION-GOVERNANCE-01：Agent 发布权不能扩大 Conversation audience

覆盖：`S-CONVERSATION-NO-OWNER-01`、`S-CONVERSATION-EXPLICIT-AUDIENCE-01`、`S-CONVERSATION-CURRENT-AUDIENCE-ACCESS-01`

- **参与者与身份**：Human-H 是 active Human Workspace Member；Human-P 是某 Channel 的当前 active Human audience member；Owner-O 是当前 Workspace Owner 但不在该 Channel audience；Agent-A 的 Run 仅获准向已有 Thread-1 发布；Workspace 管理 audience 与共享授权。
- **初始共享状态**：Conversation-1 和 Thread-1 已存在，Agent-A 可读取并向 Thread-1 发布；不存在 Agent-A 有权创建的新 Conversation 或成员变更。
- **意图**：Human-H 创建包含自己 Membership 的新 Conversation 并确定初始 audience；P、O 与 Agent-A 分别尝试改变既有 Channel audience；同时验证任何角色能否改变 DM audience。
- **正常流程**：Workspace 接受 Human-H 的治理意图，原子建立新 Conversation、Timeline、显式初始 audience 和 creator provenance，但不创建 Owner 或 Administrator 关系。P 可按 `current_human_audience` 路径修改 Channel；O 可按 `workspace_owner_override` 恢复 Channel，即使此前不在 audience。O 的角色本身不能读取内容，但若显式把自己的 Membership 加入 Channel，之后可读取完整 Timeline、Thread 和已有 Message，且该 override 留下审计。Agent-A 仍只能在 Run 与当前授权有效时向 Thread-1 发布普通 Message。DM 参与者保持固定。
- **失败与恢复**：初始 audience 缺少 creator、包含 inactive/cross-Workspace Membership，或 Agent-A 尝试创建 Conversation/改变 audience 时，Workspace 拒绝整个治理意图且不创建部分事实；已有 Thread-1 及其合法发布能力不受影响。普通 Human 若既不在 Channel audience、也不是 Workspace Owner，则不能修改它。包括 O 在内的任何角色都不能改变 DM 参与者。Human-N 新加入 Workspace 时不会自动进入任何已有 Conversation；只有显式加入 Channel 才授予完整历史访问，随后移除会阻止其所有 Workspace 新旧内容读取，但无法追回此前合法下载的副本。
- **最终共享状态**：只有 Human-H 合法建立的新 Conversation 存在；其 creator provenance 保留但不存在 Conversation Owner/Administrator。Agent-A 的权限仍被限制在原 Discussion Scope，没有因内容发布能力获得治理权。
- **可观察结果**：Human-H 可观察新 Conversation；Agent-A 收到确定的未授权结果；Human-N 在加入后看到完整历史、移除后所有 Workspace 读取被拒绝；O 在加入前看不到正文；审计区分 creator provenance、audience-member 治理、owner override 与 Agent content intent，权限投影不把 creator 显示为 owner。
- **验证不变量**：I-01、I-02、I-15、I-16、I-20、I-22、I-25、I-36、I-37、I-38、I-39、I-49。

### S-WORKSPACE-REMOVAL-NO-RESTORE-01：Workspace 移除不会留下或复活 Conversation 权限

覆盖：`S-WORKSPACE-MEMBERSHIP-INCARNATION-01`

- **参与者与身份**：Actor-M 是稳定 Human 或 Agent identity，当前 active `Membership-M1` 属于多个 Channel 和一个 DM；Human-G 是当前 Workspace Owner，因此可治理 Human 或 Agent Membership；若 Actor-M 是 Agent，可能还存在相关 Agent Request/Run。
- **初始共享状态**：Membership-M1 可读取这些 Conversation 的完整历史；相关 pending Agent Request 或 active Run 可能存在；历史 Message 同时记录 Actor-M 和 Membership-M1-at-time。
- **意图**：Human-G 终止 Membership-M1，之后同一 Actor-M 重新加入 Workspace。
- **正常流程**：Workspace 接受移除后使 Membership-M1 永久 terminal，立即关闭其全部 Channel/DM 访问，取消受影响的 pending Agent Request，并 fence active Run 的新共享写入；Actor-M 身份、Message、署名和 membership-at-time 历史不变。若 Actor-M 是 Human，后来接受新的 Workspace Invitation；若是 Agent，则通过独立 Agent 治理重新准入。两种情况都创建 `Membership-M2`，它不满足任何引用 Membership-M1 的 audience 或授权；Channel 需要重新显式添加 M2，DM 需要创建新的 Conversation。
- **失败与恢复**：缓存、搜索索引、变化流订阅或后台清理滞后不能继续授权读取；离线 Node 重连后不能提交 M1 的旧 Run Message；重复移除保持幂等；试图复活 M1 或在 M1 仍 active 时创建 M2 均失败。若 Actor-M 是仍拥有 Agent 的 Human，未包含全部 ownership transfer 的移除/退出也整体失败。移除动作若未形成完整权威结果则整体失败，不能报告成功后仍保留任一旧访问、执行权或 ownerless Agent。
- **最终共享状态**：Actor-M 保持一个稳定身份和两段可区分的历史 Membership；M1 永久 terminal，M2 是唯一 active Membership，旧 Conversation 与执行权限没有复活。
- **可观察结果**：所有 Workspace 读取入口一致拒绝 M1；治理者能区分 Actor-M、M1 与 M2；审计保留每条行为的 actor 和 membership-at-time，以及移除、取消/fencing、重新加入和后续显式再授权事实。
- **验证不变量**：I-15、I-16、I-20、I-22、I-25、I-26、I-27、I-38、I-39、I-40、I-41。

### S-AGENT-MESSAGE-FRESHNESS-01：同一 Discussion Scope 推进要求 freshness review

覆盖：`S-CONTEXT-SNAPSHOT-STABLE-01`

- **参与者与身份**：Agent-A 正在生成；Human-H 可向同一 Scope 发消息；Workspace 决定发布。
- **初始共享状态**：Agent-A 的 Run Context Snapshot 记录结果 Discussion Scope 的已观察 Discussion Frontier V。
- **意图**：Agent 生成期间 Human-H 向同一 Scope 发布新回复；Agent-A 仍携带 V 提交普通候选 Message。
- **正常流程**：Workspace 原子比较 V 与当前 frontier，发现 Scope 已推进后返回 `freshness_review_required` 和准确的介入 Message；不发布候选，Run 和 WorkItem 不变。
- **失败与恢复**：相同候选的盲重试再次检查 frontier；系统不能先创建 Message 再回滚，也不能只给模糊摘要替代权威增量。
- **最终共享状态**：Human-H 的新回复存在；候选只作为 Local Node Held Draft；原 Run Context Snapshot 和 Run outcome 不被 freshness 结果改写。
- **可观察结果**：UI/Node-A 显示需复核和准确增量；审计记录观察 frontier、当前 frontier 与决定，但 Workspace 不保存候选正文为共享事实。
- **验证不变量**：I-05、I-16、I-18、I-25、I-27、I-28。

### S-AGENT-MESSAGE-FRESHNESS-DECISION-01：freshness review 后由 Agent 决定

- **参与者与身份**：Agent-A、Node-A、Workspace；Human-H 已推进结果 Scope。
- **初始共享状态**：Agent-A 得到 `freshness_review_required`；Workspace 提供准确增量；Held Draft 在 Node-A 本地，原始 Snapshot 保持不变。
- **意图**：Agent-A 阅读增量并判断候选是否仍适用。
- **正常流程**：Agent-A 可 revise、discard、confirm unchanged 或审计化 publish-anyway。revise/confirm 以最后已复核 frontier 再提交；publish-anyway 可保留旧候选内容，但同样要求最后已复核 frontier 仍为当前值，否则再次触发 review。
- **失败与恢复**：任何路径都不能绕过当前权限、scope、Run capability 或 WorkItem fencing；Node 重启后可恢复 Held Draft 和已读 frontier；discard 不创建 Message 或状态变化。
- **最终共享状态**：只有明确发布选择形成普通 Message；Run、WorkItem、Submission 与 Review 状态均由各自机制决定。
- **可观察结果**：UI/Node 显示 Agent 的选择；审计记录每次 frontier 判断、所读增量和 informed override。
- **验证不变量**：I-05、I-18、I-25、I-27、I-28。

### S-AGENT-MESSAGE-UNRELATED-SCOPE-01：无关 Thread 推进不阻塞发布

- **参与者与身份**：Agent-A 在 Thread-1 生成结果；Human-H 在同一 Conversation 的 Thread-2 回复。
- **初始共享状态**：Thread-1 与 Thread-2 是两个不同 Discussion Scope；Agent-A 已观察 Thread-1 的 frontier V1。
- **意图**：Thread-2 推进后，Agent-A 携带 V1 向 Thread-1 提交候选 Message。
- **正常流程**：Workspace 只比较 Thread-1 frontier；由于它未推进，普通 Message 正常发布，发布结果不改变 Run outcome。
- **失败与恢复**：Conversation Timeline 或 Thread-2 变化不能制造虚假 review；若 Thread-1 自身推进，则按 S-AGENT-MESSAGE-FRESHNESS-01 处理。
- **最终共享状态**：Thread-1 包含普通 Message，Thread-2 保留无关回复，两者 frontier 独立推进。
- **可观察结果**：UI 显示正确 Thread 归属；Node-A 只收到结果 Scope 的发布判断；审计记录精确 Discussion Scope。
- **验证不变量**：I-01、I-02、I-05、I-16、I-25、I-28。

## 6. 补充架构验收场景

以下场景补齐总体架构验证标准中不属于上述 18 条主链、但仍必须在后续专题和实现中保持的行为。

### S-WORK-CONVERSATION-LIFECYCLE-01：工作与讨论生命周期独立

- **参与者与初始状态**：Human-H 管理一个已有 Primary Discussion Scope 的 WorkItem。
- **正常结果**：WorkItem 完成或取消后 Conversation 历史仍可按权限读取；Conversation 继续永久存在。
- **失败结果**：archive、restore、reopen 或隐式级联命令不存在；任何将另一对象删除、完成或取消的隐式意图被拒绝。
- **可观察性与不变量**：UI 分别显示 WorkItem 终态和持续讨论；验证 I-06、I-08、I-16、I-27。

### S-RUNTIME-REPLACEMENT-01：替换 Runtime 不改变 Agent 身份

覆盖：`S-RUNTIME-ADAPTER-CONTRACT-01`

- **参与者与初始状态**：Agent-A 已有 Owner、权限和历史，并通过 Runtime-1 执行过 Run。
- **正常结果**：Owner 在 Local Custody 范围内改用兼容 Runtime-2；后续请求仍属于 Agent-A，历史、Owner 和 Workspace 权限不变。
- **失败结果**：Runtime-2 的私有 Session、协议能力或名称不能创建新 Agent 身份、继承额外权限或改变领域结果。
- **可观察性与不变量**：UI 仍显示同一 Agent；Node 适配公共执行语义；审计区分 Runtime 变化；验证 I-13、I-15、I-20、I-21、I-27。

### S-AGENT-WORKSPACE-OWNERSHIP-01：Agent identity 不跨 Workspace

- **参与者与初始状态**：Workspace-A 拥有 Agent-A 及其 Owner、Membership、权限和历史；另一个隔离的 Workspace-B 存在。
- **意图**：成员尝试把 Agent-A 加入或迁移到 Workspace-B，或者在 Workspace-B 的 Message 中以 Agent-A 为 mention target。
- **正常结果**：若 Workspace-B 需要相似 Agent，只能在 B 中创建新的 Agent-B；即使未来从同一无权限模板生成，两者仍拥有独立 Owner、Membership、权限、请求、Run、署名与历史。
- **失败结果**：Agent-A 的跨 Workspace Membership、mention、Agent Request、Run、Message provenance 或 transfer 意图均不能形成共享事实；复制配置不得复制 Agent identity、Credential、私有上下文或历史。
- **可观察性与不变量**：两个 Workspace 只显示各自 Agent；审计链不会跨 Workspace；验证 I-13、I-15、I-16、I-19、I-20、I-27、I-42。

### S-AGENT-CREATION-01：Member 创建 Agent 不继承自身权限

- **参与者与初始状态**：Workspace-A 有普通 active Human Member-H 和 Workspace Owner-O；H 尚未拥有本次要创建的 Agent，且可访问若干私有 Conversation、凭据与本地资源。
- **意图**：H 在 A 中创建自己的 Agent-A；同时验证 Owner 审批、部分创建、权限继承及非法 actor 路径。
- **正常结果**：无需 O 对单个 Agent 审批，Workspace 原子建立新的 Agent-A identity、其 active `member` Membership-A 与 H 的当前 Membership 作为唯一 accountable Agent Owner。Agent-A 永久属于 A，但创建后不在任何 Conversation audience 中，也没有继承 H 的角色权限、私有上下文、凭据、Runtime Binding 或本地资源；这些能力必须各自另行授权。
- **失败结果**：Agent actor、inactive Human、其他 Workspace 的 Membership 或无效定义发起时，Agent identity、Membership 与 Owner 关系一个也不创建。任一内部步骤失败不得留下 ownerless Agent、无 Membership Agent 或孤立 Membership；重复的同一意图只返回原结果。
- **可观察性与不变量**：H 可在 Agent 治理视图看到自己是 Agent-A Owner，O 可看到 Workspace-local Agent 与 Membership 治理事实，但普通 Conversation 中不会自动出现 Agent-A；审计记录 creator actor、membership-at-time 和三项原子结果；验证 I-14、I-15、I-16、I-19、I-27、I-41、I-42、I-45、I-51、I-52。

### S-HUMAN-MULTI-WORKSPACE-01：同一 Human 通过独立 Membership 参与多个 Workspace

- **参与者与初始状态**：同一产品部署中的稳定 Human-H 已通过 Membership-HA 参与 Workspace-A；隔离的 Workspace-B 存在，或 Human-H 正准备创建它。
- **意图**：Human-H 创建 Workspace-B，或者接受一个匹配的 pending Workspace Invitation 加入 B，并在 A、B 之间切换协作上下文。
- **正常结果**：创建 B 时原子建立 owner Membership-HB；加入已有 B 时，Invitation `accepted` 与新的 `member` Membership-HB 原子成立。HA 与 HB 可同时 active，各自承载所在 Workspace 的角色、权限与参与期。客户端切换只改变当前交互上下文，不复制或合并任何共享事实。
- **失败结果**：Membership-HA 不能用于读取或写入 B，Membership-HB 也不能用于 A；Conversation、Message、audience、Agent、Agent Request、Run 或权限的跨 Workspace 引用均不能提交。另一套独立部署不能因相同登录标识自动继承 Human-H 或其 Membership。
- **可观察性与不变量**：Human-H 可列出并切换有权访问的 Workspace；每个 Workspace 只显示本地成员资格与数据；审计在共享 Human identity 下仍明确记录 Workspace 与 membership-at-time；验证 I-16、I-25、I-27、I-38、I-41、I-42、I-43。

### S-WORKSPACE-OWNER-CONTINUITY-01：Workspace 始终保留 Human owner

- **参与者与初始状态**：Human-H 创建 Workspace-A；之后 Human-J 通过独立 active `member` Membership 加入 A。
- **意图**：验证创建时的治理建立、增加第二位 owner，以及 owner 退出、被移除或放弃 owner 角色时的连续性。
- **正常结果**：Workspace-A、Membership-HA 与 HA 的 `owner` 基础角色原子成立；当前 owner 可把 J 的同一 active Human Membership 从 `member` 改为 `owner`。存在 J 这一另一位 active owner 后，H 可以把同一 HA 改为 `member` 或终止 HA，而 Workspace 与 Conversation 均保持可治理；角色变化不创建新 Membership。
- **失败结果**：A 只有 H 一位 active owner 时，任何会把 HA 改为 `member` 或终止 HA 的命令均整体失败；不能产生 ownerless Workspace。Agent Membership、inactive Membership 或其他 Workspace 的 Membership 不能获得 A 的 owner 角色，`admin` 或自定义角色也不是有效目标状态。
- **可观察性与不变量**：治理视图可显示一个或多个当前 Workspace Owner；审计记录角色变化及 membership-at-time；Conversation creator 仍无 owner 身份或永久特权；验证 I-15、I-16、I-27、I-36、I-37、I-41、I-43、I-44。

### S-HUMAN-MEMBERSHIP-GOVERNANCE-01：只有 owner 治理 Human Membership

- **参与者与初始状态**：Workspace-A 有 Owner-O、普通 Member-M，以及尚未加入的 Human-N；O 和 M 都有各自 active Membership。
- **意图**：O 与 M 分别尝试邀请 N、移除对方、改变 Human Membership 角色，并验证 M 主动退出自己的 Workspace Membership。
- **正常结果**：只有 O 可以创建面向 N 的 pending Workspace Invitation、移除其他 Human Membership 或改变角色；Invitation 本身不授予 N 权限，N 匹配登录并接受后才与新的 `member` Membership 原子成立。M 可以终止自己的 Membership，但不能操作任何其他 Human Membership。所有成功变化都绑定 A 中的准确对象并留下审计。
- **失败结果**：M 发出的邀请、移除 O/N 或角色变更意图不产生 Membership 或角色事实；O 也不能以 A 的 owner 权限治理其他 Workspace。若 O 是最后一位 active owner，其自助退出、降级或被移除仍整体失败。
- **可观察性与不变量**：普通 Member UI 不提供或明确拒绝成员治理动作，但保留退出入口；owner 可观察准确结果；验证 I-15、I-16、I-27、I-41、I-43、I-44、I-45、I-46。

### S-WORKSPACE-INVITATION-ACCEPTANCE-01：接受 Invitation 才建立 Human Membership

- **参与者与初始状态**：Workspace-A 的 Owner-O 创建了面向 normalized email E 的 pending Workspace Invitation；Human-N 尚未注册或已注册且拥有 verified email E，在 A 中没有 active Membership，也没有任何 Conversation audience 引用。
- **意图**：在 Invitation 仍有效、已被撤销或已过期时，分别由 verified email 匹配的 N、仅持邀请链接但邮箱不匹配的 Human-X 或 Owner-O 尝试接受或直接建立 Membership。
- **正常结果**：只有 authenticated 且 verified email 完全匹配 E 的 N 能接受有效 pending Invitation；Workspace 原子提交 Invitation `accepted`、稳定 Human-N reference 与一个新的 active `member` Membership-N。接受前 N 没有任何 A 的访问权；若 N 曾有 terminal Membership，本次仍创建全新的 Membership 且不继承旧 audience，后来邮箱变化也不改写 Membership。
- **失败结果**：X 仅凭链接接受、O 代替 N 接受或直接创建 active Membership、撤销/过期后的接受、并发重复接受以及 N 已有 active Membership 时均不产生新 Membership。Owner 可在接受先提交前把 pending Invitation 变为 terminal `revoked`；到期则变为 terminal `expired`。
- **并发与唯一性**：同一 Workspace 与 normalized email E 同时至多一个 pending Invitation；相同邀请的幂等重试返回原 Invitation 且不延长期限，非相同并发邀请只有一个能成为 pending。更换有效期必须先撤销旧 Invitation，再创建新 identity；旧 Invitation 终态且接受者没有 active Membership 后才允许重新邀请。
- **可观察性与不变量**：O 与 N 可观察明确的 Invitation 终态；接受幂等重放返回同一 Membership；审计可追溯创建者、normalized email、稳定接受者和 Membership；验证 I-16、I-25、I-27、I-38、I-41、I-43、I-46、I-47、I-48、I-50。

### S-AGENT-MEMBERSHIP-GOVERNANCE-01：Agent 参与、责任与执行权分离

- **参与者与初始状态**：Workspace-A 有 Owner-O；Human-H 是 Agent-A 的 active accountable Agent Owner，Host-D 为其提供 Runtime；Agent-A 有 active Membership、pending Request 或 active Run。
- **意图**：O、H 与 Host-D 分别尝试终止/重新准入 Agent-A Membership；同时 H 尝试在仍拥有 Agent-A 时退出 Workspace，O 尝试把 ownership 转给 active Human-J 后移除 H。
- **正常结果**：只有 O 能终止 Agent Membership，原子关闭其 Conversation access、取消 pending Request 并 fence active Run；也只有 O 能为仍属于 A 的 Agent identity 创建新的 `member` Membership，且不恢复旧 audience。O 可把 ownership 转给 active Membership-J；转移与 H Membership 终止可在同一原子操作中完成，Agent identity、历史与责任审计不变。
- **失败结果**：Agent Owner-H 或 Host-D 的 Membership 终止/重新准入意图不产生共享事实；Host 停止 Runtime 只改变本地执行可用性。H 仍拥有 Agent-A 时单独退出或被移除失败；转给 inactive、其他 Workspace 或 Agent Membership 的目标失败；任何部分结果都不能产生 ownerless Agent。
- **可观察性与不变量**：Workspace 治理视图区分 Agent Membership、Agent Owner 与 Host；审计记录旧/新 Owner、membership-at-time 及 request/run fencing；验证 I-13、I-14、I-15、I-16、I-20、I-27、I-40、I-41、I-42、I-51。

### S-RUNTIME-CANNOT-FORGE-AUTHORITY-01：Runtime 不能伪造身份或授权

覆盖：`S-GATEWAY-REAUTHORIZATION-01`

- **参与者与初始状态**：Agent-A 的 Runtime 正在一个权限受限的 Run 中，通过 Workspace Interaction Gateway 发起动作。
- **正常结果**：合法动作由 Gateway 绑定实际 Agent、Run 和执行权，并由 Workspace 依据当前权限重新授权。
- **失败结果**：Runtime 在参数中声称其他 Agent、Owner、Workspace、WorkItem、producing Run 或更大 scope 时，伪造值不被信任；缺失有效 Run 发布权、Run 所属 Agent 与作者不一致或执行已被 fencing 时不产生 Message。
- **可观察性与不变量**：Node 收到明确授权结果，审计保留实际绑定身份、Run 和失败尝试；验证 I-15、I-16、I-20、I-22、I-27、I-34、I-36。

### S-WORKSPACE-SINGLE-AUTHORITY-01：投影和连接故障不产生第二权威

- **参与者与初始状态**：两个客户端读取到相同共享状态，其中一个缓存或实时连接落后。
- **正常结果**：两者的修改意图都提交给 Workspace；Workspace 决定唯一结果，落后客户端随后从稳定位置收敛。
- **失败结果**：缓存、搜索、WebSocket、Runtime Session 或本地副本不能自行确认消息、认领、权限或完成事实。
- **可观察性与不变量**：UI 可短暂落后但最终一致，审计只有一条权威决定链；验证 I-10、I-12、I-16、I-25、I-27。

### S-AUDIT-CHAIN-01：共享行为可追溯到责任和执行主体

- **参与者与初始状态**：Human-H 请求 Agent-A；Agent-A 关联可选 WorkItem，并由 Node-A/Runtime-R 执行。
- **正常结果**：每条共享行为保留稳定 actor 与 membership-at-time；每条 Agent-authored Message 还直接关联唯一 producing Run，再从 Run 追到 initiated-by、Owner-at-time、Agent Request、Attempt、Device/Runtime、correlation、causation 和存在时的 WorkItem；Human-authored Message 不伪造 producing Run。
- **失败结果**：缺少必要身份或执行关联的共享写入不能以“系统”或 Runtime 自报身份提交；Owner 变化不改写旧行为责任。
- **可观察性与不变量**：授权审计视图能完整遍历责任链、区分同一 actor 的不同 Membership，且不泄漏私有正文；验证 I-14、I-15、I-16、I-20、I-22、I-27、I-34、I-41。

## 7. 初始端到端验收测试目录

下表是后续自动化测试的稳定入口。每个编号继承其所属场景的参与者、权限与失败语义；测试可以细化前置数据，但不能改变可观察结果。

| 验收编号 | 所属场景 | 最小可观察断言 |
|---|---|---|
| `S-CONVERSATION-INDEPENDENT-01` | S-CONVERSATION-WITHOUT-THREAD-01 | Conversation 不关联 WorkItem 仍可发布、恢复和读取消息 |
| `S-CONVERSATION-PRESETS-01` | S-MENTION-DM-01 | Channel 与 DM 预设共享相同请求与执行语义 |
| `S-CONVERSATION-WITHOUT-THREAD-01` | 同名 | 只有 Timeline 时 Thread 数量为零且消息链可工作 |
| `S-CONVERSATION-GOVERNANCE-01` | 同名 | 只有治理授权 Human 能创建 Conversation 或改变 audience；Agent 发布权不能扩大可见范围 |
| `S-CONVERSATION-NO-OWNER-01` | S-CONVERSATION-GOVERNANCE-01 | creator 仅为 provenance；失权或离开不产生所有权转移或无主 Conversation |
| `S-CONVERSATION-EXPLICIT-AUDIENCE-01` | S-CONVERSATION-GOVERNANCE-01 | 新 Workspace Member 不自动获得既有 Conversation 访问权；Channel 需显式添加，DM 不可变更 |
| `S-CONVERSATION-CURRENT-AUDIENCE-ACCESS-01` | S-CONVERSATION-GOVERNANCE-01 | 加入 Channel 可读完整历史，移除后所有 Workspace 新旧内容读取被拒绝，Message 不改写 |
| `S-WORKSPACE-REMOVAL-NO-RESTORE-01` | 同名 | Workspace 移除立即撤销全部 Conversation/Run 权限；重新加入不恢复旧访问 |
| `S-WORKSPACE-MEMBERSHIP-INCARNATION-01` | S-WORKSPACE-REMOVAL-NO-RESTORE-01 | 稳定 actor 的旧 Membership 不可复活；重新加入创建唯一新 active Membership，历史保留 membership-at-time |
| `S-THREAD-OPTIONAL-BRANCH-01` | S-CONVERSATION-WITHOUT-THREAD-01 | 只有显式聚焦回复才创建 Thread |
| `S-THREAD-NO-WORK-STATE-01` | S-CONVERSATION-WITHOUT-THREAD-01 | Thread 创建或推进不改变 WorkItem 状态，且不存在 Thread 归档 |
| `S-MENTION-REQUEST-01` | S-MENTION-CHANNEL-01 | 有效 mention 的 `requested` Outcome 与 Message 原子产生定向持久 Agent Request |
| `S-MENTION-PER-TARGET-OUTCOME-01` | 同名 | 多目标 mention 为每个 distinct target 持久记录独立 Outcome；`not_requested` 不追溯激活，Request waiting/blocked 可重新求值；原因按观察者权限投影 |
| `S-MENTION-NO-WORKITEM-01` | S-MENTION-CHANNEL-01 | 普通 mention 后不存在隐式 WorkItem 或 assignment |
| `S-MENTION-IN-WORK-01` | S-WORK-FROM-MESSAGE-01 | WorkItem 讨论中的普通 mention 不推进或关联工作 |
| `S-WORK-REQUEST-01` | S-WORK-FROM-MESSAGE-01 | 显式工作请求经 Agent Request 进入统一 Run 模型 |
| `S-RUN-MESSAGE-INDEPENDENT-01` | S-MENTION-CHANNEL-01 | Run outcome 与普通 Message 分别形成事实 |
| `S-RUN-NO-MESSAGE-01` | 同名 | Runtime 正常结束且无 Message 时不伪造回复或额外状态 |
| `S-RUN-TERMINAL-CLOSES-PUBLICATION-01` | S-RUN-TERMINAL-MESSAGE-RACE-01 | terminal 与首次发布只有一个 Workspace 提交顺序；terminal 后幂等重放不新增 Message |
| `S-WORK-FROM-MESSAGE-01` | 同名 | WorkItem 保留 source Message 和唯一 Primary Discussion Scope |
| `S-WORK-STANDALONE-ATOMIC-01` | 同名 | Conversation、初始 Message、WorkItem 全成或全不成 |
| `S-WORK-CONVERSATION-LIFECYCLE-01` | 同名 | Conversation 与 WorkItem 生命周期不互相级联 |
| `S-WORK-ASSIGNEE-NO-ACCESS-01` | S-WORK-FROM-MESSAGE-01 | 无 Scope 访问权的 Agent 不能被静默分配或获权 |
| `S-WORK-DIRECT-ASSIGN-01` | S-WORK-FROM-MESSAGE-01 | Direct Assignment 明确建立唯一 assignee |
| `S-WORK-OPEN-CLAIM-01` | S-CLAIM-RACE-01 | 开放任务由 eligible Agent 自主认领而非 Workspace 代选 |
| `S-WORK-SINGLE-ASSIGNEE-01` | S-CLAIM-RACE-01 | 并发结果最多一个当前 assignee |
| `S-CLAIM-RACE-01` | 同名 | 两个有效认领只有一个成功，另一个得到冲突 |
| `S-CLAIM-SURVIVES-DEVICE-FAILURE-01` | S-WORK-RELEASE-REASSIGN-01 | Device/Runtime 故障和 Lease 到期不释放 Agent Claim |
| `S-LEASE-FENCING-01` | S-OFFLINE-RECONCILIATION-01 | 过期 Lease 的旧 Attempt 不能提交当前权威结果 |
| `S-MENTION-VS-DELEGATION-01` | 同名 | mention 只请求响应，显式委派才创建 Child WorkItem |
| `S-AGENT-DELEGATION-01` | 同名 | 子工作授权、执行、结果和父汇总完整可追溯 |
| `S-CONVERSATION-NO-REVIEW-01` | S-WORK-REVIEW-01 | 普通会话 Run 不形成 Review |
| `S-WORK-REVIEW-01` | 同名 | 拒绝不完成 WorkItem，返工留在同一责任链 |
| `S-OWNER-ACCOUNTABILITY-01` | S-OWNER-SUSPEND-01 | 唯一 Owner 可暂停 Agent 且不能改写历史 |
| `S-AUTHORITY-SEPARATION-01` | S-OWNER-SUSPEND-01 | Governance、Accountability、Local Custody 互不冒充 |
| `S-CONTEXT-SNAPSHOT-STABLE-01` | S-AGENT-MESSAGE-FRESHNESS-01 | 后续 Message 和 freshness decision 不改写原始 Snapshot |
| `S-PRIVATE-CONTEXT-GRANT-01` | S-PRIVATE-CONTEXT-01 | 未授权时团队请求不能读取 Owner 私有内容 |
| `S-PRIVATE-DISCLOSURE-DENIED-01` | S-PRIVATE-CONTEXT-01 | 读取授权不自动允许共享披露 |
| `S-EXTERNAL-ARTIFACT-DISAPPEARS-01` | 同名 | 外部内容消失不改写 lineage 和历史验证事实 |
| `S-OFFLINE-RECONCILIATION-01` | 同名 | 离线候选经重连再验证后才可能成为共享事实 |
| `S-LOCAL-RESTART-01` | S-OFFLINE-RECONCILIATION-01 | Node 重启可恢复请求、执行和待提交候选且不猜测成功 |
| `S-AGENT-MESSAGE-FRESHNESS-01` | 同名 | 同一 Scope 推进时不发布候选并返回准确增量 |
| `S-AGENT-MESSAGE-FRESHNESS-DECISION-01` | 同名 | Agent 复核后可修订、丢弃、确认不变或 informed override |
| `S-AGENT-MESSAGE-UNRELATED-SCOPE-01` | 同名 | 无关 Thread 推进不阻塞目标 Scope 发布 |
| `S-RUNTIME-REPLACEMENT-01` | 同名 | 替换 Runtime 后 Agent 身份、Owner、权限和历史不变 |
| `S-AGENT-WORKSPACE-OWNERSHIP-01` | 同名 | Agent 永久属于一个 Workspace；跨 Workspace 引用失败，相似 Agent 是新 identity |
| `S-AGENT-CREATION-01` | 同名 | 任一 active Human Member 可原子创建自己的 Agent、member Membership 与 Owner 关系，且不继承权限或上下文 |
| `S-HUMAN-MULTI-WORKSPACE-01` | 同名 | 同一 Human 可拥有多个隔离 Workspace Membership；身份复用不产生跨 Workspace 对象或权限 |
| `S-WORKSPACE-OWNER-CONTINUITY-01` | 同名 | Workspace 创建即有首位 Human owner；可有多个 owner 且最后一位不能退出、被移除或失去角色 |
| `S-HUMAN-MEMBERSHIP-GOVERNANCE-01` | 同名 | 只有 owner 可邀请、移除其他 Human 或改变角色；普通 Member 只能退出自己的 Membership |
| `S-WORKSPACE-INVITATION-ACCEPTANCE-01` | 同名 | pending Invitation 不授权；匹配 Human 接受时与新的 member Membership 原子成立 |
| `S-AGENT-MEMBERSHIP-GOVERNANCE-01` | 同名 | 只有 Workspace Owner 可终止/重新准入 Agent Membership；Human Owner 退出前必须转移 Agent ownership |
| `S-RUNTIME-ADAPTER-CONTRACT-01` | S-RUNTIME-REPLACEMENT-01 | 不同 Adapter 保持公共执行语义和相同领域结果 |
| `S-RUNTIME-CANNOT-FORGE-AUTHORITY-01` | 同名 | Runtime 自报身份或 scope 不产生权限 |
| `S-AGENT-MESSAGE-PRODUCING-RUN-01` | S-RUNTIME-CANNOT-FORGE-AUTHORITY-01 | Agent Message 必须由 Workspace 绑定同一 Agent 的唯一 producing Run，Human Message 无此关联 |
| `S-GATEWAY-REAUTHORIZATION-01` | S-RUNTIME-CANNOT-FORGE-AUTHORITY-01 | 每个 Runtime Workspace 动作绑定并重新授权 |
| `S-WORKSPACE-SINGLE-AUTHORITY-01` | 同名 | 缓存、连接和本地副本不能确认共享事实 |
| `S-NOTIFICATION-LOSS-01` | S-MENTION-CHANNEL-01 | 通知丢失后已提交 Agent Request 仍可恢复发现 |
| `S-AUDIT-CHAIN-01` | 同名 | 共享结果可遍历完整请求、责任与执行链 |

## 8. 覆盖结论

- 路线图列出的 18 个必选场景均有正常流程、权限/并发/断线或失败分支、最终共享状态和三端可观察结果；
- `TRACEABILITY.md` 中 I-01 至 I-52 引用的全部验收编号均已在本文定义；
- 场景只约束领域行为，不依赖表名、字段名、传输协议、错误码或页面布局；
- Step 2 及后续专题可以增加更细的状态转换和测试数据，但不得改变本文的成功、失败和权限语义。
