# AI-Native 协作框架：项目设计与实施路线图

> 状态：Proposed
>
> 上游基线：`docs/ARCHITECTURE_V2.md`
>
> 目的：将总体架构逐层落实为可实施设计，明确每一步的工作、产物、完成标准，以及何时可以开始工程编码和基本产品实现。

## 1. 总体策略

项目不采用“先把所有专题设计完，再一次性开始编码”的方式，也不在领域语义尚未明确时从数据库表、页面或协议字段开始。

采用两条并行但有门槛的工作轨道：

```text
设计轨道
架构基线
→ 核心场景
→ Conversation & Work
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

## 3. Step 0：关闭总体架构基线

### 目标

保证 V2 中不存在会改变产品形态的未定义概念，让后续专题设计拥有稳定上游。

### 要做什么

1. 将 Conversation、Conversation Timeline、Thread、Discussion Scope、Message、Agent Request 和显式 WorkItem 的语义补入 `ARCHITECTURE_V2.md`；
2. 明确 Conversation 是唯一讨论容器，拥有顶层 Conversation Timeline，Channel/DM 只是参与、发现和展示策略，不建立独立领域模型；
3. 明确 Thread 是从顶层 Message 展开的可选聚焦分支，不是强制消息容器，也不承担任务状态；
4. 明确 `@Agent` 创建 Agent Request，不隐式创建或推进 WorkItem，所有执行入口经 Agent Request 汇入 Run；
5. 明确每个成功 Run 都必须在结果 Discussion Scope 发布 Final Message；普通 Run 不产生 Acceptance；
6. 明确 WorkItem 是可选、显式、用户可见的工作管理对象，关联 source Message 与 Primary Discussion Scope；
7. 明确无现成讨论位置的 WorkItem 创建会原子创建 Conversation 和初始 Message，并使用新 Conversation Timeline 作为 Primary Discussion Scope；
8. 明确 Final Message 以已观察 Discussion Frontier 为发布前置条件，冲突产生 Publication Hold；
9. 检查 V2、`CONTEXT.md` 和所有 ADR 是否互相一致；
10. 建立“架构不变量 → ADR → 后续专题 → 验收场景”的追踪清单。

### 产物

- 更新后的 `docs/ARCHITECTURE_V2.md`；
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

1. Human 在 Channel 风格 Conversation 中 `@Agent`，只创建 Agent Request；
2. Human 在 DM 风格 Conversation 中 `@Agent`，执行语义与 Channel 风格一致；
3. Runtime 正常退出但未发布 Final Message；
4. 从现有 Message 显式创建并分配 WorkItem；
5. 无 Conversation 时创建 WorkItem，原子生成专用讨论位置；
6. 普通 mention 其他 Agent 不创建 Child WorkItem，显式委派才创建；
7. 多个 Agent 并发认领一个开放任务；
8. Agent 主动释放，Human 显式重新分配；
9. Agent-A 委派 Agent-B 并汇总结果；
10. Runtime 成功但受 Review 的 Result Submission 被拒绝；
11. Owner 暂停 Agent；
12. Local Node 断网、Lease 到期和重连；
13. 私有上下文未授权、已授权读取但禁止披露；
14. 外部 Artifact 内容消失但 lineage 保留；
15. Conversation 只有顶层 Message、没有 Thread；
16. 同一 Discussion Scope 在 Agent 生成期间新增回复，Final Message 发布得到 held；
17. held 后 Agent 获取准确增量、显式 reconciliation 并成功发布；
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

**Completed。** 核心场景与初始端到端验收目录已写入 `docs/design/01-core-scenarios.md`。仍不开始产品实现；下一步进入 Step 2 Conversation & Work 领域模型设计。

## 5. Step 2：设计 Conversation & Work 领域模型

### 目标

定义共享协作的事实、关系、生命周期和原子不变量。这是数据库、Web、Workspace Interface 和 Local Node 的共同上游。

### 要做什么

#### 5.1 Conversation 模型

- 定义统一 Conversation、Conversation Timeline、Channel/DM 策略预设、可选 Thread、Discussion Scope 和 Message；
- 定义参与者、可见性和权限继承；
- 定义消息顺序、编辑、删除和归档语义；
- 定义顶层 Message、Thread root 和 Thread Reply 的归属关系；
- 定义各 Discussion Scope 的 frontier，以及哪些内容变化会推进它；
- 定义 mention 的合法目标；
- 定义 Agent Request 的触发来源和结果目标；
- 区分 Conversation Timeline 与 Execution Timeline。

#### 5.2 Agent Request 与 Work 模型

- 定义 Agent Request、可选 WorkItem 关联和从请求到 Run 的交接语义；
- 定义 WorkItem、Child WorkItem、关系和依赖；
- 定义 source Message 和 Primary Discussion Scope；
- 定义无讨论位置时 Conversation、初始 Message 和 WorkItem 的原子创建；
- 定义 Direct Assignment 与 Claimable WorkItem；
- 定义 Work Assignee 的唯一性；
- 定义 Agent Claim、释放、撤销和重分配；
- 定义显式“继续工作”和普通 mention 的区别；
- 定义可选 Result Submission、Acceptance、拒绝和返工；
- 定义取消、阻塞、归档和重新打开。

#### 5.3 状态转换

至少形成：

```text
Agent Request lifecycle
WorkItem lifecycle
Agent Claim lifecycle
optional Result / Acceptance lifecycle
Conversation / Thread lifecycle and Discussion Scope frontier
```

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

- 每个核心场景都能映射为确定状态转换；
- 不需要依靠自然语言模型判断是否创建、关联或拆分 WorkItem；
- 普通 Agent Request 可以完成而不存在 WorkItem；
- 每个成功 Run 都有已提交的 Final Message；
- 独立 WorkItem 不会缺少 Primary Discussion Scope；
- Conversation 可以没有 Thread，顶层 Message 不依赖隐式默认 Thread；
- stale Discussion Frontier 只产生 Publication Hold，不产生 Final Message 或 Run success；
- Conversation 归档不会隐式取消 WorkItem；
- WorkItem 完成不会抹除 Conversation 历史；
- 并发认领最多一个成功；
- 一个 WorkItem 最多一个当前 assignee。

### 实施状态

还不建议开始主干实现，因为调用 Interface 和工程基础尚未确定。

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
- ContinueWorkWithAgent；
- Create/Update/CancelWorkItem；
- PublishClaimableWork；
- Claim/Release/ReassignWorkItem；
- CreateChildWorkItem；
- PublishFinalMessage；
- SubmitWorkResult；
- Accept/RejectResult；
- Suspend/ResumeAgent。

#### 6.3 定义 Interface 契约

每个意图明确：

- actor 来自哪里，哪些字段调用者不能自报；
- 幂等身份；
- 版本或并发前置条件；
- 成功结果；
- 正常但未提交的业务结果，例如 `PublishFinalMessage` 的 Publication Hold；
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
- 一次 `@Agent` 原子提交 Message 和 Agent Request，不是一串容易部分成功的 CRUD；
- 一次无讨论位置的 WorkItem 创建原子提交 Conversation、初始 Message 和 WorkItem；
- `PublishFinalMessage` 原子校验 Discussion Frontier，并确定返回 `published` 或 `held`；
- Interface 不暴露数据库、事件存储或策略求值器；
- 所有 Step 1 场景都能通过 Interface 驱动和观察。

### 实施状态

尚未正式进入实现，但已经可以估算模块、测试和工作量。

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
→ post Message with @Agent
→ atomically create an Agent Request without a WorkItem
→ query the pending Agent Request
→ placeholder executor publishes a Final Message
→ display the result in the source Discussion Scope

Human explicitly creates a standalone WorkItem
→ atomically create its dedicated Conversation, source Message, and WorkItem
→ use the new Conversation Timeline as its Primary Discussion Scope
→ optionally assign it to an Agent and create an Agent Request
→ placeholder executor publishes a Final Message to the Primary Discussion Scope
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

**完成 Step 4 后，开始工程骨架与 Workspace 核心编码。此时尚未形成基本产品。**

此时可以实施：

- Workspace Collaboration Module；
- Human、Agent、Owner 和 Membership 基础模型；
- Conversation、Conversation Timeline、Channel/DM 策略、可选 Thread、Discussion Scope 和 Message；
- Agent Request、Final Message 和可选 WorkItem 关联；
- 显式 WorkItem、Direct Assignment 和 Agent Claim；
- Workspace Interface 的第一个 transport Adapter；
- 共享事务存储；
- 最小 Web 页面；
- 不启动真实 Runtime 的纵向验收链。

与此同时，设计轨道继续 Step 5 和 Step 6。

## 8. Step 5：设计 Execution Model

### 目标

把来自 Conversation 和显式 WorkItem 的持久 Agent Request 可靠地转换为不可靠设备上的执行，并彻底分离 Agent Request、Agent Claim、Run 与 Execution Lease。

### 要做什么

- 定义 Agent Request、Run、Attempt、Execution Lease；
- 定义 Conversation mention、Direct Assignment、Agent Claim、显式委派和继续工作如何产生 Agent Request；
- 定义 Agent Request 如何在授权与 intake 检查后产生 Run；
- 定义 Assigned Request Inbox 与 Eligible Work Inbox 的读取语义；
- 明确 Inbox 是可重建读取视图，不是任务权威；
- 定义 Local Node 如何发现、获取和恢复 Agent Request；
- 定义 Lease 获取、续期、到期和防旧执行；
- 定义何时创建新 Agent Request、Run 和 Attempt；
- 定义 Final Message 提交与 Run 成功的顺序；
- 定义 `PublishFinalMessage(expectedDiscussionFrontier)` 的原子校验、published/held 结果和幂等重放；
- 定义 Publication Hold、准确增量获取、显式 reconciliation 和有界重试；
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

- 请求来源、可选工作归属、设备执行权和 Runtime Session 不再共用状态；
- Device 断线不会丢失 Agent Claim；
- 旧 Attempt 不能覆盖当前结果；
- 没有 Final Message 的 Run 不能成功；
- Discussion Scope 推进后，旧 frontier 的候选 Final Message 不能发布，Run 保持未成功；
- 所有执行失败都得到确定的共享状态；
- Local Node 无需依赖实时通知保证工作可发现。

### 实施状态

基础 Workspace 实现继续进行；不要开始正式 Local Node 执行循环。

## 9. Step 6：设计 Local Agent、Runtime Integration 与 Workspace Interaction

### 目标

确定 Local Node 如何受控地驱动可替换 Runtime，并允许 Runtime 作为当前 Agent 操作 Workspace。

### 要做什么

#### 9.1 Local Agent Module

- 定义 Device 身份与 Agent Binding；
- 定义本地持久状态和恢复范围；
- 定义并发与运行生命周期；
- 定义 Agent Request 获取、确认和拒绝；
- 定义 Run Context Snapshot 获取；
- 定义 Discussion Frontier 跟踪与 Publication Hold 的本地持久恢复；
- 定义本地工作目录和 Credential 使用；
- 定义 Offline Continuation；
- 定义 pending Final Message、可选 Result Submission、held reconciliation 和重连提交。

#### 9.2 Runtime Integration seam

定义协议无关的行为：

- 启动一次执行；
- 输入目标和上下文；
- 接收进度、交互请求和候选结果；
- 请求取消；
- 协商可选能力；
- 保存不透明的本地 Session 状态。

具体 ACP、CLI、stdio 或其他协议在首个 Runtime Adapter 专题中确定。

#### 9.3 Workspace Interaction seam

定义 Runtime 在当前执行身份下能够：

- 查询授权共享上下文；
- 发布进度、问题和阻塞；
- 向结果 Discussion Scope 提交带已观察 frontier 的候选 Final Message，并处理 published/held 结果；
- 显式创建 Child WorkItem；
- 通过 mention 请求或通过显式委派让其他 Agent 参与；
- 提交 Artifact，并在关联 WorkItem 需要时提交 Result Submission。

明确 Agent、Owner、Workspace、Agent Request、Run、可选 WorkItem 和权限由 Local Agent Module 绑定，并由 Workspace Authority 重新验证，Runtime 不得自报。

#### 9.4 第一个真实 Adapter

选择一个真实 Runtime，验证 Runtime Integration seam；不要同时实现多个半成品 Adapter。第二个 Adapter 出现后再确认 Interface 是否足够稳定。

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
→ Final Message is committed to the original Discussion Scope
→ Run succeeds without creating a WorkItem or Acceptance
```

