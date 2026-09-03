# 会议议题一：Artifact 版本管理与 VFS 边界

> 状态：Meeting Discussion Draft
>
> 目标：确定复杂协作中的工作文件与发布成果如何建模，讨论当前单 Artifact 版本模型是否继续扩展，或由 VFS 承担共享文件与版本管理。
>
> 关联材料：[Workspace、Project、Conversation 与 VFS 边界提案](./11-workspace-project-vfs-boundaries.md)、[Workspace Artifacts](./10-artifact-workspace.md)、[ADR-0016](../adr/0016-workspace-governs-artifact-content-and-lineage.md)

## 1. 本次会议要回答的问题

当前 Artifact 以一个 `markdown | file | url` 对象为单位。Markdown/File 各自拥有一个可变 Current State 和零到多个不可变 Snapshot，能够支撑单份文档或单个文件的编辑、保存历史、引用和交付。

需要讨论的是：

> 当一次 Human-Agent 或多 Agent 协作的工作对象变成目录、多文件、素材、代码、数据和中间稿的组合时，Artifact 是否仍然应该承担工作区和版本管理，还是应引入 VFS，由 Artifact 只表达正式发布的成果？

这不是“是否给 Artifact 增加文件夹 UI”的问题，而是版本单位、并发单位和交付单位是否仍然相同。

## 2. 当前设计基线

当前模型是：

```text
Artifact
├── stable Workspace identity
├── type: markdown | file | url
├── Current State 0..1
├── Snapshot 0..N
├── Message Reference 0..N
├── Project Association 0..N
└── active | deleted | purged
```

主要规则：

- Markdown/File 只有一个当前内容状态；
- 编辑或替换 Current State 不自动形成永久历史；
- Human 保存历史、Message 引用或 Agent 固定上下文时才创建或复用 Snapshot；
- Snapshot 固定单份内容及其 digest，不表达目录级原子状态；
- Agent 更新通过 base state hash、Local held draft 和 freshness review 避免覆盖；
- Artifact 没有目录、分支、合并、移动、重命名和多文件原子提交；
- Artifact 文件树、快照分支和自动合并目前被列为非目标。

因此，当前 Artifact 更接近“具有 Current State 和发布历史的单个协作对象”，不是共享文件系统。

## 3. 单 Artifact 模型遇到的复杂协作场景

### 3.1 一个成果由多个文件共同组成

例如一份 PPT 交付可能同时依赖：

```text
launch-deck/
├── deck.pptx
├── data/
│   └── metrics.xlsx
├── assets/
│   ├── architecture.svg
│   └── cover.png
├── sources/
│   └── references.md
└── review/
    └── comments.md
```

如果每个文件都是独立 Artifact，就缺少“这些文件在同一版本上共同构成一次交付”的目录级提交。如果整个目录被打包成一个 File Artifact，则失去文件级编辑、引用、diff 和并发能力。

### 3.2 多 Agent 并行修改

Builder、Reviewer 和 Data Agent 可能分别修改不同文件，也可能修改同一主文件。当前单 Artifact CAS 可以拒绝陈旧覆盖，但不能直接表达：

- 基于同一个目录快照派生多个工作分支；
- 比较两组多文件变化；
- 合并无冲突文件；
- 对冲突文件请求 Human 决策；
- 把一次合并结果作为新的目录级版本。

### 3.3 中间工作状态与正式交付混在一起

Agent 需要保存草稿、缓存、素材和临时分析，但这些内容不一定都值得成为 Artifact。若全部发布为 Artifact，会导致：

- Artifact 列表被中间文件淹没；
- 用户无法区分工作文件和交付物；
- 每个临时文件都被迫获得独立 identity、权限和删除生命周期；
- 多文件之间的结构关系只能依赖名称约定。

### 3.4 历史版本继续编辑

当前 Snapshot 是不可变引用。如果用户从历史 Snapshot 继续修改，需要明确它是：

- 覆盖当前 Artifact；
- 创建 Artifact copy；
- 创建 branch；
- 在同一个多文件工作区中创建新的 revision lineage。

单文件 Snapshot 不能独立回答该选择，更无法处理历史目录状态。

## 4. 需要先区分的三个概念

| 概念 | 作用 | 典型操作 |
| --- | --- | --- |
| Working File | 持续变化的工作状态 | 读写、重命名、移动、删除 |
| Workspace Revision | 一组文件在某个时刻的一致状态 | snapshot、branch、compare、merge |
| Artifact | 被命名、发布、引用、评审和交付的成果 | publish、review、reference、deliver |

当前模型主要把 Working File 和 Artifact 合并在一个对象中。复杂协作需要讨论这三者是否继续合并。

## 5. 可选模型

### 方案 A：继续增强 Artifact

把 Artifact 扩展为可以包含目录和多个子文件的复合对象：

```text
Artifact
├── Artifact Entry 0..N
│   ├── directory
│   └── file + blob
├── Current Tree
├── Tree Snapshot 0..N
└── optional branch / merge
```

优点：

- 保留当前 Artifact 作为统一用户概念；
- Message、Review 和 Project Association 仍然只引用 Artifact；
- 对单文件用户不需要引入新的顶层对象。

需要承担的复杂度：

- Artifact 将同时成为文件系统、版本库和交付物；
- 临时文件与正式成果仍然共享同一 identity/lifecycle；
- 目录、文件、分支和合并能力会持续膨胀 Artifact 领域；
- Repository、Working Copy 与复合 Artifact 的关系仍需另行解释。

