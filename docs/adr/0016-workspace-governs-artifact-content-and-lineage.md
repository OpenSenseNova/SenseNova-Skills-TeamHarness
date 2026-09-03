# ADR-0016：Workspace 管理 Artifact identity、权限与 lineage

- 状态：Accepted
- 更新：2026-08-21

## Context

团队需要在同一 Artifact 工作区中管理两类对象：由 Workspace 托管内容的 Markdown/File，以及只由 Workspace 管理 identity 和协作语义的外部 URL。把 URL 放在 Project 专用 Resource Link 中会产生第二套权限、引用、Agent 发布和历史展示模型，也使同一个链接无法自然关联多个 Project。

URL 内容位于外部站点，Workspace 既不能保证其可用性，也不应通过主动请求、镜像或版本化把外部内容误表述成自己的状态。

## Decision

1. Artifact 是 `markdown | file | url` 判别联合，稳定 identity、Workspace 权限、actor、Membership、Project Association、Message/Run lineage 与删除生命周期由 Workspace 统一管理。
2. `markdown | file` 是 Workspace 托管内容 Artifact，拥有一个可变 Current State 和零到多个不可变 ArtifactSnapshot。Markdown 使用 Yjs state，File 使用 content-addressed blob；编辑或替换 Current State 不自动创建历史。
3. `url` 只保存创建后不可修改的规范化 `http/https` locator 和可编辑描述。它没有 Current State、Snapshot、draft、file state、content blob、download 或内容清理语义；服务端不对目标地址执行 HEAD/GET 或可用性检查。更换 locator 必须删除旧 Artifact 并创建新 Artifact。
4. Artifact 名称和 URL 描述以 Artifact `revision` 做 CAS 更新。任一 active Workspace Member 可创建和修改 active Artifact 元数据；Artifact creator 或 Workspace Owner 可删除和恢复。Project Manager 只能解除 Project Association，不能删除 Workspace Artifact。
5. Project 外部链接使用 URL Artifact 加显式 Project Association，不保留独立 Resource Link 领域、表、API 或 UI。
6. Message Artifact Reference 是判别联合：Markdown/File 固定 Snapshot UUID、digest 和内容元数据；URL 固定发送当时的 Artifact ID、名称、locator 和描述，不创建 Snapshot。后续元数据修改、删除或封存都不改写已有 Message。
7. Agent Run return 可原子发布托管内容或 URL。托管内容 publication 必须消费 staged blob 并执行 current baseline 检查；URL publication 直接提交 locator 和描述，也可原子关联 Message。Persistent Agent 通过 Runtime Binding 发布、读取和引用 Artifact；更新先进入独立 Local held draft，Workspace 在真正写入前比较 `artifact read` 返回的 opaque state hash。过期时不产生 Artifact 变化并触发同 Session 显式复核；成功发布生成 Workspace change history，但不投影成 Agent Inbox Item或 Runtime wake。
8. Artifact 删除进入 7 天回收站。Markdown/File 到期后清理 Current State、Snapshot、Project Association 和无引用 blob；URL 到期后进入不可恢复的 `purged` tombstone并移除 Project Association，但永久保留 locator、描述、creator 和 Agent/Run lineage。历史 Message 始终保留发送时固定的引用。

## Consequences

- Workspace 管理所有 Artifact 的 identity、权限和 lineage，但只托管 Markdown/File 内容。
- Snapshot、Current State、download、draft flush、file replace 和 staged-content publication 只适用于 Markdown/File；URL 调用这些 API 返回明确的类型不支持错误。
- 外部站点是否可访问不形成 Workspace 状态，不触发服务端网络探测，也不会改写历史引用。
- 本次 schema 是破坏性新基线：旧数据库不迁移，不提供兼容表、路由、fallback 或双写，必须重新初始化。
