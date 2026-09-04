# AI-Native Collaboration

AI-Native Collaboration 是一个面向开发者自托管的协作工作区，让人和本地 AI Agent 围绕 Conversation、Project、WorkItem 和 Artifact 协同工作。项目采用 MIT 许可证，当前定位为便于二次开发的 MVP。

[English](README.md) · [产品介绍](docs/PRODUCT_OVERVIEW.md)

## MVP 闭环

创建 Workspace，加入 Project 或 Conversation，配置 Agent 与本地 Runtime，然后在会话中提及 Agent。服务端记录请求和 Inbox 上下文；Local Computer 在本地运行选定的 Agent，再通过 HTTP API 回传消息或 Artifact 更新。Artifact 使用内容寻址存储，并支持可审核草稿。

## 快速开始

环境要求：Node.js 24 和 npm。服务端从源码安装；本 MVP 不提供 Docker 部署和 npm 发布。

```bash
git clone https://github.com/lgl0980/ai_native_collaboration.git
cd ai_native_collaboration
cp .env.example .env
npm ci
npm run dev
```

浏览器打开 `http://localhost:5173`。如需生产模式本地运行：

```bash
npm run build
NODE_ENV=production npm start
```

环境变量、数据库和 Local Computer 配置见 [INSTALL_CN.md](INSTALL_CN.md)。Local Computer 以 `anc-local-computer.tgz` 分发，命令参考见 [local-computer/README.md](local-computer/README.md)。

## 公共版本校验

```bash
npm run verify:public
npm run build
```

该命令会检查 OpenAPI 契约、SQLite schema 基线、TypeScript、后端核心测试和 Web 主要流程、公开文档链接、依赖声明及 Local Computer 压缩包。OpenAPI 校验当前为 0 errors、519 条 style warning；warning 已记录在 [CHANGELOG.md](CHANGELOG.md)，不阻塞 MVP 发布。

## 目录说明

- `src/`：Fastify API、业务服务、Runtime 网关和 SQLite 访问
- `web/`：Vite/React 客户端
- `local-computer/`：独立打包的本地执行客户端
- `schema/`：版本化 SQLite schema 基线
- `tests/`：API、Runtime 和持久化回归测试
- `docs/contracts/openapi.json`：客户端和工具使用的 HTTP 契约

## 范围与限制

这是一个早期自托管 MVP。将服务暴露到非信任网络前，请自行评估认证、网络边界、密钥存储、备份和本地 Agent 权限。当前不提供生产部署方案、Docker 镜像、原生安装器、npm registry 包或 schema 迁移层。

- [产品介绍](docs/PRODUCT_OVERVIEW.md)
- [MVP 范围与验收](docs/MVP.md)
- [安装](INSTALL_CN.md) · [Installation](INSTALL.md)
- [贡献指南](CONTRIBUTING_CN.md) · [Contributing](CONTRIBUTING.md)
- [安全说明](SECURITY_CN.md) · [Security](SECURITY.md)
- [OpenAPI 契约](docs/contracts/openapi.json)
- [变更记录](CHANGELOG.md)

## 许可证

[MIT](LICENSE)
