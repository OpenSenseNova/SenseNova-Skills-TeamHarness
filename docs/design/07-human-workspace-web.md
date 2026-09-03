# Human Workspace Web

> 状态：Workspace 控制面、Project 折叠树、固定群聊与 WorkItem 评论已实现
>
> 当前契约版本：1.0.0
>
> 技术栈：React 19、TypeScript、Vite、Ant Design 6、Ant Design X 2、TanStack Query

## 1. 交付范围

本模块提供 Human 进入和管理 Workspace/Project 协作面的最小完整产品。Workspace 只承担组织、身份、邀请、唯一全员大群和一对一私聊；Project 是私有项目协作边界。桌面侧栏和移动端 Drawer 使用同一棵可多选展开的 Project 树，中间为 Conversation、Project 设置、WorkItem 或 Artifact 编辑器。

已实现：

- 注册、开发终端邮箱验证码、登录、退出和 30 天持久会话；
- 创建、切换并在刷新后恢复 Workspace；
- 只用名称创建 Project，自动建立 Owner 与主群，管理 Owner/Manager/Member、统一项目资源和 WorkItem；Project 可创建多个显式成员长期群聊，DM 固定属于 Workspace；
- 创建 Channel / DM 风格 Conversation，查看 Message，并在主消息流中回复任意 Message；回复会显示所引用消息并自动提及原作者；
- 从当前 Conversation 的 Human/Agent 成员中结构化选择 `@` mention；Channel 只为 Agent mention 创建 Agent Request，Human–Agent DM 中的 Human Message 则自动请求唯一 direct Agent，输入框不额外显示“无需 @”说明；
- 查询、创建、编辑、暂停、恢复和删除 Agent；删除后目录中消失，既有私聊只读保留；
- 编辑 Agent Execution Policy；
- 在 Conversation 的 Agent Request 卡片查看 Run、Context version、Discussion frontier 与来源数量；
- 为当前 Run 按来源类别创建一次 Private Context Grant 并撤销，且不显示私有正文、路径、原始 Prompt 或 Runtime Session；
- 查询成员；所有 active Workspace Human 可查看/复制分享式 Join Link，只有 Workspace Owner 可创建或停用链接并移除成员，接受者固定成为普通 Member；
- 修改 Workspace 名称、查看当前 Membership、离开 Workspace；
- 从 Workspace、Conversation 或 Project 使用同一个“上传 Artifact”动作放入任意支持的文件，不预先选择 Markdown、File 或 URL；Project 资源只能在当前 Project 直接上传，不提供从 Workspace 加入已有 Artifact 的入口；
- 在主内容区实时协作编辑和预览 Markdown、替换 File 当前状态，并用可空名称显式保存 UUID 历史快照；
- 从 Message composer 的 `+` 入口引用 Artifact：Markdown/File 再选当前状态或历史快照，URL 直接固定发送时 locator 和描述；历史消息在 Artifact 删除或封存后仍展示固定 metadata 和状态；
- 在 Project WorkItem 看板查看、分配和评论；WorkItem 评论不创建 Topic 或 Conversation，Agent 只在分配或显式 `@mention` 时被唤醒；
- 通过 Workspace change cursor 轮询并刷新受影响的权威投影。

Conversation 归档/恢复的 Web 接线已经交付：详情页按权限提供归档/恢复，归档后保留历史并进入只读；Workspace 和 Project 侧栏均提供独立的已归档列表、历史查看和恢复入口。未实现：Computer/Runtime Catalog 与 Skill inventory 的完整 Web 接线、完整 Execution Timeline、Office 在线编辑、Artifact/VFS 文件树、Review，以及新的 Agent Session 隔离与轮换。Computer Token、本地命令路径、Runtime 凭据、Skill 正文和启动配置始终属于 Local Node，不在 Human Web 中暴露。

## 2. 页面结构

```text
/login                                登录
/register                             注册
/verify-email                         邮箱验证
/join/:token                           预览并确认加入 Workspace
/w/:workspaceId                       Workspace Shell
  /c/:conversationId                  Conversation / Thread / Agent Request
  /projects                            Project 树入口提示，不再承担目录中转页
  /p/:projectId                       Project 设置 / 资源 / WorkItem
    /c/:conversationId                Project Conversation / Thread / Agent Request
    /members                          Project 成员
    /artifacts/:artifactId            Project 关联 Artifact 编辑器
  /artifacts/:artifactId              Workspace Artifact 编辑器
  /agents                             Agent 目录与治理
  /members                            Human 成员与 Join Link
  /settings                           Workspace 设置
```

