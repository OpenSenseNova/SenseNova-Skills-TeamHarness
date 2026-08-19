# Human Workspace Web

> 状态：V1 Project、Repository、Resource Link 与 Artifact 工作区已实现
>
> 当前契约版本：1.0.0
>
> 技术栈：React 19、TypeScript、Vite、Ant Design 6、Ant Design X 2、TanStack Query

## 1. 交付范围

本模块提供 Human 进入和管理 Workspace/Project 协作面的最小完整产品。桌面布局左侧为当前管理范围、Conversation 与控制入口，中间为 Conversation、Project 资料或 Artifact 编辑器；Conversation 与 Artifact 页面右侧保留 Artifact 工作区，Project 默认资料页则由中间的统一“项目资源”承担资源管理。移动端使用 Drawer。

已实现：

- 注册、开发终端邮箱验证码、登录、退出和 30 天持久会话；
- 创建、切换并在刷新后恢复 Workspace；
- 只用名称创建 Project，管理成员、可选 Primary Repository 与统一项目资源，并在 Workspace/Project 两种 scope 中分别创建 Channel；DM 固定属于 Workspace；
- 创建 Channel / DM 风格 Conversation，查看 Message，回复 Thread；
- 从当前 Conversation 的 Human/Agent 成员中结构化选择 `@` mention；Channel 只为 Agent mention 创建 Agent Request，Human–Agent DM 中的 Human Message 则自动请求唯一 direct Agent，输入框不额外显示“无需 @”说明；
- 查询、创建、编辑、暂停、恢复和删除 Agent；删除后目录中消失，既有私聊只读保留；
- 编辑 Agent Execution Policy；
- 在 Conversation 的 Agent Request 卡片查看 Run、Context version、Discussion frontier 与来源数量；
- 为当前 Run 按来源类别创建一次 Private Context Grant 并撤销，且不显示私有正文、路径、原始 Prompt 或 Runtime Session；
- 查询成员、创建/复制/撤销邀请、修改角色与权限、移除成员；
- 修改 Workspace 名称、查看当前 Membership、离开 Workspace；
- 从 Workspace/Conversation 右栏创建 Markdown、上传任意文件、关联或解除 Project，并管理 7 天回收站；Project 默认页通过统一资源目录上传文件、加入已有 Artifact 或管理外部 Link；
- 在主内容区实时协作编辑和预览 Markdown、替换 File 当前状态，并用可空名称显式保存 UUID 历史快照；
- 从 Message composer 的 `+` 入口先选 Artifact，再选当前状态或历史快照；历史消息固定 snapshot UUID 并在软删除后展示元数据占位；
- 通过 Workspace change cursor 轮询并刷新受影响的权威投影。

Conversation 归档/恢复的 Web 接线已经交付：详情页按权限提供归档/恢复，归档后保留历史并进入只读；Workspace 和 Project 侧栏均提供独立的已归档列表、历史查看和恢复入口。未实现：本机 Working Copy 连接向导、Computer/Runtime Catalog 与 Skill inventory 的完整 Web 接线、完整 Execution Timeline、Office 在线编辑、Artifact 文件树、WorkItem、Result Submission、Review 和复杂角色。Computer Token、本地命令路径、Runtime 凭据、Skill 正文和启动配置始终属于 Local Node，不在 Human Web 中暴露。

## 2. 页面结构

```text
/login                                登录
/register                             注册
/verify-email                         邮箱验证
/invitations/:invitationId            接受邀请
/w/:workspaceId                       Workspace Shell
  /c/:conversationId                  Conversation / Thread / Agent Request
  /projects                            Project 目录
  /p/:projectId                       Project 资料 / Repository / 本机连接状态
    /c/:conversationId                Project Conversation / Thread / Agent Request
    /members                          Project 成员
    /artifacts/:artifactId            Project 关联 Artifact 编辑器
  /artifacts/:artifactId              Workspace Artifact 编辑器
  /agents                             Agent 目录与治理
  /members                            Human 成员与邀请
  /settings                           Workspace 设置
```

宽屏主导航 Rail 将“协作 / Projects / 团队 / Workspace 设置”作为同级入口；窄屏 Drawer 提供相同层级。协作区显示 Workspace Channel 和全局私聊，Projects 区展示可选协作范围；进入某个 Project 后，二级侧栏只显示资料、Project Channel 和成员，不出现“项目私聊”。中间内容区是当前主工作面。Project 资料页不显示右侧 Artifacts 面板，避免与统一项目资源目录重复；Project Conversation 和 Artifact 编辑页仍保留该面板，移动端以 Drawer 提供同一能力。

