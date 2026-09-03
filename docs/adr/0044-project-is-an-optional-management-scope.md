# ADR-0044：Project 是可选协作范围，Repository 不是成立条件

- 状态：Accepted
- 日期：2026-08-19

## Context

Workspace 既要支持跨项目讨论，也要支持围绕一个持续目标形成独立成员、Conversation 和共享资料。把 Project 等同于 Git Repository 会排除研究、产品、运营和尚未进入代码阶段的协作；把 Repository 当作本机目录又会泄露 Local Custody，并让同一 Project 无法跨 Computer 使用。

Project Membership、Artifact 所有权和 Repository 执行准入回答的是不同问题，不能合并成一个隐式权限或所有权关系。

## Decision

1. `Workspace → Conversation` 与 `Workspace → Project → Channel` 都是正式路径，共用唯一的 Conversation、Message、Agent Request、Run 和 Attempt 模型。DM 只属于 Workspace，不是 Project 子资源；Conversation scope 创建后不可移动。
2. 任一 active Human Workspace Member 可以只用名称创建 Project；description 可选。创建必须原子建立 Project 和 creator 的首个 Human `owner` Project Membership。
3. Project Membership 只能引用同 Workspace 的 active Membership。Human 为 `owner | manager | member`，Agent 固定为 `member`；任何路径都不能消除最后一位 active Human Owner。所有 active Project Membership 都自动参与该 Project 的 public Channel，private Channel 使用显式 audience，角色只决定 Project 管理能力。
4. Project 不要求 Repository、Working Copy 或本机目录；Agent 执行使用 Local Computer 上按 Attempt 隔离的 scratch workdir，路径和凭据不进入 Workspace Authority。
5. WorkItem 是独立的 Project 工作对象，支持 Human 创建、分配/重新分配、阻塞/解除阻塞、评论、Agent Result Submission，以及 Human 完成/取消；开放认领、委派、Review 和 Completion Policy 延后。
6. 外部资料统一使用 Workspace URL Artifact，并通过显式 Project Association 出现在一个或多个 Project 中。URL 只接受 `http/https`，locator 创建后不可修改；它没有 Current State、Snapshot 或上传语义，但与 Markdown/File 共用 Artifact identity、权限、Agent lineage、消息引用和删除生命周期。
7. Artifact Association 不复制内容、不转移所有权。Project Manager 可以解除 Association，但不能据此修改或删除 Workspace Artifact。Markdown/File 的 Message 与 Run 引用固定 Snapshot；URL 引用固定发送时 locator 和展示 metadata。
8. Project 页面统一呈现成员、Conversation、WorkItem、Artifacts 和项目资源；Repository、Working Copy 与旧版 Project Repository API 不属于当前 MVP。

## Consequences

- 不保留“Project 必须有 Repository”的创建合同或 Repository-anchored 产品文案。
- Project 从 scratch 协作开始；当前版本不提供 Repository 挂载、Working Copy 或 Git worktree 能力。
- Local Computer 的绝对路径、凭据和未提交内容始终留在本机，不进入 Workspace Authority。
- Project 级加入流程、delete/archive、Conversation 跨 scope move、多 active Repository 和任意本地目录仍不在当前范围。
