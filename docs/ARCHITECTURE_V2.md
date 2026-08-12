# AI-Native 协作框架：总体架构基线 V2

> 状态：Accepted Architecture Baseline V2
>
> 文档定位：描述产品边界、核心协作语义、权威关系、系统职责、稳定 seam 与长期不变量。
>
> V2 不覆盖 `ARCHITECTURE_REFINED.md`。领域词义以根目录 `CONTEXT.md` 为准，已确认取舍记录在 `docs/adr/`。

## 1. 文档目的

本文定义实现 AI-native 协作框架时不得破坏的总体架构。它回答：

1. Human 与 Agent 如何在同一个 Workspace 中共享讨论、工作和结果；
2. `@Agent`、Agent Request、显式 WorkItem、直接分配、开放认领和 Agent 委派分别意味着什么；
3. Workspace、Owner、Local Node、Agent 与 Runtime 各自拥有什么权威；
4. 共享上下文如何形成，私有上下文如何隔离；
5. 本地概率性执行如何可靠地连接到共享协作事实；
6. 哪些 Module 和 seam 必须长期稳定；
7. 产品如何从最小完整协作闭环逐层生长。

本文不规定：

- 数据库表、索引、事务代码或迁移方案；
- HTTP、WebSocket、SSE、ACP、MCP 或 CLI 的具体协议字段；
- Runtime Adapter 的代码 Interface；
- 状态枚举、错误码、重试次数和超时数值；
- Sandbox、对象存储、搜索和部署工具的具体产品选型；
- Web 页面布局和交互细节。

这些内容由专题设计和实施文档承载。总体架构只规定其必须满足的行为与边界。

## 2. 产品定义

本系统是一套供真实团队使用的 AI-native 协作基础设施。Human 和 Agent 在同一个 Workspace 中讨论、形成工作、承担责任、执行任务、交付结果并完成验收。

它不是多 Agent 聊天室，也不是新的通用 Agent Runtime。其独特价值在于把共享协作与本地 Agent 执行连接成一条可信、可恢复、可追溯的工作链：

> Conversation 形成共享语境，Agent Request 将协作意图可靠地连接到 Run，WorkItem 在需要时承载显式工作责任，Workspace 维护共同事实，Local Node 承载本地执行，Agent 将结果发布回共享讨论。

核心产品承诺：

- Conversation 可以独立存在，人和 Agent 共享同一份有权限边界的讨论历史；Channel 和 DM 只是它的参与与展示策略；
- `@Agent` 创建可恢复的 Agent Request，不隐式创建、分配或推进 WorkItem；
- 每个成功 Run 都由 Agent 在其结果 Discussion Scope 中发布明确的最终 Message；
- WorkItem 是可选、显式、用户可见的工作管理对象，不是每次 Agent 执行的包装器；
- 未分配工作可以由符合条件的 Agent 自主认领；
- Agent 可以在受控边界内向其他 Agent 委派工作；
- Agent 是独立作者，但始终有明确的 Human Owner 承担责任；
- Agent 在 Owner 的电脑上执行，并通过可替换 Runtime 完成工作；
- Runtime 可以主动参与 Workspace，但不能绕过身份、权限、执行或显式工作状态；
- 共享 Agent Request 与显式工作在断网、重启、重复请求和 Runtime 失败后不会静默消失。

## 3. 非目标与当前范围

### 3.1 非目标

- 不重新实现模型 Tool Loop、通用 Coding Agent 或 Agent Framework；
- 不以自由 Agent-to-Agent 对话替代需要责任管理的显式 WorkItem；
- 不让聊天消息、Runtime Session 或模型记忆成为任务队列；
- 不把每次 Agent 对话隐式提升为 WorkItem、Result Submission 或 Acceptance；
- 不承诺通用 exactly-once 执行或无法实现的外部副作用 exactly-once；
- 不允许 Runtime 直接成为 Workspace 权威或持有长期高权限凭据；
- 不把成员、权限、任务归属和执行所有权设计成多主状态；
- 不提前拆分微服务或引入只服务于假想扩展性的公开 Interface；
- 不在非托管个人设备上宣称存在 Owner 无法绕过的强制隔离。

### 3.2 当前产品约束

当前版本只支持本地执行：

- 每个 Agent 的 Runtime 运行在某个团队成员的电脑上；
- Agent Owner 与 Agent Host 必须是同一个 Human；
- 不提供团队执行服务器或远程托管 Runtime。

这些是当前范围，不是 Agent 身份模型的不变量。Agent、Owner、Host、Device 和 Runtime Binding 仍保持概念分离，以便未来新增部署形态时不改写历史身份和协作语义。

## 4. 第一性原理

### 4.1 协作需要共同事实

如果不同成员不能对消息、任务、责任人、权限、产物和完成状态得出同一结论，就不存在真正的共享空间。因此每个 Workspace 必须有一个逻辑上的 Workspace Authority。

Local Node 可以保存待提交意图和候选结果，但只有 Workspace Authority 提交后，变化才成为共享事实。

### 4.2 Conversation 与 WorkItem 回答不同问题

Conversation 回答“谁在什么可见范围内讨论了什么”，Agent Request 回答“谁请求哪个 Agent 响应什么”，WorkItem 回答“团队显式管理什么结果、由谁负责、进展如何”。普通对话执行不需要 WorkItem；只有需要持续责任、开放认领、委派、进度或完成管理时才显式创建 WorkItem。

