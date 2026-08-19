# AI-Native 协作框架：总体架构基线 V1

> 状态：Accepted Architecture Baseline V1
>
> 文档定位：描述产品边界、核心协作语义、权威关系、系统职责、稳定 seam 与长期不变量。
>
> 领域词义以根目录 `CONTEXT.md` 为准，已确认取舍记录在 `docs/adr/`。

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

同一产品部署可以承载多个彼此隔离的 Workspace。Human identity 在部署内稳定：一个 Human 可以创建自己的 Workspace，也可以通过各自独立的 Workspace Membership 加入其他人的 Workspace；客户端或 Local Node 的安装本身不等于创建 Workspace。该多 Workspace 参与能力只复用 Human identity，不合并 Workspace 权限、Conversation、Message、Agent Request、Run 或其他共享事实，也不让两套独立部署自动形成联邦身份。

一个 Workspace 内可以存在零到多个 Project。Project 是包含独立成员、Conversation 和共享资源的可选协作范围，不是某台 Computer 上的绝对路径，也不是所有 Conversation 的必经父级。`Workspace → Conversation` 与 `Workspace → Project → Conversation` 都是正式路径，并共享同一个 Conversation、Message、Agent Request 与 Run 模型。Project 可以没有 Repository；若挂载 Primary Repository，每台参与 Repository 执行的 Computer 才在本地映射 Working Copy，并为 Attempt 建立隔离 Worktree。

它不是多 Agent 聊天室，也不是新的通用 Agent Runtime。其独特价值在于把共享协作与本地 Agent 执行连接成一条可信、可恢复、可追溯的工作链：

> Conversation 形成共享语境，Agent Request 将协作意图可靠地连接到 Run，WorkItem 在需要时承载显式工作责任，Workspace 维护共同事实，Local Node 承载本地执行，Agent 将结果发布回共享讨论。

核心产品承诺：

- Conversation 可以独立存在，人和 Agent 共享同一份有权限边界的讨论历史；Channel 和 DM 只是它的参与与展示策略；
- Workspace 与 Project 是不同协作范围；Conversation 可以直接属于 Workspace，也可以绑定一个 Project，但不会因此分裂为两套讨论模型；
- 每个 Project 同时最多挂载一个 Primary Repository；有 Repository 的 Attempt 使用匹配 Working Copy 的隔离 Worktree，没有 Repository 的 Attempt 使用隔离 scratch；
- Artifact 是 Workspace 级、稳定、可版本化的共享成果，可显式关联多个 Project；Resource Link 只是 Project 下不带版本的外部 URL；
- 每个显式 `@Agent` 目标以及 Human–Agent DM 中由固定 direct Membership 推导出的唯一 Agent 目标，都形成可恢复的 Mention Outcome；有效目标创建 Agent Request，且都不隐式创建、分配或推进 WorkItem；
- Run 可以在其结果 Discussion Scope 中发布零到多条普通 Message，执行终态与 Message 是否存在彼此独立；
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
- 不把每次 Agent 对话隐式提升为 WorkItem、Result Submission 或 Review；
- 不承诺通用 exactly-once 执行或无法实现的外部副作用 exactly-once；
- 不允许 Runtime 直接成为 Workspace 权威或持有长期高权限凭据；
- 不把成员、权限、任务归属和执行所有权设计成多主状态；
- 不提前拆分微服务或引入只服务于假想扩展性的公开 Interface；
- 不在非托管个人设备上宣称存在 Owner 无法绕过的强制隔离。

### 3.2 当前产品约束

当前版本只支持本地执行：

- 每个 Agent 的 Runtime 运行在某个团队成员的电脑上；
- 当前默认 Agent Owner 托管 Runtime，但 Owner、Host 与 Runtime Binding 仍是不同事实；
- 不提供团队执行服务器或远程托管 Runtime。

这些是当前范围，不是 Agent 身份模型的不变量。Agent、Owner、Host、Device 和 Runtime Binding 仍保持概念分离，以便未来新增部署形态时不改写历史身份和协作语义。

### 3.3 MVP 功能范围

MVP 必须形成 Conversation 协作闭环：Human 和 Agent 可以在 Conversation Timeline 与 Thread 中发布不可变 Message；每个显式 `@Agent` 目标独立形成持久的 Mention Outcome，有效目标创建 Agent Request，无效目标记录未触发原因；执行经 Run/Attempt 完成，并把普通 Message 写回触发请求的准确 Discussion Scope。

Thread 是 MVP 必需能力，但不是每个 Conversation 的必需实例：Conversation 可以只有 Timeline；从顶层 Message 发起首条聚焦回复时才原子形成 Thread 与第一条 reply。

MVP 中任一 active Human Workspace Member 都可以创建 Workspace Channel；任一 active Human Project Member 都可以创建该 Project 的 Channel。Channel 创建只固定 scope，不创建参与者关系。DM 只存在于 Workspace scope并固定两个 direct Workspace Membership。Agent Run 只获得既有 Discussion Scope 内经过当前授权的发布能力；它不能创建新的 Conversation 或治理 Workspace/Project Membership。

MVP 不设置 Conversation Owner、Administrator 或 Channel 成员治理。Conversation creator 只作为不可变审计来源。Workspace Channel 的当前参与者、发现、完整历史访问和 `@Agent` 候选等于全部 active Workspace Membership；Project Channel 等于全部 active Project Membership 且其 Workspace Membership 也必须 active。成员变化只通过 Workspace/Project Membership 命令发生，并立即作用于该 scope 的全部 Channel。

当前 scope Membership 控制整个 Channel 历史，而不是按加入时间形成历史窗口。加入 Workspace 或 Project 后可读取该 scope 所有 Channel 的 Timeline、全部 Thread 及已有 Message；移除后不能再读取新旧内容，但已发布 Message 保持不可变。Workspace 不创建 per-Message ACL，也无法追回成员此前已合法下载到本地的内容，因此成员加入 scope 必须明确提示会披露完整 Channel 历史。

Workspace Membership 表示一个 Human 或 Agent 在一个 Workspace 中一次连续的参与期，而不是其稳定身份本身。同一 actor 在同一 Workspace 中最多一个 active Membership；Human 可以同时在不同 Workspace 中各有 active Membership。移除使该 Membership 永久 terminal，后来重新加入创建新的 Membership。Project Membership 在其上形成独立、同样不可复活的 Project 参与期。重新加入恢复当前 scope 的 Channel 访问，但不会恢复固定 DM 或既有 Run 授权；Message 等历史事实同时保留稳定 actor 与 membership-at-time。

Workspace Owner 是 active Human Workspace Membership 上的最高治理角色，不是独立对象或 creator 永久特权。创建 Workspace 时必须原子创建 creator 的 `owner` Membership；同一 Workspace 可有多个 active owner，但任何退出、移除或角色变更都不能使 active owner 数量降为零。Conversation 仍然没有 Owner，具体动作仍按当前角色与 preset 判断。

MVP 的 Workspace Membership 基础角色必填且仅为 `owner | member`。只有 Human Membership 可为 owner，Agent Membership 固定为 member；不引入 admin、自定义角色、继承或角色层级。角色变化修改同一连续 Membership、不创建新 Membership，并保留审计。

Human Membership 治理由当前 Workspace Owner 执行：只有 Owner 可以邀请 Human 加入、终止另一 Human 的 Membership，或修改 Human Membership 的基础角色。普通 Human Member 只能主动终止自己的 Membership；最后一位 owner 的退出仍被连续性不变量拒绝。

任一 active Human Workspace Member 都可在该 Workspace 创建自己的 Agent，无需 Workspace Owner 对单个 Agent 审批。Workspace 必须原子建立新的 Workspace-local Agent identity、该 Agent 的 active `member` Membership，以及 creator 当前 active Human Membership 作为唯一 Agent Owner；任一部分失败则三者都不存在。Agent 因 active Workspace Membership 立即进入 Workspace Channel，但不自动进入任何 Project、固定 DM、私有上下文、凭据、Runtime Binding 或本地资源。产品 provisioning 命令可显式携带一个已由目标 Computer 报告为 ready 的 `runtimeId`。

