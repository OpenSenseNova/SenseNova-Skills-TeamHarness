# AI-Native 协作框架：项目设计与实施路线图

> 状态：Active — V1 纵向链已实现；真实 Runtime 登录态冒烟为发布前 opt-in Gate
>
> 上游基线：`docs/ARCHITECTURE_V1.md`
>
> 目的：将总体架构逐层落实为可实施设计，明确每一步的工作、产物、完成标准，以及何时可以开始工程编码和基本产品实现。

## 1. 总体策略

项目不采用“先把所有专题设计完，再一次性开始编码”的方式，也不在领域语义尚未明确时从数据库表、页面或协议字段开始。

采用两条并行但有门槛的工作轨道：

```text
设计轨道
架构基线
→ 核心场景
→ Conversation / Thread / Agent Request
→ Workspace Interface
→ 工程基础决策
→ Execution Model
→ Local Agent & Runtime
→ 权限 / 上下文 / 产物 / 可靠性 / 运维

实施轨道
                         └→ Workspace 核心编码
                                           └→ 基本产品纵向链
                                                      └→ 逐层增加可靠性与治理
```

核心原则：

- 每个阶段都要产出可验证结果，而不只是概念描述；
- 先确定领域行为，再确定存储和 wire schema；
- Interface 是调用者和测试共同使用的验证面；
- 只有真实存在两种行为实现时才建立外部 seam；
- 实施按可工作的纵向链增长，新能力建立在已工作的产品上；
- 后续设计可以与前一层实施并行，但不能改变已经通过的上游不变量；
- 若专题设计发现总体架构错误，先更新 `CONTEXT.md`、ADR 和架构版本，不用兼容层掩盖冲突。

## 2. 实施门槛总览

| 门槛 | 到达时间 | 可以开始什么 | 尚不能宣称什么 |
|---|---|---|---|
| Gate 0：架构基线成立 | Step 0 完成 | 规划专题设计和工程验证 | 不能开始领域实现 |
| Gate A：工程骨架与 Workspace 核心编码可开始 | Step 4 完成 | Workspace Collaboration Module、持久化骨架、最小 Web | 尚未形成基本产品，不能宣称 Agent 可端到端执行 |
| Gate B：基本产品实现可开始 | Step 6 完成 | 第一条包含 Local Node、Runtime Adapter 和 Workspace 写回的完整纵向链 | 还不能供真实团队安全使用 |
| Gate C：内部可用版本 | Step 9 完成 | 两名 Human、多个 Agent 进行受控试用 | 尚未达到生产运营标准 |
| Gate D：可发布版本 | Step 12 完成 | 面向目标用户发布 | 不代表已具备未来企业能力 |

最直接的答案是：

> **Step 4 完成后可以开始工程骨架与 Workspace 核心编码；Step 6 完成后才开始基本产品实现，即第一条真正有 Agent 执行的端到端纵向链。**

Step 4 之前可以编写探索性代码或测试技术可行性，但不得将其当作产品实现主干。

### Project 与 Artifact 0.6 纵向链

ADR-0044 当前定义已经实现且不保留旧的 Repository-required 合同：

1. Project 只要求名称，Repository 为零或一个 active 关联；挂载、默认分支更新、解除和历史 provenance 由同一权威模型管理；
2. Repository-backed Attempt 使用匹配 Working Copy 的隔离 worktree，repository-less Project 使用隔离 scratch；
3. Resource Link 与 Workspace Artifact 是两个独立资源模型；Artifact 通过多对多关联进入 Project；
4. Markdown Yjs 当前状态、File 可替换 current blob、UUID 历史快照、消息固定引用、Agent staged publication 和回收清理形成完整纵向链；
5. OpenAPI、生成 Web 类型、Human Web、变化流、审计和自动化测试使用同一合同。

## 3. Step 0：关闭总体架构基线

### 目标

保证 V2 中不存在会改变产品形态的未定义概念，让后续专题设计拥有稳定上游。

### 要做什么

1. 将 Conversation、Conversation Timeline、Thread、Discussion Scope、Message、Agent Request 和显式 WorkItem 的语义补入 `ARCHITECTURE_V1.md`；
2. 明确 Conversation 是唯一讨论容器，拥有顶层 Conversation Timeline，Channel/DM 只是参与、发现和展示策略，不建立独立领域模型；
3. 明确 Thread 是从顶层 Message 展开的可选聚焦分支，不是强制消息容器，也不承担任务状态；
4. 明确每个 `@Agent` 目标创建 Mention Outcome，仅有效目标创建 Agent Request，不隐式创建或推进 WorkItem，所有执行入口经 Agent Request 汇入 Run；
5. 明确 Run 由执行层独立结束，Conversation 只存在一种 Message，普通 Message 不承担 Run、WorkItem、Submission 或 Review 状态；
6. 明确 WorkItem 是可选、显式、用户可见的工作管理对象，关联 source Message 与 Primary Discussion Scope；
7. 明确无现成讨论位置的 WorkItem 创建会原子创建 Conversation 和初始 Message，并使用新 Conversation Timeline 作为 Primary Discussion Scope；
8. 明确 Agent Inbox wake 只携带 sequence，Runtime 用 claim receipt 主动拉取准确 Discussion Scope 增量；
9. 检查 V2、`CONTEXT.md` 和所有 ADR 是否互相一致；
10. 建立“架构不变量 → ADR → 后续专题 → 验收场景”的追踪清单。

### 产物

- 更新后的 `docs/ARCHITECTURE_V1.md`；
- 更新后的 `CONTEXT.md`；
- 必要的新 ADR；
- `docs/design/TRACEABILITY.md`。

### 完成标准

