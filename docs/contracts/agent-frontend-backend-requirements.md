# Agent 前端所需后端能力

状态：Runtime 配置、Skills 只读资源与 Workspace Document Library 已进入后端正式契约；前端接入待联调
范围：Agent 创建、Agent 管理、Conversation 中的 Agent 执行反馈

## 1. 原则

前端只消费后端正式返回的数据，不自行发明或推断运行配置。

- Agent 没有 Standing Context；模型、推理强度和运行模式属于 Runtime Binding，Skill 属于 Computer/Runtime，团队规则和知识属于 Workspace Document Library。
- 不从浏览器扫描本机目录，也不根据 Runtime 名称硬编码模型或 Skill。
- 后端先更新 `docs/contracts/openapi.json`，再生成 `web/src/api/generated.ts`，前端随后接入生成类型。
- 字段名、枚举值和资源拆分方式由后端在 OpenAPI 中确定；本文只描述页面所需的数据和行为。

## 2. 当前已有能力

| 页面需求 | 当前接口 | 当前可用数据 |
| --- | --- | --- |
| 创建 Agent | `POST /v1/workspaces/{workspaceId}/agents` | 名称、描述、Computer 与 Runtime 绑定 |
| 查看 Agent | `GET /v1/workspaces/{workspaceId}/agents/{agentId}` | 基础资料、生命周期、创建者、Runtime 绑定 |
| 查看 Computer | `GET /v1/computers` | 在线状态、Runtime 可用性、检测版本 |
| 修改 Runtime 绑定 | `POST /v1/workspaces/{workspaceId}/agents/{agentId}/runtime-bindings` | Computer 与 Runtime |
| 团队规则与知识 | Workspace Documents 接口 | 版本化 Markdown 团队文档 |
| 运行限制 | Execution Policy 接口 | 并行数、运行时长、上下文预算、工具调用上限 |
| 删除 Agent | `DELETE /v1/workspaces/{workspaceId}/agents/{agentId}` | 删除并保留历史消息与审计记录 |
| Conversation 执行状态 | `GET /v1/conversations/{conversationId}/agent-requests` | Request 状态与 intake 投影 |

## 3. Agent 创建页缺少的数据与操作

用户选择 Computer 和 Runtime 后，前端还需要后端返回该 Runtime 当前真实可用的配置选项：

1. 可选模型，以及默认模型；
2. 每个模型支持的推理强度，以及默认推理强度；
3. 可选运行模式，以及默认模式；
4. 选项不可用时的结构化原因，例如未安装、未登录、版本不支持或 Computer 离线；
5. 创建 Agent 时能够原子保存 Runtime 绑定和上述运行配置，避免 Agent 已创建但配置未保存的半完成状态；
6. 后端校验所选配置确实属于当前 Computer 上的当前 Runtime，不能只相信前端提交值。

验收结果：刷新创建页或重新打开已创建 Agent 时，前端展示的选项和最终保存值都来自后端，不依赖前端常量。

## 4. Agent 管理页缺少的数据与操作

Agent 详情需要一个正式的“当前有效运行配置”读模型，至少能够表达：

- 当前 Computer 与 Runtime；
- Runtime 检测版本和连接状态；
- 当前有效模型；
- 当前有效推理强度；
- 当前有效运行模式；
- 每项配置是显式选择还是 Runtime 默认值；
- 配置的并发控制版本，用于阻止覆盖其他人的修改。

同时需要正式的更新操作：

- 只接受该 Runtime 实际支持的组合；
- 使用 expected revision/version 处理并发修改；
- Runtime 下线或能力变化后，返回结构化失效状态和原因；
- 更新成功后，详情读取立即返回新的有效配置。

Execution Policy 只承担运行限制。Agent 资料、Runtime Binding、Computer Skill inventory 与 Workspace Documents 是四个独立资源。

## 5. Skills 页缺少的数据与操作

