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
- 权限、策略或并发检查失败必须得到明确结果，不能静默改派、隐式创建工作或部分提交共享事实。

每个场景包含正常结果与至少一个失败或冲突分支。场景编号是稳定引用；括号中的验收编号用于更细粒度的测试与追踪。

## 2. Conversation 与 Agent Request

### S-MENTION-CHANNEL-01：在 Channel 风格 Conversation 中请求 Agent

覆盖：`S-MENTION-REQUEST-01`、`S-MENTION-NO-WORKITEM-01`、`S-NOTIFICATION-LOSS-01`、`S-RUN-FINAL-MESSAGE-01`

- **参与者与身份**：Human-H 是 Conversation 成员；Agent-A 是可被提及的 Workspace Agent；Node-A 可执行 Agent-A。
- **初始共享状态**：存在一个 Channel 风格 Conversation，其顶层 Conversation Timeline 对 Human-H 和 Agent-A 可见；不存在相关 WorkItem。
- **意图**：Human-H 发布一条顶层 Message，并显式 `@Agent-A` 请求响应。
- **正常流程**：Workspace 原子提交 Message 和面向 Agent-A 的持久 Agent Request；请求记录触发 Message 与该 Conversation Timeline 作为结果 Discussion Scope。请求被接受后形成 Run；Agent-A 基于触发时可见内容执行，并在同一 Timeline 提交 Final Message，随后 Run 才成功。
- **失败与恢复**：若 Human-H 无权发消息或无权请求 Agent-A，Message 与 Agent Request 均不提交；若请求受接单、预算或并发策略阻塞，其状态明确可见且不改派；若实时通知丢失，Agent Request 仍可由 Node-A 恢复发现。
- **最终共享状态**：成功时有原始 Message、一个不关联 WorkItem 的 Agent Request、一个 Run 和一个已提交 Final Message；始终没有隐式 WorkItem、Direct Assignment 或 Acceptance。
- **可观察结果**：UI 显示消息、目标 Agent 和请求/运行结果；Node-A 可从稳定位置发现请求；审计串联 Human-H、Agent-A、请求、Run、Attempt 和 Final Message。
- **验证不变量**：I-01、I-03、I-04、I-05、I-16、I-23、I-25、I-27。

### S-MENTION-DM-01：在 DM 风格 Conversation 中请求 Agent

覆盖：`S-CONVERSATION-PRESETS-01`

- **参与者与身份**：Human-H 和 Agent-A 是 DM 风格 Conversation 的参与者；Node-A 可执行 Agent-A。
- **初始共享状态**：存在一个仅对双方可见的 Conversation；它使用 DM 参与和展示预设，但没有独立 DM 领域身份或状态机。
- **意图**：Human-H 在 Conversation Timeline 中 `@Agent-A`。
- **正常流程**：消息、Agent Request、Run、Final Message 与 S-MENTION-CHANNEL-01 使用相同语义；结果仍发布到触发 Message 所在 Discussion Scope。
- **失败与恢复**：无关成员不能读取该 Conversation 或请求结果；若 Agent-A 已失去访问权，请求必须被明确拒绝或阻塞，不能因 DM 标签绕过权限。
- **最终共享状态**：成功结果与 Channel 风格一致，差异只体现在参与者、可发现性和展示策略。
- **可观察结果**：UI 可以呈现 DM 风格，但 Node-A 与审计观察到的请求和执行链不出现第二套 DM 专用事实。
- **验证不变量**：I-01、I-03、I-05、I-16。

### S-RUN-MISSING-FINAL-01：Runtime 正常退出但没有发布 Final Message

- **参与者与身份**：Agent-A、Node-A、Workspace；Human-H 是请求发起者。
- **初始共享状态**：Agent Request 已接受，Run 和当前 Attempt 正在执行，结果 Discussion Scope 可发布。
- **意图**：Runtime 报告进程正常退出，但没有向 Workspace 提交 Final Message。
- **正常流程**：Workspace 将 Runtime 退出视为执行信号而非协作成功；Run 保持未成功，并允许受策略约束的恢复、重试或取消。技术重试属于同一 Run 的新 Attempt。
- **失败与恢复**：Node-A 不得用进程退出、空输出或本地缓存伪造 Final Message；若恢复后成功提交 Final Message，Run 才能成功；若最终取消或失败，必须形成明确终态。
- **最终共享状态**：在 Final Message 提交前不存在成功 Run，也不存在普通 Run 的 Acceptance。
- **可观察结果**：UI 区分“Runtime 已退出”和“Run 已成功”；Node-A 保留可恢复状态；审计记录各 Attempt 及缺失 Final Message 的结果。
- **验证不变量**：I-05、I-12、I-23、I-25、I-27。