- Conversation Timeline、可选 Thread、Discussion Scope、Agent Request、Run、WorkItem 不再有重叠含义；
- Channel 和 DM 不再产生重复领域模型；
- 所有已确认核心需求都能指向一条架构不变量；
- 没有协议、数据库或 UI 细节被误写成领域不变量；
- 不再存在需要用户回答的核心产品问题。

### 实施状态

**Completed：Gate 0 已关闭。** 架构基线已经成立，可以开始 Step 1 核心场景与后续专题设计；此阶段不开始产品实现。

## 4. Step 1：编写核心场景与验收目录

### 目标

把架构语言转成可观察行为，为所有后续设计和验收测试提供共同输入。

### 要做什么

为每个核心场景写清：

- 参与者和当前身份；
- 初始共享状态；
- 用户或 Agent 发起的意图；
- 正常流程；
- 权限、并发、断线和失败分支；
- 最终共享状态；
- UI、Local Node 和审计可观察到什么；
- 哪条架构不变量被验证。

至少覆盖：

1. Human 在 Channel 风格 Conversation 中 `@Agent`，持久记录目标 Outcome，且仅有效目标创建 Agent Request；
2. Human 在 DM 风格 Conversation 中 `@Agent`，执行语义与 Channel 风格一致；
3. Runtime 正常结束且没有发布 Message，Run 仍按独立执行结果结束；
4. 从现有 Message 显式创建并分配 WorkItem；
5. 无 Conversation 时创建 WorkItem，原子生成专用讨论位置；
6. 普通 mention 其他 Agent 不创建 Child WorkItem，显式委派才创建；
7. 多个 Agent 并发认领一个开放任务；
8. Agent 主动释放，Human 显式重新分配；
9. Agent-A 委派 Agent-B 并汇总结果；
10. Runtime 成功但受 Review 的 Result Submission 被拒绝，Submission 状态保持不变；
11. Owner 暂停 Agent；
12. Local Node 断网、Lease 到期和重连；
13. 私有上下文未授权、已授权读取但禁止披露；
14. Artifact 删除并到期清理正文后，Message 与 Run 的版本快照和 lineage 仍保留；
15. Conversation 只有顶层 Message、没有 Thread；
16. 同一 Discussion Scope 在 Agent 生成期间新增回复，只设置 wakePending 并在下一安全边界继续拉取；
17. Agent 获取准确增量后选择修订、丢弃、确认不变或审计化 publish-anyway；
18. 同一 Conversation 的无关 Thread 推进，不阻塞当前 Discussion Scope 的发布。

### 产物

- `docs/design/01-core-scenarios.md`；
- 场景编号，例如 `S-MENTION-CHANNEL-01`；
- 初始的端到端验收测试目录。

### 完成标准

- 每个核心场景都有正常与失败结果；
- 场景只描述可观察行为，不依赖表名或协议字段；
- 后续每份专题设计都能引用场景编号；
- 场景之间没有互相矛盾的任务或权限语义。

### 实施状态

**Completed。** 核心场景与初始端到端验收目录已写入 `docs/design/01-core-scenarios.md`，并已作为 Step 2 Conversation & Work 领域模型的验收输入。

## 5. Step 2：设计 Conversation、Thread 与 Agent Request 领域模型

### 目标

定义共享协作的事实、关系、生命周期和原子不变量。这是数据库、Web、Workspace Interface 和 Local Node 的共同上游。

### 要做什么

#### 5.1 Conversation 模型

- 定义统一 Conversation、Conversation Timeline、Channel/DM 策略预设、可选 Thread、Discussion Scope 和 Message；
- 定义参与者、可见性和权限继承；
- 定义消息顺序和不可编辑、不可删除语义，以及 Conversation 可恢复归档和归档后只读生命周期；
- 定义顶层 Message、Thread root 和 Thread Reply 的归属关系；
- 定义各 Discussion Scope 的 frontier，以及哪些内容变化会推进它；
- 定义 mention 的合法目标；
- 定义 Agent Request 的触发来源和结果目标；
- 区分 Conversation Timeline 与 Execution Timeline。

#### 5.2 Agent Request 模型

- 定义由 `requested` Agent Mention Outcome 创建的 Agent Request，以及从请求到 Run 的交接语义；
- 删除显式 `ContinueWorkWithAgent`，明确只有新 `@Agent` 目标的 `requested` Outcome 才创建新请求，普通 Message 不触发执行；
- 定义 Request 的权威生命周期、派生 intake disposition、取消和权限撤销语义；
- 定义 Message、每目标 Mention Outcome 与有效目标 Agent Request 的一次原子提交；目标结果可以不同，但任何目标都不能缺少持久结果。
- 定义 Outcome 状态随 Message 可见、精确拒绝原因按治理权限披露，并保持单一权威原因而非 public/private 双写。
- 定义 `not_requested` 与 Request intake 的边界：请求无权成立才不创建；合法请求的临时条件进入 `waiting / blocked` 投影，不可恢复拒绝进入 Request `rejected`。
- 定义权限或访问变化不追溯激活 `not_requested`；新的显式 mention 才能创建 Request，而已有 pending Request 可随临时条件变化重新求值。

#### 5.3 后续显式工作层（不属于 MVP 或当前 Step 2 关闭条件）

- 定义 WorkItem、Child WorkItem、关系和依赖；
- 定义 source Message 和 Primary Discussion Scope；
- 定义无讨论位置时 Conversation、初始 Message 和 WorkItem 的原子创建；
- 定义 Direct Assignment 与 Claimable WorkItem；
- 定义 Work Assignee 的唯一性；
- 定义 Agent Claim、释放、撤销和重分配；
- 定义 Result Submission、独立 Review、Completion Policy、拒绝和返工；
- 定义取消和阻塞，并明确当前没有 WorkItem 归档或重新打开。

