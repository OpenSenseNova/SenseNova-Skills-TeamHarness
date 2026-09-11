# Changelog

## [0.1.0] - 2026-09-04

首个公开版本，面向开发者自托管和二次开发。

- 提供 Workspace、Project、Conversation、Mention、Agent Inbox、WorkItem 和 Artifact 的核心协作闭环。
- 提供 Node.js 24/npm 源码安装路径，以及 Local Computer release asset 打包路径。
- 保留 OpenAPI HTTP 契约和 SQLite schema 基线检查。
- 公开文档收敛为 README、安装、贡献、安全、Local Computer 参考和变更记录。
- OpenAPI 校验：0 errors；当前有 519 条 style warning，属于非阻塞提示。

限制：当前版本不提供生产部署方案、Docker/Compose、npm publish、原生安装器、数据库迁移层或旧 API 兼容层。