Conversation 是唯一的讨论容器领域实体。Channel 和 DM 不形成独立领域模型：它们只是 Conversation 在参与者、可发现性、成员变化和界面呈现上的策略预设。每个 Conversation 有一个顶层 Conversation Timeline，并可拥有零个或多个从顶层 Message 展开的 Thread；Thread 继承 Conversation 的可见性，不承担任何工作状态。

### 4.3 Agent 身份不等于 Runtime

Agent 是长期协作者；Runtime 是一次或多次执行所使用的可替换引擎。替换 Runtime、Adapter、模型或 Session 不得创建新的 Agent、改变其 Owner、重置权限或割裂协作历史。

### 4.4 本地执行必然不可靠

Owner 的电脑会休眠、掉线、重启，Local Node 和 Runtime 会崩溃。任务责任归属必须独立于设备在线状态；一次设备执行的临时所有权也必须独立于 Agent 的长期任务责任。

### 4.5 Agent 执行是概率性的

Runtime 进程正常结束不等于协作成功。普通 Run 只有在 Agent 的最终 Message 被 Workspace Authority 提交到指定 Discussion Scope 后才能成功；关联显式 WorkItem 时，该 Message 也不自动证明工作目标已经满足，是否需要 Result Submission、自动完成或 Acceptance 由 WorkItem 的可选 Completion Policy 决定。

### 4.6 责任必须伴随制止能力

Agent 的行为由 Agent 署名，但每个 Agent 必须有唯一 Human Owner 承担责任。Owner 必须能够暂停 Agent、请求取消运行、收紧能力和预算并查看共享审计；Owner 不能替 Agent 署名、突破 Workspace 权限或改写历史。

### 4.7 共享上下文有明确边界

共享上下文不是整个 Workspace、完整 Conversation、Runtime Prompt 或本地模型记忆。每次执行使用稳定、可解释的 Run Context Snapshot；Owner 私有上下文只有在显式授权后才能参与共享 Agent 执行。

### 4.8 外部动作不能靠重试猜测

发消息、部署、支付、删除和发布等动作可能不可逆。网络层可以重复投递意图，但系统不能因此假设重复执行安全；外部动作必须在当前权限和风险策略下执行，并能确认、去重、补偿或进入明确的人工处理状态。

## 5. 核心协作场景

### 5.1 Conversation 中直接 `@Agent`

```text
Human or Agent posts a Message mentioning Agent-A
→ Workspace atomically records the Message and an Agent Request for Agent-A
→ Workspace authorizes the request and applies Agent-A's intake constraints
→ capture a Run Context Snapshot and its Discussion Frontier
→ create a Run for the accepted Agent Request
→ Agent-A's Local Node executes when available
→ Agent-A submits a candidate final Message to the source Discussion Scope with the observed frontier
→ Workspace commits it only while that frontier is current
→ the committed final Message allows the Run to succeed
```

`@Agent` 的 Message 与 Agent Request 必须属于同一个权威用例。Agent Request 在 Run 之前记录触发来源、目标 Agent 和结果发布位置，因此消息成功而通知丢失时仍可恢复；实时连接只用于唤醒，不能决定请求是否存在。

默认结果位置与触发 Message 的 Discussion Scope 相同：Conversation Timeline 中的 mention 返回该 Timeline，Thread Reply 中的 mention 返回该 Thread。产品可以提供“在 Thread 中继续”等显式动作改变位置，但不能为了统一存储而为每条 Message 创建隐藏的默认 Thread。

Agent Mention 是定向会话请求，不是 Direct Assignment。目标 Agent 不需要认领该请求；请求可能因权限、接单策略、预算、能力或并发约束而等待、拒绝或阻塞，但不能静默改派给其他 Agent。

工作边界只由显式产品动作决定：

- 普通 mention 只为每个被提及 Agent 创建独立 Agent Request；
- “从消息创建工作”显式创建 WorkItem，并保留 source Message；
- “分配 / 继续此工作”创建关联已有 WorkItem 的 Agent Request；
- “创建 Child WorkItem / 委派”显式创建子工作；
- 自然语言模型不能决定是否创建、推进或拆分 WorkItem。

### 5.2 显式创建和分配 WorkItem

```text
Member explicitly creates a WorkItem from a Message or work-management action
→ reuse the selected Primary Discussion Scope, or atomically create a Conversation and initial source Message
→ persist a user-visible WorkItem linked to its source Message and Primary Discussion Scope
→ optionally assign it to a Human or Agent
→ if an Agent should execute now, create an Agent Request linked to that WorkItem
→ every successful Run publishes its final Message to the Primary Discussion Scope
→ optional Completion Policy completes the WorkItem or requests Acceptance
```

WorkItem 创建不要求已有 Conversation，但绝不产生没有讨论归宿的“无头任务”。如果调用者未选择讨论位置，Workspace 必须在同一权威用例中创建专用 Conversation、由创建者署名的初始 Message，并将该 Conversation Timeline 作为 Primary Discussion Scope。WorkItem 只保存一个 Primary Discussion Scope；该 Scope 已唯一标识所属 Conversation，不能再维护一份可能冲突的主讨论引用。

WorkItem 与自动创建的 Conversation 仍然生命周期独立：WorkItem 完成或归档不删除讨论，Conversation 归档也不取消工作。assignee 必须有权读取并向 Primary Discussion Scope 发布结果；不能为了完成分配而静默扩大 Conversation 可见性。

### 5.3 Agent 自主认领开放任务