这些事实继续保留在领域设计中，等显式工作层进入产品范围时再完成剩余确认和实现；MVP 不创建对应 schema、命令、投影或 UI。

#### 5.4 状态转换

至少形成：

```text
Agent Request lifecycle
Conversation / Thread lifecycle and Discussion Scope frontier
```

WorkItem、Agent Claim、Result Submission、Review 和 Completion Policy 的状态转换属于后续显式工作层。

每个转换必须说明：

- 谁可发起；
- 前置条件；
- 同步成立的不变量；
- 冲突时的确定结果；
- 产生的领域事实。

### 产物

- `docs/design/02-conversation-and-work.md`；
- 状态转换表；
- 领域关系图；
- 原子不变量清单；
- 对 `CONTEXT.md` 的必要更新。

### 完成标准

- 每个 Conversation MVP 场景都能映射为确定状态转换；
- 每个 Agent Mention 目标独立产生 `requested(request)` 或 `not_requested(reason)`，仅有效目标创建 Agent Request，且不会创建任何 WorkItem；
- 所有 Message 读者都能看到每目标是否触发 Request；精确 `not_requested` 治理原因只向当前 Workspace Owner 或目标 Agent 的当前 Owner 投影，其他读者只得到安全概括；
- Mention Outcome 一经 `requested` 永不因 intake 等待、阻塞或拒绝而改写；三类结果在数据模型中没有重叠含义；
- `not_requested` 也永久不变，原因消失不自动补建 Request，避免权限变化触发历史 Message 执行；
- Agent Request 和 Run 可以完成而不存在 WorkItem；
- Run terminal outcome 与 Message 发布相互独立，Run 可以产生零到多条普通 Message；
- Run terminal 关闭该 Run 首次发布新 Agent Message 的共享写入权；发布与 terminal 必须形成唯一 Workspace 提交顺序，terminal 后只能幂等返回 terminal 前已提交发布的原结果；
- Conversation 可以没有 Thread，顶层 Message 不依赖隐式默认 Thread；
- 任一 active Human scope Member 可创建 Workspace 或 Project Channel；Channel 不保存成员关系，当前参与者自动等于所属 Workspace/Project 的 active Membership；
- MVP 不引入 Conversation Owner/Administrator、Channel 成员治理或 Owner 恢复；creator 只用于审计，Workspace DM 固定两个 direct participants；
- 当前 scope Membership 控制完整 Channel 历史：加入 scope 可读全部历史，移除后不能读取新旧内容；不引入加入时间窗口或 Message ACL；
- Workspace Membership 移除立即关闭 Workspace Channel、DM 与相关执行；重新加入恢复 Workspace Channel 但不恢复固定 DM 或旧 Run 权限；
- Human/Agent identity 与 Workspace Membership 分离；Membership 是不可复活的连续参与期，同一 actor 在同一 Workspace 至多一个 active，Human 可在多个 Workspace 同时拥有独立 active Membership，重新加入同一 Workspace 创建新的 Membership，历史行为记录 membership-at-time；
- Agent identity 永久归属一个 Workspace，不能跨 Workspace 加入或迁移；相似配置在另一 Workspace 创建新的 Agent，权限、Owner、上下文和历史不合并；
- 任一 active Human Workspace Member 可创建 Agent；Workspace 原子建立 Agent identity、active `member` Membership 与 creator 作为唯一 Agent Owner。Agent 立即参与 Workspace Channel，但不自动进入 Project、DM 或本地执行资源；
- 产品必须支持从顶层 Message 的第一条 reply 原子创建 Thread，且 Thread 内 `@Agent` 的结果目标仍是该 Thread；
- Agent Message 发布校验 active Run/Attempt、claim receipt、Binding revision 与当前权限；不存在单独的 freshness review 阶段；
- 每条 Agent-authored Message 必须由 Workspace 绑定到同一 Agent 的唯一 producing Run；Human-authored Message 没有 producing Run，关联不参与 Run outcome；
- Conversation 支持 expected-revision 归档/恢复；归档保留历史、从默认列表隐藏并阻止新写入，存在 pending Agent Request 或 active Run 时拒绝归档；
- WorkItem 不是当前 Step 2、Step 3 或 MVP 的关闭条件。

### 实施状态

**Completed。** Workspace 授权前置事实与 Conversation MVP 的关系、生命周期、角色权限、原子边界、冲突结果和验收场景均已关闭。Thread 是必须交付的能力，但单个 Conversation 可以没有 Thread。已确认的 WorkItem、Submission、Completion Policy 和 Review 事实保留在 `docs/design/02-conversation-and-work.md`，整体延后到显式工作层，不阻塞 Step 3 或 MVP。

## 6. Step 3：设计 Workspace Collaboration Module 的 Interface

### 目标

给 Human Client 和 Local Node 一个小而深的共享协作 Interface，隐藏事务、权限、并发、投递和读取投影。

### 要做什么

#### 6.1 设计 Interface 形态

Interface 至少表达三类行为：

- 提交经过认证的协作意图；
- 读取经过授权的当前快照；
- 从稳定位置跟随已提交变化和工作提示。

不要为每个内部 Module、Repository 或数据库表暴露 Interface。

#### 6.2 定义闭合业务意图

至少包括：

- PostMessage；
- PostMessageAndRequestAgent；
- PostAgentMessage / ReviewHeldDraft；
- ReplyInThread / PostMessageAndRequestAgentInThread；
- RemoveWorkspaceMember；
- Suspend/ResumeAgent。

`CreateConversation` 与 Workspace/Project Membership 变更属于 Human governance Interface，不得因 Agent 已有 `PostAgentMessage` 权限而向 Runtime 或 Local Node 暴露。任一 active Human scope Member 可创建 Channel；Channel 没有参与者变更意图，DM 不提供 direct participant 变更。上述行为与内容发布不是同一种授权能力。