任一 active Human Workspace Member 都可只用名称创建 Project，Workspace Authority 必须原子建立 Project 与 creator 的首个 Human `manager` Project Membership；description 与 Primary Repository 都可选。Project Manager 可以挂载、更新或解除当前 Repository，但 identity 更换必须先解除再挂载，历史 Repository 记录继续支撑既有 Run provenance。共享事实只保存可安全共享的仓库身份与默认引用，不保存本机绝对路径、凭据或本地工作区状态。Project Membership 只能引用同 Workspace 的 active Membership；Human 可为 `manager | member`，Agent 固定为 `member`，且任何路径都不能移除或降级最后一位 active Human Manager。Project 只对 active Project Member 可发现；Workspace Owner 可读取安全治理元数据并执行恢复性成员治理，但不因此获得成员目录、Repository 内容或 Conversation 内容权限。

Project Channel 的参与者始终是同 Project 的全部 active Project Membership；Project 不创建或展示 DM。Project Membership remove/leave 必须立即关闭全部 Project Channel 访问并取消或 fence 相关请求与执行；重新加入创建新的 Project Membership ID，同时重新获得当前 Project Channel 访问。当前版本提供 Project 名称、描述、成员、Channel、Resource Link、Artifact Association 与零或一个 active Repository。

只有当前 Workspace Owner 可以终止或重新准入 Agent Membership，并可把 Agent ownership 转移给同 Workspace 的另一 active Human Membership。Agent Owner 负责暂停、恢复、运行约束和制止，但不能终止或恢复 Agent Membership；Agent Host 只能停止本地执行。只要某 Human Membership 仍拥有任一 Agent，其退出或移除必须失败。ownership transfer 保留不可改写的历史责任区间，任何事务提交前后都不能产生 ownerless Agent。

邀请 Human 加入必须先创建持久的 Workspace Invitation，而不能由 owner 直接替他人创建 active Membership。Invitation 以认证 seam 提供的 normalized verified email 作为目标，状态为 `pending | accepted | revoked | expired`；因此它可以在目标 Human 注册或安装产品前存在。pending 及其链接都不授予任何访问权，只有 authenticated Human 当前拥有完全匹配的 verified email 才能接受。接受时必须原子把 Invitation 变为 terminal `accepted`、记录稳定 accepted Human identity 并创建新的 active `member` Membership；owner 可在接受前撤销，超过有效期后进入 terminal `expired`。重新加入同一 Workspace 也必须使用新的 Invitation，旧 terminal Membership 与旧 Invitation 都不能复用；接受后邮箱变化不改变 Human identity 或 Membership。

同一 Workspace 与同一 normalized verified email 同时至多存在一个 pending Invitation。对同一邀请意图的重复提交返回已有 pending Invitation，不创建第二个有效入口，也不隐式延长其有效期；需要更换邀请或有效期时先将旧 Invitation 撤销，再创建新 Invitation。旧 Invitation accepted、revoked 或 expired 且接受者当前没有 active Membership 后，允许创建新的 Invitation identity。

MVP 不包含 WorkItem、assignment、claim、delegation、Result Submission、Completion Policy 或 Review，也不预建这些对象的表、命令或空字段。它们保留为已设计的后续显式工作层，不影响 Conversation MVP 的实现与发布门槛。

Agent identity 由一个 Workspace 创建并永久归属于该 Workspace，不能迁移、共享或以同一 identity 加入另一个 Workspace。另一个 Workspace 即使需要相同名称、配置或能力，也必须创建新的 Agent identity；未来若出现复用需求，只能复用不携带权限、Owner、历史或上下文的定义模板，不能复用 Agent 本身。

## 4. 第一性原理

### 4.1 协作需要共同事实

如果不同成员不能对消息、任务、责任人、权限、产物和完成状态得出同一结论，就不存在真正的共享空间。因此每个 Workspace 必须有一个逻辑上的 Workspace Authority。

Local Node 可以保存待提交意图和候选结果，但只有 Workspace Authority 提交后，变化才成为共享事实。

### 4.2 Conversation 与 WorkItem 回答不同问题

Conversation 回答“谁在什么可见范围内讨论了什么”，Agent Request 回答“谁请求哪个 Agent 响应什么”，WorkItem 回答“团队显式管理什么结果、由谁负责、进展如何”。普通对话执行不需要 WorkItem；只有需要持续责任、开放认领、委派、进度或完成管理时才显式创建 WorkItem。

Conversation 是唯一的讨论容器领域实体。Channel 和 DM 不形成独立领域模型：它们只是 Conversation 在参与者、可发现性、成员变化和界面呈现上的策略预设。每个 Conversation 有一个顶层 Conversation Timeline，并可拥有零个或多个从顶层 Message 展开的 Thread；Thread 继承 Conversation 的可见性，不承担任何工作状态。

Channel 不保存自己的成员事实。Workspace Channel 直接查询 active Workspace Membership，Project Channel 直接查询 active Project Membership 与其 backing Workspace Membership。Message 的可见性不固化为发布时读者列表，scope 成员加入/移除也不改写 Message；这保留完整讨论语境，同时避免 Thread root、reply、Agent Request 来源因按时间截断而对当前成员变成残缺事实。

Human/Agent identity 回答“谁”，Workspace Membership 回答“该身份在哪一段连续参与期内以什么当前权限参与”。两者不能合并：历史署名必须跨移除与重新加入保持稳定，授权引用则必须随旧 Membership terminal 永久失效。无需额外 permission epoch；Membership identity 本身就是参与期 fence。

创建 Channel 选择一个既有协作 scope；改变可见范围只能通过 Workspace/Project Membership 治理。在既有 Discussion Scope 内发布 Message 是内容意图。Agent 的 Run-scoped 发布权只能在当前 scope 内使用，不能派生出创建讨论或管理成员的权力。

### 4.3 Agent 身份不等于 Runtime

Agent 是长期协作者；Runtime 是一次或多次执行所使用的可替换引擎。替换 Runtime、Adapter、模型或 Session 不得创建新的 Agent、改变其 Owner、重置权限或割裂协作历史。

### 4.4 本地执行必然不可靠

Owner 的电脑会休眠、掉线、重启，Local Node 和 Runtime 会崩溃。任务责任归属必须独立于设备在线状态；一次设备执行的临时所有权也必须独立于 Agent 的长期任务责任。

### 4.5 执行、消息与工作完成相互独立

Runtime 进程正常结束只形成执行层 outcome。Conversation 只有一种不可变 Message；Run 是否结束不由 Message 的存在或缺失决定，Message 也不改变 WorkItem、Result Submission 或 Review。需要结构化状态变化时，Agent 必须通过 Workspace Interaction Gateway 发出明确命令，Workspace 再按当前权限和 fencing 提交。

“状态相互独立”不等于“授权无限延续”。Run terminal 表示该次逻辑执行已经结束，因此它同时关闭该 Run 首次发布新 Agent Message 的共享写入权；否则一个已经结束的执行仍能制造新的执行归属事实，terminal 就失去语义。Agent Message 首次发布与 Run terminal 转换必须由同一 Workspace Authority 给出唯一提交顺序：Message 先提交则它合法存在，terminal 先提交则后来的首次发布不产生 Message。对 terminal 前已经提交成功的同一发布意图进行幂等重放，只返回原逻辑结果，不构成 terminal 后的新写入。Runtime 进程退出只是本地执行信号，不等同于 Run 已进入 Workspace terminal。

### 4.6 责任必须伴随制止能力

Agent 的行为由 Agent 署名，但每个 Agent 必须有唯一 Human Owner 承担责任。Owner 必须能够暂停 Agent、请求取消运行、收紧能力和预算并查看共享审计；Owner 不能替 Agent 署名、突破 Workspace 权限或改写历史。

### 4.7 共享上下文有明确边界

共享上下文不是整个 Runtime Prompt 或本地模型记忆。权威层级固定为 `Message → Agent Inbox Item → Agent Request → Run → Attempt`。Conversation Timeline 与每个 Thread 各自维护 Discussion Frontier；Conversation context version 只能检测总体变化，不能替代 Scope position。Workspace wake 只携带 Agent ID 和最高 Inbox sequence，Runtime 通过 Agent 级 `teamctl` 主动领取 attention，并读取当前 Discussion Scope 自上次成功处理位置以来的消息增量。完整契约见 `docs/design/08-context-and-privacy.md`。

### 4.8 外部动作不能靠重试猜测

