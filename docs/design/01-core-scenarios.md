# Core Scenarios and Acceptance Catalog

> 状态：Accepted Step 1 Baseline
>
> 上游：`docs/ARCHITECTURE_V1.md`、`CONTEXT.md`、`docs/design/TRACEABILITY.md`
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

### S-ARTIFACT-DELETE-PURGE-01：Artifact 删除、恢复与到期清理

- **参与者与身份**：Artifact creator-H、Workspace Owner-O、后续 Message 读者-R。
- **初始共享状态**：Workspace 已保存 Artifact 当前状态、历史快照、Project 关联，以及固定其中一个 Snapshot UUID 的 Message reference。
- **意图**：H 删除 Artifact；保留期内可能恢复，或等待 7 天到期。
- **正常流程**：删除后 Artifact 立即从普通列表、编辑器和 Project 面板隐藏。7 天内恢复会重新显示原关联；到期则清除当前状态、关联和无人引用 blob。单个历史快照软删除后立即禁止内容访问，7 天后在无其他引用时回收 blob。
- **失败与恢复**：非 creator 且非 Workspace Owner 的删除/恢复被拒绝；过期 revision 不覆盖；清理后不能恢复正文或伪造可下载内容。
- **最终共享状态**：Message 与 Run 保留 Snapshot UUID 和最小展示元数据，内容不可用状态明确；audit 保留删除与清理事实而不保留正文。
- **可观察结果**：回收站显示到期时间和清理状态；历史 Message 显示“该历史内容已删除”。
- **验证不变量**：I-63、I-66、I-68。

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

### S-CONVERSATION-SCOPE-MEMBERSHIP-01：Channel 与所属协作范围自动对齐

覆盖：`S-CONVERSATION-NO-OWNER-01`、`S-CONVERSATION-CURRENT-SCOPE-ACCESS-01`

- **参与者与身份**：Human-H 与 Agent-A 是 active Workspace Members；Project-P 另有 active Project Members；Agent-A 的 Run 仅获准向已有 Thread-1 发布。
- **初始共享状态**：Workspace Channel-CW、Project Channel-CP 和 Workspace DM-D 已存在；Channel 不保存参与者记录，DM 固定两个 direct Membership。
- **意图**：Human-H 创建 Channel；治理者随后增加/移除 Workspace 或 Project Member；Agent-A 尝试创建 Conversation 或治理成员。
- **正常流程**：Workspace 原子建立 Channel、Timeline、fixed scope 与 creator provenance。CW 的参与者立即等于 Workspace active Membership，CP 等于 Project active Membership。新成员无需 Conversation 写入即可读取完整 Channel 历史并成为结构化 `@Agent` 候选；移除立即撤权并取消/fence 相关执行。DM 参与者保持固定。
- **失败与恢复**：Agent-A 创建 Conversation、Agent 发布凭证治理 Membership、创建 Project DM 或修改 DM participants 时整体拒绝。Channel 不存在 add/remove participant API。
- **最终共享状态**：creator provenance 保留但不存在 Conversation Owner/Administrator 或 Channel member facts；所有 Channel 权限只由当前 scope Membership 决定。
- **可观察结果**：参与者列表、Conversation discovery 和 `@Agent` picker 与 Workspace/Project member 列表自动对齐；审计记录 Membership 治理与 Agent content intent，而不是 Conversation-local participant events。
- **验证不变量**：I-01、I-02、I-15、I-16、I-20、I-22、I-25、I-36、I-37、I-38、I-39、I-49。

### S-WORKSPACE-REMOVAL-NO-RESTORE-01：Workspace 移除不会留下或复活 Conversation 权限

覆盖：`S-WORKSPACE-MEMBERSHIP-INCARNATION-01`