Interface 不提供 Conversation ownership 查询、转移或管理员维护命令。读取结果可以暴露 creator provenance，但调用者不得用 creator 身份推导当前治理权限。

Conversation 快照必须返回当前 scope Membership 推导的只读参与者投影；Workspace join 或 Project member add 不拼装 Conversation-local 变更，所有 Channel 读取直接依据最新 scope Membership。

所有读取 Interface——快照、变化跟随、搜索与缓存回源——在读取时按当前 Workspace/Project Membership 或固定 DM participants 重新授权。scope 成员加入后返回完整 Channel 历史；移除后不再返回旧内容。

`RemoveWorkspaceMember` 是一个闭合治理意图：Workspace Membership 撤销、全部 Channel/DM 访问关闭，以及相关 pending Request 取消和 active Run fencing 必须作为一个权威结果生效。投影或物理清理可随后收敛；以后重新加入仅恢复 scope-derived Channel。

Human Membership 仍拥有 Agent 时不能终止。只有当前 Workspace Owner 可转移 ownership、终止或重新准入 Agent Membership；当前 Agent Owner 治理暂停/恢复与约束，Agent Host 的本地停止不能冒充任何共享治理权。

加入或重新加入 Workspace 返回新的 Workspace Membership；Interface 不能接受调用者指定要复活的 Membership。Actor 身份由认证上下文绑定，所有治理、Conversation 与执行命令再绑定其当前 active Membership；审计结果同时保留 actor 与 membership-at-time。

Workspace Invitation 允许在 Human 注册前以 normalized verified email 建立 pending 邀请，但邀请链接不是 bearer authority。接受 Interface 从认证 seam 获得 stable Human identity 与 verified-email claims，只有完全匹配才原子提交 Invitation `accepted` 与新的 `member` Membership；调用者不能自报 email 已验证或 accepted Human identity。

Agent 创建 Interface 原子产生新的 Workspace-local Agent identity、active `member` Membership 与 creator 作为唯一 Agent Owner。该 Membership 立即授予 Workspace Channel participation，但不建立 Project Membership、固定 DM、私有上下文、凭据、Runtime Binding 或本地资源。

WorkItem、Result Submission 和 Review 的 Interface 意图在后续显式工作层设计，不为 MVP 预留空命令。

#### 6.3 定义 Interface 契约

每个意图明确：

- actor 来自哪里，哪些字段调用者不能自报；
- 幂等身份；
- 版本或并发前置条件；
- 成功结果；
- 正常但无 Message 的执行结果，例如 Runtime 基于 Initial Snapshot 与已确认 Addenda 返回 `no_output`；
- 稳定失败类型及是否可重试；
- 一次提交必须原子成立的事实；
- 调用者可以观察到的变化。

#### 6.4 设计契约测试

测试只通过 Workspace Interface 验证领域结果，不穿透内部 Repository 或状态机实现。

### 产物

- `docs/design/03-workspace-interface.md`；
- Interface 行为规范；
- 意图和结果 schema 的概念草案；
- 稳定错误分类；
- 契约测试清单。

### 完成标准

- Web 和 Local Node 不需要自己编排领域事务；
- 一次含 `@Agent` 的发布原子提交 Message、所有 per-target Outcome 与有效目标的 Agent Request；局部拒绝被持久表达而不是静默遗漏；
- Interface 返回完整 per-target Outcome，使调用者不需要通过缺失的 Request 猜测目标是否被请求；
- Interface 只向当前 Workspace Owner 或目标 Agent 的当前 Owner 投影精确 `not_requested` 治理原因，其他观察者仅得安全概括；Web、Local Node、缓存与变化流不得越权泄露原始明细；
- 第一条 Thread reply 原子创建 Thread 与 reply Message；
- Agent Inbox claim 幂等且可重放；claim 后崩溃不得丢失 Message 或重复创建 Run；
- Agent Message 的作者和 producing Run 由 Workspace 从受信执行凭证绑定，Interface 不接受 Runtime 自报的 Agent 或 Run 作为权威；
- Agent Message 首次发布和 producing Run terminal 使用同一并发裁决点；Interface 明确区分新发布失败与已提交发布的幂等重放结果；
- Conversation 创建和 scope Membership 变更只接受受信 Human actor；Agent 发布凭证不能调用或拼装这些治理意图；
- creator 离开或失权不触发 Conversation ownership transfer；Interface 始终按当前 Workspace Human 权限与 preset 求值治理资格；
- 新 Workspace/Project Member 自动成为该 scope 全部 Channel 的当前参与者；DM direct participants 不可变；
- scope 成员添加授予完整 Channel 历史读取，移除立即阻止所有后续读取；所有投影一致执行当前授权；
- Workspace Member 移除后撤权立即成立，相关请求/运行被取消或 fenced；重新加入恢复 Channel但不恢复 DM/Run；
- Agent identity、Membership、Request、Run 与 Message provenance 始终同属一个 Workspace；不存在 Agent 迁移、共享或跨 Workspace 调用路径；
- Interface 不暴露数据库、事件存储或策略求值器；
- 所有 Conversation MVP 场景都能通过 Interface 驱动和观察。

### 实施状态

**Conversation / Thread / Mention Outcome / Agent Request 部分已实现。** 当前 Interface 已覆盖 scope-derived Channel access、结构化 mention 的原子发布、权限化原因投影、准确 Thread 结果目标、pending Request 取消、变化流与可靠投递。

## 7. Step 4：确定工程基础与第一纵向切片

### 目标

做出启动主干实现所需的最少技术决策，并把第一条纵向链拆成可交付工作。

### 要做什么

#### 7.1 技术与代码组织决策

只决定当前真实需要的内容：

