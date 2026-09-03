# MVP 测试矩阵

这份清单描述当前开源 MVP 的稳定验证面。默认测试只使用临时 SQLite、文件 Blob 和 deterministic fake ACP，不依赖真实模型登录态；真实 Runtime smoke 属于发布前的可选验收。

## 默认门禁

```bash
npm run check       # OpenAPI、数据库、类型、前后端测试
npm run build       # API、Web、Local Computer 打包
npm run test:integration:backend
```

`npm run test:regression` 会一次执行全部门禁和构建，CI 使用 `npm run check` 与 `npm run build`。

## 分层

| 层级 | 验证对象 | 典型入口 |
| --- | --- | --- |
| 静态 | TypeScript、OpenAPI、SQLite 建库基线、生产构建 | `npm run typecheck`、`npm run openapi:lint`、`npm run db:check`、`npm run build` |
| 领域 | Workspace、Project、Conversation、WorkItem、Artifact v2 的状态与权限 | `tests/*-service.test.ts`、`tests/project.test.ts`、`tests/work-item.test.ts` |
| HTTP | Fastify 路由、鉴权、幂等、错误合同和 multipart 上传 | `tests/http-api.test.ts`、`tests/conversation-visibility.test.ts` |
| Runtime | Agent Inbox、隔离 Session、ACP Gateway、Held Draft 和版本 CAS | `tests/agent-inbox.test.ts`、`tests/agent-session-window.test.ts`、`tests/local-computer-worker.test.ts`、`tests/held-draft.test.ts` |
| Web | 登录、成员治理、会话、Agent 管理、Artifact v2 页面和主题 | `web/src/**/*.test.tsx` |

## 核心业务覆盖

| 区域 | 验收点 | 自动化证据 |
| --- | --- | --- |
| 身份与 Workspace | 注册/验证/登录/退出；Owner 与 Member 权限；可撤销 Join Link | `tests/auth.test.ts`、`tests/workspace-service.test.ts`、`tests/workspace-join-link-token-cipher.test.ts` |
| Project | Project 可独立于本地仓库存在；成员角色、Project Conversation 与 WorkItem 看板 | `tests/project.test.ts`、`tests/conversation-visibility.test.ts`、`tests/work-item.test.ts` |
| Conversation | Workspace/Project/DM scope；公开/私密 audience；Thread、归档与恢复；结构化 `@Agent` | `tests/conversation-visibility.test.ts`、`tests/conversation-lifecycle.test.ts`、`tests/collaboration-requests.test.ts` |
| Agent 执行 | 无正文 wake；按 mention/work item 隔离 Session；权限撤销时 fence；本地 ACP 回复 | `tests/agent-inbox.test.ts`、`tests/agent-session-window.test.ts`、`tests/local-computer-worker.test.ts` |
| Project Resource | 文件树上传、目录、改名、替换、回收站；外部 Link | `tests/http-api.test.ts`、`tests/project.test.ts` |
| Artifact v2 | Project-scoped 不可变版本；版本下载；派生关系；消息和 WorkItem 固定引用版本 | `tests/artifact-v2.test.ts`、`tests/work-item.test.ts`、`tests/held-draft.test.ts` |
| 并发与恢复 | frontier/version CAS；冲突保留 Held Draft；精确重放不重复发布 | `tests/held-draft.test.ts`、`tests/workspace-control-plane.test.ts` |

## 明确不属于默认门禁

- 真实 `codex-acp`、第三方模型质量和本机登录态；可用 `ANC_RUNTIME_COMMAND` 运行 `npm run smoke:codex` 等 smoke 命令。
- 跨机器网络、浏览器像素级视觉回归、压测和公网部署安全性。
- 云端 Agent 托管、SMTP、计费、跨部署联邦、Project Repository/Working Copy，以及旧版 Workspace Artifact API。

fake ACP 通过只证明本地编排和 HTTP 合同正确，不能证明真实模型输出质量。发布前应另外记录 Runtime 版本、模型、数据目录和人工验收结果。
