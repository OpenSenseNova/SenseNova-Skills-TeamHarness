# ADR-0044：Project 是可选协作范围，Repository 不是成立条件

- 状态：Accepted
- 日期：2026-08-19

## Context

Workspace 既要支持跨项目讨论，也要支持围绕一个持续目标形成独立成员、Conversation 和共享资料。把 Project 等同于 Git Repository 会排除研究、产品、运营和尚未进入代码阶段的协作；把 Repository 当作本机目录又会泄露 Local Custody，并让同一 Project 无法跨 Computer 使用。

Project Membership、Artifact 所有权和 Repository 执行准入回答的是不同问题，不能合并成一个隐式权限或所有权关系。

## Decision

1. `Workspace → Conversation` 与 `Workspace → Project → Channel` 都是正式路径，共用唯一的 Conversation、Message、Agent Request、Run 和 Attempt 模型。DM 只属于 Workspace，不是 Project 子资源；Conversation scope 创建后不可移动。
2. 任一 active Human Workspace Member 可以只用名称创建 Project；description 与 Primary Repository 都可选。创建必须原子建立 Project 和 creator 的首个 Human `manager` Project Membership。
3. Project Membership 只能引用同 Workspace 的 active Membership。Human 为 `manager | member`，Agent 固定为 `member`；任何路径都不能消除最后一位 active Human Manager。所有 active Project Membership 都自动参与该 Project 的全部 Channel，角色只决定 Project 管理能力。
4. 一个 Project 同时最多有一个 active Primary Repository。Manager 可以挂载 Repository、更新默认分支或解除关联；Repository identity 不可原地修改，更换必须先解除再挂载。解除只改变当前资源，历史记录继续支撑既有 Run provenance；存在 active Attempt 时拒绝解除。
5. 有 Primary Repository 的新 Project Run 必须固定匹配 Working Copy，并在独立 Attempt Worktree 中执行；没有 Primary Repository 的新 Project Run 使用隔离 scratch workdir。已经接受的 Run 始终按其快照中的 Repository 基线执行。
6. Resource Link 是 Project 下的轻量外部资料，仅接受 `http/https` URL。active Human Project Member 可创建，creator 或 Project Manager 可修改、删除。Resource Link 没有版本、上传、Agent lineage 或 Artifact 语义。
7. Artifact 是 Workspace 级对象，通过显式多对多关联出现在一个或多个 Project 中。关联不复制内容、不转移所有权，并默认展示 Artifact 当前状态；Message、Run provenance 与 Context Source 仍固定具体 ArtifactSnapshot UUID。
8. Project 页面是协作概览，分别呈现成员、Conversation、Artifacts、Resource Links 和可选 Repository，不再把 Repository 当作 Project 的唯一内容或空状态。

## Consequences

- 不保留“Project 必须有 Repository”的创建合同或 Repository-anchored 产品文案。
- 同一 Project 可以从 scratch 协作开始，后来挂载 Repository；解除后未来 Run 回到 scratch，历史 Repository Run 仍可解释。
- Local Working Copy 的绝对路径、凭据和未提交内容仍留在 Local Computer；Workspace 只保存安全 Repository identity 与执行 provenance。
- Project invitation、delete/archive、Conversation 跨 scope move、多 active Repository 和任意本地目录仍不在当前范围。
