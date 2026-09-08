# AI-Native Collaboration

AI-Native Collaboration 是一个面向开发者自托管的协作工作区，让人和本地 AI Agent 围绕 Conversation、Project、WorkItem 和 Artifact 协同工作。项目采用 MIT 许可证，便于从源码运行并进行二次开发。

[English](README.md) · [产品介绍](docs/PRODUCT_OVERVIEW.md)

## 功能

- **人和 Agent 共用一个空间** —— Conversation、Project、WorkItem 和 Artifact 放在一起，而不是散落在各个聊天窗口。
- **一句话变成一项工作** —— 在会话中 @Agent 或创建待办，明确负责人和预期结果。
- **本地执行 Agent** —— Local Computer 在你自己的电脑上运行选定的 Agent，使用本地文件和工具，凭据与敏感数据留在本地。
- **可审计的成果** —— Artifact 使用内容寻址存储，支持可审核草稿和版本历史，结果不会淹没在长聊天里。
- **中断可恢复** —— 未发布的结果会被保留，冲突后可显式 retry、discard 或 force。

## 工作方式

创建 Workspace，加入 Project 或 Conversation，配置 Agent 与本地 Runtime，然后在会话中提及 Agent。服务端记录请求和 Inbox 上下文；Local Computer 在本地运行选定的 Agent，再通过 HTTP API 回传消息或 Artifact 更新。

## 快速开始

环境要求：Node.js 24 和 npm。服务端从源码运行；不提供 Docker 镜像和 npm 包。

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

## 构建与测试

```bash
npm test
npm run build
```

## 目录说明

- `src/`：Fastify API、业务服务、Runtime 网关和 SQLite 访问
- `web/`：Vite/React 客户端
- `local-computer/`：独立打包的本地执行客户端
- `schema/`：版本化 SQLite schema 基线
- `tests/`：API、Runtime 和持久化回归测试
- `docs/contracts/openapi.json`：客户端和工具使用的 HTTP 契约

## 文档与范围

这是一个早期自托管项目。将服务暴露到非信任网络前，请自行评估认证、网络边界、密钥存储、备份和本地 Agent 权限。当前不提供生产部署方案、Docker 镜像、原生安装器、npm registry 包或 schema 迁移层。

- [产品介绍](docs/PRODUCT_OVERVIEW.md)
- [安装](INSTALL_CN.md) · [Installation](INSTALL.md)
- [贡献指南](CONTRIBUTING_CN.md) · [Contributing](CONTRIBUTING.md)
- [安全说明](SECURITY_CN.md) · [Security](SECURITY.md)
- [OpenAPI 契约](docs/contracts/openapi.json)
- [变更记录](CHANGELOG.md)

## 许可证

[MIT](LICENSE)