此时第一次形成产品独特价值，但仍只适合开发环境验证。

## 10. Step 7：设计身份、Owner 与授权

### 目标

把 Workspace Governance、Owner Accountability 和 Local Custody 落实为可执行规则。

### 要做什么

- 定义 Human、Agent、Device 和执行身份；
- 定义 Agent 创建、暂停、恢复、Owner 变更和归档；
- 定义当前 Owner=Host 的产品约束；
- 定义 Workspace Role、Agent 权限、接单策略和委派策略；
- 定义 Agent Request、Direct Assignment、Claim、Delegation、Final Message、Artifact 和可选 Acceptance 的动作矩阵；
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

- 定义 Run Context Snapshot 的来源与版本；
- 定义 Discussion Scope 截止位置、Discussion Frontier 和显式引用；
- 定义 Publication Hold 后的增量获取与显式 reconciliation 不改写原始 Snapshot；
- 定义后续要求何时只创建 Agent Request、何时显式关联 WorkItem；
- 定义 Agent 主动查询更多共享内容的审计；
- 定义 Private Context Grant；
- 分离私有内容读取权和共享披露权；
- 定义 Prompt、Session 和共享事实的关系。

#### 11.2 Artifact

- 定义 Artifact 身份、版本、lineage 和权限；
- 定义 Workspace-managed 内容与外部版本引用；
- 定义外部内容验证、失效和可选归档；
- 定义 Artifact 与可选 WorkItem、Run、Attempt 和 Agent 的关联。