前端通过 `GET /v1/workspaces/{workspaceId}/agents/{agentId}/skills` 获取当前 Agent Binding 对应的真实 Skill 清单，不解析 Prompt，也不猜测本机目录。每个 Skill 返回：

- `id`、`name`、`displayName`、`description`；
- `source` 与 `scope: global | workspace`；
- `installed`、`enabled`、`runtimeCompatible`；
- 可选 `version` 与内容 `revision`；
- `userInvocable` 与可空 `unavailableReason`。

还需要区分：

1. Computer 上可用的 Skills；
2. 当前 Agent 已启用的 Skills（Agent endpoint 按当前 Binding 投影）；
3. Runtime 不兼容或暂时不可用的 Skills。

当前 V1 是只读发现：Local Computer 对 Codex 扫描 Codex user/system 与 Agent Skills 标准目录，对 Claude 扫描 Skills/commands 目录，读取 `SKILL.md` 或 command Markdown 的受限 frontmatter。Workspace Authority 只保存脱敏 metadata 和 digest，不接收绝对路径或 Skill 正文。安装、启用和停用命令尚未开放，前端不得伪造操作按钮。

该边界与 Raft 的实际做法一致：页面请求的是 Computer daemon 的 Skill inventory，daemon 按当前 Runtime 与 Agent workspace 扫描本机目录后返回；Skill list 不是 ACP `initialize` 的返回值，也不是从 Agent persona 或 Prompt 推导出来的。本项目采用 HTTP catalog report 代替 Raft 的 daemon event，但权威边界相同。

验收结果：Agent 管理页可以显示真实数量、名称、说明和状态；换 Computer 或 Runtime 后，清单由后端重新计算。

## 6. Conversation 中的 Agent 执行反馈

Conversation 现在具有正式生命周期字段：

- `lifecycleStatus: active | archived`
- `revision`
- `archivedAt`
- `archivedByMembershipId`

默认列表只返回 active Conversation；归档管理页使用
`GET /v1/workspaces/{workspaceId}/conversations?lifecycleStatus=archived` 或对应 Project 列表。
操作接口为：

- `POST /v1/conversations/{conversationId}/archive`
- `POST /v1/conversations/{conversationId}/restore`

两者提交 `expectedRevision` 和 `Idempotency-Key`。归档保留 Message/Thread/Run provenance，并让 Conversation 只读；恢复后重新可写。存在 pending Agent Request 或 active Run 时后端返回 `CONVERSATION_HAS_ACTIVE_EXECUTION`，前端应提示用户先取消或等待结束。产品不提供物理删除 Conversation。

交互约束如下：

1. Human 的 `@Agent` 内容只作为普通 Human Message 展示；
2. Agent Request/Run 的等待、执行和失败状态在 Conversation 左下角的执行区展示，不在消息流中插入 Request 卡片；
3. Runtime 完成工作后，由 CLI 使用 Agent 身份向 Conversation 发送普通 Agent Message；
4. Agent Message 需要携带后端可验证的 Request/Run 来源关联，供审计和线程定位使用，但视觉上仍是普通消息；
5. Request 与 Run 可以完成但不产生消息，Message 也不能被前端根据 Request 状态自行伪造；
6. Conversation 的 Request 列表应提供 Agent 身份、当前阶段、开始/更新时间和结构化失败原因，供左下角状态区渲染；
7. 用户取消尚未执行的 Request 时不要求输入文本理由。后端记录系统定义的取消原因和操作者即可。

## 7. 错误与权限要求

所有新增读取和操作都需要：

- 校验 Workspace、Agent、Computer 与 Runtime 的归属关系；
- 返回稳定的机器可读错误码，并附可直接展示的简短说明；
- 区分无权限、资源不存在、Computer 离线、Runtime 不可用、配置组合不支持和版本冲突；
- 不向无权限用户泄露本机路径、密钥、环境变量或私有 Skill 内容；
- 删除或暂停 Agent 后，阻止新的执行，但不删除历史 Conversation Message。