发消息、部署、支付、删除和发布等动作可能不可逆。网络层可以重复投递意图，但系统不能因此假设重复执行安全；外部动作必须在当前权限和风险策略下执行，并能确认、去重、补偿或进入明确的人工处理状态。

## 5. 核心协作场景

### 5.1 Conversation 中请求 Agent

```text
Human or Agent posts a Message explicitly mentioning Agent-A,
or Human posts in its fixed one-to-one DM with Agent-A
→ Workspace atomically records the Message and an Agent Request for Agent-A
→ Workspace authorizes the request and applies Agent-A's intake constraints
→ create a durable Agent Inbox Item and lightweight wake
→ Runtime claims the Discussion Scope and creates a Run/Attempt
→ Agent-A's Local Node executes when available
→ Runtime pulls the current Discussion Scope delta and optional history through teamctl
→ Agent-A may publish zero or more ordinary Messages through the Agent-scoped gateway
→ the execution layer records Run terminal outcome independently
```

含显式 `@Agent` 的 Message，以及 Human–Agent DM 中自动面向唯一 direct Agent 的 Human Message，其全部 per-target Mention Outcome 与有效目标的 Agent Request 必须属于同一个权威用例。DM 的隐式目标来自固定 Membership 关系，不解析正文；显式再选择同一 Agent 也必须去重。Agent Request 在 Run 之前记录触发来源、目标 Agent 和结果发布位置，因此 `requested` 成功而通知丢失时仍可恢复；实时连接只用于唤醒，不能决定请求是否存在。

同一 Message 中的多个 Agent Mention 是多个可分离请求，不是一个不可分割的批命令。Workspace 在提交 Message 时为每个 distinct target 持久记录一个 Mention Outcome：有效目标为 `requested` 并关联新 Agent Request；无效目标为 `not_requested` 并记录结构化原因。某一目标失败不阻止 Message 或其他目标的 Request，但不得静默忽略失败目标。重复 mention 同一 Agent 只产生一个目标结果。

Mention Outcome 的 `requested / not_requested` 状态随 Message 对所有可读者可见，使团队不会误判 Agent 是否收到请求。`not_requested` 只保存一份权威原因；读取投影只向当前 Workspace Owner 或目标 Agent 的当前 Owner 返回精确治理原因，其他观察者只返回安全概括。安全概括不是第二份领域事实，客户端、搜索或缓存也不得获得比当前观察者更高的原因可见性。

`not_requested` 与 Agent Request 生命周期有严格边界：目标不是可请求的 Workspace Agent、目标无权访问结果 Scope、发起者无请求权限等情况意味着请求不能合法成立，因此不创建 Request。只要请求合法成立，Mention Outcome 就永久是 `requested`；Agent 暂停、Node 离线、调度或并发限制等可恢复条件属于 pending Request 的派生 `waiting / blocked`，明确且不可恢复的接单策略、能力或预算拒绝则使该 Request 进入 `rejected`。后续 intake 结果不得反向改写 Mention Outcome。

`not_requested` 的建立失败原因后来消失时，旧 Outcome 仍保持不变，也不会自动补建 Request。授权、成员或 Scope 访问变化只影响变化后的新意图；要请求该 Agent，Human 或 Agent 必须在当前权限和上下文下发布新的显式 `@Agent` Message。与此相对，已经存在的 pending Request 在临时条件消失后可以自动重新求值，因为它原本就是合法、持久且尚未终结的请求。

默认结果位置与触发 Message 的 Discussion Scope 相同：Conversation Timeline 中的 mention 返回该 Timeline，Thread Reply 中的 mention 返回该 Thread。产品可以提供“在 Thread 中继续”等显式动作改变位置，但不能为了统一存储而为每条 Message 创建隐藏的默认 Thread。

Agent Mention 是定向会话请求，不是 Direct Assignment。目标 Agent 不需要认领该请求；请求可能因权限、接单策略、预算、能力或并发约束而等待、拒绝或阻塞，但不能静默改派给其他 Agent。

工作边界只由显式产品动作决定：

- 普通 mention 为每个被提及 Agent 独立记录 Mention Outcome，仅 `requested` 结果创建 Agent Request；
- “从消息创建工作”显式创建 WorkItem，并保留 source Message；
- Direct Assignment、Agent Claim 或 Child delegation 创建关联 WorkItem 的 Agent Request；
- “创建 Child WorkItem / 委派”显式创建子工作；
- 自然语言模型不能决定是否创建、推进或拆分 WorkItem。

### 5.2 显式创建和分配 WorkItem

```text
Member explicitly creates a WorkItem from a Message or work-management action
→ reuse the selected Primary Discussion Scope, or atomically create a Conversation and initial source Message
→ persist a user-visible WorkItem linked to its source Message and Primary Discussion Scope
→ optionally assign it to a Human or Agent
→ if an Agent should execute now, create an Agent Request linked to that WorkItem
→ Agent publishes ordinary result Messages and may explicitly SubmitResult
→ Completion Policy may complete the WorkItem or require an independent Review
```

WorkItem 创建不要求已有 Conversation，但绝不产生没有讨论归宿的“无头任务”。如果调用者未选择讨论位置，Workspace 必须在同一权威用例中创建专用 Conversation、由创建者署名的初始 Message，并将该 Conversation Timeline 作为 Primary Discussion Scope。WorkItem 只保存一个 Primary Discussion Scope；该 Scope 已唯一标识所属 Conversation，不能再维护一份可能冲突的主讨论引用。

WorkItem 与自动创建的 Conversation 仍然生命周期独立：WorkItem 完成或取消不删除或归档讨论，Conversation 归档也不改变 WorkItem 状态。Conversation 支持可恢复归档且归档后只读；WorkItem 当前不提供归档、恢复或重新打开。assignee 必须有权读取并向 active Primary Discussion Scope 发布结果；不能为了完成分配而静默扩大 Conversation 可见性。

### 5.3 Agent 自主认领开放任务

```text
Member publishes an unassigned Claimable WorkItem
→ Workspace evaluates Claim Eligibility
→ every eligible Agent may discover it
→ each Agent autonomously decides whether to claim
→ first valid Agent Claim closes claimability and establishes the sole assignee
→ Workspace atomically creates an Agent Request for the claiming Agent
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
→ Agent-B publishes ordinary result Messages and explicitly submits structured results when needed
→ result returns through the Child WorkItem relationship
→ Agent-A continues or aggregates the parent WorkItem
```

Agent 可以通过普通 mention 请求另一个 Agent 提供会话意见，不因此产生 Child WorkItem。只有显式委派才创建 Child WorkItem；它不需要每次由 Human 单独批准，但必须受到权限、接单策略、Owner 预授权、预算、并发和递归边界约束。需要责任管理的 Agent-to-Agent 协作永远通过 Workspace WorkItem，不退化成不可追踪的 Runtime-to-Runtime 调用。

被委派 Agent 仍可因不满足明确接单条件而拒绝或阻塞，Workspace 不因为委派者也是 Agent 就放宽接收方策略。

### 5.5 工作补充、返工与验收

普通 Message 不隐式关联或改变 WorkItem，也不启动执行。新的明确 `@Agent` 目标先形成 Mention Outcome，仅 `requested` 结果创建新的 Agent Request；Direct Assignment、Agent Claim 和 Child delegation 则创建显式关联 WorkItem 的请求。Runtime 失败后的技术重试属于同一 Run 的新 Attempt。

当前 Agent assignee 可以显式创建引用普通 Message 与 Artifact 的 Result Submission。Submission 是不可变候选事实，没有 accepted/rejected 状态；需要评价时显式创建独立 Review。Review 拒绝本身不启动新 Run；反馈 Message 中新的明确 `@Agent` 先形成 Mention Outcome，仅有效目标创建请求。

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

### 5.7 Runtime 运行中的 Inbox 拉取

```text
Runtime receives a lightweight Inbox wake
→ teamctl inbox check lists pending Discussion Scopes
→ teamctl message check atomically claims one Scope
→ the response contains attention references and the ordered Scope message delta
→ later wake while busy only sets wakePending
→ Runtime checks the Inbox again at the next safe boundary
→ Runtime publishes through teamctl or explicitly returns no output
```

`@` 只决定 attention，不裁剪 Conversation 历史。普通 Channel Message 不唤醒 Agent，但后续明确 mention 会让 `message check` 返回上次成功处理位置之后的完整 Scope 增量。Claim receipt 可重放，正文不会进入 wake、启动参数或本地 manifest。回传可以产生零条 Message；`no_output` 是执行结果而不是空 Message。