#### 11.3 Completion

- 定义普通 Run 的 Final Message 完成语义；
- 定义显式 WorkItem 的可选 Result Submission；
- 定义可选 Completion Policy；
- 定义自动完成、Human Review、Agent Review 和 verifier；
- 定义拒绝、返工和新 Run；
- 定义高风险 producer/acceptor 分离。

### 产物

- `docs/design/08-context-and-privacy.md`；
- `docs/design/09-artifact-and-completion.md`；
- 数据位置与披露矩阵；
- Final Message 与可选 Artifact/Result/Acceptance 状态图；
- 隐私和完成策略测试目录。

### 完成标准

- 同一 Run 的初始共享上下文可解释；
- 后续消息不会静默改变执行输入；
- stale Discussion Frontier 不会发布 Final Message，held 后的上下文补充可追溯；
- 未授权私有上下文无法进入团队任务；
- 读取私有内容不会自动允许披露；
- 普通 Run 只有提交 Final Message 后才能成功；
- 需要 Review 的 WorkItem 不会被 Runtime 成功绕过 Completion Policy；
- 外部 Artifact 消失不会改写历史 lineage。

### 实施状态

在现有纵向链上逐个加入 Run Context Snapshot、外部 Artifact 和可选 Review，不建立平行结果模型。