```text
Member publishes an unassigned Claimable WorkItem
→ Workspace evaluates Claim Eligibility
→ every eligible Agent may discover it
→ each Agent autonomously decides whether to claim
→ first valid Agent Claim establishes the sole assignee
→ Workspace creates an Agent Request for the claiming Agent when execution should start
→ other concurrent claims fail without changing ownership
```

Workspace 决定 Agent 能不能认领；Agent 决定自己要不要认领。Workspace 不替 Agent 选择“最合适”的候选者，Agent 也不能通过自报绕过权限和硬约束。

Agent Claim 是持久责任归属。它保持到 Agent 主动释放、Workspace 撤销或授权成员显式重新分配；Device 离线、Attempt 失败或 Execution Lease 到期都不会自动将任务重新开放。

### 5.4 Agent 向 Agent 委派

```text
Agent-A encounters delegated work
→ Agent-A creates a traceable Child WorkItem
→ Agent-A directly assigns Agent-B or publishes it for open claim
→ Workspace validates both sides' policies and delegation bounds
→ successful assignment or claim creates an Agent Request for Agent-B
→ Agent-B executes through its own Local Node
→ Agent-B publishes a final Message to the Child WorkItem's Primary Discussion Scope
→ result returns through the Child WorkItem relationship
→ Agent-A continues or aggregates the parent WorkItem
```

Agent 可以通过普通 mention 请求另一个 Agent 提供会话意见，不因此产生 Child WorkItem。只有显式委派才创建 Child WorkItem；它不需要每次由 Human 单独批准，但必须受到权限、接单策略、Owner 预授权、预算、并发和递归边界约束。需要责任管理的 Agent-to-Agent 协作永远通过 Workspace WorkItem，不退化成不可追踪的 Runtime-to-Runtime 调用。

被委派 Agent 仍可因不满足明确接单条件而拒绝或阻塞，Workspace 不因为委派者也是 Agent 就放宽接收方策略。

### 5.5 工作补充、返工与验收

对现有 WorkItem 的补充要求只有通过“继续此工作”等显式动作才关联该 WorkItem，并产生新的 Agent Request 和 Run。普通 Message 或 mention 不隐式改变工作状态。Runtime 失败后的技术重试属于同一 Run 的新 Attempt；新的协作请求创建新的 Agent Request 和 Run。

需要 Review 的 WorkItem 可以从最终 Message 和 Artifact 创建 Result Submission。Result Submission 被拒绝后，工作仍属于原 WorkItem；后续修改产生新的 Agent Request 和 Run，不创建一个与原责任链无关的任务。没有 WorkItem 的普通会话 Run 不产生 Acceptance 语义。

### 5.6 断网与恢复

```text
Local Node loses Workspace connection
→ bounded pure local computation may continue
→ Workspace reads and writes pause
→ externally visible side effects wait for current authorization
→ Execution Lease may expire
→ local output remains a candidate
→ reconnect and revalidate Agent Request, optional WorkItem association, authority, and execution state
→ submit, resume, discard, or reconcile explicitly
```

离线状态不能产生共享事实，也不能扩大已经授予的能力。

### 5.7 生成期间讨论继续推进

```text
Agent generates a candidate Final Message from Discussion Frontier V
→ other members publish new Messages to the same Discussion Scope
→ Agent submits PublishFinalMessage with expected frontier V
→ Workspace atomically compares V with the current frontier as part of the publication decision
→ because the scope advanced, Workspace does not create the Final Message
→ Workspace returns Publication Hold and the exact intervening content range
→ Agent explicitly reconciles the new content and submits against a newer frontier
```

Publication Hold 是正常业务结果，不是网络失败，也不能通过原样重试绕过。Run 在 held 期间保持未成功；原始 Run Context Snapshot 不被改写，后续内容作为可审计的显式 reconciliation 输入。新增内容摘要可以帮助 Runtime 重新生成，但摘要是 held 决定之后产生的派生信息，准确的 Message 引用和 frontier 范围才是权威依据。

## 6. 核心领域模型

### 6.1 协作模型

```text
Workspace
├── Member
│   ├── Human
│   └── Agent
├── Conversation
│   ├── audience / visibility / participation policy
│   ├── Conversation Timeline
│   │   └── top-level Message
│   │       ├── Agent Request 0..N
│   │       └── Thread 0..1
│   │           └── reply Message 0..N
│   │               └── Agent Request 0..N
│   └── Discussion Scope = Conversation Timeline | Thread
├── Agent Request
│   ├── target Agent
│   ├── trigger source
│   ├── result Discussion Scope
│   ├── optional WorkItem
│   ├── Run Context Snapshot
│   └── Run 0..1
│       └── Attempt 0..N
└── WorkItem 0..N
    ├── source Message
    ├── Primary Discussion Scope
    ├── parent / related WorkItem
    ├── current Work Assignee 0..1
    ├── Agent Request / Run 0..N
    ├── Artifact 0..N
    ├── Result Submission 0..N
    └── Acceptance 0..N
```

Conversation 是唯一讨论容器。Channel 和 DM 只是在参与者、可发现性、成员变化和 UI 呈现上的策略预设，不拥有独立领域身份或状态机。顶层 Message 属于 Conversation Timeline；Thread 是从一条顶层 Message 展开的可选分支，Thread Reply 属于且只属于一个 Thread。Conversation Timeline 和 Thread 都是可读取与发布的 Discussion Scope，但 Discussion Scope 只是位置值，不是新的容器实体。