- **参与者与身份**：Actor-M 是稳定 Human 或 Agent identity，当前 active `Membership-M1` 属于多个 Channel 和一个 DM；Human-G 是当前 Workspace Owner，因此可治理 Human 或 Agent Membership；若 Actor-M 是 Agent，可能还存在相关 Agent Request/Run。
- **初始共享状态**：Membership-M1 可读取这些 Conversation 的完整历史；相关 pending Agent Request 或 active Run 可能存在；历史 Message 同时记录 Actor-M 和 Membership-M1-at-time。
- **意图**：Human-G 终止 Membership-M1，之后同一 Actor-M 重新加入 Workspace。
- **正常流程**：Workspace 使 Membership-M1 永久 terminal，立即关闭 Channel/DM 访问并 fence 相关执行。重新加入创建 Membership-M2，自动恢复 Workspace Channel 访问，但不匹配 DM-D 的固定 participant 或任何旧 Run 授权。
- **失败与恢复**：缓存、搜索索引、变化流订阅或后台清理滞后不能继续授权读取；离线 Node 重连后不能使用 M1 的旧授权；重复移除保持幂等；试图复活 M1 或在 M1 仍 active 时创建 M2 均失败。若 Actor-M 是 Agent creator，Human 退出不删除 Agent 或改写 creator，Host Binding 可独立失效。
- **最终共享状态**：Actor-M 保持一个稳定身份和两段可区分的历史 Membership；M1 永久 terminal，M2 是唯一 active Membership；Channel access 来自 M2，旧 DM 与执行权限没有复活。
- **可观察结果**：所有 Workspace 读取入口一致拒绝 M1；治理者能区分 Actor-M、M1 与 M2；审计保留每条行为的 actor 和 membership-at-time，以及移除、取消/fencing、重新加入和后续显式再授权事实。
- **验证不变量**：I-15、I-16、I-20、I-22、I-25、I-26、I-27、I-38、I-39、I-40、I-41。

### S-AGENT-INBOX-PULL-01：Runtime 主动领取 Discussion Scope 消息

覆盖：`S-CONTEXT-SNAPSHOT-STABLE-01`

- **参与者与身份**：Agent-A、Node-A、Human-H；Human-H 在 Agent DM 或明确 mention Agent-A。
- **初始共享状态**：Inbox Item 已提交，wake 只含 Agent ID 与最高 sequence。
- **意图**：Runtime 获取当前 Scope 里需要一起理解的消息。
- **正常流程**：Runtime 先调用 `inbox check`，再用 `message check` 原子 claim 当前 Scope；响应把 attention 与正文分离，并按 position 返回从上次成功处理位置开始的完整消息增量。
- **失败与恢复**：同一 receipt 可重放；claim 后 Node/Runtime 崩溃不会丢消息或重复创建 Run。
- **最终共享状态**：Inbox Item 由 pending/claimed 进入 handled；Runtime 可发送普通 Message 或返回 `no_output`。
- **可观察结果**：wake、prompt 和日志无用户正文；receipt、Run/Attempt 和 position 范围可审计。
- **验证不变量**：I-05、I-16、I-18、I-25、I-27、I-28。

### S-AGENT-INBOX-BUSY-WAKE-01：运行中消息不启动第二个 Runtime

- **参与者与身份**：Agent-A、Node-A、Human-H；Agent-A 的 ACP Session 正在处理当前 Scope。
- **初始共享状态**：当前 work cycle active，Human-H 又向同一 Scope 发送一条消息。
- **意图**：让 Agent-A 在同一 Session 的安全边界继续处理，而不是启动第二次执行。
- **正常流程**：Node-A 只设置 `wakePending`；当前 turn 结束后 Runtime 再次检查 Inbox，新请求加入同一活动 Run，并通过新的 receipt 取得后续消息增量。
- **失败与恢复**：重复 wake 被按 Agent 合并；旧 session/capability 在 Agent Restart 后被 fence。
- **最终共享状态**：消息只被一个活动 Agent 进程处理；每次普通 Message publication 保留当前 Run/Attempt provenance。
- **可观察结果**：执行轨迹只有一个 Agent process/session，不产生相同输入的双回复。
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
- **正常结果**：WorkItem 完成或取消后 Conversation 历史仍可按权限读取；Conversation 继续永久存在。Human 可另行显式归档 Conversation，归档后历史可读但不可发布，恢复后重新可写。
- **失败结果**：任一对象的状态变化不得隐式级联到另一对象；存在 pending Agent Request 或 active Run 时归档 Conversation 被拒绝。
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
- **正常结果**：Workspace 原子建立 Agent-A identity、active `member` Membership-A 与 H 作为唯一 accountable Agent Owner。Agent-A 自动参与 Workspace Channel，但不进入 Project、DM、私有上下文、凭据、Runtime Binding 或本地资源。
- **失败结果**：Agent actor、inactive Human、其他 Workspace 的 Membership 或无效定义发起时，Agent identity、Membership 与 ownership 关系一个也不创建。
- **可观察性与不变量**：治理视图区分 Agent Owner、creator provenance 与 Host；审计记录 creator actor、Owner membership-at-time 和三项原子结果。