- Workspace Authority 和 Local Node 的实现语言与运行方式；
- 仓库组织与 Module 位置；
- 共享事务存储；
- Workspace Access 的第一个 transport Adapter；
- 数据库集成测试方式；
- Human 身份的最小认证方式；
- 本地配置和秘密保存方式；
- 构建、格式化、静态检查和测试命令。

只为难以逆转、存在真实取舍的选择创建 ADR。

#### 7.2 第一纵向切片

将第一条链拆成可提交工作：

```text
Human login
→ create/join Workspace
→ create Conversation with a Channel-style participation policy
→ post a top-level Message
→ reply with @Agent, atomically creating a Thread and its first reply
→ atomically create an Agent Request without a WorkItem
→ query the pending Agent Request
→ placeholder executor optionally publishes an ordinary Message
→ execution outcome is recorded independently
→ display the result in that same Thread
```

第一切片中的 placeholder executor 只用于验证 Workspace 工作流，不伪装成最终 Runtime Integration。它应位于未来可删除的测试/开发 Adapter 中，而不是成为第二套执行架构。

#### 7.3 建立验收测试结构

- Workspace Interface 契约测试；
- 使用真实事务存储的集成测试；
- 第一纵向切片的端到端测试；
- 测试断言可观察结果，不断言内部表结构。

### 产物

- 必要的技术 ADR；
- 代码目录设计；
- 第一纵向切片 backlog；
- Definition of Done；
- 测试策略和基础命令。

### 完成标准

- 开发者无需自行决定领域语义或核心技术方向即可开始；
- 第一切片有明确输入、输出和验收场景；
- 代码 Module 对应 V2 的职责，不按数据库表拆分；
- 没有为未来 Adapter 预建假想 seam。

### 实施状态：Gate A

**Completed：Gate A 已关闭。** Workspace 核心、HTTP Adapter、Human 认证和最小 Web 已形成可运行产品；尚未形成 Agent 执行闭环。

此时可以实施：

- Workspace Collaboration Module；
- Human、Agent、Owner 和 Membership 基础模型；
- Conversation、Conversation Timeline、Channel/DM 策略、可选 Thread、Discussion Scope 和 Message；
- Agent Request 与普通 Message provenance；
- Workspace Interface 的第一个 transport Adapter；
- 共享事务存储；
- 最小 Web 页面；
- 不启动真实 Runtime 的纵向验收链。

与此同时，设计轨道继续 Step 5 和 Step 6。

## 8. Step 5：设计 Execution Model

### 目标

把来自 Conversation 的持久 Agent Request 可靠地转换为不可靠设备上的执行，并彻底分离 Agent Request、Run 与 Execution Lease。

### 要做什么

- 定义 Agent Request、Run、Attempt、Execution Lease；
- 定义 Conversation mention 如何产生 Agent Request；
- 定义 Agent Request 如何在授权与 intake 检查后产生 Run；
- 定义 Assigned Request Inbox 的读取语义；
- 明确 Inbox 是可重建读取视图，不是任务权威；
- 定义 Local Node 如何发现、获取和恢复 Agent Request；
- 定义 Lease 获取、续期、到期和防旧执行；
- 定义何时创建新 Agent Request、Run 和 Attempt；
- 定义 Runtime Adapter outcome 如何独立形成 Run terminal state；
- 定义 Runtime 本地结束与 Workspace Run terminal 的边界：正常收尾先解决本地 pending Message 发布意图，再请求 terminal；取消、授权撤销、超时等强制 terminal 可以先关闭后续首次发布；
- 定义 Agent Message 首次发布与 producing Run terminal 的统一提交顺序，不引入独立 `RunWritePermission` 状态；
- 定义 `PostAgentMessage(expectedDiscussionFrontier)` 的原子校验、published/freshness-review 结果和幂等重放；
- 定义准确增量、Held Draft、Agent 四种复核选择和有界恢复；
- 定义取消、Owner 暂停、授权撤销和 Runtime 失败；
- 定义断网候选结果的重连校验；
- 定义失败或拒绝为何不静默改派；
- 定义外部副作用结果未知时的处理责任。

### 产物

- `docs/design/04-execution-model.md`；
- Agent Request/Run/Attempt/Lease 状态转换表；
- Inbox 查询语义；
- 失败恢复序列图；
- 并发与幂等验收场景。

### 完成标准

- 请求来源、设备执行权和 Runtime Session 不再共用状态；
- 旧 Attempt 不能覆盖当前结果；
- 没有 Message 的 Run 仍按执行层 outcome 结束，且不产生隐式回复状态；
- Discussion Scope 推进后，旧 frontier 的候选 Message 不能首次发布，Run 保持不变；
- producing Run terminal 后不能首次发布新 Agent Message；terminal 前已提交发布的幂等重放返回原结果且不新增 Message；
- 所有执行失败都得到确定的共享状态；
- Local Node 无需依赖实时通知保证工作可发现。

### 实施状态

Context/Privacy Gate 1–4 已实现：schema v5、accept/Run/Attempt/return 纵向链、Standing/Policy/Private Grant、Immutable Manifest、通用 ACP v1 Adapter、四类 Runtime Profile 与 fake ACP 门禁均已落地。真实 Runtime 登录态冒烟仍是 opt-in 发布前 Gate 5。

## 9. Step 6：设计 Local Agent、Runtime Integration 与 Workspace Interaction

### 目标

确定 Local Node 如何受控地驱动可替换 Runtime，并允许 Runtime 作为当前 Agent 操作 Workspace。

### 要做什么

#### 9.1 Local Agent Module