## 3. 显式 WorkItem

### S-WORK-FROM-MESSAGE-01：从现有 Message 创建并分配 WorkItem

覆盖：`S-WORK-DIRECT-ASSIGN-01`、`S-WORK-REQUEST-01`、`S-MENTION-IN-WORK-01`、`S-WORK-ASSIGNEE-NO-ACCESS-01`

- **参与者与身份**：Human-H 可管理工作；Agent-A 是候选 assignee；双方可访问源 Message 所在 Discussion Scope。
- **初始共享状态**：Conversation 中已有一条由 Human-H 可引用的 Message；没有对应 WorkItem。
- **意图**：Human-H 显式选择“从消息创建工作”，并直接分配给 Agent-A。
- **正常流程**：Workspace 创建用户可见 WorkItem，保留该 Message 为 source Message，并把选定 Scope 设为唯一 Primary Discussion Scope；Agent-A 成为唯一 assignee。需要立即执行时，另行创建关联该 WorkItem 的 Agent Request，成功 Run 的 Final Message 发布到 Primary Discussion Scope。
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
- **正常流程**：Workspace 原子决定唯一胜者；首个有效 Agent Claim 建立唯一 assignee，并可为胜者创建 Agent Request。
- **失败与恢复**：另一认领得到确定冲突结果，不能成为第二 assignee，也不能因本地先执行而获得责任；不符合资格或权限已变化的认领被拒绝。
- **最终共享状态**：WorkItem 只有一个当前 assignee；失败方没有 Agent Claim 或面向该工作的执行请求。
- **可观察结果**：双方 UI/Node 最终看到相同 owner；审计保留成功与冲突尝试及其因果顺序。
- **验证不变量**：I-09、I-10、I-12、I-16、I-25、I-27。

### S-WORK-RELEASE-REASSIGN-01：Agent 释放后由 Human 重新分配

覆盖：`S-CLAIM-SURVIVES-DEVICE-FAILURE-01`

- **参与者与身份**：Agent-A 是当前 assignee；Human-H 有重分配权限；Agent-B 是可选新 assignee。
- **初始共享状态**：Agent-A 通过有效 Agent Claim 负责 WorkItem；其 Device 在线与否不改变该责任。
- **意图**：Agent-A 主动释放责任，随后 Human-H 显式把 WorkItem 分配给 Agent-B。
- **正常流程**：释放提交后 WorkItem 变为未分配；只有它既有的发布策略明确允许开放认领时才重新成为 Claimable WorkItem。Human-H 的后续分配建立 Agent-B 为唯一 assignee，并可创建新的关联 Agent Request。
- **失败与恢复**：仅 Device 断线、Attempt 失败或 Lease 到期不构成释放；无权主体不能释放他人责任或重分配；与释放并发的分配只能产生一个确定最终 assignee。
- **最终共享状态**：责任历史保留 Agent-A 的 Claim、显式释放和 Human-H 的重新分配；不会出现责任空窗被误记为 Agent-A 仍执行，也不会出现双 assignee。
- **可观察结果**：UI 显示当前 assignee 和责任历史；Node-A 停止获得新执行权，Node-B 只处理新请求；审计记录三次显式决策。
- **验证不变量**：I-09、I-10、I-11、I-12、I-16、I-27。

### S-AGENT-DELEGATION-01：Agent-A 委派 Agent-B 并汇总结果