## 8. 联调顺序

1. 后端确认资源边界、字段名和枚举；
2. 后端实现并补齐接口测试；
3. 更新 `docs/contracts/openapi.json`；
4. 重新生成 `web/src/api/generated.ts`；
5. 前端使用生成类型接入创建页、管理页和 Conversation 状态区；
6. 端到端验证“创建 Agent → 绑定 Runtime → 查看配置与 Skills → @Agent → 左下角显示执行 → Agent 在 Conversation 中回复 → 无理由取消等待请求”。

## 9. 已落地的 Runtime 配置契约

Local Computer 先通过 ACP `initialize` 和 `session/new` 探测 Runtime，再调用
`PUT /v1/computers/self/runtime-catalog` 上报以下字段：

- `runtimeId`
- `availability`
- `detectedVersion`
- `configuration.models[]`、`defaultModelId`
- `configuration.reasoningEfforts[]`、`defaultReasoningEffort`
- `configuration.modes[]`、`defaultModeId`
- 不可用时的 `unavailableReason.code` 与 `unavailableReason.message`

每个模型还包含 `supportedReasoningEfforts`。Local Computer 会在隔离的探测 Session 中切换
ACP model config，并从每次返回的完整 `configOptions` 读取该模型的 reasoning-effort 选项。
值为 `null` 表示 Runtime 没有返回这个模型的细粒度约束；后端不会把未知约束伪造成空列表，
Human Web 也不会在这种情况下提供显式推理强度选择。空数组表示该模型明确不提供推理强度配置。

Human 通过 `GET /v1/computers` 读取同一份已校验的能力快照。Workspace 不接收本机命令、
绝对路径、环境变量或认证信息。

创建 Agent 时，`runtimeBinding` 可以原子提交 `computerId`、`runtimeId`、`model`、
`reasoningEffort` 和 `mode`。更新现有绑定仍使用
`POST /v1/workspaces/{workspaceId}/agents/{agentId}/runtime-bindings`，并且必须提交
`expectedRevision`；尚无绑定时该值为 `0`。后端只接受当前 Computer、当前 Runtime 能力快照
中存在的选项和已声明支持的组合。

Agent 详情中的 `runtimeBinding` 正式返回：

- Computer、Runtime、连接状态、可用性和检测版本；
- `bindingRevision`，用于更新时的并发控制；
- `validatedRuntimeCatalogRevision`，表示该选择通过校验时使用的能力快照；
- `runtimeCatalogRevision`，表示当前 Computer 最新能力快照；
- `configuration.requested`，表示 Human 的显式选择，`null` 表示跟随 Runtime 默认值；
- `configuration.effective`，分别返回当前值和 `explicit | runtime_default | unavailable` 来源；
- `configuration.status` 与结构化 `invalidReason`。

Runtime 能力变化后，已保存的 Binding 不会被静默改写。详情读取会立即变为
`selection_unavailable`、`runtime_unavailable` 或 `computer_offline`；接受新 Run 时后端再次校验并
fail closed。模型、推理强度和 mode 只从固定 Binding revision 读取，Attempt 执行输入直接读取
固定的 Binding revision。

## 10. 已落地的 Workspace Document 契约

后端提供：

- `POST|GET /v1/workspaces/{workspaceId}/documents`
- `GET|PUT /v1/workspaces/{workspaceId}/documents/{documentId}`

Document 使用稳定 ID、expected revision 和不可变内容版本。响应包含 `version`、`revision`、`title`、`contentMarkdown`、`contentDigest`、创建者与时间。它是团队共享知识，不属于某个 Agent。V1 不把 Document 自动注入 Runtime，也不把 Document 更新放入 Agent Inbox；Runtime 只能通过后续明确授权的读取能力获取具体版本。
