# 会议议题三：Conversation 是普通群聊还是话题群，以及 Topic 与 WorkItem 的关系

> 状态：Decision Implemented
>
> 目标：决定 Conversation 的产品形态，明确 Timeline、Thread、Topic 与 WorkItem 的关系，避免把团队讨论、Agent 执行和工作状态混成同一个对象。
>
> 关联材料：[Conversation and Work](./02-conversation-and-work.md)、[Workspace、Project、Conversation 与 VFS 边界提案](./11-workspace-project-vfs-boundaries.md)、[ADR-0019](../adr/0019-conversation-unifies-channel-and-dm.md)、[ADR-0020](../adr/0020-discussion-scopes-distinguish-timelines-from-threads.md)

## 0. 已实施决策

- Conversation 采用普通长期群聊，不新增 Topic 层。
- Workspace 自动拥有且只拥有一个全员大群；Workspace 另有一对一 DM。
- Project 自动创建全员主群，并允许 Project Human 创建多个显式成员长期群聊。
- WorkItem 是 Project 对象，使用独立 `WorkItemComment`，不再创建专用 Conversation、Topic 或隐藏群聊。
- Project 内所有 Human 和已加入 Project 的 Agent 可读取 WorkItem 与评论；只有分配、`@mention` 或明确触发才唤醒 Agent。
- Conversation、WorkItem 和 Agent Session 的生命周期保持分离；Agent Session 已按 Mention `agentRequestId` 与 WorkItem `workItemId` 实现隔离，Runtime 仅作为可丢弃 cache。

以下方案比较保留为决策过程记录；与上述结论冲突的“当前设计基线”描述已经失效。

## 1. 本次会议要回答的问题

Conversation 可以有两种不同的产品理解：

1. **普通群聊**：所有成员在一个连续 Timeline 中交流，需要时从某条 Message 展开 Thread；
2. **话题群**：Conversation 是稳定群容器，具体讨论必须或通常发生在一个有标题、状态和上下文边界的 Topic 中。

如果采用话题群，还需要进一步决定：

> Topic 是单纯讨论分支，还是应与 WorkItem 建立一对一、一对多或可选关系？

## 2. 当前设计基线

当前模型是：

```text
Conversation
├── Conversation Timeline
│   ├── top-level Message 0..N
│   └── Thread 0..N
│       ├── root top-level Message 1
│       └── reply Message 1..N
└── membership / visibility policy
```

Thread 当前具有以下语义：

- 由某条 top-level Message 的第一次回复原子创建；
- 没有空 Thread；
- 继承 Conversation audience 和权限；
- 没有独立名称、成员、owner、archive 或 lifecycle；
- 是一个独立 Discussion Scope，拥有自己的 frontier；
- Agent 结果和 WorkItem discussion 可以发布到 Timeline 或 Thread。

当前 WorkItem 具有 immutable description、Project 内不可变 taskNumber、可选 source Message 和独立 WorkItemComment 流。WorkItem 不创建专用 Conversation 或 Topic；需要进入讨论时通过 source Message 和显式引用回到现有 Conversation。

因此历史设计曾同时存在三种工作讨论方式；当前实现收敛为前两种，WorkItem 只保留独立评论流：

```text
普通 Conversation Timeline
Conversation 中的 Thread
WorkItem 专用 Conversation
```

这三种入口的产品边界尚未完全统一。

## 3. 普通群聊模型

普通群聊下，Conversation 本身就是主要阅读和发言界面：

```text
Project Conversation
├── Message
├── Message
├── Message → optional Thread
└── Message
```

### 优点

- 用户无需先创建或选择 Topic；
- 适合轻量沟通、临时问题和连续讨论；
- 群聊心智成熟，消息发送成本低；
- 当前 Timeline + Thread 实现可以继续复用。

### 风险

- 多件事情混在一个 Timeline 中；
- Agent 不容易判断本次请求的上下文边界；
- WorkItem 与讨论只能依赖 Message/Thread 引用；
- 长期项目群会产生很大的上下文和检索噪声；
- 同一个 WorkItem 的消息可能散落在 Timeline 和多个 Thread 中。

## 4. 话题群模型

话题群下，Conversation 是成员稳定的群容器，Topic 是具体讨论范围：