- **参与者与身份**：Agent-A 是父 WorkItem assignee；Agent-B 在策略范围内可接收委派；两者由各自 Local Node 执行。
- **初始共享状态**：父 WorkItem、其 Primary Discussion Scope 和 Agent-A 的有效执行链已存在；没有子工作。
- **意图**：Agent-A 显式委派一个可独立验收的子结果给 Agent-B，并在返回后汇总父结果。
- **正常流程**：Workspace 创建关联父工作的 Child WorkItem，验证双方权限、Owner 预授权、预算、并发和递归边界，分配 Agent-B 并创建请求；Agent-B 在子工作的 Primary Discussion Scope 发布 Final Message；Agent-A 通过父子关系读取结果并继续父 Run 或创建后续请求，最终发布父结果。
- **失败与恢复**：Agent-B 拒绝接单、预算不足或递归越界时，委派保持明确失败/阻塞且父 WorkItem 仍由 Agent-A 负责；Agent-B 的 Runtime 不能直接回调 Agent-A Runtime 来绕过 Workspace。
- **最终共享状态**：父子 WorkItem 各有唯一 assignee 和独立执行链，结果通过显式关系汇总，完整责任链可追溯。
- **可观察结果**：UI 展示父子关系及各自状态；两个 Node 只获得各自权限；审计可从父请求追到委派、子 Run、子结果和父汇总。
- **验证不变量**：I-10、I-15、I-17、I-20、I-22、I-27。

### S-WORK-REVIEW-01：需要 Review 的 Result Submission 被拒绝

覆盖：`S-CONVERSATION-NO-ACCEPTANCE-01`

- **参与者与身份**：Agent-A 是 WorkItem assignee；Reviewer-R 有 Acceptance 权限；Human-H 可观察结果。
- **初始共享状态**：WorkItem 的 Completion Policy 要求 Review；Agent-A 的 Run 已发布 Final Message，并形成引用该消息和可选 Artifact 的 Result Submission。
- **意图**：Reviewer-R 判断提交结果不满足要求并拒绝。
- **正常流程**：Workspace 记录拒绝；WorkItem 不完成且继续属于原责任链。后续返工通过同一 WorkItem 上新的 Agent Request 和 Run 进行，新结果形成新的 Result Submission。
- **失败与恢复**：Runtime 成功、Final Message 发布或 Artifact 上传均不能绕过 Completion Policy；无 Acceptance 权限的主体不能批准或拒绝；普通 Conversation Run 不得生成 Acceptance。
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
- **意图**：Agent-A 尝试读取私有内容并在共享 Final Message 中使用信息。
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
- **最终共享状态**：内容可用性变化与历史事实分离；既有 Run、WorkItem 和 Acceptance 历史不被重写。
- **可观察结果**：UI 显示内容不可用及保留的来源信息；Node 不把读取失败改写成新版本；审计保留提交和验证主体。
- **验证不变量**：I-23、I-24、I-27。

## 5. Discussion Scope 与并发发布

### S-CONVERSATION-WITHOUT-THREAD-01：Conversation 只有顶层 Message

覆盖：`S-CONVERSATION-INDEPENDENT-01`、`S-THREAD-OPTIONAL-BRANCH-01`、`S-THREAD-NO-WORK-STATE-01`

- **参与者与身份**：Human-H、Agent-A、Workspace。
- **初始共享状态**：存在一个不关联 WorkItem 的 Conversation，只有其 Conversation Timeline，没有 Thread。
- **意图**：Human-H 连续发布顶层 Message，并在其中一次请求 Agent-A。
- **正常流程**：所有顶层 Message 直接属于 Conversation Timeline；该 Timeline 本身作为 Discussion Scope 提供上下文和接收 Final Message，不创建默认或隐藏 Thread。
- **失败与恢复**：实现不能因需要统一消息流而自动创建 Thread；只有用户从一条顶层 Message 显式展开聚焦分支时才形成 Thread；即使形成 Thread，也不承载 WorkItem 责任或完成状态。
- **最终共享状态**：在未展开分支时 Thread 数量为零，Conversation、请求和消息仍可完整恢复。
- **可观察结果**：UI 不显示伪造 Thread；Node-A 观察到 Timeline frontier；审计中的结果 Scope 明确为 Conversation Timeline。
- **验证不变量**：I-01、I-02、I-03、I-04、I-05、I-25。

### S-FINAL-PUBLISH-CONTEXT-ADVANCED-01：同一 Discussion Scope 推进导致 Publication Hold

覆盖：`S-CONTEXT-SNAPSHOT-STABLE-01`