Agent Request 是所有 Agent 执行入口的统一事实：Conversation mention、WorkItem 分配、Agent Claim、显式委派和继续工作都通过它进入同一个 Run / Attempt 模型。Agent Request 可以不关联 WorkItem，Run 不能被 Agent 认领，因为它在创建时已经有目标 Agent；Agent 认领的是开放 WorkItem，Device 获取的是 Attempt 的 Execution Lease。

WorkItem 是可选、显式且用户可见的独立工作对象。每个 WorkItem 必须有 source Message 和一个 Primary Discussion Scope；从独立工作入口创建且没有现成讨论位置时，Workspace 原子创建专用 Conversation、初始 Message 和 WorkItem，并使用新 Conversation Timeline 作为 Primary Discussion Scope。Conversation 与 WorkItem 生命周期独立，归档或完成任何一方都不能隐式改变另一方。

### 6.2 Agent 模型

```text
Agent
├── stable Workspace identity
├── exactly one active Human Owner
├── Workspace permissions and intake policy
├── declared capabilities
├── collaboration history
└── Runtime Binding
    ├── Host
    ├── Device
    └── Runtime
```

Agent 是 assignee、actor 和 author。Owner 是 accountable Human，不是 Agent 行为的 author。Host 提供本地执行资源，不因此取得 Workspace 管理权。

当前 Owner 与 Host 必须相同，但历史记录仍分别保存 Owner、Device 和 Runtime 执行事实。

### 6.3 工作与执行模型

- **Agent Request**：对指定 Agent 的持久响应或工作推进请求；它先于 Run 存在，可以等待、拒绝或阻塞；
- **WorkItem**：团队希望获得的结果和责任单位；
- **Work Assignee**：当前唯一负责推进 WorkItem 的成员；
- **Agent Claim**：Agent 对开放 WorkItem 的持久责任取得；
- **Run**：授权某个 Agent 在一组目标、上下文、策略和预算下响应一个 Agent Request 的逻辑执行；
- **Attempt**：某个 Device 使用某个 Runtime 对 Run 的一次具体执行；
- **Execution Lease**：一个 Device 对当前 Attempt 的可过期执行所有权；
- **Final Message**：Agent 对 Run 的明确可读结果；提交到结果 Discussion Scope 是 Run 成功的必要条件；
- **Publication Hold**：结果 Discussion Scope 已越过 Agent 提交的 Discussion Frontier 时，Workspace 不发布候选 Final Message 并要求显式 reconciliation 的权威结果；
- **Result Submission**：显式 WorkItem 需要完成治理时，对 Final Message 和 Artifact 的候选结果引用；
- **Acceptance**：仅在 WorkItem 的 Completion Policy 要求时形成的权威完成判断。

必须分离：

```text
Agent Request      = 为什么请求哪个 Agent 响应
Agent Claim        = 谁长期负责这个开放 WorkItem
Run                = 该 Agent 对一次请求的逻辑执行
Execution Lease    = 哪台 Device 此刻执行这个 Attempt
Runtime Session    = Runtime 如何维持本地连续性
```

这些概念不能共享一个身份、状态或恢复规则。Direct Assignment 与 Agent Claim 可以产生 Agent Request，但不能取代它；普通 mention 也不能冒充 WorkItem assignment。

### 6.4 Artifact 模型

Artifact 是稳定、版本化的结果引用。Workspace Authority 保存其身份、权限、来源、版本和与可选 WorkItem、Run、Attempt、Agent 的关系。

Artifact 内容可以：

- 存储在 Workspace 管理的内容存储中；
- 引用 Git commit、外部文档版本或其他可验证外部版本；
- 按保留策略额外归档副本。

外部内容消失后，Workspace 仍保留当时提交、引用和验证过什么的历史事实，但不能声称仍拥有已丢失的内容。

## 7. 架构不变量

所有实现必须保持以下不变量：