### 2.1 Project 的目标交互

Project 页面是协作概览，表达名称、成员、Conversation、可选 Primary Repository 和统一项目资源。统一目录按更新时间倒序混排 File Artifact、Markdown Artifact 与 Resource Link；“加入已有 Artifact”只新增当前 Project 关联，不复制内容、不改变 Workspace 归属，也不移除其他 Project 关联。Repository 状态只在已挂载时出现，不能把“无 Repository”渲染成 Project 不完整或不可用。

创建入口只要求名称，可选 description 与远程 Git Repository。Project Manager 可在资料页后来挂载 Repository、更新默认分支、解除后更换 identity；解除不会删除历史 Run provenance。

Project 默认页把上述资料放在同一页面。绝对路径只有当前本机用户在明确连接或诊断时可见，不进入服务端响应、变化流或其他成员页面。若已挂载 Repository 但当前 Computer 没有匹配 Working Copy，Conversation、Artifact 和 Resource Link 仍可用，Repository-backed Run 显示连接指引；未挂载 Repository 时 Project Run 明确使用隔离 scratch。

Project Conversation 继续使用普通 Conversation UI。`@Agent` 只产生普通 Mention Outcome / Agent Request 状态；Runtime 运行中状态进入统一执行状态面，Runtime 最终通过 Workspace CLI/MCP 在原 Discussion Scope 发送普通 Message，不为 `@` 单独构造回复卡片。

## 3. 认证契约

公开注册创建 `pending_verification` Human 和单次邮箱验证挑战。验证码为 6 位数字、10 分钟有效、最多尝试 5 次；开发环境只写入服务终端。密码使用 Node.js 内建 Argon2id 保存，不存储明文。

验证或登录成功后，服务设置 `anc_session`：HttpOnly、SameSite=Lax，生产环境 Secure，30 天到期。Web 只通过 `/v1/auth/session` 恢复身份，不读取 Cookie 内容。Human API 同时保留 Bearer 认证供契约测试和非浏览器客户端使用。

## 4. 数据恢复与变化同步

进入 Workspace 后，Web 先读取 bootstrap cursor，再并行加载 members、agents、Workspace Channels/DM 与可发现 Projects。进入 Project 时再加载其 members 和全部 Project Channels。Membership change 会同时刷新 participant projection 与 `@Agent` 候选。随后每 2 秒读取变化流；页面隐藏时暂停，重新可见或网络恢复时立即追赶。

变化流只触发 TanStack Query 对应资源失效：

```text
message              → Conversation messages
agent_request        → Conversation requests
conversation         → Conversation list/detail/participants
project              → Project detail/list/conversations
artifact             → Artifact list/detail/current/snapshots/trash and Project filters
project_membership   → Project member directory and Project context
agent                → Agent directory
workspace_membership → Member directory
workspace_invitation → Invitation directory
workspace            → Workspace bootstrap/list
```

客户端不从变化 payload 推导第二套领域状态。刷新或重新登录后，全部可见状态仍从 Workspace Authority 恢复。

## 5. 写入与并发

所有公开写入由 API client 附带 UUID `Idempotency-Key`，TanStack Query 不自动重试 mutation。实体治理提交当前 revision；`409` 冲突直接呈现给 Human，再读取最新权威投影。Message 发送成功才清空草稿；失败保留输入，避免丢失 Human 内容。

结构化 `@` 由成员选择器产生 `mentionedActorIds`，显示文本中的 `@name` 只用于阅读。只有所选 actor 为 Agent 时才创建 Agent Request。文件不进入 `@`；`+` 提交 `artifactSelections[{artifactId,snapshotId|null}]`，其中 `null` 表示发送时固定当前状态。

## 6. 联调边界

- OpenAPI：`docs/contracts/openapi.json`
- Web 生成类型：`web/src/api/generated.ts`
- Web API 封装：`web/src/api/client.ts`
- Workspace 恢复与导航：`web/src/workspace/WorkspaceShell.tsx`
- Conversation：`web/src/workspace/ConversationPage.tsx`

修改 HTTP schema 后必须运行 `npm run openapi`，再运行 `npm run typecheck && npm test && npm run build`。生产构建由 Fastify 静态托管 `web/dist`，非 `/v1` 的未知 GET 路径回退到 `index.html`。
