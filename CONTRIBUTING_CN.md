# 贡献指南

感谢你帮助改进这个自托管 MVP。请围绕公开行为提交小而明确的变更；除非另有兼容性决策，不要改变现有 HTTP API、Runtime 语义或 SQLite schema 基线。

## 开发

```bash
npm ci
npm run dev
npm run verify:public
```

使用 Node.js 24。`docs/contracts/openapi.json` 是公开 HTTP 契约；修改路由后运行 `npm run openapi`，同时检查契约和生成的 Web client 类型。Schema 变化使用 `npm run db:check` 校验。不要把私有设计笔记、凭据、数据库、日志或构建产物加入仓库。

公开文档保持精简：README、安装、贡献、安全、MVP、产品介绍、Local Computer 命令参考、变更记录、许可证和 OpenAPI 契约。扩展说明写在本文件或英文版本中，不新增内部架构专题文档。

## Pull Request

请说明：

- 用户可见行为和影响范围；
- 实际执行的校验命令及结果；
- 已知限制、迁移或发布风险、安全影响；
- 公开命令或 API 改动对应的文档更新。

保持提交可审查，不引入无关格式化。除非项目范围先行调整，PR 不应新增 Docker/Compose、npm 发布、原生安装器、API 兼容层或数据库迁移。

## 发布维护

首个公开版本为 `v0.1.0`。GitHub Release 是唯一分发渠道；服务端从源码安装，Local Computer 作为 release asset。维护者在校验 workflow 通过后创建 `v*.*.*` tag。workflow 会构建 `anc-local-computer.tgz` 并生成 SHA-256，不会执行 `npm publish`。