## 6. 核心领域模型

### 6.1 协作模型

```text
Product Deployment
├── Human identity 0..N
│   └── Workspace Membership 0..N across isolated Workspaces
└── Workspace 0..N
    ├── Agent identity 0..N, each permanently confined to this Workspace
    │   ├── exactly one active accountable Human Owner Membership
    │   ├── immutable ownership history and creator provenance
    │   └── creation atomically establishes its active member Membership
    ├── Workspace Membership 0..N
    │   ├── exactly one Human | Workspace-owned Agent identity
    │   ├── base role: owner | member
    │   ├── at most one active Membership per actor in this Workspace
    │   └── one or more active Human Memberships hold owner role
    ├── Workspace Invitation 0..N
    │   ├── exactly one normalized verified email target
    │   ├── pending | accepted | revoked | expired
    │   ├── at most one pending per Workspace + normalized email
    │   └── accepted → stable Human identity + exactly one new active member Membership
    ├── Project 0..N
    │   ├── active Primary Git Repository 0..1
    │   ├── Resource Link 0..N
    │   ├── Artifact Association 0..N
    │   ├── Project Membership 1..N
    │   │   ├── references one active Workspace Membership
    │   │   ├── Human manager | member; Agent member
    │   │   └── one or more active Human Managers
    │   └── Project Conversation 0..N
    ├── Conversation
    │   ├── optional Project scope
    │   ├── fixed scope / derived Channel participants or fixed DM participants
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
    │   ├── Agent Inbox Item 1
    │   └── Run 0..1
    │       ├── claimed Agent Request 1..N
    │       ├── Agent Inbox Claim Receipt 1..N
    │       └── Attempt 0..N
    ├── Artifact 0..N
    │   ├── mutable Current State 1
    │   ├── immutable ArtifactSnapshot 0..N
    │   ├── Project Association 0..N
    │   └── exact Message Reference 0..N
    └── WorkItem 0..N
        ├── source Message
        ├── Primary Discussion Scope
        ├── parent / related WorkItem
        ├── current Work Assignee 0..1
        ├── assignment kind / monotonically increasing revision
        ├── Agent Request / Run 0..N
        ├── Artifact 0..N
        ├── Result Submission 0..N
        ├── Current Submission 0..1
        └── Review 0..N
```

Conversation 是唯一讨论容器。Channel 和 DM 只是在参与者、可发现性、成员变化和 UI 呈现上的策略预设，不拥有独立领域身份或状态机。顶层 Message 属于 Conversation Timeline；Thread 是从一条顶层 Message 展开的可选分支，Thread Reply 属于且只属于一个 Thread。Conversation Timeline 和 Thread 都是可读取与发布的 Discussion Scope，但 Discussion Scope 只是位置值，不是新的容器实体。

Project 是 Workspace-local 的可选协作 scope，Repository 不是成立条件。它可以聚合 Resource Link，并通过显式多对多关系关联 Workspace Artifact；这些资源不会改变 Project Channel 的成员投影或 Artifact 所有权。若存在 Primary Repository，它是共享身份而不是任何 Computer 的本机目录；同一个 Project 可以在不同 Computer 上绑定不同 Local Working Copy。Conversation 创建时固定为 Workspace Conversation 或某个 Project Conversation；二者共享上述完整领域模型，不存在 scope 迁移、Project 专用 Message 或第二套执行状态。

有 Primary Repository 的 Project Run 只能在具有匹配 Local Working Copy 与可用 Runtime 的 Computer 上执行，Local Agent Module 必须为每个 Attempt 建立隔离 Worktree 并把它作为 Runtime `cwd`。没有 Primary Repository 的 Project Run 与 Workspace-level Run 都使用隔离 scratch directory。Run Context Snapshot 固定接受时的 Repository 基线，之后的挂载或解除不改写既有 Run。本机绝对路径、Git 凭据和未提交工作区状态始终属于本地保管。Runtime 文件写入或 staged blob 都不会自动成为共享 Artifact 当前状态或历史快照；共享发布必须走受控事务。

Agent Request 是所有 Agent 执行入口的统一事实：Conversation mention 的 `requested` Outcome、Direct Assignment、Agent Claim、显式委派和 Agent Review 都通过它进入同一个 Run / Attempt 模型。Agent Request 可以不关联 WorkItem，Run 不能被 Agent 认领，因为它在创建时已经有目标 Agent；Agent 认领的是开放 WorkItem，Device 获取的是 Attempt 的 Execution Lease。当前模型没有 `ContinueWorkWithAgent`。

WorkItem 是可选、显式且用户可见的独立工作对象。每个 WorkItem 必须有 source Message 和一个 Primary Discussion Scope；从独立工作入口创建且没有现成讨论位置时，Workspace 原子创建专用 Conversation、初始 Message 和 WorkItem，并使用新 Conversation Timeline 作为 Primary Discussion Scope。Conversation 与 WorkItem 生命周期独立，完成或取消 WorkItem 不改变 Conversation；Conversation 可归档/恢复，WorkItem 当前不提供归档或重新打开。

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

Agent identity 的命名空间和治理归属是单一 Workspace。所有 Agent Membership 都只能属于该 Workspace；Agent、Owner、权限、Conversation、Agent Request、Run、Message provenance 与审计链不能跨 Workspace 连接。相似 Agent 在其他 Workspace 是新的 actor，历史不合并。

当前 Owner 与 Host 必须相同，但历史记录仍分别保存 Owner、Device 和 Runtime 执行事实。

### 6.3 工作与执行模型

- **Agent Request**：对指定 Agent 的持久响应或工作推进请求；它先于 Run 存在，可以等待、拒绝或阻塞；
- **WorkItem**：团队希望获得的结果和责任单位；
- **Work Assignee**：当前唯一负责推进 WorkItem 的成员；
- **Agent Claim**：Agent 对开放 WorkItem 的持久责任取得；
- **Run**：授权某个 Agent 在一组目标、上下文、策略和预算下响应一个 Agent Request 的逻辑执行；
- **Attempt**：某个 Device 使用某个 Runtime 对 Run 的一次具体执行；
- **Execution Lease**：一个 Device 对当前 Attempt 的可过期执行所有权；
- **Message provenance**：每条 Agent-authored Message 必须关联同一 Agent 的唯一 producing Run；Human-authored Message 不关联 Run。该关系用于提交授权与追溯，不形成 final/result 类型；
- **Agent Inbox Claim / Held Draft**：Runtime 主动领取一个 Discussion Scope 的消息增量；未提交的 Artifact publication intent 可留在 Local Node，普通 Message 通过 `teamctl message send` 直接发布；
- **Result Submission**：显式 WorkItem 的不可变候选结果，引用普通 Message 和/或 Artifact；
- **Review**：对一个 Submission 的独立、显式评价，状态不写回 Submission。

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

Artifact 是 Workspace 级稳定共享成果，由持续自动保存的 Current State 和零到多个长期 ArtifactSnapshot 组成。`markdown` 当前状态使用原始 Yjs 二进制；`file` 当前状态使用可替换的内容寻址 blob。编辑或替换只推进当前状态，不自动创建历史；显式“保存到历史”、消息引用当前状态或 Context 固定当前内容时才按 digest 创建或复用快照 UUID。

Artifact 可显式关联多个 Project，但关联不复制内容或转移 Workspace 所有权。Message 固定具体 ArtifactSnapshot UUID 并保存最小展示元数据；后续当前状态变化不会改变历史引用。Agent 输出先进入 Run/Attempt 私有 staged blob，只有最终 return 事务成功时才原子更新 Current State、创建或复用 Snapshot、建立 Message reference、change 与 audit。Human 与 Agent 使用同一结构，不记录面向用户的来源分类。

Artifact 删除进入 7 天回收站；保留期内恢复会重新显示原 Project 关联。历史快照统一软删除并立即禁止内容访问，7 天后在无其他有效引用时回收 blob；Message 继续保留文件名、可空名称、保存时间、媒体类型和大小并显示内容已删除。Resource Link 是无快照外部 URL，不能冒充 Artifact。

## 7. 架构不变量

所有实现必须保持以下不变量：

