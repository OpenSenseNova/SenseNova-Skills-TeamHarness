# Project、共享资源与本地执行

> 状态：Implemented
>
> 设计版本：1.1.0
>
> 决策基线：ADR-0044、ADR-0016

## 1. 产品定义

Project 是 Workspace 内私有的文件、工作和项目协作边界。它聚合 Project Membership、一个自动主群、多个固定群聊、WorkItem、项目资源和 Workspace Artifact Association。Repository、Working Copy 和 VFS 执行层不属于当前 MVP。

```text
Workspace
├── Workspace General 1
├── Direct Message 0..N
├── Artifact 0..N
│   └── Project Association 0..N
└── Project
    ├── Project Membership
    ├── Main Group 1
    ├── Explicit Group 0..N
    ├── WorkItem 0..N
    │   └── WorkItem Comment 0..N
    └── Artifact Association 0..N
```

Project 名称、本机目录名和 Local Computer 工作目录互不等价；所有关系使用稳定 ID。Project Group 使用普通 Conversation Timeline、Thread、Message、Mention Outcome 和 Agent Request；DM 只属于 Workspace。WorkItem Comment 是独立语义，不复用 Message 或隐藏 Conversation。

## 2. Project 与 Membership

`POST /v1/workspaces/{workspaceId}/projects` 只要求 `name`，`description` 可选。事务原子建立 Project、creator 的唯一 active Human `owner` Membership 和一个 `project_all` 主群。

Project Membership 引用同 Workspace 的 active Membership，并形成不可复活的独立参与期：Human 为 `owner | manager | member`，Agent 固定为 `member`。Project 始终恰有一位 active Human Owner，Owner 可任命多个 Manager；Owner 离开前必须转让所有权。Owner 与 Manager 可邀请或移除 Human；只有 Owner/Manager 能把自己拥有的 Agent 带入 Project，并记录 sponsor。Manager 被降级或离开时，其带入的 Agent 级联退出。任一 Owner/Manager 可移除项目 Agent，Agent Owner 也可主动撤回。

主群中的 Human 参与者由 active Project Human Membership 派生；Agent 不会因加入 Project 自动进入主群或任何其他群，必须由 Agent Owner 逐群授权。任意 Project Human 可以创建显式成员长期群聊并选择 Project Human；群创建者和 Project Owner/Manager 管理 Human 成员。普通 Project 对非成员不可发现；Workspace Owner 只看到成员数、群聊数等治理元数据，不能读取成员目录、消息、文件或 WorkItem，异常时可据此恢复指定新的 Project Owner。Project 不创建或展示 DM。

## 3. 本地执行边界

Project 不要求 Repository，也不在 Workspace Authority 保存 clone source、checkout 路径、credential 或未提交内容。当前版本的 Project/Workspace Run 使用 Local Computer 上按 Attempt 隔离的 scratch workdir；Local Computer 负责路径、清理和 Runtime `cwd`，服务端只保存安全的执行 provenance。

Project 和其成员、资源、WorkItem 写入均使用各自的 revision/CAS；当前没有 Repository revision。

## 4. Project Artifact Association

Artifact 拥有 Workspace 级稳定 identity。`artifact_project_associations` 是显式多对多关系，一个 Artifact 可关联多个 Project；关联不复制 Artifact、不改变 creator，也不把 Project Manager 变成 Artifact 删除者。

外部资料使用 `url` Artifact。创建时可在 `projectIds` 中包含当前 Project；原“添加外部链接”交互直接调用 URL Artifact 创建 API，不存在 Project 专用链接实体。URL 与 Markdown/File 一样出现在统一项目资源目录中。

active Project Member 可创建带当前 Project Association 的 Artifact，或把有权读取的 active Artifact 关联进 Project。Project Manager 或 Workspace Owner 可解除关联；删除 Artifact 仍只允许 Artifact creator 或 Workspace Owner。删除后的关联保留至 7 天到期，因此恢复后重新可见；到期封存或清理时移除关联。

## 5. Run 执行范围

Run Context Snapshot 在接受 Agent Request 时固定 Project 与权限上下文；Attempt 使用 Local Computer 创建的隔离 `workspace_scratch` workdir。Runtime 写盘只是本地执行效果，只有 Message 或 Artifact publication 的显式提交才能成为共享事实。

## 6. WorkItem 与 Agent 唤醒

WorkItem 是 Project 级对象，所有 Project Human 和已加入 Project 的 Agent都可以读取其目标与独立评论。任务既可以由 Human 直接在看板创建，也可以从 Project Conversation 的某条 Message 创建；对话入口只保存来源 Conversation、Message、Thread 引用，不复用 Message 或创建隐藏 Conversation。读取资格不表示自动执行；只有分配、评论中的显式 `@mention` 或明确触发才写入 Agent attention。Result Submission 精确引用同一 Agent 发布的 WorkItem Comment，不引用 Conversation Message。

## 7. Web 信息架构

左侧保留一级“项目”入口，但不再使用“项目目录页 → 点击进入项目”的额外导航层。Project 直接作为文件夹节点展开或折叠，多个节点可同时展开；当前路由 Project 自动展开，并按 Workspace 记住本地状态。每个节点的二级入口只显示主群、其他固定群聊和“设置”。创建 Project 后直接展开并进入主群，群聊按 Project 独立懒加载；桌面侧栏和移动端 Drawer 使用同一棵树。

“设置”进入 Project 管理页，承载资料、Project Artifact、WorkItem 和成员管理入口，不提供 Primary Repository 管理卡。“项目资源”按更新时间倒序统一渲染当前 Project 的 Artifact。Human 不在添加前选择 Markdown、File 或 URL：

- 上传任意支持的内容，在同一事务中创建归属于当前 Project 的 Artifact；
- 内容格式只决定打开后的展示与可用操作，不产生额外的创建入口。

Project 资源页不查询 Workspace Artifact 候选，不提供“加入已有 Artifact”或“移出项目”动作。

Project 设置页不重复显示右侧 Artifacts 面板，Project Conversation 和 Artifact 页面继续保留。Project Run 使用 Local Computer 隔离 scratch，Conversation 和 Artifact 不依赖本机目录。

## 8. 验收要求

- 只用名称即可创建 Project、Owner Membership 和主群；创建后侧栏直接展开并进入主群。
- 多个 Project 可同时展开，Project 行本身不打开项目首页，群聊独立懒加载，“设置”是二级入口。
- Human/Agent Project participation、Manager sponsor 级联回收、Agent 逐群授权和 Workspace Owner 治理元数据读取符合权限边界。
- WorkItem 评论不创建 Conversation，读取不广播唤醒，分配/`@mention` 才触发 Agent attention。
- Project Run 使用 Local Computer 隔离 scratch，服务端不接收本机绝对路径或 Git 凭据。
- Runtime 文件写入不会自动成为共享 Artifact，发布必须经过 Workspace Authority。
- URL Artifact 只接受 `http/https`，可关联多个 Project，且不产生 Current State 或 Snapshot。
- Project Manager 可以解除 Artifact Association，但不能据此修改或删除 Workspace Artifact。
- API、OpenAPI、Web、Local Computer、变化流、审计和自动化测试使用同一 Artifact 语义。