宽屏主导航 Rail 将“协作 / 项目 / 团队 / Workspace 设置”作为同级入口；窄屏 Drawer 提供相同层级。协作区只显示唯一 Workspace 大群和全局一对一私聊。项目区直接显示 Project 文件夹节点：点击名称只展开/折叠，不打开项目首页；多个 Project 可同时展开，当前路由对应节点自动展开，状态按 Workspace 保存在本地。每个节点只显示主群、其他固定群聊和“设置”，群聊逐 Project 独立懒加载。治理元数据 Project 单独显示且不能展开内容。

### 2.1 Project 的目标交互

Project 不再通过目录页多点一次进入。“设置”页显示资料、群成员、WorkItem 和项目资源。Project Artifact 从当前 Project 直接上传，不查询或导入 Workspace Artifact。

创建入口只要求名称，可选 description。创建成功后直接展开新节点并打开主群；Project Owner/Manager 后续可在设置页管理成员、资源和 WorkItem。

Project 默认页把上述资料放在同一页面。本机绝对路径、Runtime 凭据和工作目录只属于 Local Computer，不进入服务端响应、变化流或其他成员页面。Project Run 使用隔离 scratch，Conversation 和 Artifact 不依赖本机目录。

Project Conversation 继续使用普通 Conversation UI。`@Agent` 只产生普通 Mention Outcome / Agent Request 状态；Runtime 运行中状态进入统一执行状态面，Runtime 最终通过 Workspace CLI/MCP 在原 Discussion Scope 发送普通 Message，不为 `@` 单独构造回复卡片。

## 3. 认证契约

公开注册创建 `pending_verification` Human 和单次邮箱验证挑战。验证码为 6 位数字、10 分钟有效、最多尝试 5 次；开发环境只写入服务终端。密码使用 Node.js 内建 Argon2id 保存，不存储明文。

验证或登录成功后，服务设置 `anc_session`：HttpOnly、SameSite=Lax，生产环境 Secure，30 天到期。Web 只通过 `/v1/auth/session` 恢复身份，不读取 Cookie 内容。Human API 同时保留 Bearer 认证供契约测试和非浏览器客户端使用。

## 4. 数据恢复与变化同步

进入 Workspace 后，Web 先读取 bootstrap cursor，再并行加载 members、agents、当前可见 Workspace Channels/DM 与可发现 Projects。进入 Project 时再加载其 members 和当前可见 Project Channels。Membership/audience change 会同时刷新 participant projection 与 `@Agent` 候选；governance-only private Channel 只加载基本信息和参与者，不请求 Message 或 Artifact。随后每 2 秒读取变化流；页面隐藏时暂停，重新可见或网络恢复时立即追赶。

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
workspace_join_link  → Join Link directory
workspace            → Workspace bootstrap/list
```

客户端不从变化 payload 推导第二套领域状态。刷新或重新登录后，全部可见状态仍从 Workspace Authority 恢复。

## 5. 写入与并发

所有公开写入由 API client 附带 UUID `Idempotency-Key`，TanStack Query 不自动重试 mutation。实体治理提交当前 revision；`409` 冲突直接呈现给 Human，再读取最新权威投影。Message 发送成功才清空草稿；失败保留输入，避免丢失 Human 内容。

结构化 `@` 由成员选择器产生 `mentionedActorIds`，显示文本中的 `@name` 只用于阅读。只有所选 actor 为 Agent 时才创建 Agent Request。Artifact 不进入 `@`；`+` 提交 `artifactSelections[{artifactId,snapshotId|null}]`：Markdown/File 的 `null` 表示发送时固定 Current State，URL 必须为 `null` 并直接固定 locator，不显示 Snapshot 选择。

## 6. 联调边界

- OpenAPI：`docs/contracts/openapi.json`
- Web 生成类型：`web/src/api/generated.ts`
- Web API 封装：`web/src/api/client.ts`
- Workspace 恢复与导航：`web/src/workspace/WorkspaceShell.tsx`
- Conversation：`web/src/workspace/ConversationPage.tsx`

修改 HTTP schema 后必须运行 `npm run openapi`，再运行 `npm run typecheck && npm test && npm run build`。生产构建由 Fastify 静态托管 `web/dist`，非 `/v1` 的未知 GET 路径回退到 `index.html`。