- **参与者与身份**：Agent-A 正在生成；Human-H 可向同一 Scope 发消息；Workspace 决定发布。
- **初始共享状态**：Agent-A 的 Run Context Snapshot 记录结果 Discussion Scope 的已观察 Discussion Frontier V。
- **意图**：Agent 生成期间 Human-H 向同一 Scope 发布新回复；Agent-A 仍携带 V 提交候选 Final Message。
- **正常流程**：Workspace 原子比较 V 与当前 frontier，发现 Scope 已推进后返回 Publication Hold 和准确的介入内容范围；候选 Final Message 不发布，Run 不成功。
- **失败与恢复**：相同候选的盲重试仍不能绕过 hold；系统不能先创建 Message 再回滚，也不能只给模糊摘要替代权威消息范围。
- **最终共享状态**：Human-H 的新回复存在；不存在候选 Final Message；原 Run Context Snapshot 不变，Run 处于可 reconciliation 的未成功状态。
- **可观察结果**：UI 显示 held 和新增内容；Node-A 得到准确增量引用；审计记录观察 frontier、当前 frontier 与发布决定。
- **验证不变量**：I-05、I-16、I-18、I-25、I-27、I-28。

### S-FINAL-PUBLISH-RECONCILE-01：Publication Hold 后显式 reconciliation

- **参与者与身份**：Agent-A、Node-A、Workspace；Human-H 已推进结果 Scope。
- **初始共享状态**：Run 因 stale frontier 得到 Publication Hold；Workspace 提供准确的介入 Message 范围；原始 Snapshot 保持不变。
- **意图**：Agent-A 读取增量、明确吸收新信息并重新生成结果。
- **正常流程**：Node-A 把权威增量作为显式 reconciliation 输入；Agent-A 基于更新后的已观察 frontier 提交新候选；若 frontier 仍当前，Workspace 原子提交 Final Message 并使 Run 成功。
- **失败与恢复**：如果 reconciliation 期间 Scope 再次推进，再次得到新的 hold；摘要生成失败不影响读取权威增量；Agent-A 不能声称已 reconciliation 却沿用旧 frontier。
- **最终共享状态**：成功时只有经过 reconciliation 的 Final Message 被发布，并明确关联原 Run；原 Snapshot 和增量输入均可追溯。
- **可观察结果**：UI 显示从 held 到重新生成再到发布；Node-A 可重复恢复；审计记录每次 frontier 判断和所读增量。
- **验证不变量**：I-05、I-18、I-25、I-27、I-28。

### S-FINAL-PUBLISH-UNRELATED-SCOPE-01：无关 Thread 推进不阻塞发布

- **参与者与身份**：Agent-A 在 Thread-1 生成结果；Human-H 在同一 Conversation 的 Thread-2 回复。
- **初始共享状态**：Thread-1 与 Thread-2 是两个不同 Discussion Scope；Agent-A 已观察 Thread-1 的 frontier V1。
- **意图**：Thread-2 推进后，Agent-A 携带 V1 向 Thread-1 提交 Final Message。
- **正常流程**：Workspace 只比较 Thread-1 的 frontier；由于 Thread-1 未推进，Final Message 正常发布到 Thread-1，Run 可成功。
- **失败与恢复**：Conversation 全局变化、Timeline 变化或 Thread-2 变化不能制造虚假 hold；若 Thread-1 自身推进，则必须按 S-FINAL-PUBLISH-CONTEXT-ADVANCED-01 held。
- **最终共享状态**：Thread-1 包含 Final Message，Thread-2 保留无关回复，两者 frontier 独立推进。
- **可观察结果**：UI 显示正确 Thread 归属；Node-A 只收到结果 Scope 的发布判断；审计记录精确 Discussion Scope。
- **验证不变量**：I-01、I-02、I-05、I-16、I-25、I-28。

## 6. 补充架构验收场景

以下场景补齐总体架构验证标准中不属于上述 18 条主链、但仍必须在后续专题和实现中保持的行为。

### S-WORK-CONVERSATION-LIFECYCLE-01：工作与讨论生命周期独立

- **参与者与初始状态**：Human-H 管理一个已有 Primary Discussion Scope 的 WorkItem。
- **正常结果**：完成或归档 WorkItem 后 Conversation 历史仍可按权限读取；归档 Conversation 后 WorkItem 不被隐式取消。
- **失败结果**：任何级联动作若将另一对象隐式删除、完成或取消，操作被拒绝或只作用于明确目标。
- **可观察性与不变量**：UI 和审计分别显示两次生命周期动作；验证 I-06、I-08、I-16、I-27。

### S-RUNTIME-REPLACEMENT-01：替换 Runtime 不改变 Agent 身份

覆盖：`S-RUNTIME-ADAPTER-CONTRACT-01`