- 定义 Device 身份与 Agent Binding；
- 定义本地持久状态和恢复范围；
- 定义并发与运行生命周期；
- 定义 Agent Request 获取、确认和拒绝；
- 定义 Run Context Snapshot 执行事实；
- 定义 Agent Inbox、Discussion Scope position、claim receipt 和 staged publication intent 的本地持久恢复；
- 定义本地工作目录和 Credential 使用；
- 定义 Offline Continuation；
- 定义 pending ordinary Message、Held Draft decision 和重连提交。

#### 9.2 Runtime Integration seam

定义协议无关的行为：

- 启动一次执行；
- 输入目标和上下文；
- 接收进度、交互请求和候选结果；
- 请求取消；
- 协商可选能力；
- 保存不透明的本地 Session 状态。

当前通用实现使用官方 `@agentclientprotocol/sdk` 的 ACP v1 fluent client 与 stdio；CLI、HTTP 或 Embedded Runtime 若不是 ACP，必须实现新的 `RuntimeIntegration`，不能塞入 ACP Profile。

#### 9.3 Workspace Interaction seam

定义 Runtime 在当前执行身份下能够：

- 查询授权共享上下文；
- 发布进度、问题和阻塞；
- 向结果 Discussion Scope 提交带已观察 frontier 的普通候选 Message，并处理 published/freshness-review 结果；
- 通过 mention 请求其他 Agent 参与。

明确 Agent、Owner、Workspace、Agent Request、Run 和权限由 Local Agent Module 绑定，并由 Workspace Authority 重新验证，Runtime 不得自报。

#### 9.4 通用 ACP 与真实 Runtime Profile

以 fake ACP Agent 作为无凭据强制契约门禁；Codex、Claude、Gemini 与 Goose 共享同一个 ACP transport，通过明确 `runtimeId` Profile 生成各自 Attempt-root 指令入口并声明 continuity。真实 Runtime 已安装且登录时，通过 `npm run smoke:<runtime>` 执行 opt-in 冒烟，并显式提供 `ANC_RUNTIME_COMMAND` 与可选 `ANC_RUNTIME_ARGS_JSON`；不能让 CI 依赖四家账号或根据可执行文件名猜测协议能力。

### 产物

- `docs/design/05-local-agent-module.md`；
- `docs/design/06-runtime-and-workspace-interaction.md`；
- Runtime Integration 行为规范；
- Workspace Interaction 行为规范；
- 第一个 Runtime Adapter 实施计划；
- Local Node 端到端测试计划。

### 完成标准

- Runtime 替换不改变 Agent 身份和 Workspace 领域模型；
- Runtime 不持有长期 Workspace Credential；
- Runtime 可以主动协作但不能绕过 Workspace Authority；
- 断网、取消和进程退出都有确定行为；
- 第一个真实 Adapter 可以在不补充领域语义的情况下实现。

### 实施状态：Gate B

**完成 Step 6 后，开始基本产品实现，即真正的 Agent 端到端纵向链。**

在已有 Workspace 核心编码上增加：

```text
@Agent
→ durable Agent Request becomes discoverable
→ Local Node obtains execution authority
→ first Runtime Adapter executes
→ Runtime uses Workspace Interaction Gateway
→ Agent may commit ordinary Messages to the original Discussion Scope
→ execution layer ends Run without creating a WorkItem, Submission, or Review
```

此时第一次形成产品独特价值，但仍只适合开发环境验证。

## 10. Step 7：设计身份、Owner 与授权

### 目标

把 Workspace Governance、Owner Accountability 和 Local Custody 落实为可执行规则。

### 要做什么

- 定义 Human、Agent、Device 和执行身份；
- 定义 Agent 创建、暂停、恢复和 Owner 变更；
- 定义当前 Owner=Host 的产品约束；
- 定义 Workspace Role、Agent 权限、接单策略和委派策略；
- 定义 Agent Request、Direct Assignment、Claim、Delegation、Message、Artifact、Submission 和 Review 的动作矩阵；
- 定义 Owner 的暂停、取消、收紧和审计权；
- 区分 Workspace Authorization 与 Local Execution Policy；
- 定义权限撤销对新操作和运行中操作的影响；
- 定义 Agent Authorship 和 owner-at-time 审计。

### 产物

- `docs/design/07-authorization-and-governance.md`；
- 主体×动作×资源权限矩阵；
- Owner/Agent 生命周期；
- 撤销和暂停场景；
- 授权验收测试。

### 完成标准

- 每个共享写动作都有唯一授权权威；
- Owner 只能收紧，不能突破 Workspace 权限；
- Agent 不能通过 Runtime 参数伪造身份或能力；
- Agent Delegation 同时满足发起方和接收方规则；
- 历史 Owner 责任不会因转移而改变。

### 实施状态

在 Gate B 纵向链上加入真实身份、Owner 控制与最小权限。完成后才能让多名开发成员开始受控试用。

## 11. Step 8：设计 Context、Artifact 与 Completion

### 目标

形成可解释、可复核且不泄漏 Owner 私有数据的执行输入和结果闭环。

### 要做什么

#### 11.1 Context

- 定义 Run Context Snapshot、Inbox attention 与 Discussion message delta 的边界；
- 定义 Workspace/Conversation context version 和显式来源引用；
- 定义 message check 的准确增量、receipt replay 和同一 Agent Session 的安全边界；
- 定义后续要求何时只创建 Agent Request、何时显式关联 WorkItem；
- 定义 Agent 主动查询更多共享内容的审计；
- 定义 Private Context Grant；
- 分离私有内容读取权和共享披露权；
- 定义 Prompt、Session 和共享事实的关系。

#### 11.2 Artifact

- 定义 Workspace 级 Artifact 身份、不可变线性版本、lineage 和权限；
- 定义 Markdown Yjs 草稿、显式正式保存、普通文件流式上传和内容寻址去重；
- 定义 Human/Agent 发布 CAS、Run staged blob 与最终回传原子事务；
- 定义 Artifact 与多个 Project 的显式关联，以及 Message 对具体版本的固定引用；
- 定义 7 天回收站、恢复、到期清理和删除后的最小历史快照。