## 12. Step 9：设计可靠存储、变化传播与副作用

### 目标

让已经工作的协作链在重复、崩溃、断网和外部结果未知时仍保持正确。

### 要做什么

- 从领域原子性推导事务范围；
- 设计共享存储 schema、约束和索引；
- 设计命令幂等和并发控制；
- 设计每个 Discussion Scope 的 frontier 推进与 `PublishFinalMessage` 条件写入；
- 设计 Publication Hold 的持久恢复、准确增量范围和事务后摘要生成；
- 设计已提交变化的可靠传播；
- 设计 Assigned/Eligible Inbox 投影；
- 设计 snapshot/follow 不丢变化的读取方式；
- 设计 Execution Lease 和防旧执行机制；
- 设计 Local Node pending command/result；
- 设计 Artifact 上传或外部引用确认；
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
- stale Discussion Frontier 不会创建 Final Message，Publication Hold 可恢复且不会退化成盲重试；
- 一个 Conversation 中无关 Discussion Scope 的推进不会造成发布冲突；
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
- Final Message、Artifact 和可选 Result Submission；
- Publication Hold、增量提示和 Agent reconciliation 状态；
- 可选 Review / Acceptance、阻塞和重分配；
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

- Human 能从 `@Agent` 一直追踪到 Agent Request、Run 和 Final Message，而不会看到隐式 WorkItem；
- Human 能从显式 WorkItem 追踪到关联 Runs，以及存在时的 Result Submission 和 Acceptance；
- 用户能区分“未读消息”“待处理任务”和“Agent 正在执行”；
- UI 不维护第二套领域状态；
- 刷新或更换客户端后能够从 Workspace Authority 恢复。

### 实施状态

最小 Web 可以从 Gate A 开始实现；完整 Human Experience 在本阶段按已工作的领域链扩展。

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
Build:  Final Message + explicit WorkItem + Direct Assignment + Agent Claim
```

### 16.2 Gate B 后

完成第一条真正纵向链：

```text
Human @Agent
→ durable Agent Request
→ local Runtime executes
→ Agent commits a Final Message
→ source Discussion Scope shows result without creating a WorkItem
```

然后按以下顺序扩展：

1. 独立创建显式 WorkItem，并自动建立专用讨论位置；
2. 开放任务池与并发认领；
3. Agent-A 显式委派 Agent-B；
4. Owner 暂停与最小权限；
5. Context Snapshot 与 Private Context Grant；
6. Discussion Frontier、Publication Hold 与显式 reconciliation；
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

Step 0 的架构基线已经关闭，Step 1 的核心场景与初始端到端验收目录已经写入 `docs/design/01-core-scenarios.md`。下一步开始 Step 2 Conversation / Agent Request / WorkItem 领域模型设计。

在 Step 4 之前，团队的主要产出是场景、领域状态机、Workspace Interface 和工程基础决定；完成 Step 4 后可以开始工程骨架与 Workspace 核心编码，但直到 Step 6 完成后才进入基本产品纵向链的实现，不等待所有专题文档完成。
