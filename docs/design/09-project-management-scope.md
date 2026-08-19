# Project、共享资源与本地执行

> 状态：Implemented
>
> 设计版本：1.0.0
>
> 决策基线：ADR-0044

## 1. 产品定义

Project 是 Workspace 内可选的协作范围。它聚合一组 Project Membership、Project Conversation、Artifact 关联、Resource Link，以及零或一个当前 Primary Repository。Repository 不是 Project 的身份或成立条件。

```text
Workspace
├── Conversation
├── Artifact
└── Project
    ├── Project Membership
    ├── Project Conversation
    ├── Artifact Association 0..N
    ├── Resource Link 0..N
    └── active Primary Repository 0..1
```

Project 名称、Repository identity、本机目录名互不等价；所有关系使用稳定 ID。Workspace Conversation 与 Project Channel 共用同一套 Timeline、Thread、Message、Mention Outcome、Agent Request、Run 与 Attempt；DM 只属于 Workspace，不进入 Project。

## 2. Project 与 Membership

`POST /v1/workspaces/{workspaceId}/projects` 只要求 `name`，`description` 与 `repository` 均可选。事务原子建立 Project 与 creator 的首个 active Human Manager Membership；提供 Repository 时，同一事务额外建立 active Primary Repository。

Project Membership 引用同 Workspace 的 active Membership，并形成不可复活的独立参与期：Human 为 `manager | member`，Agent 固定为 `member`。Project 始终至少有一位 active Human Manager。remove/leave 会立即撤销全部 Project Channel 和执行权限；重新加入生成新 ID，并自动恢复现有 Project Channel 访问。

Project Channel 的参与者始终等于全部 active Project Membership。Manager 角色额外授予资源和成员管理能力；Workspace Owner 若不是 Project Member，仍不能读取 Project Channel。Project 不创建或展示 DM。

## 3. 可选 Primary Repository

同一 Project 同时最多一个 `active` Repository 关联。共享字段为稳定 Repository identity、clone source、default branch、revision 与时间；绝对 checkout 路径、credential、文件权限和未提交内容不进入 Workspace Authority。

- `PUT /v1/projects/{projectId}/repository`：没有 active Repository 时挂载；已有相同 identity 时只允许 CAS 更新 default branch。
- Repository identity 不可原地修改。更换时先 `DELETE` 解除，再 `PUT` 新 identity。
- `DELETE` 把当前行标记为 `detached`，删除当前 Working Copy 投影，但保留历史行供既有 Run Context Snapshot 解析。
- 存在引用该 Repository 的 running Attempt 时拒绝解除。

Project revision 与 Repository revision 都参与 CAS，防止另一位 Manager 的资源变化被覆盖。

## 4. Resource Link

Resource Link 是 Project 内轻量外部资料：

```text
id / projectId / title / url / description
revision / createdByMembershipId / createdAt / updatedAt
```

URL 只接受 `http` 或 `https`。任一 active Human Project Member 可创建；creator 或 Project Manager 可 CAS 修改、删除。它没有内容上传、版本历史、Agent publication、Context lineage 或回收站，不得被包装成 Artifact。

## 5. Artifact Association

Artifact 拥有 Workspace 级稳定身份。`artifact_project_associations` 是显式多对多关系，一个 Artifact 可关联多个 Project；关联不复制 Artifact，不改变 creator，也不把 Project Manager 变成 Artifact 删除者。

普通 Project Member 可把有权读取的 active Artifact 关联到所在 Project；只有 Project Manager 或 Workspace Owner 可解除关联。Project 过滤默认显示已关联 Artifact，Workspace 视图可发现并发起关联。删除 Artifact 时关联保留到清理期结束，因此恢复后自动重新可见。

## 6. Run 执行范围

Run Context Snapshot 在接受 Agent Request 时固定当时的 Project 与 Repository 基线：

- 有 active Primary Repository：必须有 identity 匹配且 fresh 的 Local Working Copy；每个 Attempt 从该 Working Copy 创建独立 worktree，并以 worktree 为 Runtime `cwd`。
- 无 active Primary Repository：使用该 Attempt 的隔离 `workspace_scratch` workdir，不产生 `project_working_copy_unavailable`。

Project 后来挂载或解除 Repository，不会改写既有 Run。新 Run 读取新的 active 状态。Runtime 写盘仍只是本地执行效果，只有 Message、Artifact publication 或外部 Git 协议的显式提交才能成为共享事实。

## 7. Web 信息架构

Project 目录和默认页以协作范围呈现，而不是 Repository 列表。默认页用一个按更新时间倒序的“项目资源”目录混排三种来源：直接上传形成的 File Artifact、加入当前 Project 的 Workspace Artifact，以及 Project Resource Link：

- 资料与成员；
- 当前可见 Conversation；
- 统一项目资源；
- 可选 Primary Repository 与本机 Working Copy 状态。

上传文件必须在同一事务中创建 File Artifact 的 Current State 和当前 Project 关联，不自动创建历史快照；加入已有 Artifact 只建立多对多关联；外部 Link 始终保留独立的轻量 CRUD 语义。Project 默认页不重复显示右侧 Artifacts 面板，Project Conversation 与 Artifact 编辑页继续保留。

没有 Repository 时显示 scratch 执行说明，不显示错误空状态。存在 Repository 但当前 Computer 没有匹配 Working Copy 时，Conversation、Artifact 和 Resource Link 仍可使用，仅 Repository-backed Run 显示连接指引。

## 8. 验收要求

- 只用名称即可创建、发现并进入 Project Conversation；无 Repository 的 Attempt 使用隔离 scratch。
- 挂载 Repository 后，新 Run 恢复 Working Copy 准入和 per-Attempt worktree；解除后新 Run 回到 scratch。
- active Attempt 阻止解除，历史 Run 仍解析原 Repository provenance。
- Resource Link 通过 URL、权限与 revision 检查。
- 一个 Artifact 可关联多个 Project，关联不复制版本或转移删除权限。
- API、OpenAPI、Web、Local Computer、变化流、审计和自动化测试使用同一语义。
