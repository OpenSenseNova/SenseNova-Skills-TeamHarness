# ADR-0016：Workspace 管理 Artifact 内容与 lineage

- 状态：Accepted
- 更新：2026-08-19

Artifact 是 Workspace 级稳定身份。当前类型只有 Markdown 和 uploaded File；每个 Artifact 有一个持续更新的 Current State 和零到多个长期 ArtifactSnapshot。快照以不可变 UUID 标识，内容引用 Workspace 管理的 SHA-256 blob，并记录可空 label、保存者、保存时间、digest、媒体类型和大小。

Markdown Yjs 和 File current blob 都是 Current State；编辑或替换不自动创建历史。Human 保存历史、Message 引用当前状态和 Agent return 统一按 digest 创建或复用 Snapshot；Agent publication 还必须在最终 return 事务中原子更新 Current State、固定 Snapshot UUID、建立 Message reference、change 与 audit。

Artifact 可显式关联多个 Project，但关联不复制内容或转移所有权。Message 和 Run 固定具体 ArtifactSnapshot UUID。快照重命名、恢复和软删除不改变 UUID；删除后内容立即不可访问，7 天后且没有其他有效引用时回收 blob，历史消息保留文件名、可空名称、保存时间、媒体类型和大小并明确内容已删除。

外部 URL 使用 Resource Link，Git 结果使用 Repository/Git 协议；当前不把它们包装成 Artifact 类型或外部内容 Adapter。