### 方案 B：引入 VFS，Artifact 成为发布对象

VFS 承载共享文件、目录和工作版本，Artifact 由一个固定 VFS revision 发布：

```text
VFS Tree
├── working files
├── directory revisions
├── session branches/workspaces
└── repository mounts
        ↓ publish
Artifact
├── stable publication identity
├── source node/path
├── source revision
├── producing Session
└── review/delivery lineage
```

优点：

- 工作状态和发布成果分离；
- 多文件可以作为一个一致 revision 管理；
- Session 可以获得隔离文件视图；
- Artifact 列表只保留有交付意义的对象；
- Repository 可以成为 VFS 的一种 mount，而不是 Artifact 特例。

需要承担的复杂度：

- 新增 VFS identity、path、revision、permission 和 materialization 模型；
- Artifact 与 VFS revision 的引用、保留和删除规则必须确定；
- 当前 Artifact Current State、Yjs draft 和 File replace 需要重新定位；
- 需要定义 VFS revision 与 Git commit 的关系。

### 方案 C：Artifact 直接成为 VFS Node

不再维护独立 Artifact 内容，而是给某个 VFS file/directory 增加 `published` metadata：

```text
VFS Node
├── working revisions
└── Publication 0..N
```

优点：

- 文件只有一套内容和版本来源；
- 从工作文件发布的链路最短；
- 不需要复制内容。

需要承担的复杂度：

- 工作文件 rename/move/delete 是否改变 Artifact identity；
- 同一文件的多次发布是一个 Artifact 还是多个 Publication；
- URL、外部交付物和跨 Project 共享难以完全等同于 VFS Node；
- Artifact 的权限、审计和产品入口可能被文件系统语义吞没。

## 6. 方案比较

| 维度 | A：增强 Artifact | B：VFS + Artifact publication | C：Artifact 是 VFS Node |
| --- | --- | --- | --- |
| 单文件兼容性 | 高 | 高 | 中 |
| 多文件原子版本 | 需要在 Artifact 内新增 | VFS 原生承担 | VFS 原生承担 |
| 工作状态与交付分离 | 弱 | 强 | 中 |
| 分支与合并归属 | Artifact | VFS | VFS |
| Repository 对接 | 额外适配 | 作为 mount | 作为 mount |
| Artifact identity 稳定性 | 高 | 高 | 依赖 node/path 设计 |
| URL Artifact 兼容性 | 高 | 可保留独立类型 | 较弱 |
| 领域复杂度位置 | Artifact 膨胀 | 新增 VFS 层 | VFS 与发布语义耦合 |

## 7. 无论选择哪种方案都必须回答的版本问题

1. **版本单位**：一个文件、一个目录树，还是一次交付集合？
2. **当前状态**：是否永远只有一个 Current State？
3. **分支**：历史版本继续编辑是 copy、branch 还是替换 current？
4. **合并**：系统只做冲突检测，还是支持结构化 merge？
5. **原子性**：多个文件如何在同一版本中共同提交？
6. **并发性**：两个 Agent 修改不同文件时是否可以自动合并？
7. **身份**：rename、move 或重新发布是否改变 Artifact identity？
8. **保留策略**：Artifact 删除后，其来源 revision 是否必须永久保留？
9. **引用稳定性**：Message 和 Review 固定 Artifact revision 还是 VFS revision？
10. **外部版本**：Git commit、Office 内部修订和 VFS revision 谁是权威？

## 8. 会议验收场景

最终方案至少应能明确解释以下场景：

### 场景一：Builder 与 Reviewer 协作 PPT

Builder 修改 PPT 和图表素材，Reviewer 从 Builder 的固定版本继续修改。系统必须能说明 Reviewer 创建的是新 Artifact、Artifact child revision、VFS branch 还是其他对象，以及最终 lineage 如何展示。

### 场景二：多个 Agent 修改同一项目目录

Agent-A 修改 `report.md`，Agent-B 修改 `data.csv`。两者基于同一 baseline 并行执行，系统必须说明是否能够合并、合并的原子单位及冲突处理方式。

### 场景三：从历史版本继续工作

用户打开三天前的版本并要求 Agent 修改。系统必须保证当前版本不被静默覆盖，并能显示新版本从哪个历史状态派生。

### 场景四：工作文件不作为交付物

Agent 生成十个中间文件，最终只发布一份报告。系统必须说明哪些内容进入共享工作区，哪些成为 Artifact，哪些可被清理。

## 9. 本次会议需要形成的决策

- [ ] Artifact 是工作文件、发布成果，还是两者兼有；
- [ ] 是否正式引入 VFS；
- [ ] 版本单位是 file 还是 tree revision；
- [ ] 是否需要 branch/fork/merge；
- [ ] Artifact 与 VFS revision 的 identity 和保留关系；
- [ ] Markdown Yjs Current State 应留在 Artifact 还是迁入 VFS；
- [ ] File/URL Artifact 如何进入新模型；
- [ ] 第一版最小端到端场景和明确非目标。

## 10. 决策记录模板

```text
Decision:

Artifact definition:

VFS decision:

Version unit:

Branch/merge rule:

Artifact ↔ VFS relationship:

Migration impact:

MVP scope:

Deferred questions:
```