1. Conversation 是唯一讨论容器领域实体，拥有一个 Conversation Timeline、可以有零个 Thread、也可以不关联 WorkItem；Channel 和 DM 只是参与与展示策略。
2. Thread 只是从 Conversation Timeline 中一条 Message 展开的可选聚焦分支，不是强制消息容器，也不承担工作责任、执行或完成状态。
3. 每个 Agent 执行都由持久 Agent Request 触发；Agent Request 可以但不必须关联 WorkItem。
4. `@Agent` 为每个目标创建定向 Mention Outcome，仅有效目标创建 Agent Request；它不是 Direct Assignment，也不隐式创建、推进或拆分 WorkItem。
5. Run terminal outcome 由执行层独立记录；普通 Message 的存在或缺失不决定 Run、WorkItem、Submission 或 Review 状态。
6. WorkItem 是可选、显式、用户可见的工作管理对象；每个 WorkItem 有一个 source Message 和一个 Primary Discussion Scope。
7. 没有现成讨论位置的 WorkItem 创建必须原子产生专用 Conversation、初始 Message 和 WorkItem，并以该 Conversation Timeline 作为 Primary Discussion Scope。
8. WorkItem 与 Conversation 生命周期独立；assignee 必须拥有 Primary Discussion Scope 所需访问权，分配不能静默扩大可见性。
9. Direct Assignment 与开放 Agent Claim 是不同的 WorkItem 入口；二者可以产生 Agent Request，但不建立第二套执行模型。
10. 一个 WorkItem 同一时刻至多有一个 Work Assignee；当前 assignment kind 决定 Agent 是否可自行释放，单调递增的 assignment revision 阻止旧责任期间的命令获得当前权限。
11. Agent Claim 不随 Device 或 Runtime 故障自动丢失。
12. Run 创建时已绑定目标 Agent，不能被 Agent Claim；Execution Lease 可过期，并阻止旧 Attempt 继续提交当前执行的权威结果。
13. Agent 是稳定 Workspace 身份，与 Owner、Host、Device、Runtime 和 Session 分离。
14. 每个 Agent 有且只有一个 active Human Owner，历史 Owner 责任不可改写。
15. Workspace Governance、Owner Accountability 与 Local Custody 权威不同，任何一方都不能冒充另一方。
16. 每个 Workspace 只有一个共享事实逻辑权威。
17. Agent Delegation 只有通过显式 Child WorkItem 才建立工作责任链；普通 Agent Mention 不构成委派。
18. 每个 Inbox claim 都有稳定 Discussion Scope、可重放 receipt 和准确 position 范围；wake 不包含 Message 正文，Runtime 主动拉取上下文。
19. Owner 私有上下文默认不参与团队触发的执行，使用与披露分别授权。
20. Runtime 不是 Workspace Principal，不持有长期 Workspace 凭据，不决定权限、归属或完成。
21. Runtime Integration 的职责稳定，具体协议可替换。
22. Runtime 对 Workspace 的所有操作经过 Workspace Interaction Gateway 和 Workspace Authority 再授权。
23. 普通 Run 不产生 WorkItem Completion 或 Review；只有显式 WorkItem 可以使用 Result Submission、Completion Policy 和 Review。
24. Workspace 权威管理 Artifact 身份、内容、版本、草稿、权限、关联与 lineage；编辑器和 Runtime 不能建立旁路事实。
25. 实时连接、缓存、搜索投影和 Runtime Session 的失败不破坏请求、执行、权限和工作责任正确性。
26. 离线执行不能产生共享事实或发起未经当前授权的外部可见副作用。
27. 所有共享行为必须能追溯 actor、Agent Owner、Agent Request、Run、Attempt、实际执行 Device/Runtime，以及存在时的 WorkItem。
28. Workspace 与 Conversation 分别维护 context version；Local Agent Module 从 Initial cursor 开始读取准确变化、在同一 Runtime Session 中注入有序 Addenda，并以最后确认的 cursor 约束回传。
29. MVP 必须支持 Thread，但不实现或预留 WorkItem、assignment、claim、delegation、Result Submission、Completion Policy 或 Review 对象。
30. 同一 Message 中的每个 distinct Agent Mention 目标独立、持久地形成 `requested(request)` 或 `not_requested(reason)`；单个目标失败不能阻止 Message 或其他有效 Request，也不能被静默遗漏。
31. Mention Outcome 状态随 Message 对所有可读者可见；精确 `not_requested` 治理原因只向当前 Workspace Owner 或目标 Agent 的当前 Owner 投影，其他读者得到安全概括，且两者来自同一权威事实。
32. `not_requested` 只表示 Request 从未合法建立；合法 Request 后续的 intake waiting、blocking 或 rejection 只属于 Agent Request，不能改写 Mention Outcome。
33. 后续权限或访问变化不能激活历史 `not_requested` Outcome；只有新的显式 Agent Mention 可以建立新 Request，已有 pending Request 则可在临时条件变化后重新求值。
34. 每条 Agent-authored Message 必须由 Workspace 绑定到同一 Agent 的唯一 producing Run；Human-authored Message 不关联 Run，Runtime 和客户端不能自报或伪造该关系。
35. Run terminal 关闭该 Run 首次发布新 Agent Message 的共享写入权；Agent Message 首次发布与 Run terminal 转换由 Workspace 形成唯一提交顺序，terminal 后只允许对 terminal 前已提交发布意图作无新增事实的幂等重放。
36. 任一 active Human Workspace Member 可创建 Workspace Channel，任一 active Human Project Member 可创建 Project Channel；Channel 不建立成员记录，Agent Run 只能在当前 scope 授权内发布。
37. MVP 没有 Conversation Owner、Administrator、Channel 成员治理或恢复路径；creator 只保留审计 provenance。Workspace DM 固定两个 direct participants，Project 不提供 DM。
38. Workspace Channel 当前成员等于全部 active Workspace Membership；Project Channel 当前成员等于全部 active Project Membership 且 backing Workspace Membership 必须 active。成员列表是只读投影。
39. 当前 scope Membership 控制完整 Channel 历史：加入 scope 后可读全部历史，移除后不能读取任何新旧内容；Message 保持不可变，不存在加入时间截断或 per-Message ACL。
40. Workspace Membership 终止立即关闭 Workspace Channel、固定 DM 与相关执行访问；后来重新加入恢复 Workspace Channel，但不恢复旧 DM 或 Run 权限，历史署名不变。
41. Human/Agent 稳定身份与 Workspace Membership 分离；每个 Membership 表示该 actor 在一个 Workspace 中一次不可复活的连续参与期，同一 actor 在同一 Workspace 至多一个 active Membership，重新加入该 Workspace 创建新 Membership，授权引用 Membership 而历史行为同时记录 actor 与 membership-at-time。
42. Agent identity 由且仅由一个 Workspace 创建并永久归属该 Workspace，不能迁移、共享或跨 Workspace 使用；另一 Workspace 中的相似 Agent 是新的 identity，权限、Owner、上下文与历史不合并。
43. Human identity 在同一产品部署内稳定且可同时参与多个 Workspace；每个 Human–Workspace 组合通过独立 Membership 隔离权限和参与期。共享 Human identity 不允许 Conversation、Message、Agent Request、Run、Agent 或授权跨 Workspace 引用，独立部署也不自动共享身份。
44. Workspace Owner 是 active Human Membership 上的最高治理角色而非独立对象；Workspace 创建与 creator owner Membership 原子成立，可同时有多个 owner，且任何命令都不能使 active owner 数量降为零。Workspace ownership 不产生 Conversation Owner。
45. MVP 的 Workspace Membership 基础角色必填且仅为 `owner | member`；只有 Human Membership 可为 owner，Agent Membership 固定为 member，不存在 admin、自定义角色或角色层级。角色变化不更换 Membership，也不替代其他 scope-specific 授权。
46. 只有当前 Workspace Owner 可以邀请、移除其他 Human Member 或修改 Human Membership 角色；普通 Human Member 只能退出自己的 Membership，且任何路径都必须保留至少一位 active owner。Human Membership 治理规则不隐式授予 Agent Membership 治理权。
47. Human 加入或重新加入 Workspace 必须接受一个匹配的 pending Workspace Invitation；pending 不授予任何权限，接受与新 `member` Membership 原子成立，`accepted | revoked | expired` 均为终态且 Invitation 与旧 Membership 都不可复用。Owner 不能直接替另一 Human 创建 active Membership。
48. 同一 Workspace 与 normalized verified email 同时至多一个 pending Invitation；重复邀请返回已有 pending 事实且不修改有效期，更换邀请必须先终结旧 Invitation，终态后且接受者没有 active Membership 时才可创建新的 Invitation identity。
49. 任一 active Human scope Member 可在其 Workspace 或 Project 创建 Channel；Channel 成员完全跟随 scope Membership，无 Conversation-local mutation API。DM 只属于 Workspace且固定两个 direct participants，Agent 永无 Membership 治理权。
50. Workspace Invitation 以 normalized verified email 为目标而非预先存在的 Human identity；邀请链接没有 bearer authority，只有具有完全匹配 verified email 的 authenticated Human 能接受，接受时固化稳定 Human identity，之后邮箱变化不改写 Invitation、Membership 或历史。
51. 只有 Workspace Owner 可终止或重新准入 Agent Membership，并可把 Agent ownership 转移给另一 active Human Membership；Agent Owner 只能治理责任与制止，Agent Host 只能治理本地执行。仍拥有 Agent 的 Human Membership 不能终止，ownership transfer 后退出才可提交且绝不产生 ownerless Agent。
52. 任一 active Human Workspace Member 可创建自己的 Workspace-local Agent；Workspace 原子建立 Agent identity、active `member` Membership 与 creator 作为唯一 Agent Owner。Agent 立即进入 Workspace Channel，但不自动进入 Project、DM、私有上下文、凭据、Runtime Binding 或本地资源。
53. Workspace Conversation 与 Project Channel 是两条同等正式路径；DM 只存在于 Workspace。每个 Conversation 创建时固定一个 nullable Project scope，之后不能跨 scope 移动，二者共享唯一 Conversation/Message/Request/Run 模型。
54. Project Membership 只能引用同 Workspace 的 active Workspace Membership，并形成不可复活的独立参与期；Human 为 `manager | member`，Agent 固定为 `member`。
55. 任一 active Human Workspace Member 可只用名称原子创建 Project 与自己的首个 Human Manager Membership；description 与 Primary Repository 可选，任何 demote、remove、leave 或上游 Workspace removal 都不能消除最后一位 active Human Manager。
56. Project 只对 active Project Member 可发现；Workspace Owner 的非成员投影只提供安全治理元数据与恢复性成员治理，不授予成员目录、Conversation 或执行内容访问。
57. Project Channel 当前成员始终等于同 Project 的全部 active Project Membership；角色只决定 Project 管理命令，Project 不提供 DM。
58. Project Membership 终止立即关闭全部 Project Channel 权限并 fence 相关 Agent Request、Run 与 Attempt；重新加入产生新 Membership ID 并恢复当前 Project Channel 访问。
59. 当前版本的 Project 包含名称、描述、成员、Conversation、Resource Link、Artifact Association 与零或一个 active Primary Repository；不实现 Project invitation、delete/archive、跨 scope move 或多个 active Repository。
60. Project Repository 是可挂载和解除的当前共享身份，不是本机绝对路径；identity 不可原地修改，历史记录继续支撑既有 Run provenance，本机 Working Copy 路径、凭据和状态留在 Local Agent Module。
61. 有 Primary Repository 的 Project Attempt 必须使用匹配 Working Copy 建立的隔离 Worktree；没有 Repository 的 Project Attempt 与 Workspace Attempt 使用隔离 scratch。active Attempt 阻止解除其 Repository，Repository 变化不改写既有 Run Snapshot。
62. Runtime 对 Local Working Copy、Attempt Worktree 或 staged blob 的写入不会自动成为 Message、Artifact Current State、ArtifactSnapshot 或其他共享事实；任何共享结果都必须通过受控发布路径显式提交。
63. Artifact 是 Workspace 级稳定身份；Project Association 是显式多对多关系，不复制内容、不转移所有权，并默认展示当前状态。
64. ArtifactSnapshot 内容不可变并以 UUID 标识；保存历史按当前内容 digest 创建或复用快照，重命名、恢复和软删除不改变 UUID。
65. Markdown Yjs 与 File current blob 构成可变 Current State；编辑或替换只推进 current revision，不自动创建历史快照。
66. Message、Run provenance 与 Context Source 固定具体 ArtifactSnapshot UUID 和 digest；引用当前状态时必须先按 digest 创建或复用快照，后续当前状态变化不改写历史引用。
67. Agent staged blob 在成功 return 前不是共享 Artifact；Current State、Snapshot、Message reference、change、audit 与 Run terminal 在同一事务提交，失败全部回滚。
68. Artifact 和历史快照使用 7 天回收语义；快照删除后保留身份与最小引用元数据，内容立即不可访问，并只在无其他有效引用时回收 blob。

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
- Agent Mention Outcome、Agent Request、触发来源、结果目标和可选 WorkItem 关联；
- WorkItem、Direct Assignment、Claim Eligibility、Agent Claim 和工作关系；
- Run、Attempt、Execution Lease 和 Discussion Frontier 的共享协调事实；
- Artifact lineage，以及显式 WorkItem 的 Result Submission、Completion Policy 和 Review；
- 共享审计、可靠变化传播和面向读取的投影。