1. Conversation 是唯一讨论容器领域实体，拥有一个 Conversation Timeline、可以有零个 Thread、也可以不关联 WorkItem；Channel 和 DM 只是参与与展示策略。
2. Thread 只是从 Conversation Timeline 中一条 Message 展开的可选聚焦分支，不是强制消息容器，也不承担工作责任、执行或完成状态。
3. 每个 Agent 执行都由持久 Agent Request 触发；Agent Request 可以但不必须关联 WorkItem。
4. `@Agent` 创建定向 Agent Request，不是 Direct Assignment，也不隐式创建、推进或拆分 WorkItem。
5. 每个成功 Run 都必须由 Agent 向其结果 Discussion Scope 提交明确的 Final Message。
6. WorkItem 是可选、显式、用户可见的工作管理对象；每个 WorkItem 有一个 source Message 和一个 Primary Discussion Scope。
7. 没有现成讨论位置的 WorkItem 创建必须原子产生专用 Conversation、初始 Message 和 WorkItem，并以该 Conversation Timeline 作为 Primary Discussion Scope。
8. WorkItem 与 Conversation 生命周期独立；assignee 必须拥有 Primary Discussion Scope 所需访问权，分配不能静默扩大可见性。
9. Direct Assignment 与开放 Agent Claim 是不同的 WorkItem 入口；二者可以产生 Agent Request，但不建立第二套执行模型。
10. 一个 WorkItem 同一时刻至多有一个 Work Assignee。
11. Agent Claim 不随 Device 或 Runtime 故障自动丢失。
12. Run 创建时已绑定目标 Agent，不能被 Agent Claim；Execution Lease 可过期，并阻止旧 Attempt 继续提交当前执行的权威结果。
13. Agent 是稳定 Workspace 身份，与 Owner、Host、Device、Runtime 和 Session 分离。
14. 每个 Agent 有且只有一个 active Human Owner，历史 Owner 责任不可改写。
15. Workspace Governance、Owner Accountability 与 Local Custody 权威不同，任何一方都不能冒充另一方。
16. 每个 Workspace 只有一个共享事实逻辑权威。
17. Agent Delegation 只有通过显式 Child WorkItem 才建立工作责任链；普通 Agent Mention 不构成委派。
18. Run Context Snapshot 稳定、可解释且有权限边界；后续消息不会静默改变当前 Run，显式 reconciliation 也不改写原始 Snapshot。
19. Owner 私有上下文默认不参与团队触发的执行，使用与披露分别授权。
20. Runtime 不是 Workspace Principal，不持有长期 Workspace 凭据，不决定权限、归属或完成。
21. Runtime Integration 的职责稳定，具体协议可替换。
22. Runtime 对 Workspace 的所有操作经过 Workspace Interaction Gateway 和 Workspace Authority 再授权。
23. 普通 Run 不产生 Acceptance；只有显式 WorkItem 可以使用 Result Submission 和可选 Completion Policy。
24. Workspace 权威管理 Artifact lineage，但不要求拥有全部 Artifact 内容。
25. 实时连接、缓存、搜索投影和 Runtime Session 的失败不破坏请求、执行、权限和工作责任正确性。
26. 离线执行不能产生共享事实或发起未经当前授权的外部可见副作用。
27. 所有共享行为必须能追溯 actor、Agent Owner、Agent Request、Run、Attempt、实际执行 Device/Runtime，以及存在时的 WorkItem。
28. Final Message 发布必须以其结果 Discussion Scope 的已观察 Discussion Frontier 为前置条件；Scope 已推进时只能产生 Publication Hold，不能创建 Message 或让 Run 成功。

## 8. 系统上下文

```text
Human Clients
      │
      │ shared collaboration Interface
      ▼
┌───────────────────────────────────────────────────────────┐
│                   Workspace Authority                     │
│                                                           │
│  Governance   Conversation & Requests   Work & Execution  │
│  Artifact Lineage & Completion      Delivery & Read Model │
│                                                           │
│  authoritative shared commits and audit                   │
└──────────────────────────┬────────────────────────────────┘
                           │
                           │ Workspace Access seam
                           ▼
┌───────────────────────────────────────────────────────────┐
│                       Local Node                          │
│                                                           │
│  Node Coordination   Context Assembly   Local Custody     │
│  Workspace Interaction Gateway         Runtime Integration│
└──────────────────────────┬────────────────────────────────┘
                           │
                           │ Runtime Integration seam
                           ▼
                     Agent Runtime
                           │
                           │ mediated local/external tools
                           ▼
                Local Resources / External Systems
```

Human Client、Local Node 与 Runtime 都是可替换调用者或执行者。任何客户端都不能成为共享状态机、权限或审计的隐藏权威。

## 9. 深 Module 与职责

### 9.1 Workspace Collaboration Module

Workspace Collaboration Module 对 Human Client 和 Local Node 提供一个统一的共享协作 Interface。调用者只需表达命令、读取快照和跟随已提交变化，不需要理解事务、投递、并发控制、权限计算和投影实现。

它在内部拥有：

- Human、Agent、Owner、Membership 和共享权限；
- Conversation、Conversation Timeline、可选 Thread、Message、Discussion Scope、参与和可见性策略；
- Agent Request、触发来源、结果目标和可选 WorkItem 关联；
- WorkItem、Direct Assignment、Claim Eligibility、Agent Claim 和工作关系；
- Run、Attempt、Execution Lease、Discussion Frontier 和 Publication Hold 的共享协调事实；
- Artifact lineage，以及显式 WorkItem 的 Result Submission、Completion Policy 和 Acceptance；
- 共享审计、可靠变化传播和面向读取的投影。

这个 Module 必须足够深：一次 `@Agent` 用例由它原子地完成 Message 提交、Agent Request 创建、授权、上下文来源和结果目标记录；一次没有现成讨论位置的 WorkItem 创建由它原子地产生 Conversation、初始 Message 和 WorkItem；一次 Final Message 发布由它原子检查 Discussion Frontier，并确定 published 或 held。调用者不能自己编排一串容易部分成功的浅操作。

内部可以按领域组织实现，但内部 Module 不自动形成远程调用、独立事务或公开 seam。必须同步成立的不变量由同一个权威提交保护。

### 9.2 Local Agent Module

Local Agent Module 在 Owner 设备上把可靠 Agent Request 转换为受控 Runtime 执行。它对 Workspace 隐藏 Runtime 差异、Session、私有上下文、本地凭据、进程生命周期和工作目录。

它在内部拥有：

- Device 身份、Workspace 连接和本地持久恢复状态；
- Agent 与 Runtime Binding；
- Agent Request 与 Run Context Snapshot 获取和本地 Context Assembly；
- Private Context Grant 的本地执行；
- Runtime 启动、观察、取消和结果收集；
- Workspace Interaction Gateway；
- 本地资源、Credential、工作目录和外部 Tool 的约束；
- 断网期间的有界继续、待提交 Final Message / 候选结果和恢复。