- **参与者与初始状态**：Agent-A 已有 Owner、权限和历史，并通过 Runtime-1 执行过 Run。
- **正常结果**：Owner 在 Local Custody 范围内改用兼容 Runtime-2；后续请求仍属于 Agent-A，历史、Owner 和 Workspace 权限不变。
- **失败结果**：Runtime-2 的私有 Session、协议能力或名称不能创建新 Agent 身份、继承额外权限或改变领域结果。
- **可观察性与不变量**：UI 仍显示同一 Agent；Node 适配公共执行语义；审计区分 Runtime 变化；验证 I-13、I-15、I-20、I-21、I-27。

### S-RUNTIME-CANNOT-FORGE-AUTHORITY-01：Runtime 不能伪造身份或授权

覆盖：`S-GATEWAY-REAUTHORIZATION-01`

- **参与者与初始状态**：Agent-A 的 Runtime 正在一个权限受限的 Run 中，通过 Workspace Interaction Gateway 发起动作。
- **正常结果**：合法动作由 Gateway 绑定实际 Agent、Run 和执行权，并由 Workspace 依据当前权限重新授权。
- **失败结果**：Runtime 在参数中声称其他 Agent、Owner、Workspace、WorkItem 或更大 scope 时，伪造值不被信任，动作被拒绝且不产生共享事实。
- **可观察性与不变量**：Node 收到明确授权结果，审计保留实际绑定身份和失败尝试；验证 I-15、I-16、I-20、I-22、I-27。

### S-WORKSPACE-SINGLE-AUTHORITY-01：投影和连接故障不产生第二权威

- **参与者与初始状态**：两个客户端读取到相同共享状态，其中一个缓存或实时连接落后。
- **正常结果**：两者的修改意图都提交给 Workspace；Workspace 决定唯一结果，落后客户端随后从稳定位置收敛。
- **失败结果**：缓存、搜索、WebSocket、Runtime Session 或本地副本不能自行确认消息、认领、权限或完成事实。
- **可观察性与不变量**：UI 可短暂落后但最终一致，审计只有一条权威决定链；验证 I-10、I-12、I-16、I-25、I-27。

### S-AUDIT-CHAIN-01：共享行为可追溯到责任和执行主体

- **参与者与初始状态**：Human-H 请求 Agent-A；Agent-A 关联可选 WorkItem，并由 Node-A/Runtime-R 执行。
- **正常结果**：从最终共享行为可追到 initiated-by、actor、Owner-at-time、Agent Request、Run、Attempt、Device/Runtime、correlation、causation 和存在时的 WorkItem。
- **失败结果**：缺少必要身份或执行关联的共享写入不能以“系统”或 Runtime 自报身份提交；Owner 变化不改写旧行为责任。
- **可观察性与不变量**：授权审计视图能完整遍历责任链且不泄漏私有正文；验证 I-14、I-15、I-16、I-20、I-22、I-27。

## 7. 初始端到端验收测试目录

下表是后续自动化测试的稳定入口。每个编号继承其所属场景的参与者、权限与失败语义；测试可以细化前置数据，但不能改变可观察结果。