### S-HUMAN-MULTI-WORKSPACE-01：同一 Human 通过独立 Membership 参与多个 Workspace

- **参与者与初始状态**：同一产品部署中的稳定 Human-H 已通过 Membership-HA 参与 Workspace-A；隔离的 Workspace-B 存在，或 Human-H 正准备创建它。
- **意图**：Human-H 创建 Workspace-B，或者接受一个匹配的 pending Workspace Invitation 加入 B，并在 A、B 之间切换协作上下文。
- **正常结果**：创建 B 时原子建立 owner Membership-HB；加入已有 B 时，Invitation `accepted` 与新的 `member` Membership-HB 原子成立。HA 与 HB 可同时 active，各自承载所在 Workspace 的角色、权限与参与期。客户端切换只改变当前交互上下文，不复制或合并任何共享事实。
- **失败结果**：Membership-HA 不能用于读取或写入 B，Membership-HB 也不能用于 A；Conversation、Message、Agent、Agent Request、Run 或权限的跨 Workspace 引用均不能提交。
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

- **参与者与初始状态**：Workspace-A 的 Owner-O 创建了面向 normalized email E 的 pending Workspace Invitation；Human-N 在 A 中没有 active Membership 或 Conversation access。
- **意图**：在 Invitation 仍有效、已被撤销或已过期时，分别由 verified email 匹配的 N、仅持邀请链接但邮箱不匹配的 Human-X 或 Owner-O 尝试接受或直接建立 Membership。
- **正常结果**：只有 authenticated 且 verified email 完全匹配 E 的 N 能接受 Invitation；Workspace 原子提交新的 active `member` Membership-N。接受后 N 自动参与 Workspace Channel，但不继承旧 DM 或 Run authority。
- **失败结果**：X 仅凭链接接受、O 代替 N 接受或直接创建 active Membership、撤销/过期后的接受、并发重复接受以及 N 已有 active Membership 时均不产生新 Membership。Owner 可在接受先提交前把 pending Invitation 变为 terminal `revoked`；到期则变为 terminal `expired`。
- **并发与唯一性**：同一 Workspace 与 normalized email E 同时至多一个 pending Invitation；相同邀请的幂等重试返回原 Invitation 且不延长期限，非相同并发邀请只有一个能成为 pending。更换有效期必须先撤销旧 Invitation，再创建新 identity；旧 Invitation 终态且接受者没有 active Membership 后才允许重新邀请。
- **可观察性与不变量**：O 与 N 可观察明确的 Invitation 终态；接受幂等重放返回同一 Membership；审计可追溯创建者、normalized email、稳定接受者和 Membership；验证 I-16、I-25、I-27、I-38、I-41、I-43、I-46、I-47、I-48、I-50。

### S-AGENT-MEMBERSHIP-GOVERNANCE-01：Agent 参与、责任与执行权分离

- **参与者与初始状态**：Workspace-A 有 Workspace Owner-G；Human-H 是 Agent-A 的当前 accountable Owner，Host-D 为其提供 Runtime；Agent-A 有 active Membership。
- **意图**：G 治理 Agent Membership 与 ownership，Host-D 停止 Runtime，Human-H 尝试退出 Workspace。
- **正常结果**：G 可终止/重新准入 Agent Membership并关闭相关共享权限，或把 Agent ownership 转移给另一 active Human Membership；H 可暂停/恢复和约束 Agent；Host-D 只能改变本地执行可用性。ownership transfer 不改写旧责任历史。
- **失败结果**：Workspace Owner-G 在不是 Agent Owner 时不能冒充 H 暂停 Agent；Host-D 不能借本地控制修改共享 Agent identity、Membership 或 ownership；H 仍拥有 Agent-A 时退出失败，转给 inactive、Agent 或 cross-Workspace Membership 也失败。
- **可观察性与不变量**：治理视图区分 Agent Membership、current/historical Agent Owner、creator provenance 与 Host；审计记录旧/新 Owner、membership-at-time 及 request/run fencing。

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