Workspace 不调用 Runtime；Runtime 也不直接调用 Workspace Authority。Local Agent Module 是两种不同权威之间的深适配与执行 Module。

### 9.3 Human Experience Module

Web、桌面或其他 Human Client 通过同一 Workspace 协作 Interface 工作。Human Experience Module 负责把 Conversation、Agent Request、可选 WorkItem、Agent 状态、执行进度、Artifact 和可选 Review 组织成可理解的交互，但不复制领域状态机。

Web 页面不是新的权威层。刷新、断线或更换客户端后，用户必须从 Workspace Authority 恢复相同的共享事实。

## 10. 稳定 seam

总体架构只建立行为真实变化、且具有长期价值的 seam。

### 10.1 Workspace Access seam

位于 Human Client / Local Node 与 Workspace Collaboration Module 之间。其 Interface 提供三类语义：

- 提交经过认证的协作意图；
- 读取带权限的当前快照；
- 从稳定位置跟随已提交变化、Agent Request 与工作提示。

Interface 必须隐藏传输协议、事务、重试、投影和通知实现。具体 HTTP、SSE、WebSocket 或其他 Adapter 属于协议设计。

### 10.2 Runtime Integration seam

位于 Local Agent Module 与异构 Runtime 之间。其 Interface 只表达平台需要的公共执行语义，例如启动、输入、交互、进度、候选结果、取消和可选能力。

ACP、CLI、stdio、HTTP 或 Embedded Runtime 是 Adapter 选择，不是领域语言。Runtime 特有的 Session、消息和错误不得进入 Workspace 领域模型。

### 10.3 Workspace Interaction seam

位于 Runtime 与 Local Agent Module 的 Workspace Interaction Gateway 之间。其 Interface 让当前 Runtime 在受控执行上下文中查询共享内容、发布进度与 Final Message、显式创建工作、委派 Agent，并在关联 WorkItem 需要时提交 Result Submission。

CLI、MCP 或 Runtime 原生 Tool 机制可以成为 Adapter。Adapter 不能要求 Runtime 自报 Owner、Workspace、Agent 身份或有效权限；这些事实由 Local Agent Module 绑定并由 Workspace Authority 重新验证。

Runtime Integration seam 与 Workspace Interaction seam 可以共享同一底层传输，但职责不能合并：前者控制 Runtime 执行，后者控制 Runtime 对 Workspace 的行为。

### 10.4 Artifact Content seam

位于 Artifact lineage 与内容承载方式之间。Workspace 管理内容、外部版本引用和未来其他内容来源可以是不同 Adapter，但调用者始终看到稳定 Artifact 身份、版本、权限和来源。

数据库访问、Human 身份认证、Clock、ID Generator、策略求值器和内部 Repository 不因为测试便利或未来可能变化而成为系统级 seam。需要替换时可以作为 Module 内部 seam；只有真实出现第二种行为实现时才提升为外部 seam。

## 11. 权威与权限模型

### 11.1 Workspace Governance

Workspace Authority 决定：

- 谁是 Workspace Member；
- Agent 的共享身份、Owner、状态和共享权限；
- 谁可以读取 Conversation 和 Artifact；
- 谁可以创建 Agent Request、让哪个 Agent 执行以及向哪个 Discussion Scope 发布结果；
- 谁可以创建、分配、认领、委派、重分配和验收 WorkItem；
- 哪些共享变化可以成为权威事实。

客户端请求不能通过普通参数自报 actor、Owner、Workspace 或授权结果。

### 11.2 Owner Accountability

Owner 对 Agent 行为承担责任并拥有制止与收紧能力：

- 暂停 Agent 和阻止新执行；
- 请求取消运行中工作；
- 收紧 Agent 接单策略、能力和预算；
- 管理 Private Context Grant 和本地资源；
- 查看 Agent 的共享审计历史。

Owner 权力只能收紧 Workspace 授权，不能扩张它。Owner 变更只影响未来行为，不修改历史 owner-at-time。

### 11.3 Local Custody

Host 控制自己的 Device、本地文件、Credential、Runtime 和是否继续提供执行。Workspace 授权不能强迫一台个人设备执行，也不能证明 Owner 没有在自己的设备上绕过本地隔离。

当前 Owner 与 Host 相同，但权限判断仍区分：

```text
Workspace Authorization：共享操作是否被允许
Local Execution Policy：本机是否愿意并能够执行
实际执行：两者同时允许
```

### 11.4 Agent Authorship

Agent 的 Message、Agent Request 后续操作、WorkItem 操作、Artifact 和 Result Submission 由 Agent 署名。审计同时保留 initiated-by、actor、owner-at-time、Device、Runtime、Agent Request、Run、Attempt、correlation、causation 和可选 WorkItem。

Owner 关系不能把 Agent 行为改写为 Human 行为。

## 12. 上下文与隐私

### 12.1 共享上下文

Run Context Snapshot 至少包含：

- Agent Request 的稳定触发来源和结果目标；
- 来源为 Message 时，该 Message、其 Discussion Scope 在触发时刻之前的可见内容，以及对应 Discussion Frontier；
- 显式附加或引用的 Conversation、WorkItem、Decision 和 Artifact 版本；
- 执行所需的目标、约束、策略和身份引用。

Snapshot 保存稳定来源与版本，不要求保存完整 Runtime Prompt。Agent 可以通过 Workspace Interaction Gateway 主动查询更多有权共享内容，但这种查询必须可追溯。Publication Hold 后提供的新 Message 和 frontier 是显式 reconciliation 输入，不会反向修改原始 Snapshot。