```text
Conversation
├── General Topic
├── Topic: 登录故障排查
├── Topic: VFS 方案设计
└── Topic: V1 发布检查
```

Topic 可以成为一等对象：

```text
Topic
├── title
├── description / goal 0..1
├── status: active | closed | archived
├── root Message 0..1
├── Message 0..N
├── WorkItem binding 0..N
├── VFS/Artifact references 0..N
└── own discussion frontier
```

### 优点

- 每段讨论有稳定名称和边界；
- Agent 可以按 Topic 拉取上下文，而不是读取整个群；
- Topic 可以承载文件、Artifact、Session 和 WorkItem 导航；
- 多个长期事项在同一个成员群中仍然可分开推进；
- Topic 比“为每项工作创建新 Conversation”更轻。

### 风险

- 发消息前可能多一步选择 Topic；
- General、临时消息和 Topic 创建规则需要设计；
- Topic 与现有 Thread 是否重复；
- Topic close/archive 与 WorkItem completed/cancelled 可能被误认为同一状态；
- Topic 数量过多时仍然需要搜索、归档和排序。

## 5. Topic 与现有 Thread 的关系

会议需要先决定 Topic 是什么：

### 方案 T1：Topic 只是 Thread 的产品重命名

保留当前 Thread 结构，只增加标题和更明显的入口。

问题：当前 Thread 必须从 top-level Message 的回复产生，没有独立 lifecycle，也不能在没有 root Message 时预先创建。

### 方案 T2：Topic 是增强后的 Thread

在现有 Discussion Scope 基础上增加：

- title / description；
- active/closed/archived；
- 显式创建；
- WorkItem binding；
- Agent context summary；
- 排序、关注和未读状态。

这样可以复用消息和 frontier 模型，但会修改当前“Thread 没有独立 lifecycle”的决策。

### 方案 T3：Topic 与 Thread 并存

Topic 是长期讨论容器，Topic 内仍可从 Message 创建 Thread：

```text
Conversation
└── Topic
    ├── Message
    └── Message → Thread
```

这种层级表达力最强，但会增加导航、权限、上下文和存储复杂度。需要证明嵌套 Thread 是真实产品需求，而不是预先设计。

## 6. Topic 与 WorkItem 的可选绑定模型

### 模型 W1：Topic 与 WorkItem 完全独立

```text
Topic 0..N ← references → WorkItem 0..N
```

Topic 管讨论，WorkItem 管责任和状态，双方只通过普通引用连接。

优点：最灵活；讨论不必任务化。

风险：一个 WorkItem 的主要讨论位置不明确，Agent 和用户需要自行判断。

### 模型 W2：Topic 可选绑定一个 WorkItem

```text
Topic 0..1 ── WorkItem
WorkItem 1 ── Primary Topic
```

普通 Topic 可以没有 WorkItem；一旦某个话题需要负责人、状态或交付，就创建并绑定 WorkItem。

优点：保留自然讨论，同时为结构化工作提供唯一主位置。

风险：需要定义先有 Topic 还是先有 WorkItem，以及解绑、取消和重新关联规则。

### 模型 W3：每个 WorkItem 必须拥有一个 Topic

```text
WorkItem 1 ── 1 Topic
```

创建 WorkItem 时复用现有 Topic，或原子创建 Topic、source Message 和 WorkItem。

优点：每项工作都有稳定讨论上下文，Agent Context 最容易确定。

风险：大量小 WorkItem 会产生大量 Topic；简单任务被迫拥有完整讨论空间。

### 模型 W4：一个 Topic 可以组织多个 WorkItem

```text
Topic 1 ── 0..N WorkItem
WorkItem 1 ── 1 Primary Topic
```

适合一个长期话题下拆分多项工作，例如“V1 发布”Topic 下包含测试、文档、部署三个 WorkItem。

优点：讨论和任务拆分层次自然。

风险：Topic 的整体状态不能由多个 WorkItem 简单推导，Agent 发布结果时需要明确目标 WorkItem。

## 7. 绑定不等于生命周期合并

无论采用哪种绑定，都应继续保持讨论事实与工作事实独立：

