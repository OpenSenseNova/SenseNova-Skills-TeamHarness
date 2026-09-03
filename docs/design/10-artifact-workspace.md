# Workspace Artifacts

> 状态：Implemented
>
> 设计版本：1.1.0

## 1. 统一 Artifact 与内容边界

Artifact 是 Workspace 级稳定 identity，也是 Human 看到的唯一产品对象。Human 创建时不选择 Markdown、File 或 URL，只有“上传 Artifact”一个动作。上传后的媒体类型和内部内容状态只负责决定展示与编辑能力，不是三种产品入口。

服务内部为已有内容保留 `markdown | file | url` 存储判别：

- `markdown`：Workspace 托管 Yjs Current State，支持实时源码编辑与预览；
- `file`：Workspace 托管 content-addressed Current State，可替换但不提供 Office 在线编辑；
- `url`：Workspace 管理不可变 `http/https` locator、可编辑描述、权限、Project Association 与 lineage，不托管外部内容。

Markdown/File 返回 `currentState` 与 `latestSnapshot`。URL 返回 `url` 与 `description`，不返回 Current State 或 Snapshot 字段。URL 地址创建后不可修改；更换地址必须删除旧 Artifact 并创建新 Artifact。服务端不主动请求、探测、抓取或镜像目标地址。

## 2. 权威对象与存储

```text
Artifact
├── markdown | file
│   ├── Current State 1
│   ├── ArtifactSnapshot 0..N
│   └── managed Message Reference 0..N
├── url
│   ├── immutable locator + editable description 1
│   └── frozen URL Message Reference 0..N
├── Project Association 0..N
└── active | deleted | purged lifecycle
```

- `artifacts` 保存 identity、名称、类型、creator、revision、状态与时间。
- `artifact_drafts` 只保存 Markdown Yjs state；`artifact_file_states` 只保存 File current blob。
- `artifact_snapshots` 只属于 Markdown/File，使用稳定 UUID 和 SHA-256 content digest。
- `artifact_url_states` 一对一保存规范化 locator、描述、最后更新者以及 Human、Run/Attempt 或 Runtime Binding 创建 provenance。locator 与创建 provenance 不可更新。
- `message_artifact_references` 是判别联合：托管内容列固定 Snapshot；URL 列固定发送时名称、locator 和描述。

URL Artifact 不创建 draft、file state、content blob 或 snapshot。数据库约束阻止 subtype 混用；旧 `project_resource_links` 表不存在。Workspace 与 Local Node schema v1 是唯一支持基线，旧开发数据库必须重新初始化。

## 3. Markdown/File Current State 与 Snapshot

编辑 Markdown 或替换 File 只推进 Current State，不自动增加永久历史。Human 明确保存历史、Message 引用当前状态或 Agent Context 固定当前内容时，Workspace 才按 digest 创建或复用不可变 Snapshot UUID。

正式内容和 staged Agent 输出使用 `content_blobs` 的 SHA-256 内容寻址存储，单文件上限 100 MiB。digest 只负责去重，不代替 Snapshot identity。

保存历史提交 `expectedCurrentRevision + label|null`：

- active digest 不存在时创建新 Snapshot UUID；
- digest 相同且有新 label 时复用 UUID 并更新 label；
- digest 相同且 label 为空时不创建快照；
- current revision 或 digest 已变化时返回 `ARTIFACT_CURRENT_CONFLICT`。

Markdown Web 编辑器使用 CodeMirror 6、Yjs、`y-codemirror.next` 与 Hocuspocus；flush 只推进 Current State。File replace 也要求 current revision CAS，内容相同返回 `ARTIFACT_CONTENT_UNCHANGED`。

## 4. URL metadata 与类型限制

URL 使用 WHATWG URL 解析后只接受 `http:` 或 `https:`。名称与可空描述是展示 metadata，统一通过 `PATCH /v1/artifacts/{artifactId}` 和 Artifact `expectedRevision` 做 CAS；请求不存在 URL 修改字段。

以下内容操作对 URL 返回 `ARTIFACT_TYPE_UNSUPPORTED`，且不会隐式创建内容对象：

- 保存、查看、下载、恢复或删除 Snapshot；
- current download、File replace 或 Markdown draft flush；
- 带 staged blob、digest 或 baseline 的内容 publication。

外部站点的可访问性、重定向或内容变化不形成 Workspace 状态。

## 5. Human、Agent 与权限

任一 active Workspace Member 可创建并读取 active Artifact，也可 CAS 修改名称；URL 还可修改描述。Artifact creator 或 Workspace Owner 可删除和恢复。Project Manager 只可解除 Project Association，不能删除 Artifact。