### 12.2 私有上下文

团队触发的 Shared Agent 默认只使用共享上下文。Private Context Grant 明确规定允许使用的本地来源类别、适用范围和披露规则。

以下内容默认不离开 Owner 设备：

- 模型和 Tool Credential；
- 未明确共享的文件和个人记忆；
- Runtime Session 和本地恢复状态；
- 原始 Prompt、隐藏推理和含秘密的 Tool 输出。

Workspace 审计可以记录私有来源类别和策略版本，但不能以“可审计”为由默认上传私有正文。

## 13. 可靠性与失败原则

总体架构规定结果，不固定实现机制：

- 已成功提交的 Agent Request、Direct Assignment、Agent Claim、Final Message 和 Result Submission 不能静默丢失；
- 重复提交同一意图不能重复产生逻辑效果；
- 并发认领只能产生一个成功 assignee；
- 旧 Attempt 不能覆盖当前 Attempt 的执行结果；
- 通知丢失不能导致 Agent Request 或 Claimable WorkItem 永久不可发现；
- Local Node 重启后能够恢复待执行 Agent Request、当前执行和待提交 Final Message / 候选结果；
- Runtime 正常退出但未提交 Final Message 时，Run 不能被标记为成功；
- Discussion Frontier 冲突不能发布候选 Final Message 或让 Run 成功，重复原命令仍得到同一 held 语义；
- Publication Hold 必须提供可恢复的准确增量范围；摘要可以延后生成或失败，不能取代权威 Message 引用；
- 已开始但结果未知的外部副作用进入明确对账状态；
- 权限撤销、Owner 暂停和 Workspace 移除会阻止新的共享操作；
- 无法在线确认权限时，不发起新的外部可见副作用。

幂等记录、事务性事件传播、租约、fencing、Outbox、Checkpoint 和对账是满足这些结果的候选机制，其完整设计进入专题文档。

## 14. 完成与风险治理

普通 Conversation Run 没有 Completion Policy 或 Acceptance。Agent 的 Final Message 被提交只证明该 Run 完成了协作响应，不声明任何显式工作目标已被验收。

显式 WorkItem 可以不要求 Review，也可以根据风险选择 Completion Policy：

- 低风险、可逆的 WorkItem 可以在 Agent 提交 Final Message 或 Result Submission 后自动完成；
- 需要主观判断的工作由发起者或指定 Reviewer Acceptance；
- 可确定验证的工作由授权 verifier Acceptance；
- 高风险工作要求与 producer 独立的授权主体 Acceptance；
- 未满足条件的结果进入返工、阻塞或取消，而不是伪装成完成。

高风险 Tool 和外部副作用必须经过当前 Workspace Authorization 与 Local Execution Policy。具体 Approval 流程、动作规范化和风险等级属于专题设计。

## 15. 初始部署与分层演进

### 15.1 初始部署

```text
One Workspace Authority deployment
One shared transactional store
Optional Workspace-managed Artifact content store
N Human Clients
N Owner-hosted Local Nodes
At least one Runtime Adapter
```

Workspace Collaboration Module 初始采用模块化单体。内部领域实现共享一个一致性模型，不为了未来拆分引入远程调用。

### 15.2 Layer 1：最小 AI-native 协作闭环

必须端到端支持：

```text
two Humans and their locally hosted Agents
→ shared Conversation
→ @Agent atomically creates a durable Agent Request without a WorkItem
→ Agent executes and publishes a Final Message to the source Discussion Scope
→ a Human explicitly creates an assigned WorkItem with a Primary Discussion Scope
→ an open WorkItem is autonomously claimed by one eligible Agent
→ Agent-A delegates a Child WorkItem to Agent-B
→ WorkItem Runs use the same Agent Request / Run path and publish results to their Primary Discussion Scopes
→ explicit work completes directly or under an optional Completion Policy
```

这一层即使功能少，也必须是一个可实际使用的多人多 Agent 产品，而不是只有通用框架但缺少核心协作链。

### 15.3 Layer 2：可靠恢复与风险边界

增加断网恢复、执行租约、防旧执行提交、取消、预算、Owner 暂停、外部副作用审批与故障注入验证。

### 15.4 Layer 3：上下文与生态扩展

增加更多 Runtime Adapter、Workspace Interaction Adapter、Artifact 内容来源、上下文检索、验证器和外部集成。只有真实出现第二种行为实现时才扩展相应 seam。

### 15.5 Layer 4：新的部署形态

在真实需求出现后考虑远程托管执行、团队执行节点、企业设备治理和多节点 Workspace Authority 部署。新增部署形态不得改变 Conversation、Agent Request、可选 WorkItem、Agent Claim、Owner、Run、Attempt 和可选 Acceptance 的语义。

## 16. 架构验证标准

任何实现至少必须通过以下可观察场景：

