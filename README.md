# AI-Native Collaboration

一个可自托管的 Human + 本地 AI Agent 协作 Workspace MVP。它把对话、Agent Inbox、Project、WorkItem 和可审计的 Artifact 版本放在同一个权限边界内；Agent 的执行仍留在用户自己的 Local Computer 上。

当前版本优先保证一条清晰的纵向链：注册登录 → 创建 Workspace/Project → 邀请成员 → 创建 Agent → 在对话中 `@Agent` → 本地 Agent 读取 Inbox 并回复 → 发布 Project Artifact。它适合评估产品边界和二次开发，不是托管 SaaS 或生产级多租户服务。

## 功能范围

- Human 注册、邮箱验证码（开发环境显示在 API 终端）、登录和 Workspace 成员治理。
- Workspace 全员对话、私聊、Thread、归档，以及结构化 `@Agent` 请求。
- Agent 生命周期、Owner、Runtime Binding、执行策略和本地运行状态。
- Project 成员、对话、WorkItem 看板和独立评论流。
- Project Resource 文件树、外部 Link、Artifact 不可变版本、版本下载和回收站。
- 独立 `anc-computer` Local Computer：检测 ACP Runtime、隔离 Agent Session、通过受控 `teamctl` 读写 Workspace。

明确不在这个 MVP 中：云端 Agent 托管、SMTP 邮件发送、组织级计费、通用数据库迁移、旧版 Workspace Artifact/Repository/Working Copy API，以及跨部署身份联邦。

## 运行环境

- Node.js 24 或更新版本
- npm 10 或更新版本
- 浏览器（开发 Web 客户端）

## 快速开始

```bash
git clone https://github.com/lgl0980/ai_native_collaboration.git
cd ai_native_collaboration
cp .env.example .env
npm ci
npm run dev
```

打开 <http://127.0.0.1:5173>。开发服务器默认监听：

- Web：`127.0.0.1:5173`
- API：`127.0.0.1:3000`
- 数据：`.data/workspace.sqlite`、`.data/local-node.sqlite` 和 `.data/content-blobs/`

环境变量只有四个核心设置：`NODE_ENV`、`HOST`、`PORT`、`APP_DATA_DIR`，完整样例见 [.env.example](.env.example)。开发默认只绑定 loopback；部署到反向代理或容器时再显式设置 `HOST=0.0.0.0`。

生产构建由同一个 Fastify 进程提供 API 和静态 Web：

```bash
npm run build
NODE_ENV=production npm start
```

生产入口为 <http://127.0.0.1:3000>。数据库是新的破坏性基线，开发数据目录不随代码迁移；需要保留数据时先备份整个 `APP_DATA_DIR`。

## 连接 Local Computer

在要运行 Agent 的本机安装并连接 Local Computer：

```bash
# 先在 Web 中创建 Computer，复制一次性 token
npm run build
npm install --global ./web/public/downloads/anc-local-computer.tgz

anc-computer connect \
  --server http://127.0.0.1:3000 \
  --token '<computer-token>'
anc-computer run
```

macOS 可使用 `anc-computer service install` 安装用户级 LaunchAgent；用 `service status|restart|stop|logs|uninstall` 管理。连接配置、Local Node 数据库、Agent 工作目录和 Runtime 凭据都只保存在本机用户目录，不会上传到 Workspace API。

Local Computer 只向服务端拉取无正文的 wake 信号。Runtime 通过本次 Session 注入的 `teamctl` 主动读取上下文，并在精确的 Discussion frontier 或 Artifact 版本 CAS 上发布结果。不同 `@Agent` 请求和不同 WorkItem 不共享 Runtime Session。

## 项目结构

```text
src/
  domain/       Workspace、Project、Conversation、Artifact 领域服务
  http/         Fastify API 和 OpenAPI schema
  runtime/      ACP 适配、Agent Session、teamctl Gateway
  storage/      SQLite、内容 Blob、Local Node 状态
web/            React + Vite 客户端
local-computer/ 可独立安装的 anc-computer 包
schema/         workspace/local-node SQLite 建库基线
tests/          API、领域、Runtime 和 Web 测试
docs/           架构、契约、ADR 和测试矩阵
```

API 契约在 [docs/contracts/openapi.json](docs/contracts/openapi.json)，领域入口在 [`WorkspaceService`](src/domain/workspace-service.ts) 和 [`ProjectResourceService`](src/domain/project-resource-service.ts)。

## 验证

```bash
npm run check       # OpenAPI、数据库、TypeScript、API/Web 测试
npm run build       # API、Web、Local Computer 打包
npm run openapi     # 领域路由变化后重新生成契约和 Web 类型
```

需要真实本机 Runtime 时，显式提供 `ANC_RUNTIME_COMMAND` 再运行 `npm run smoke:codex`（也支持 `smoke:claude`、`smoke:gemini`、`smoke:goose`、`smoke:hermes`）。CI 只使用 fake ACP Agent，不依赖本机登录态。

## 文档

- [MVP 范围与验收](docs/MVP.md)
- [总体架构](docs/ARCHITECTURE_V1.md)
- [Artifact v2 与 Project 资源](docs/artifact-v2.md)
- [Local Computer](local-computer/README.md)
- [协作平台测试矩阵](docs/testing/COLLABORATION_TEST_MATRIX.md)
- [OpenAPI 契约](docs/contracts/openapi.json)
- [贡献指南](CONTRIBUTING.md)
- [安全策略](SECURITY.md)

## 许可证

[MIT](LICENSE)