Human 创建入口只有统一 multipart 上传：

```text
POST /v1/workspaces/{workspaceId}/artifacts
multipart/form-data: file, projectIds?
```

Artifact 名称直接使用上传文件名。Human API 不提供 `/artifacts/markdown`、`/artifacts/files` 或 `/artifacts/urls` 三套创建契约，也不要求客户端先声明 Artifact 类型。

Run return 的 `artifactPublications` 是判别联合。Markdown/File publication 消费 Run/Attempt 私有 staged blob，更新既有 Artifact 时要求 initial `currentRevision + contentDigest`；事务原子提交 Current State、Snapshot、可选 Message reference、change、audit 与 Run terminal。URL publication 直接提交 `name + url + description? + projectIds?`，不接收 staged blob、Artifact ID 或 baseline，并可通过 `attachToMessageIndexes` 原子关联 Message。

Persistent Agent 使用 `teamctl`：

```text
teamctl artifact publish --type url --url <http(s)> --name <name> [--description ...]
teamctl artifact read <artifact-id>
teamctl artifact update <artifact-id> --base-hash <stateHash> [--name ...] [--description ...]
teamctl artifact publish --send-draft --draft-id <id> [--anyway]
teamctl artifact draft get --draft-id <id>
teamctl artifact draft discard --draft-id <id>
teamctl message send ... --artifact-id <id> [--artifact-id <id> ...]
```

`artifact publish` 的 `--file` 与 `--url` 互斥；URL 创建禁止 `--artifact-id` 和 base hash。Persistent Agent 的托管内容更新与 URL metadata 更新先进入独立 Local held Artifact Draft，Workspace 在实际写入前原子比较 Artifact base state hash；过期则不发布并返回 current hash，Local Computer 在同一 ACP Session 发起显式复核 turn。成功发布只写 Workspace change history，不创建 Agent Inbox Item；`artifact draft discard` 只终止本地候选和记录审计，不完成任何 Discussion receipt。读取托管内容时物化本地文件；读取 URL 只返回 metadata，不创建本地文件。Agent metadata update 仅支持 URL 名称/描述，不允许修改 locator。

## 6. Message 与 Run lineage

Human composer 对 Markdown/File 保持“选择 Artifact，再选择当前状态或历史 Snapshot”；对 URL 直接选择 Artifact，不显示内容版本二级选择。Persistent Agent 可用重复 `--artifact-id` 将已发布 Artifact 作为正式 Message reference。

发送时：

- Markdown/File 当前状态先 pin 为 Snapshot，再保存 UUID、digest、media type 与大小；
- URL 保存 Artifact ID、当时名称、locator 与描述，不创建 Snapshot。

后续 metadata 修改不改写既有 Message。Artifact 删除或到期封存后，Message 仍解析并展示发送时引用，同时标记当前 Artifact 为已删除或已封存。Run publication 记录 producing Run/Attempt 或 Runtime Binding provenance；URL locator 不因 Artifact lifecycle 改变。外部站点是否仍可访问不影响引用状态。

## 7. 删除、恢复与到期处理

删除 Artifact 统一进入 7 天回收站：

- 保留期内 creator 或 Workspace Owner 可恢复，原 Project Association 重新可见；
- Markdown/File 到期后删除 Current State、Snapshot 和 Association，并回收没有其他引用的 blob；
- URL 到期后移除 Association，进入不可恢复的 `purged` tombstone，但永久保留 locator、描述、creator 和 Agent/Run lineage；
- 历史 Message 始终保留发送时固定的托管 Snapshot metadata 或 URL locator。

Web 回收站对 URL 表述为“7 天后封存”，不使用“清理内容”。

## 8. Web

Artifacts 面板、Project 资源页和 Conversation 附件入口都只提供“上传 Artifact”。Project 资源页只上传并显示当前 Project 的 Artifact，不从 Workspace 加入已有 Artifact，也不提供“移出项目”。界面不提供“新建 Markdown”“上传文件”“添加链接”三选一，也不显示类型选择器。

Artifact 打开后再依据实际内容提供适用的预览、编辑、替换、下载或历史能力。Project 页面只渲染 Artifact，不查询或维护第二套链接资源。

## 9. 非目标

- Artifact 文件树或 Office 在线编辑；
- URL 内容抓取、服务端可用性检查或网页版本历史；
- URL locator 原地修改或重定向跟踪；
- 快照分支、合并或自动覆盖；
- 逐 Artifact ACL；
- 把 Git Working Copy、Attempt worktree 或 staged blob 当成共享 Artifact。