1. Conversation 不关联 WorkItem 时仍能独立存在和恢复；
2. Channel 与 DM 风格的参与方式共享同一个 Conversation 模型和执行语义；
3. Conversation 可以只有 Conversation Timeline 而没有 Thread；只有从顶层 Message 展开聚焦回复时才形成 Thread；
4. `@Agent` 提交成功后，即使通知丢失也存在可恢复 Agent Request，且不会隐式创建 WorkItem；
5. 普通 mention 其他 Agent 只创建 Agent Request，只有显式委派才创建 Child WorkItem；
6. Runtime 正常退出但没有提交 Final Message 时，Run 不会成功；
7. 成功 Run 的 Final Message 出现在其指定的原始或 Primary Discussion Scope；
8. 独立创建 WorkItem 且未选择讨论位置时，Conversation、初始 Message 和 WorkItem 要么全部创建，要么全部失败，Primary Discussion Scope 是新 Conversation Timeline；
9. Conversation 归档不取消 WorkItem，WorkItem 完成不删除 Conversation；
10. 无权访问 Primary Discussion Scope 的 Agent 不能被静默分配，也不能通过分配获得隐式可见性；
11. 两个 Agent 基于同一 Discussion Frontier 生成结果时，先提交者可以发布，后提交者得到 Publication Hold、看不到伪造的 Final Message，且 Run 不会成功；
12. Publication Hold 的 Agent 可以读取准确增量并显式 reconciliation，原始 Run Context Snapshot 保持不变；
13. 同一开放任务的并发 Agent Claim 最多一个成功；
14. Device 断线和 Execution Lease 到期不自动清除 Agent Claim；
15. 一个 WorkItem 不会出现两个当前 assignee；
16. Agent-A 可以在授权边界内显式委派 Agent-B，且完整责任链可追溯；
17. 替换 Runtime Adapter 后，Agent 身份、Owner、权限和历史不变；
18. Runtime 无法通过 Tool 参数伪造 Agent、Owner、Workspace 或授权范围；
19. Owner 可以暂停 Agent，但不能删除或改写 Agent 历史行为；
20. 未授予 Private Context Grant 时，团队请求不能读取 Owner 私有上下文；
21. 私有上下文的读取授权不会自动赋予共享发布权；
22. 普通 Run 不产生 Acceptance，需要 Review 的 WorkItem 不会被 Runtime 成功绕过 Completion Policy；
23. 外部 Artifact 内容消失不会改写已记录的 lineage 和历史验证事实；
24. 离线节点不能产生共享事实或发起未经当前授权的新外部副作用；
25. Web、缓存、实时连接、搜索和 Runtime Session 失效不破坏核心正确性。

## 17. 明确禁止的架构退化

- 用 Message、WebSocket 或 Runtime Session 直接充当任务队列；
- 让 `@Agent` 直接跳过持久 Agent Request 进入 Runtime；
- 从普通 mention 隐式创建、推进或拆分 WorkItem；
- 为 Conversation 请求和显式 WorkItem 建立两套 Run / Attempt 状态机；
- 创建没有 source Message 或 Primary Discussion Scope 的 WorkItem；
- 为每个 Conversation 或 Message 创建伪装成 Thread 的默认消息容器；
- 用 Conversation 全局版本阻塞某个无关 Thread 的 Final Message 发布；
- 在 Discussion Frontier 已推进后原样发布或盲重试候选 Final Message；
- 把 WorkItem 与其自动创建的 Conversation 合并为同一生命周期对象；
- 为 Channel 和 DM 建立重复的 Conversation 领域模型；
- 把 Agent Claim 与 Execution Lease 合成一个 `claim` 状态；
- 允许一个 WorkItem 同时存在多个责任 assignee；
- 把 Agent 身份绑定到某个 Runtime、模型或 Device；
- 让 Owner、Host、Agent 和 Runtime 共用身份；
- 让 Owner 因责任关系自动获得超越 Workspace 的权限；
- 让 Runtime 直接写权威事件或自行声明执行权限；
- 让 Agent Delegation 退化为不经过 Workspace 的 Runtime-to-Runtime 调用；
- 默认把 Owner 的私人文件、记忆或 Credential 加入团队任务上下文；
- 把 Artifact 内容存储位置当成 Artifact 身份；
- 让 Adapter 决定 Agent Request、WorkItem、权限、Agent Claim 或 Acceptance；
- 为内部数据库、Clock、ID Generator 和每个 Repository 创建系统级公开 seam；
- 为尚未出现的规模问题提前拆分 Workspace Collaboration Module；
- 将当前的 Owner=Host 约束误写成永久身份不变量。

## 18. 后续专题设计

总体架构通过后，按需要逐层形成：

1. Conversation & Work：Conversation Timeline、可选 Thread、Discussion Scope、Message、Agent Request、显式 WorkItem 和工作图；
2. Agent Governance：Owner、Host、Membership、权限、接单和委派策略；
3. Execution Model：Agent Request、Run、Attempt、Execution Lease、取消、恢复和防旧执行；
4. Workspace Interface：命令、查询、变化跟随、幂等、Discussion Frontier 和 Publication Hold；
5. Runtime Integration：公共执行语义、能力协商、错误和 Adapter 一致性；
6. Workspace Interaction：CLI/MCP 等 Adapter、Tool 能力和身份绑定；
7. Context & Privacy：Snapshot、Private Context Grant、检索、披露和保留；
8. Artifact & Completion：lineage、外部引用、Final Message，以及显式 WorkItem 的 Result Submission、验证和 Acceptance；
9. Side Effects & Approval：风险判断、授权、去重、补偿和对账；
10. Storage & Delivery：事务存储、变化传播、投影、备份和恢复；
11. Threat Model：资产、攻击者、信任假设和控制；
12. Human Experience：Web 信息架构、Inbox、Conversation、Work Graph 和 Review。

专题设计可以改变内部实现，但不得改变本文的领域语义和可观察不变量。若新的产品需求要求改变本文，应先更新领域语言和 ADR，再发布新的总体架构版本。