这个 Module 必须足够深：一次含 `@Agent` 的 Message 用例由它原子地完成 Message、所有 per-target Mention Outcome、有效目标的 Agent Request、Agent Inbox Item 和 wake signal；不同目标允许不同 Outcome，但不能缺失结果。Workspace/Conversation 变化、context version、变化流和审计同样原子提交。调用者不能自行编排容易部分成功的浅操作。

内部可以按领域组织实现，但内部 Module 不自动形成远程调用、独立事务或公开 seam。必须同步成立的不变量由同一个权威提交保护。

### 9.2 Local Agent Module

Local Agent Module 在 Owner 设备上把可靠 Agent Request 转换为受控 Runtime 执行。它对 Workspace 隐藏 Runtime 差异、Session、私有上下文、本地凭据、进程生命周期、Project Working Copy 与 Attempt Worktree 的本机路径。

它在内部拥有：

- Device 身份、Workspace 连接和本地持久恢复状态；
- Agent 与 Runtime Binding；
- Agent Request 与 Run Context Snapshot 获取和本地 Context Assembly；
- Project Repository 到 Local Working Copy 的本机映射与校验；
- Workspace scratch directory 或 per-Attempt isolated worktree 的建立、回收与 `cwd` 传递；
- Private Context Grant 的本地执行；
- Runtime 启动、观察、取消和结果收集；
- Workspace Interaction Gateway；
- 本地资源、Credential、工作目录和外部 Tool 的约束；
- 断网期间的有界继续、Local Held Draft、待提交候选结果和恢复。

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

位于 Runtime 与 Local Agent Module 的 Workspace Interaction Gateway 之间。其 Interface 让当前 Runtime 在受控执行上下文中查询共享内容、发布普通 Message、显式创建允许的 Child WorkItem、委派 Agent，并在关联 WorkItem 需要时执行获准的结构化命令，例如 Claim、Block、SubmitResult 或 DecideReview。

CLI、MCP 或 Runtime 原生 Tool 机制可以成为 Adapter。Adapter 不能要求 Runtime 自报 Owner、Workspace、Agent 身份或有效权限；这些事实由 Local Agent Module 绑定并由 Workspace Authority 重新验证。

Runtime Integration seam 与 Workspace Interaction seam 可以共享同一底层传输，但职责不能合并：前者控制 Runtime 执行，后者控制 Runtime 对 Workspace 的行为。

### 10.4 Artifact Editor boundary

Markdown 实时编辑器与普通 File 查看器通过小型类型适配器注册表共享同一个 Artifact Current State / ArtifactSnapshot 领域模型。Workspace 管理内容寻址存储、快照、权限和审计关系；编辑器只处理类型特定交互，不能建立第二套历史或权限状态。当前没有第二种内容存储实现，因此内容存储不提升为外部 seam。

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

Agent 的 Message、Agent Request 后续操作、WorkItem 操作、Artifact 和 Result Submission 由 Agent 署名。审计同时保留 initiated-by、稳定 actor、membership-at-time、owner-at-time、Device、Runtime、Agent Request、Run、Attempt、correlation、causation 和可选 WorkItem。