### S-PROJECT-SCOPE-01：可选 Project Scope 与 Workspace Conversation 并存

- **参与者与初始状态**：Workspace-A 有 Human-H、没有 Repository 的 Project-P 和 P 的 active Project Membership-H；A 中还没有 Conversation。
- **意图**：H 分别直接在 A 和在 P 中创建 Channel。
- **正常结果**：两个 Conversation 共用 Timeline、Thread、Message、Agent Request 与 Run 模型；前者参与者来自 Workspace Membership，后者来自 Project Membership；两个列表和 Web 路由互不混入。
- **失败结果**：跨 Project Membership、Workspace Membership 与 Project Membership 混用、创建后 move scope 或非 Project Member 创建 P 的 Conversation 均不产生共享事实。
- **可观察性与不变量**：Project 不是所有 Conversation 的必经父级；验证 I-01、I-16、I-38、I-53、I-54、I-57。

### S-PROJECT-GOVERNANCE-01：Project 角色与 Channel 参与统一基于 Membership

- **参与者与初始状态**：Human-M 是 Project-P 的 Manager，因此也是 active Project Member；Human-O 是 Workspace Owner 但不是 P 的成员。
- **意图**：M 管理 Project 成员并读取 Channel-C；O 查询 Project 并尝试读取内容。
- **正常结果**：M 因 Project Membership 读取 C，并因 manager 角色管理成员；O 只能获得安全治理元数据，不能读取 C。
- **失败结果**：O 的治理投影不返回成员目录、Conversation 列表、Message 或 Run；不存在 Conversation participant self-add 或 Owner recovery。
- **可观察性与不变量**：Project Membership 决定 Channel access，Project role 只决定管理命令；验证 I-15、I-16、I-56、I-57。

### S-PROJECT-MEMBERSHIP-REENTRY-01：Project 重入自动恢复 Channel 权限

- **参与者与初始状态**：Project-P 有两位 Human Manager；Member-H 通过 Project Membership-PH 参与全部 Project Channel，且可能关联 pending Agent Request 或 active Run。
- **意图**：Manager 移除 PH，随后把 H 的同一个 active Workspace Membership 重新添加到 P。
- **正常结果**：PH terminal 立即关闭全部 Project Channel 读取并取消或 fence 相关执行；重新加入产生 Project Membership-PH2，H 自动重新获得现有 Channel 的完整历史访问。
- **失败结果**：最后一位 Human Manager 的 remove/demote/leave 或导致该结果的 Workspace Membership removal 整体失败；Agent 不能被提升为 Manager。
- **可观察性与不变量**：历史 provenance 保留 PH，当前权限只接受 PH2；不产生 Conversation-local participant 事实；验证 I-27、I-54、I-55、I-58。

### S-PROJECT-REPOSITORY-LIFECYCLE-01：Project 独立成立并切换 Repository 执行范围

- **参与者与初始状态**：Human-H 是 Workspace-A 的 active Member，Project-P 尚不存在。
- **意图**：H 只用名称创建 P，先进行无 Repository 协作，随后挂载 Repository-R，最后解除 R。
- **正常结果**：Workspace 原子建立 P 与 H 的首个 Human Manager Membership；无 Repository 的 Run 使用隔离 scratch。挂载 R 后的新 Run 要求匹配 Working Copy 并使用 Attempt Worktree；解除后新 Run 回到 scratch，旧 Run Snapshot 仍保留 R provenance。
- **失败结果**：Repository identity 不可原地更换；Project 或 Repository revision 过期、身份无效、权限不足或存在 active Attempt 时，挂载/更新/解除整体失败。
- **可观察性与不变量**：Project 在三个阶段都可发现、使用 Conversation 和共享资源；绝对路径不进入 Workspace；验证 I-55、I-59、I-60、I-61。

### S-PROJECT-RESOURCE-LINK-01：Project Member 管理外部资料