```text
Topic status
= 这段讨论是否仍然活跃、关闭或归档

WorkItem lifecycle
= 这项责任是否 open、blocked、completed 或 cancelled
```

因此不能从自然语言或 Topic 操作隐式改变 WorkItem：

- 在 Topic 中说“完成了”不会自动 complete WorkItem；
- WorkItem completed 不必自动 archive Topic；
- Topic closed 不等于 WorkItem cancelled；
- WorkItem blocked 不阻止 Topic 继续讨论；
- 结果 Message 不自动成为 Result Submission。

如果需要联动，应当是显式命令或产品提示，而不是共享状态机。

## 8. Agent 上下文与 Session 的影响

普通群聊和话题群对 Agent 的上下文模型影响很大。

### 普通群聊

Agent 被 @ 时可能需要从整个 Timeline、当前 Thread 或上次处理位置中选择上下文。随着群聊变长，必须依赖检索、摘要和 context selection。

### 话题群

Agent Request 可以固定 Topic frontier：

```text
Agent Request
├── Conversation ID
├── Topic ID
├── Topic frontier
├── bound WorkItem 0..1
├── Project/VFS context 0..1
└── target Agent
```

这样 Session 的默认消息上下文更清晰，但 Topic 仍不能代替一次执行 Session；同一 Topic 可以产生多次 Agent Request 和多个 Session。

## 9. 产品形态的可选组合

| 组合 | Conversation | Topic/Thread | WorkItem |
| --- | --- | --- | --- |
| C1 普通群聊 | 主要消息流 | 可选 Thread | 引用 Timeline/Thread |
| C2 普通群聊 + 工作 Topic | 保留 General Timeline | 需要时显式创建 Topic | 可选绑定 Topic |
| C3 话题群 | 成员与 Topic 容器 | 每段主要讨论在 Topic | WorkItem 必须或可选绑定 |
| C4 WorkItem-centric | 只保留导航和通用消息 | 每个 WorkItem 一个 Topic | WorkItem 是主要入口 |

## 10. 会议验收场景

### 场景一：临时问题

成员问“测试环境地址是什么”。系统是否要求创建 Topic 或 WorkItem？回答后如何避免产生无意义的长期对象？

### 场景二：长期技术讨论但没有负责人

团队持续讨论 VFS 方案，暂时没有明确交付和 assignee。Topic 是否可以独立存在？

### 场景三：从讨论形成工作

某个 Topic 讨论后决定由 Agent-A 完成实现。系统如何从 Topic 创建 WorkItem，并固定 source、description 和 Primary Discussion Scope？

### 场景四：一个话题拆成多个 WorkItem

“V1 发布”需要测试、部署和文档三个负责人。系统使用一个 Topic + 三个 WorkItem，还是三个 Topic？

### 场景五：一个 WorkItem 的要求发生重大变化

现有设计要求 materially changed requirement 创建新 Message 和新 WorkItem。新 WorkItem 是否复用原 Topic、创建 Child Topic，还是创建全新 Topic？

### 场景六：Agent 在群中被连续请求

同一 Conversation 中两个 Topic 同时 @Agent。系统必须说明 Agent Inbox、Session、上下文 frontier 和回复位置如何区分。

## 11. 本次会议需要形成的决策

- [x] Conversation 默认是普通长期群聊；
- [x] 保留普通 Timeline 与现有 Thread，不引入 Topic；
- [x] Topic 不作为 Thread 重命名、增强层或独立层；
- [x] WorkItem 使用独立评论区，不绑定 Topic；
- [x] Conversation 与 WorkItem 生命周期不联动；
- [x] Agent Request 仍固定现有 Conversation/Thread Discussion Scope；
- [x] WorkItem 与 Project 绑定，不从 Conversation 或 Topic 继承 Project/VFS；
- [x] standalone WorkItem 不创建专用 Conversation。
- [ ] Agent Session 默认 scope 另案讨论，不在本轮结论内。

## 12. 决策记录模板

```text
Decision:

Conversation product shape:

General Timeline:

Topic definition:

Topic ↔ Thread relationship:

Topic ↔ WorkItem cardinality:

Lifecycle coupling rule:

Agent context scope:

Standalone WorkItem behavior:

MVP scope:

Deferred questions:
```