Owner 关系不能把 Agent 行为改写为 Human 行为。

## 12. 上下文与隐私

### 12.1 共享上下文

Run Context Snapshot 至少包含：

- Agent Request 的稳定触发来源和结果目标；
- 来源为 Message 时，该 Message、其 Discussion Scope 在触发时刻之前的可见内容，以及对应 Discussion Frontier；
- 显式附加或引用的 Conversation、WorkItem、Decision 和 Artifact 版本；
- 执行所需的目标、约束、策略和身份引用。

Run Context Snapshot 保存执行授权与稳定来源版本，不保存完整 Runtime Prompt 或 Conversation 副本。Agent 通过 Workspace Interaction Gateway 主动领取 Discussion Scope 增量并查询更多有权共享内容；这些读取必须可追溯，但不会反向修改 Run Snapshot。

显式来源统一使用 `kind + sourceId + opaque sourceVersion + sourceOrder + contentDigest + typed metadata`。未落地 Authority/Resolver 的预留 kind 必须 fail closed。Workspace schema 分开保存 Policy、Run Context、Inbox Item、Claim Receipt、Private Grant 与 Runtime read audit；不保存 Attempt manifest 或 Addendum delivery。规范见 `docs/design/08-context-and-privacy.md`。

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

- 已成功提交的 Message、Agent Request、Direct Assignment、Agent Claim、Result Submission 和 Review 不能静默丢失；
- 重复提交同一意图不能重复产生逻辑效果；
- 并发认领只能产生一个成功 assignee；
- 旧 Attempt 不能覆盖当前 Attempt 的执行结果；
- 通知丢失不能导致 Agent Request 或 Claimable WorkItem 永久不可发现；
- Local Node 重启后能够恢复待执行 Agent Request、当前执行、未完成 claim receipt 和待提交候选结果；
- Run terminal outcome 与 Message 发布分别持久化，任一方不能伪造或覆盖另一方；
- Agent Message 首次发布与 producing Run terminal 共享一个权威提交顺序：先发布可成立，先 terminal 则拒绝新发布；已提交发布的幂等重放不创建第二条 Message；
- 每个 Inbox claim 都必须幂等且可重放；Run terminal 前不能丢失已经 claim 的 Message；
- Discussion delta 必须提供准确 position 范围；attention 引用不能取代权威 Message 正文；
- 已开始但结果未知的外部副作用进入明确对账状态；
- 权限撤销、Owner 暂停和 Workspace 移除会阻止新的共享操作；
- 无法在线确认权限时，不发起新的外部可见副作用。

幂等记录、事务性事件传播、租约、fencing、Outbox、Checkpoint 和对账是满足这些结果的候选机制，其完整设计进入专题文档。

## 14. 完成与风险治理

普通 Conversation Run 没有 Completion Policy、Result Submission 或 Review。Run 的执行终态和 Agent 发布的普通 Message 均不声明任何显式工作目标已完成。

显式 WorkItem 可以不要求 Review，也可以根据风险选择 Completion Policy：

- manual WorkItem 由授权 Human 显式完成；
- automatic WorkItem 在有效 Current Submission 后运行统一完成检查；
- review-required WorkItem 需要独立 Reviewer 接受 Current Submission；
- Reviewer 可以是授权 Human 或 Agent，但不能是 submitter；确定性 Verifier 留给有真实需求时的未来扩展；
- 未满足条件的结果进入返工、阻塞或取消，而不是伪装成完成。

高风险 Tool 和外部副作用必须经过当前 Workspace Authorization 与 Local Execution Policy。具体 Approval 流程、动作规范化和风险等级属于专题设计。

## 15. 初始部署与分层演进

### 15.1 初始部署

```text
One Workspace Authority deployment
One shared transactional store
Workspace-managed content-addressed Artifact store
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
→ Humans and Agents publish ordinary Messages in the Conversation Timeline
→ a reply to a top-level Message creates a Thread and continues there
→ each @Agent target gets a durable Mention Outcome; valid targets create Agent Requests without WorkItems
→ Agent executes and may publish ordinary Messages back to that exact Timeline or Thread
→ the Run ends independently of whether it published any Message
```

这一层即使功能少，也必须是一个可实际使用的多人多 Agent 产品，而不是只有通用框架但缺少核心协作链。

### 15.3 Layer 2：显式工作管理

在 Conversation 闭环已经可用后，增加 WorkItem、Direct Assignment、Agent Claim、Child WorkItem delegation、Result Submission、Completion Policy 和 Review。所有显式工作执行复用同一 Agent Request / Run 路径，不建立第二套执行状态机。

### 15.4 Layer 3：可靠恢复与风险边界

增加断网恢复、执行租约、防旧执行提交、取消、预算、Owner 暂停、外部副作用审批与故障注入验证。

### 15.5 Layer 4：上下文与生态扩展

增加更多 Runtime Adapter、Workspace Interaction Adapter、Artifact editor adapter、上下文检索、验证器和外部集成。只有真实出现第二种行为实现时才扩展相应 seam。

### 15.6 Layer 5：新的部署形态

在真实需求出现后考虑远程托管执行、团队执行节点、企业设备治理和多节点 Workspace Authority 部署。新增部署形态不得改变 Conversation、Agent Request、可选 WorkItem、Agent Claim、Owner、Run、Attempt、Result Submission 和 Review 的语义。

## 16. 架构验证标准

以下场景按产品层累计生效：Layer 1 MVP 只验收 Conversation、Thread、Agent Request、Run/Attempt 和普通 Message 相关条目；涉及 WorkItem、Claim、Delegation、Submission、Completion Policy 或 Review 的条目从 Layer 2 开始生效。未来条目不会反向成为 MVP 门槛。

任何进入对应产品层的实现至少必须通过以下可观察场景：