- **参与者与初始状态**：Human-H 是 Project-P 的 active Member，Manager-M 管理 P。
- **意图**：H 创建一个 `https` Resource Link，随后 H 或 M 修改、删除。
- **正常结果**：Link 保存 title、URL、可选 description、creator 与 revision；creator 或 Manager 可通过 CAS 修改、删除。
- **失败结果**：非 `http/https` URL、过期 revision、非 creator 的普通 Member 或非成员请求被拒绝。
- **可观察性与不变量**：Resource Link 不出现 Artifact Current State、ArtifactSnapshot、上传或 Agent 审计语义；验证 I-59。

### S-PROJECT-WORKING-COPY-01：同一 Project 在不同 Computer 映射不同路径

- **参与者与初始状态**：Project-P 锚定 Repository-R；Computer-A 与 Computer-B 都由有权成员控制。
- **意图**：两台 Computer 分别把 P 连接到各自的本地 Git checkout。
- **正常结果**：A 与 B 可以使用不同绝对路径；本机分别校验 checkout 的 Repository identity，并只向 Workspace 报告安全的 availability、branch、commit 与同步状态。
- **失败结果**：路径不是 Git checkout、Repository identity 不匹配或本机无权访问时，只拒绝对应 Computer 的绑定或执行，不改写 P 的 Repository identity，也不暴露该路径。
- **可观察性与不变量**：共享 API、变化流、审计与其他 Computer 均看不到绝对路径、Git 凭据或 dirty content；验证 I-60。

### S-PROJECT-ATTEMPT-WORKTREE-01：Project Attempt 使用隔离 Worktree

- **参与者与初始状态**：Agent-A 收到 Project-P Conversation 中的有效 Agent Request；Computer-A 上存在匹配 Repository 的 ready Local Working Copy 和 Runtime。
- **意图**：Local Agent Module 获取 Attempt Lease 并启动 Runtime。
- **正常结果**：P 有 Repository 时，Local Agent Module 为该 Attempt 建立隔离 Git worktree，将其绝对路径作为 ACP `session/new(cwd)`；P 无 Repository 时使用隔离 scratch。Runtime 通过受控 return 显式发布需要共享的 Message，并原子更新 Artifact Current State、创建或复用 ArtifactSnapshot。
- **失败结果**：P 有 Repository 但没有匹配 Working Copy、identity 不一致或 worktree 无法建立时不启动 Runtime，也不回退到主 checkout、Workspace 根目录或用户 Home。
- **可观察性与不变量**：Conversation 只出现 Runtime 显式发送的普通 Message；仅发生文件写入不会自动生成 Message、Artifact 或成功事实；验证 I-61、I-62。

## 7. 初始端到端验收测试目录

下表是后续自动化测试的稳定入口。每个编号继承其所属场景的参与者、权限与失败语义；测试可以细化前置数据，但不能改变可观察结果。

