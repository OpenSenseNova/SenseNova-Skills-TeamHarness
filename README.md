# AI-Native Collaboration

AI-Native Collaboration 是一个面向 Human 与本地 AI Agent 的协作系统。V1 提供可运行的 Web、Workspace API 和独立 Local Computer，把 Conversation、Agent 执行、Project Repository 与 Artifact 放在同一个有权限和审计边界的工作区内。

## V1 能力

- Human 注册、邮箱验证、登录与 Workspace 成员治理。
- Workspace Channel、Human/Agent 私聊、Thread、结构化 `@Agent` 与归档。
- Agent 资料、Runtime Binding、模型/推理强度/模式配置、重启与删除。
- Pull-based Agent Inbox：DM 自动唤醒 Agent；Channel/Thread 只有明确 `@Agent` 才唤醒。
- Project 资料、成员、Channel、外部 Link、Artifact 关联与可选 Primary Repository。
- Markdown/File Artifact、不可变版本、Project 多对多关联、消息快照引用和回收站。
- 独立 `anc-computer`、本机 Runtime 探测、Working Copy、Attempt scratch/worktree 和受控 `teamctl`。

## 系统结构

```text
Human Browser
  └─ Web (React + Vite)
       └─ Workspace API (Fastify + SQLite)
            ├─ Workspace / Conversation / Agent / Project / Artifact
            └─ agent.inbox_changed（只含 Agent ID 与 sequence）

Local Computer
  ├─ Runtime Catalog 与本机凭据边界
  ├─ ACP Adapter → Codex / Claude / Gemini / Goose / Hermes
  ├─ Attempt scratch 或 Git worktree
  └─ teamctl → Inbox / Message / Artifact API
```

服务端不保存本机绝对路径、Git 凭据或 Computer Token 明文。Runtime 不直接获得服务端凭据；它只能通过 Attempt 内注入的 `teamctl` 访问当前 Agent 和 Run 被授权的能力。

## 本地开发

要求 Node.js 24 及系统 Git。

```bash
npm install
npm run dev
```

打开 `http://127.0.0.1:5173`。API 默认监听 `http://127.0.0.1:3000`。开发环境首次注册时，6 位验证码会显示在 API 终端；当前版本不连接 SMTP。

生产构建由同一个 Fastify 进程提供 API 和 Web：

```bash
npm run build
npm start
```

生产入口为 `http://127.0.0.1:3000`。

## Local Computer

`npm run dev` 和 `npm run build` 会生成可独立安装的 Local Computer 包。目标机器安装一次后，可从任意目录运行：

```bash
npm install --global 'http://127.0.0.1:5173/downloads/anc-local-computer.tgz'

anc-computer connect \
  --server 'http://127.0.0.1:3000' \
  --token '<computer-token>'

anc-computer run
```

连接配置以 `0600` 权限保存在操作系统用户级应用数据目录。Local Computer 会检测已安装的 ACP Runtime，定期上报脱敏状态，并从服务端长轮询 Agent Inbox wake。

Repository 操作同样不依赖当前目录：

```bash
anc-computer project create --workspace <workspace-id>
anc-computer project bind --project <project-id>
anc-computer project clone --project <project-id>
anc-computer project cleanup --attempt <attempt-id>
```

有 Repository 的 Project Attempt 使用独立 detached Git worktree；无 Repository 的 Project Attempt 与 Workspace Attempt 使用隔离 scratch。真实 checkout 路径与 Git 凭据始终留在 Local Computer。

## Agent 消息上下文

消息正文不会放进 wake payload、Runtime 启动参数或本地 manifest。Runtime 收到轻量通知后主动拉取：

```bash
teamctl inbox check
teamctl message check --target conversation:<conversation-id>
teamctl message read --target conversation:<conversation-id>
teamctl message resolve <message-id>
teamctl message send --target conversation:<conversation-id> --body '结果已发布。'
teamctl return no-output --run <run-id>
```

`message check` 会一次领取当前 Discussion Scope 的待处理提醒，并返回该 scope 自上次成功处理位置以来的 Conversation/Thread 消息增量。`@` 只决定是否提醒 Agent，不会把 Conversation 历史裁成一条 mention。Runtime 回复通过 `message send` 直接成为普通 Conversation Message；同一 scope 在 Runtime 忙碌时不会启动第二个并行进程。

## Artifact 与 Project 资源

Project 资料页把三类资源放在同一个列表中：

- 上传 File Artifact，并在创建时关联当前 Project；
- 加入已有 Workspace Artifact，只增加关联，不复制或改变归属；
- 创建外部 Link，继续使用独立 Link CRUD。

Agent 可通过 `teamctl artifact publish` 发布新 Artifact 或更新已授权的 Artifact。Artifact publication 与 Message publication 分离，均保留 Agent、Run、Attempt 与 Runtime Binding provenance。

## 数据库 V1 基线

V1 使用两个独立 SQLite 数据库：

- `workspace.sqlite`：共享协作权威数据；
- `local-node.sqlite`：Local Computer 私有执行状态。

两者的 schema 均从版本 `1` 开始，并使用不同的 SQLite `application_id` 防止数据库族混用。本次 V1 是新的破坏性基线，不兼容早期开发数据库，也不包含预发布迁移链。

后续迭代遵循“分库、按表定向迁移”：只在受影响的数据库内修改明确的表、索引或约束，保留账户、Workspace、Conversation、Project、Artifact 等无关数据；禁止通过重建整个数据库完成局部功能升级。`schema/manifest.json` 是数据库族版本的唯一来源，`npm run db:check` 校验基线 SQL、迁移链和 Local Computer 打包副本的一致性。

## 验证

```bash
npm run openapi
npm run openapi:lint
npm run db:check
npm run typecheck
npm test
npm run build
```

真实 Runtime 冒烟是显式 opt-in：

```bash
ANC_RUNTIME_COMMAND='<runtime-command>' npm run smoke:codex
```

还可使用 `smoke:claude`、`smoke:gemini`、`smoke:goose` 和 `smoke:hermes`。CI 只使用无凭据 fake ACP Agent，不依赖本机登录态。

## 文档

- [总体架构](docs/ARCHITECTURE_V1.md)
- [实施路线图](docs/IMPLEMENTATION_ROADMAP.md)
- [核心领域词汇](CONTEXT.md)
- [Local Computer](local-computer/README.md)
- [数据基础](docs/design/03-module-1-data-foundation.md)
- [协作请求](docs/design/04-module-2-collaboration-requests.md)
- [Local Agent 模块](docs/design/05-local-agent-module.md)
- [Workspace 控制面](docs/design/06-workspace-control-plane.md)
- [Human Web](docs/design/07-human-workspace-web.md)
- [Project 管理范围](docs/design/09-project-management-scope.md)
- [Artifact 工作区](docs/design/10-artifact-workspace.md)
- [OpenAPI](docs/contracts/openapi.json)