#### 11.3 Completion

- 定义普通 Run terminal outcome 与普通 Message 的独立语义；
- 定义显式 WorkItem 的可选 Result Submission；
- 定义可选 Completion Policy；
- 定义自动完成、Human Review 和 Agent Review；确定性 verifier 留给有真实需求时的未来扩展；
- 定义拒绝、返工和新 Run；
- 定义高风险 producer/acceptor 分离。

### 产物

- `docs/design/08-context-and-privacy.md`；
- `docs/design/10-artifact-workspace.md`；
- 数据位置与披露矩阵；
- Message、Run、Artifact、Result Submission、Completion Policy 与 Review 的正交状态图；
- 隐私和完成策略测试目录。

### 完成标准

- 同一 Run 的初始共享上下文可解释；
- 运行期相关变化按 cursor 进入同一 Runtime Session，不会延迟到最终执行前才割裂刷新；
- Inbox attention、准确 Discussion position 范围、claim receipt 和 Agent decision 可追溯；
- 未授权私有上下文无法进入团队任务；
- 读取私有内容不会自动允许披露；
- 普通 Run 独立结束，且 Message absence 不创建 response outcome 状态；
- 需要 Review 的 WorkItem 不会被 Runtime 成功绕过 Completion Policy；
- Artifact 到期清理正文不会改写 Message、Run lineage 或历史版本快照。

### 实施状态

Run Context Snapshot 与 Artifact 纵向链已经落地；后续只在出现明确产品需求时增加可选 Review，不建立平行结果模型。

## 12. Step 9：设计可靠存储、变化传播与副作用

### 目标

让已经工作的协作链在重复、崩溃、断网和外部结果未知时仍保持正确。

### 要做什么

- 从领域原子性推导事务范围；
- 设计共享存储 schema、约束和索引；
- 设计命令幂等和并发控制；
- 设计 Workspace/Conversation context version 与变化记录的原子推进；
- 设计 Agent Inbox、准确 Scope 增量范围和 Local staged intent 恢复；
- 设计已提交变化的可靠传播；
- 设计 Assigned/Eligible Inbox 投影；
- 设计 snapshot/follow 不丢变化的读取方式；
- 设计 Execution Lease 和防旧执行机制；
- 设计 Local Node pending command/result；
- 设计 Artifact 流式上传、内容寻址去重和 Resource Link 引用确认；
- 设计外部副作用 operation identity、确认和对账；
- 设计备份、恢复和投影重建。

Outbox、fencing、Cursor、Dead Letter 和 Checkpoint 可以在此确定，但必须由已确认结果推导，而不是反向塑造领域模型。

### 产物

- `docs/design/10-storage-and-delivery.md`；
- `docs/design/11-side-effects-and-reconciliation.md`；
- schema 与数据库约束设计；
- 故障矩阵；
- 恢复和对账测试计划。

### 完成标准

- 已提交 Agent Request 或 WorkItem 不会因通知失败而丢失；
- 重复命令不会重复产生逻辑效果；
- 每个 Inbox claim 幂等且可恢复，Local Node staged intent 不会因 receipt 重放而重复发布；
- Version 只负责检测变化，Context Manager 根据变化流决定语义相关性；
- 并发认领最多一个成功；
- 旧 Attempt 无法覆盖当前执行结果；
- 数据库提交与变化传播不存在静默缺口；
- 外部副作用结果未知时进入明确状态；
- 投影可以从权威事实重建。

### 实施状态：Gate C

完成 Step 9 并实现对应失败测试后，可以形成**内部可用版本**，供受控团队试用核心协作链。

## 13. Step 10：设计 Human Experience

### 目标

让 Human 能看懂共享讨论、可选工作责任和本地 Agent 执行，而不把三者混成一个时间线。

### 要做什么

设计最小 Web 信息架构：

- Workspace/Conversation 导航，以及 Channel/DM 风格的界面分组；
- Conversation Timeline；
- 可选 Thread、Discussion Scope、Agent Request 与可选关联 WorkItem；
- Assigned Inbox 与 Claimable Work Pool；
- WorkItem 状态、assignee、关系和 Completion；
- Agent、Owner、在线/可执行状态；
- Execution Timeline；
- 普通 Message、Artifact 和可选 Result Submission；
- 运行中 Inbox 状态、Scope 增量和 Local staged intent decision；
- 独立 Review、阻塞和重分配；
- Owner 暂停与审计入口。

明确展示规则：

- Message 展示成员说了什么；
- Agent Request 展示请求是否等待、执行、拒绝或完成；
- WorkItem 展示谁负责和是否完成；
- Execution Timeline 展示 Runtime 执行状态；
- 原始 token、隐藏推理和含秘密 Tool 输出不进入 Conversation。

### 产物

- `docs/design/12-human-experience.md`；
- 页面信息架构；
- 核心交互流程；
- 空、加载、断线、冲突和失败状态；
- 可访问性与权限可见性规则。

### 完成标准

- Human 能从 `@Agent` 追踪到 Agent Request、Run 和实际发布的普通 Message，而不会看到隐式 WorkItem；
- Human 能从显式 WorkItem 追踪到关联 Runs，以及存在时的 Result Submission 和 Review；
- 用户能区分“未读消息”“待处理任务”和“Agent 正在执行”；
- UI 不维护第二套领域状态；
- 刷新或更换客户端后能够从 Workspace Authority 恢复。

### 实施状态