| 验收编号 | 所属场景 | 最小可观察断言 |
|---|---|---|
| `S-CONVERSATION-INDEPENDENT-01` | S-CONVERSATION-WITHOUT-THREAD-01 | Conversation 不关联 WorkItem 仍可发布、恢复和读取消息 |
| `S-CONVERSATION-PRESETS-01` | S-MENTION-DM-01 | Channel 与 DM 预设共享相同请求与执行语义 |
| `S-CONVERSATION-WITHOUT-THREAD-01` | 同名 | 只有 Timeline 时 Thread 数量为零且消息链可工作 |
| `S-CONVERSATION-SCOPE-MEMBERSHIP-01` | 同名 | Channel discovery、participants、history access 与 `@Agent` 候选自动跟随 scope Membership |
| `S-CONVERSATION-NO-OWNER-01` | S-CONVERSATION-SCOPE-MEMBERSHIP-01 | creator 仅为 provenance；不存在 Conversation owner 或 participant governance |
| `S-CONVERSATION-CURRENT-SCOPE-ACCESS-01` | S-CONVERSATION-SCOPE-MEMBERSHIP-01 | 加入 scope 可读完整 Channel 历史，移除后所有新旧读取被拒绝，Message 不改写 |
| `S-WORKSPACE-REMOVAL-NO-RESTORE-01` | 同名 | Workspace 移除立即撤销 Channel/DM/Run 权限；重新加入只恢复 Channel |
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
| `S-ARTIFACT-DELETE-PURGE-01` | 同名 | 7 天内可恢复原关联，到期清内容且历史保留最小删除占位 |
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
| `S-AGENT-MEMBERSHIP-GOVERNANCE-01` | 同名 | Workspace Owner 可转移 ownership、终止/重新准入 Agent Membership；Agent Owner 退出前必须先转移全部 Agent |
| `S-PROJECT-SCOPE-01` | 同名 | Workspace/Project Conversation 并存且 scope、derived participants、列表与路由不混用 |
| `S-PROJECT-GOVERNANCE-01` | 同名 | Project Membership 自动授予 Channel access，manager 角色另行授予治理命令 |
| `S-PROJECT-MEMBERSHIP-REENTRY-01` | 同名 | Project Membership 终止立即撤权并 fence 执行；重新加入自动恢复 Channel access |
| `S-PROJECT-REPOSITORY-LIFECYCLE-01` | 同名 | Project 可无 Repository 成立；挂载/解除只改变新 Run，active Attempt 阻止解除，历史 provenance 保留 |
| `S-PROJECT-RESOURCE-LINK-01` | 同名 | URL、revision 与 creator-or-manager 权限受控，Resource Link 不产生 Artifact 语义 |
| `S-PROJECT-WORKING-COPY-01` | 同名 | 同一 Repository 在不同 Computer 可使用不同本机路径，绝对路径与凭据不进入共享层 |
| `S-PROJECT-ATTEMPT-WORKTREE-01` | 同名 | Repository-backed Project 使用隔离 worktree；repository-less Project 使用隔离 scratch |
| `S-ARTIFACT-REALTIME-DRAFT-01` | Artifact Workspace | 双客户端同步与重连/重启恢复 Yjs 当前状态，编辑不产生历史快照 |
| `S-ARTIFACT-SNAPSHOT-CAS-01` | Artifact Workspace | Human/Agent 的旧 current revision 或 content digest 发布均冲突且不覆盖 |
| `S-ARTIFACT-PROJECT-ASSOCIATION-01` | Artifact Workspace | 同一 Workspace Artifact 显式关联多个 Project 且不复制或转移所有权 |
| `S-ARTIFACT-MESSAGE-REFERENCE-01` | Artifact Workspace | Message 固定发送时 Snapshot UUID，后续当前状态变化与清理不改写引用 |
| `S-ARTIFACT-AGENT-PUBLISH-01` | Artifact Workspace | staged blob 不提前共享，成功 return 原子更新当前状态并固定 Snapshot，失败不留 Snapshot 或 Message |
| `S-RUNTIME-ADAPTER-CONTRACT-01` | S-RUNTIME-REPLACEMENT-01 | 不同 Adapter 保持公共执行语义和相同领域结果 |
| `S-RUNTIME-CANNOT-FORGE-AUTHORITY-01` | 同名 | Runtime 自报身份或 scope 不产生权限 |
| `S-AGENT-MESSAGE-PRODUCING-RUN-01` | S-RUNTIME-CANNOT-FORGE-AUTHORITY-01 | Agent Message 必须由 Workspace 绑定同一 Agent 的唯一 producing Run，Human Message 无此关联 |
| `S-GATEWAY-REAUTHORIZATION-01` | S-RUNTIME-CANNOT-FORGE-AUTHORITY-01 | 每个 Runtime Workspace 动作绑定并重新授权 |
| `S-WORKSPACE-SINGLE-AUTHORITY-01` | 同名 | 缓存、连接和本地副本不能确认共享事实 |
| `S-NOTIFICATION-LOSS-01` | S-MENTION-CHANNEL-01 | 通知丢失后已提交 Agent Request 仍可恢复发现 |
| `S-AUDIT-CHAIN-01` | 同名 | 共享结果可遍历完整请求、责任与执行链 |

## 8. 覆盖结论

- 路线图列出的 18 个必选场景均有正常流程、权限/并发/断线或失败分支、最终共享状态和三端可观察结果；
- `TRACEABILITY.md` 中 I-01 至 I-62 引用的全部验收编号均已在本文定义；
- 场景只约束领域行为，不依赖表名、字段名、传输协议、错误码或页面布局；
- Step 2 及后续专题可以增加更细的状态转换和测试数据，但不得改变本文的成功、失败和权限语义。
