# Workspace Artifacts

> 状态：Implemented
>
> 设计版本：1.0.0

## 1. 产品与领域边界

Artifact 是 Workspace 级稳定身份，内容由一个持续自动保存的当前状态和零到多个长期历史快照组成：

- `markdown`：当前状态是原始 Yjs 二进制，支持实时源码编辑与预览；
- `file`：当前状态是一个可替换的 content-addressed blob，不提供 Office 在线编辑。

编辑 Markdown 或替换 File 只推进当前状态，不自动增加永久历史。Human 明确点击“保存到历史”、Message 引用当前状态或 Workspace 为 Agent Context 固定当前内容时，才按 hash 创建或复用不可变快照。

Artifact 不等于 Resource Link、Repository 文件、Runtime 临时文件或消息附件副本。一个 Artifact 可显式关联多个 Project，Workspace 始终是唯一权威归属。

## 2. 权威对象

```text
Artifact
├── Current State 1             # mutable, autosaved
│   ├── Markdown Yjs state
│   └── File current blob
├── ArtifactSnapshot 0..N       # immutable content + stable UUID
├── Project Association 0..N
└── Message Reference 0..N      # exact snapshot UUID + display metadata
```

- `artifacts` 保存稳定身份、文件名、类型、creator、revision、最新快照内部指针和 `active | deleted | purged` 生命周期。
- `artifact_drafts` 保存 Markdown 原始 Yjs state、当前 revision 与最近更新 Membership。
- `artifact_file_states` 保存 File 当前 blob、digest、媒体类型、大小和当前 revision。
- `artifact_snapshots` 是历史快照存储表；公共领域类型为 `ArtifactSnapshot`，其 `snapshotId` 是服务端生成或从旧 Version ID 原样迁移的 UUID。
- 快照 `label` 可空、可修改或清空；UUID、内容 digest、创建时间与保存者稳定不变。
- `message_artifact_references` 固定 snapshot UUID，同时保存文件名、可空 label、快照时间、媒体类型、digest 和大小；不会保存或展示版本序号。

迁移过程只读取旧 `version_number`，新表不保留该列。版本序号不进入公共类型、API、排序、Message reference 或 UI；历史按 `created_at DESC, snapshot_id DESC` 稳定排序。

## 3. 当前状态、hash 与保存历史

正式内容和 staged Agent 输出使用 `content_blobs` 的 SHA-256 内容寻址存储。相同内容可由多个 Artifact 或快照复用同一个 blob；digest 只负责内容去重，不充当快照身份。单文件上限为 100 MiB。

“保存到历史”只提交：

```text
expectedCurrentRevision + label|null
```

Workspace 重新读取当前状态并计算 SHA-256：

- 没有相同 active digest：生成新 UUID，创建快照；
- digest 相同且提交非空新 label：复用已有 UUID，只更新 label；
- digest 相同且 label 为空：不创建快照，返回 `created=false, labelChanged=false`；
- 当前 revision 或 digest 在命令期间变化：返回 `ARTIFACT_CURRENT_CONFLICT`。

Label 不是必填项。无 label 的 UI 标题使用本地化保存时间；已有 label 可修改或清空。重命名、恢复和软删除都不改变 snapshot UUID。

## 4. 实时协作与 File 替换

Web Markdown 编辑器使用 CodeMirror 6、Yjs、`y-codemirror.next` 和 Hocuspocus Provider，通过 Fastify `/v1/artifacts/collaboration` WebSocket 入口运行。Database 扩展直接读写原始 Yjs update；flush 后推进当前 revision，不创建快照。

File 上传到已有 Artifact 的语义是“替换当前文件”。命令提交 `expectedCurrentRevision`，内容相同则返回 `ARTIFACT_CONTENT_UNCHANGED`，revision 冲突则拒绝。替换成功不会写历史；Human 可随后单独点击“保存到历史”。

## 5. Human、Agent 与权限

任一 active Workspace Member 可读取 active Artifact。Human 可创建、重命名、更新当前状态并管理历史；只有 Artifact 或快照 creator、或 Workspace Owner 可执行相应删除。Project Manager 只能解除 Project Association，不能删除 Workspace Artifact。

Agent 先上传 Run/Attempt 私有 `staged_blob`，再在 return envelope 中提交 publication intent。更新既有 Artifact 时，Agent 必须回传 Initial Context 中的 `currentRevision + contentDigest`；最终事务重新校验当前状态，避免 File 或 Markdown 在 Run 期间被覆盖。事务原子完成当前状态更新、快照创建/复用、可选 Project 关联、Message snapshot reference、change、audit 和 staged blob 消费。

Human 与 Agent 使用同一 Current State / ArtifactSnapshot 结构。公共历史中不记录或展示“手动保存”“消息引用”“Agent 发布”等来源分类；内部 Run/Attempt 审计关系不改变用户可见快照语义。

## 6. Context 与 Message 引用

`@` 只处理当前 Conversation 的 Human/Agent 参与者，文件只从 `+` 添加。`+` 严格分两步：

1. 选择 Artifact；
2. 选择“当前状态”或一个 active 历史快照。

选择当前状态发送时，Workspace 按 digest 创建或复用 snapshot UUID，再把该 UUID 写入 Message。选择已有历史则直接固定对应 UUID。消息展示为 `文件名 · label`；无 label 时展示 `文件名 · 本地化保存时间`。

Initial Context 对可安全读取的文本 Artifact 执行同样的 current-state pin，随后只交付不可变 snapshot UUID、digest、current revision、media type 和 byte length。Project Run 只选择关联当前 Project 的 Artifact；Workspace Run 选择 Workspace 可见 Artifact。

## 7. 查看、恢复、软删除与清理

历史支持查看、下载、恢复、重命名/添加名称、删除和诊断用“复制快照 ID”。查看是只读预览；恢复只用快照内容更新当前状态，不修改原快照、UUID、时间或保存者，也不会自动创建另一条历史。

删除快照采用统一软删除：

- 立即从普通历史隐藏，预览与下载返回不可用；
- snapshot UUID、label、时间、保存者和审计记录保留；
- 已有 Message 继续解析文件元数据并显示“该历史内容已删除”；
- 7 天后把快照的 blob 引用清空；只有没有 active snapshot、当前 File state 或 staged blob 引用时，content blob 才物理回收。

删除整个 Artifact 仍使用 7 天回收站。保留期内可恢复；到期清除当前 Yjs/File state、Project Association 和可回收内容，Artifact 留下 `purged` tombstone。

## 8. API 与 Web

公共 API 使用 `snapshotId`：

- `POST /v1/artifacts/{artifactId}/snapshots`
- `GET /v1/artifacts/{artifactId}/snapshots`
- `GET|PATCH|DELETE /v1/artifacts/{artifactId}/snapshots/{snapshotId}`
- `POST /v1/artifacts/{artifactId}/snapshots/{snapshotId}/restore`
- `GET /v1/artifacts/{artifactId}/snapshots/{snapshotId}/download`
- `PUT /v1/artifacts/{artifactId}/current/file`
- `GET /v1/artifacts/{artifactId}/current/download`

旧 `/versions` 路由和旧 `ArtifactVersion` 公共响应已删除。UI 不显示 `vN`、文件名版本后缀或来源徽标。

## 9. 非目标

- Artifact 文件树；
- Office 在线编辑；
- 快照分支、合并或自动覆盖；
- 逐 Artifact ACL；
- 通用万能 Resource 抽象；
- 把 Resource Link、Git 工作树或 staged blob 暴露成共享 Artifact。