| 验收编号 | 所属场景 | 最小可观察断言 |
|---|---|---|
| `S-CONVERSATION-INDEPENDENT-01` | S-CONVERSATION-WITHOUT-THREAD-01 | Conversation 不关联 WorkItem 仍可发布、恢复和读取消息 |
| `S-CONVERSATION-PRESETS-01` | S-MENTION-DM-01 | Channel 与 DM 预设共享相同请求与执行语义 |
| `S-CONVERSATION-WITHOUT-THREAD-01` | 同名 | 只有 Timeline 时 Thread 数量为零且消息链可工作 |
| `S-THREAD-OPTIONAL-BRANCH-01` | S-CONVERSATION-WITHOUT-THREAD-01 | 只有显式聚焦回复才创建 Thread |
| `S-THREAD-NO-WORK-STATE-01` | S-CONVERSATION-WITHOUT-THREAD-01 | Thread 创建、归档或推进不改变 WorkItem 状态 |
| `S-MENTION-REQUEST-01` | S-MENTION-CHANNEL-01 | mention 与 Message 原子产生定向持久 Agent Request |
| `S-MENTION-NO-WORKITEM-01` | S-MENTION-CHANNEL-01 | 普通 mention 后不存在隐式 WorkItem 或 assignment |
| `S-MENTION-IN-WORK-01` | S-WORK-FROM-MESSAGE-01 | WorkItem 讨论中的普通 mention 不推进或关联工作 |
| `S-WORK-REQUEST-01` | S-WORK-FROM-MESSAGE-01 | 显式工作请求经 Agent Request 进入统一 Run 模型 |
| `S-RUN-FINAL-MESSAGE-01` | S-MENTION-CHANNEL-01 | Final Message 提交到结果 Scope 后 Run 才成功 |
| `S-RUN-MISSING-FINAL-01` | 同名 | Runtime 正常退出但无 Final Message 时 Run 不成功 |
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
| `S-CONVERSATION-NO-ACCEPTANCE-01` | S-WORK-REVIEW-01 | 普通会话 Run 不形成 Acceptance |
| `S-WORK-REVIEW-01` | 同名 | 拒绝不完成 WorkItem，返工留在同一责任链 |
| `S-OWNER-ACCOUNTABILITY-01` | S-OWNER-SUSPEND-01 | 唯一 Owner 可暂停 Agent 且不能改写历史 |
| `S-AUTHORITY-SEPARATION-01` | S-OWNER-SUSPEND-01 | Governance、Accountability、Local Custody 互不冒充 |
| `S-CONTEXT-SNAPSHOT-STABLE-01` | S-FINAL-PUBLISH-CONTEXT-ADVANCED-01 | 后续消息和 reconciliation 不改写原始 Snapshot |
| `S-PRIVATE-CONTEXT-GRANT-01` | S-PRIVATE-CONTEXT-01 | 未授权时团队请求不能读取 Owner 私有内容 |
| `S-PRIVATE-DISCLOSURE-DENIED-01` | S-PRIVATE-CONTEXT-01 | 读取授权不自动允许共享披露 |
| `S-EXTERNAL-ARTIFACT-DISAPPEARS-01` | 同名 | 外部内容消失不改写 lineage 和历史验证事实 |
| `S-OFFLINE-RECONCILIATION-01` | 同名 | 离线候选经重连再验证后才可能成为共享事实 |
| `S-LOCAL-RESTART-01` | S-OFFLINE-RECONCILIATION-01 | Node 重启可恢复请求、执行和待提交候选且不猜测成功 |
| `S-FINAL-PUBLISH-CONTEXT-ADVANCED-01` | 同名 | 同一 Scope 推进时不发布候选并返回准确 hold |
| `S-FINAL-PUBLISH-RECONCILE-01` | 同名 | Agent 读取准确增量并以新 frontier 成功发布 |
| `S-FINAL-PUBLISH-UNRELATED-SCOPE-01` | 同名 | 无关 Thread 推进不阻塞目标 Scope 发布 |
| `S-RUNTIME-REPLACEMENT-01` | 同名 | 替换 Runtime 后 Agent 身份、Owner、权限和历史不变 |
| `S-RUNTIME-ADAPTER-CONTRACT-01` | S-RUNTIME-REPLACEMENT-01 | 不同 Adapter 保持公共执行语义和相同领域结果 |
| `S-RUNTIME-CANNOT-FORGE-AUTHORITY-01` | 同名 | Runtime 自报身份或 scope 不产生权限 |
| `S-GATEWAY-REAUTHORIZATION-01` | S-RUNTIME-CANNOT-FORGE-AUTHORITY-01 | 每个 Runtime Workspace 动作绑定并重新授权 |
| `S-WORKSPACE-SINGLE-AUTHORITY-01` | 同名 | 缓存、连接和本地副本不能确认共享事实 |
| `S-NOTIFICATION-LOSS-01` | S-MENTION-CHANNEL-01 | 通知丢失后已提交 Agent Request 仍可恢复发现 |
| `S-AUDIT-CHAIN-01` | 同名 | 共享结果可遍历完整请求、责任与执行链 |

## 8. 覆盖结论

- 路线图列出的 18 个必选场景均有正常流程、权限/并发/断线或失败分支、最终共享状态和三端可观察结果；
- `TRACEABILITY.md` 中 I-01 至 I-28 引用的全部验收编号均已在本文定义；
- 场景只约束领域行为，不依赖表名、字段名、传输协议、错误码或页面布局；
- Step 2 及后续专题可以增加更细的状态转换和测试数据，但不得改变本文的成功、失败和权限语义。