1. Conversation 不关联 WorkItem 时仍能独立存在和恢复；
2. Channel 与 DM 风格的参与方式共享同一个 Conversation 模型和执行语义；
3. Conversation 可以只有 Conversation Timeline 而没有 Thread；只有从顶层 Message 展开聚焦回复时才形成 Thread；
4. `@Agent` 的 `requested` Outcome 提交后，即使通知丢失也存在可恢复 Agent Request；`not_requested` Outcome 保留结构化原因，二者都不会隐式创建 WorkItem；
5. 普通 mention 其他 Agent 只形成 Mention Outcome，并仅在有效时创建 Agent Request；只有显式委派才创建 Child WorkItem；
6. Runtime 正常结束且没有发布 Message 时，Run 仍只按执行层 outcome 结束，不产生隐式回复或工作状态；
7. Run 发布的每条普通 Message 都出现在其明确目标 Discussion Scope；每条 Agent-authored Message 必须关联同一 Agent 的唯一 producing Run，Human-authored Message 不得关联 Run；
8. 独立创建 WorkItem 且未选择讨论位置时，Conversation、初始 Message 和 WorkItem 要么全部创建，要么全部失败，Primary Discussion Scope 是新 Conversation Timeline；
9. Conversation 可在没有 pending Agent Request 或 active Run 时归档/恢复；归档保留完整历史并阻止新 Message，WorkItem 完成或取消不删除或归档 Conversation；
10. 无权访问 Primary Discussion Scope 的 Agent 不能被静默分配，也不能通过分配获得隐式可见性；
11. 两个 Agent 可各自基于自己的 Initial Snapshot 执行，并分别按 cursor 接收与自己 scope 相关的 Addenda；任一 Runtime 都不能越权读取另一个 scope；
12. Context Manager 可读取准确增量并让 Runtime 选择 revise、discard、confirm unchanged 或 `no_output`，Initial Snapshot 保持不变；
13. 同一开放任务的并发 Agent Claim 最多一个成功；
14. Device 断线和 Execution Lease 到期不自动清除 Agent Claim；
15. 一个 WorkItem 不会出现两个当前 assignee；
16. Agent-A 可以在授权边界内显式委派 Agent-B，且完整责任链可追溯；
17. 替换 Runtime Adapter 后，Agent 身份、Owner、权限和历史不变；
18. Runtime 无法通过 Tool 参数伪造 Agent、Owner、Workspace 或授权范围；
19. Owner 可以暂停 Agent，但不能删除或改写 Agent 历史行为；
20. 未授予 Private Context Grant 时，团队请求不能读取 Owner 私有上下文；
21. 私有上下文的读取授权不会自动赋予共享发布权；
22. 普通 Run 不产生 Review，且 Runtime 成功或 Message 发布均不能绕过 WorkItem Completion Policy；
23. Artifact 到期清理正文不会改写 Message、Run lineage 和历史版本快照；
24. 离线节点不能产生共享事实或发起未经当前授权的新外部副作用；
25. Web、缓存、实时连接、搜索和 Runtime Session 失效不破坏核心正确性。
26. 从顶层 Message 发布首条 reply 时，Thread、reply 和每目标 Mention Outcome 原子创建；有效目标的 Agent Request 同步创建，无效目标不阻止 reply，Agent 结果写回该 Thread 而不是 Conversation Timeline。
27. 同一 Message 提及多个 Agent 时，每个 distinct target 独立得到 `requested(request)` 或 `not_requested(reason)`；一个无效目标不阻止 Message 和其他有效请求，且任何失败目标都不能被静默遗漏。
28. 所有 Message 读者都能判断每个 Mention Outcome 是否创建了 Request；精确 `not_requested` 治理原因只向当前 Workspace Owner 或目标 Agent 的当前 Owner 披露，其他人只看到由同一权威原因投影的安全概括。
29. `not_requested` 只表示请求从未合法成立；合法成立后的临时不可执行条件属于 pending Request 的派生 `waiting / blocked`，不可恢复的 intake 拒绝属于 Request 的 `rejected`，且都不得改写 Mention Outcome。
30. `not_requested` 原因后来消失不会补建或启动 Request；只有新的显式 Agent Mention 能创建新 Outcome 和 Request，而已有 pending Request 可在临时条件消失后自动重新求值。
31. Agent 发布 Message 时，Workspace 从受信执行凭证绑定 producing Run 并验证该 Run 属于作者 Agent；缺失、终止授权或伪造 Run 的 Agent 写入不能形成 Message，且 Message provenance 不决定 Run outcome。
32. Agent Message 首次发布与 producing Run terminal 并发时，Workspace 只形成一个提交顺序：发布先提交则 Message 保留，terminal 先提交则新发布失败；terminal 后重放 terminal 前已提交的同一意图只返回原结果，不产生重复 Message。
33. Agent 即使拥有某个 Discussion Scope 的发布权，也不能创建新 Conversation 或治理 Workspace/Project Membership；Conversation 创建只接受 active Human scope Member。
34. Conversation creator 后续离开 scope 时，Conversation 与历史保持不变，不触发 owner transfer。Channel 的其他 scope Members 继续访问；DM 保持固定参与者。
35. 新 Human 或 Agent 加入 Workspace 后自动参与全部 Workspace Channel；加入 Project 后自动参与其全部 Project Channel。DM 不提供成员变更。
36. Human 加入 scope 后能读取全部 Channel Timeline 和 Thread；被移除后所有查询、变化流、搜索和缓存投影都拒绝其读取新旧内容，已发布 Message 不删除。
37. Member 被移出 Workspace 后，即使缓存或清理任务滞后，也不能读取原 Channel/DM 或继续相关 Agent 执行；后来重新加入会恢复 scope-derived Channel，但不会恢复固定 DM 或旧执行授权。
38. 同一 Human/Agent 被移除并重新加入时，稳定 actor identity 不变但 Membership 不同；旧 Message 仍归属于该 actor 并可追溯旧 membership-at-time。
39. Agent、Agent Membership、Agent Request、Run 和 Agent-authored Message provenance 必须属于同一 Workspace；任何跨 Workspace Agent 引用、mention、Run 写回或身份迁移都不能形成共享事实。
40. 任一 active Human Member 创建 Agent 时，Agent identity、active `member` Membership 与 creator 作为唯一 Agent Owner 必须全成或全不成；成功创建立即授予 Workspace Channel access，但不产生 Project、DM、私有上下文、凭据或本地资源权限。

## 17. 明确禁止的架构退化

- 用 Message、WebSocket 或 Runtime Session 直接充当任务队列；
- 让 `@Agent` 直接跳过持久 Agent Request 进入 Runtime；
- 从普通 mention 隐式创建、推进或拆分 WorkItem；
- 为 Conversation 请求和显式 WorkItem 建立两套 Run / Attempt 状态机；
- 创建没有 source Message 或 Primary Discussion Scope 的 WorkItem；
- 为每个 Conversation 或 Message 创建伪装成 Thread 的默认消息容器；
- 用 Conversation 全局版本阻塞某个无关 Thread 的 Agent Message 发布；
- 在 Discussion Frontier 已推进后不经复核地盲重试候选 Message；
- 把 WorkItem 与其自动创建的 Conversation 合并为同一生命周期对象；
- 为 Channel 和 DM 建立重复的 Conversation 领域模型；
- 把 Agent Claim 与 Execution Lease 合成一个 `claim` 状态；
- 允许一个 WorkItem 同时存在多个责任 assignee；
- 把 Agent 身份绑定到某个 Runtime、模型或 Device；
- 让 Owner、Host、Agent 和 Runtime 共用身份；
- 让 Owner 因责任关系自动获得超越 Workspace 的权限；
- 让 Runtime 直接写权威事件或自行声明执行权限；
- 让 terminal Run 继续首次发布新 Agent Message，或用独立 `RunWritePermission` 对象制造第二套终止真相；
- 把既有 Discussion Scope 内的 Agent 发布权解释为创建 Conversation 或治理 Workspace/Project Membership 的权力；
- 为 MVP 引入 Conversation Owner、Administrator、所有权转移或 creator 特权，形成与 Workspace 权限并行的治理状态；
- 为 Channel 再建立一套显式参与者表或 add/remove API，使它与 Workspace/Project Membership 产生两套冲突真相；
- 用加入时间、退出时间或 Message 级 ACL 切割 Conversation 历史，使当前成员看到残缺 Thread 或 Agent Request 来源；
- 把异步投影清理或缓存失效当成 Workspace/Project 移除后的安全撤权点；
- 复活已 terminal 的 Workspace Membership，或仅以稳定 Human/Agent identity 作为固定 DM 与执行授权引用；
- 让同一 Agent identity 跨 Workspace 加入、迁移或共享 Owner/权限/历史，或用跨 Workspace Agent 引用形成 mention、Request、Run 或 Message；
- 让 Agent Delegation 退化为不经过 Workspace 的 Runtime-to-Runtime 调用；
- 默认把 Owner 的私人文件、记忆或 Credential 加入团队任务上下文；
- 把 Artifact 内容存储位置当成 Artifact 身份；
- 让 Adapter 决定 Agent Request、WorkItem、权限、Agent Claim 或 Review；
- 为内部数据库、Clock、ID Generator 和每个 Repository 创建系统级公开 seam；
- 为尚未出现的规模问题提前拆分 Workspace Collaboration Module；
- 将当前的 Owner=Host 约束误写成永久身份不变量。

## 18. 后续专题设计

总体架构通过后，按需要逐层形成：

1. Conversation & Work：Conversation Timeline、可选 Thread、Discussion Scope、Message、Agent Request、显式 WorkItem 和工作图；
2. Agent Governance：Owner、Host、Membership、权限、接单和委派策略；
3. Execution Model：Agent Request、Run、Attempt、Execution Lease、取消、恢复和防旧执行；
4. Workspace Interface：命令、查询、变化跟随、幂等、Agent Inbox 和 Discussion Scope pull；
5. Runtime Integration：公共执行语义、能力协商、错误和 Adapter 一致性；
6. Workspace Interaction：CLI/MCP 等 Adapter、Tool 能力和身份绑定；
7. Context & Privacy：Snapshot、Private Context Grant、检索、披露和保留；
8. Artifact & Completion：Artifact/Version、实时草稿、Project 关联、Agent publication、删除保留，以及显式 WorkItem 的 Result Submission、Completion Policy 和 Review；
9. Side Effects & Approval：风险判断、授权、去重、补偿和对账；
10. Storage & Delivery：事务存储、变化传播、投影、备份和恢复；
11. Threat Model：资产、攻击者、信任假设和控制；
12. Human Experience：Web 信息架构、Inbox、Conversation、Work Graph 和 Review。

专题设计可以改变内部实现，但不得改变本文的领域语义和可观察不变量。若新的产品需求要求改变本文，应先更新领域语言和 ADR，再发布新的总体架构版本。