**0.6 Human Web 已实现。** 当前界面覆盖注册/登录、Workspace 恢复、可选 Repository 的 Project 创建与成员治理、Workspace/Project 双 Conversation scope、Conversation / Thread、结构化 `@Agent`、Agent Request、Workspace 成员/邀请、Agent 治理、Project Resource Link，以及 Workspace/Project Artifacts 面板、Markdown 实时编辑与预览、File 上传下载、版本历史、Project 关联和回收站。Execution Timeline、WorkItem、Submission 与 Review 仍在对应领域模块后续范围。

## 14. Step 11：设计 Threat Model 与运行保障

### 目标

明确系统能保护什么、不能保护什么，并为真实运行建立最低保障。

### 要做什么

- 列出资产、攻击者和信任假设；
- 分析恶意 Runtime、被攻陷 Local Node、越权 Human 和不可信外部内容；
- 设计 Credential 生命周期和秘密脱敏；
- 设计 Prompt Injection 与 Tool 参数规范化；
- 设计本地目录、进程、网络和 Credential 隔离；
- 设计审计、日志、Metric 和 Trace 关联；
- 设计容量上限、速率、预算和滥用控制；
- 设计备份、恢复、升级和回滚；
- 明确 Owner 设备完全攻陷时无法提供的保证。

### 产物

- `docs/design/13-threat-model.md`；
- `docs/design/14-deployment-and-operations.md`；
- 风险清单与控制映射；
- 运行手册；
- 故障注入和安全测试计划。

### 完成标准

- 每项重要资产都有权威持有者和保护措施；
- 每个高风险操作都有授权和失败策略；
- 日志不泄漏 Credential、私有正文和长期 Token；
- 单节点故障和数据恢复流程经过演练；
- 文档没有宣称本地非托管环境无法实现的安全保证。

### 实施状态

完成对应控制前，不对外宣称生产可用。

## 15. Step 12：发布设计与最终追踪

### 目标

证明总体架构、专题设计、实现和验收结果形成闭环。

### 要做什么

- 完成不变量到实现与测试的追踪矩阵；
- 检查所有专题术语与 `CONTEXT.md` 一致；
- 检查 ADR 状态和被替代决定；
- 运行完整契约、集成、端到端、故障和安全测试；
- 明确支持的 Runtime Adapter 和能力限制；
- 明确备份、升级、监控和事故响应；
- 记录未完成能力与明确非目标；
- 形成发布验收清单。

### 产物

- 更新后的 `docs/design/TRACEABILITY.md`；
- `docs/RELEASE_READINESS.md`；
- 支持矩阵；
- 发布验收报告。

### 完成标准：Gate D

- 每条 V2 架构不变量至少有一个可观察测试；
- 每个核心场景在支持环境中端到端通过；
- 实现没有绕开 Workspace Interface 的隐藏写路径；
- Runtime Adapter 不泄漏协议对象到 Workspace 领域；
- 权限、上下文、Artifact 和完成链可审计；
- 恢复与运行流程已经验证；
- 所有已知限制对用户可见。

达到 Gate D 后，项目具备当前产品范围内的可发布设计与实现。未来团队执行服务器、更多 Runtime、企业身份和多节点部署按新的需求层继续生长，不提前进入本轮设计。

## 16. 建议实施节奏

### 16.1 Gate A 后

设计与实施并行：

```text
Design: Step 5 Execution Model
Build:  Workspace domain + Conversation + Agent Request + minimal Web

Design: Step 6 Local Agent & Runtime
Build:  ordinary Agent Message + Timeline/Thread result publication
```

### 16.2 Gate B 后

完成第一条真正纵向链：

```text
Human @Agent
→ durable Agent Request
→ local Runtime executes
→ Agent may commit ordinary Messages
→ execution outcome is recorded independently
→ source Discussion Scope shows result without creating a WorkItem
```

然后按以下顺序扩展：

1. 独立创建显式 WorkItem，并自动建立专用讨论位置；
2. 开放任务池与并发认领；
3. Agent-A 显式委派 Agent-B；
4. Owner 暂停与最小权限；
5. Context Snapshot 与 Private Context Grant；
6. Context Version、Agent Inbox pull 与 Local staged intent decision；
7. Artifact 和可选 Review；
8. 断网恢复、Lease 和防旧执行；
9. 外部副作用审批与对账；
10. 完整 Web 体验和运行保障。

每增加一层都必须保持上一层端到端工作，不以未完成的通用框架替代用户可验证结果。

## 17. 项目设计完成的定义

项目设计不是以文档数量判断完成，而是必须同时满足：

1. 每个核心概念在 `CONTEXT.md` 中只有一个含义；
2. 每个难以逆转的取舍都有 ADR；
3. 每个核心场景有正常、权限、并发和失败结果；
4. 每个状态变化都有明确 actor、权威和原子不变量；
5. 每个深 Module 只有一个调用者需要学习的稳定 Interface；
6. 每个外部 seam 都有真实变化来源和 Adapter 计划；
7. 每类数据都有权威位置、访问规则和保留责任；
8. 每条架构不变量都映射到专题设计、实现位置和测试；
9. 第一纵向链可以由新开发者在不补充产品决策的情况下实施；
10. 失败、恢复、安全和运维行为不是留给上线前临时决定。

## 18. 下一步

Step 0 架构基线、Step 1 核心场景与 Step 2 领域设计均已关闭。显式 WorkItem 设计已整体延后，不属于 MVP；下一步进入 Step 3，基于已稳定的 Workspace 授权与 Conversation 领域 seam 设计 MVP Workspace Collaboration Module Interface。

在 Step 4 之前，团队的主要产出是场景、领域状态机、Workspace Interface 和工程基础决定；完成 Step 4 后可以开始工程骨架与 Workspace 核心编码，但直到 Step 6 完成后才进入基本产品纵向链的实现，不等待所有专题文档完成。
