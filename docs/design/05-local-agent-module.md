# Local Agent Module 与 ACP Runtime

> 状态：Persistent Agent Session 已实现
> 契约版本：1.0.0
> 上下文与 Inbox 细节：`docs/design/08-context-and-privacy.md`

## 1. 核心对象

| 对象 | 含义 | 生命周期 |
|---|---|---|
| Workspace Agent | 团队中的稳定身份、作者与权限主体 | 长期 |
| Runtime Binding | Agent 在某台 Computer 上选择的 Runtime、模型和配置 | 可替换，revision fencing |
| Logical Session | 一个 Mention (`agentRequestId`) 或 WorkItem (`workItemId`) 的隔离上下文边界 | Mention 完成即关闭；WorkItem 随任务生命周期 |
| Runtime Session cache | Logical Session 对应的 ACP process/session、Gateway 和工作目录 | 可丢弃，按 JSONL 重建 |
| Agent Inbox | Agent 可见 Message 的服务端权威投递队列 | 持久、可重放 |
| Run / Attempt | 需要独立预算、权限、Repository/worktree 或审计的任务执行事实 | 短期、与聊天分离 |
| Runtime | Codex、Claude、Gemini、Goose、Hermes 或扫描到的通用 ACP 实现 | 协议适配器启动 |

Runtime 不是新的 Workspace Principal。它代表当前 Agent 使用本地 `teamctl` Gateway 读写 Workspace；服务端仍按 Agent Membership 与 Binding revision 鉴权。

## 2. 当前主链路：持久 Agent 消息流

Local Computer 为每个绑定 Agent 按 logical Session 维护独立 Runtime cache：

```text
Workspace Agent
  └─ active Runtime Binding on Computer
       ├─ Mention Session (agentRequestId)
       └─ WorkItem Session (workItemId)
            ├─ one ACP process/session per logical Session
            ├─ one Session work directory
            ├─ one teamctl IPC Gateway
            ├─ processing
            └─ wakePending
```

第一次启动：

```text
GET Agent session-input?kind=<mention|work_item>&key=<id>
→ dynamically rebuild Workspace/Project/Conversation or WorkItem JSONL
→ open or load the cache for this logical Session and contextHash
→ send developer instructions + Session JSONL + wake
```

后续事件：

```text
agent.inbox_changed
→ find the matching logical Session trigger
→ if a turn is active: set wakePending
→ otherwise: send only "Agent Inbox changed."
→ Runtime pulls and completes Inbox targets with teamctl
```

不同 Mention（即使来自同一 DM/Conversation）不会复用 Runtime 上下文；每个 `agentRequestId` 都有独立 Session。一个 Mention Session 的 JSONL 只包含触发点之前最多 200 条 scope history；若触发消息引用 WorkItem，则额外提供引用的 WorkItem ID，Agent 通过 `teamctl work-item read <id>` 获取最新任务和 Artifact。`work-item list/read` 的读取范围由 Project membership 决定，同一 Project 内未被当前消息引用的 WorkItem 也可读取；WorkItem Session 包含当前任务与全部评论。

## 3. 本地目录

持久聊天 Session 使用 Local Computer 应用数据目录：

```text
agents/<agent-id>/<mention|work_item>/<session-key>/
├── work/             # 当前 Session 工作区；Markdown/File read 在 work/artifacts 下物化内容
├── held-artifacts/   # 当前 Session 未发布托管 Artifact 的冻结内容
└── bin/              # 当前 Session Gateway 注入的 teamctl launcher
```

这里没有聊天 Attempt 的 `input/`、`output/`、manifest、context-feed 或 scratch。Gateway 不为每个命令写回传文件或 RuntimeReturnEnvelope；普通 Message 与 Artifact 直接通过 IPC 代理提交 Workspace。

`artifact publish --file` 的输入文件必须位于 Agent `work/` 内，Local Computer 会为 held publication 冻结一份私有内容；这是 Local Computer 的路径边界，不是服务端路径。`artifact publish --url` 不读取本地文件，也不探测目标地址。Workspace 只在 freshness 通过时创建或更新 Artifact，共享状态不接收本机绝对路径。

## 4. `teamctl` Gateway

Local Computer 创建短期 socket capability，把 `teamctl` 放入 Runtime 的 `PATH`，但不把 Computer Token 暴露给 Runtime。Gateway 固定绑定：

```text
Agent ID
Workspace membership
Computer
Runtime Binding revision
Local Agent work directory
```

每个请求经过以下边界：

1. 本地 socket token 校验；
2. 命令与参数结构校验；
3. 本地文件 realpath/workdir 校验（仅文件操作）；
4. Local Computer 使用自己的凭据调用 Computer API；
5. Workspace 重新校验 Agent、Membership、Binding revision、Discussion Scope 或 Artifact 权限；
6. mutation 使用幂等键与 claim receipt。

Project WorkItem 也经过同一个 Gateway：`work-item list/read` 拉取当前分配，`block` 报告结构化阻塞，`submit` 把已发布在 Primary Discussion Scope 的 Message 登记为不可变 Result Submission。后两条命令同时携带 WorkItem revision 与 assignment revision；Human 侧的重分配、成员移除、完成或取消会推进 fence，使旧 Agent session 的延迟命令失效。

完整命令和上下文契约见 `docs/design/08-context-and-privacy.md`。

## 5. Runtime Adapter

所有 Runtime 共用一个 `RuntimeIntegration` / ACP Adapter，不为 Codex、Claude 或某个“自定义 ACP”建立独立消息模型。Runtime catalog 只负责：

- 扫描本机确实可启动的 ACP command；
- 上报稳定 Runtime ID 与能力；
- 用统一的 ACP initialize/session new-or-load/prompt/cancel/close 流程启动；
- 将模型、reasoning effort 和 mode 作为配置传递。

创建 Agent 页面只展示当前 Computer 实际探测到的 Runtime。所谓“自定义 ACP”是通用扫描/注册能力，不是一个可单独选择的虚拟 Agent。

## 6. Session 恢复与 Restart

Local Node `runtime_sessions` 保存 logical Session key、context hash、不透明 Runtime session ID、adapter instance ID、首次说明是否已发送和最新 Inbox sequence。Local Computer 重启时：

1. 使用相同 Agent + Session kind/key + context hash + adapter instance ID 查找活动记录；
2. Runtime 支持 load 时恢复同一 Session；
3. Runtime 明确报告 session 不存在时标记旧记录 lost，再创建新 Session；
4. 不复制 Runtime 私有历史到 Workspace。

Agent Restart：

- 递增 Runtime Binding revision；
- 把旧 revision 的 claimed Inbox Item 退回 pending；
- 终止旧 receipt 与本地 ACP Session/capability；
- 下一次 wake 按新 revision 创建或恢复新的 Session；
- 保留 Agent、Conversation、Message、Artifact 和 Inbox 历史。

## 7. Run / Attempt 的边界

Run/Attempt 不参与以下操作：

- Agent DM 或 `@Agent` 消息领取；
- Conversation 历史读取；
- 普通 Agent Message 发布；
- 持久 Agent Session 内的 Artifact read/publish。

Run/Attempt 只在调用方明确发起“独立执行任务”时使用，例如：

- 固定 Project Repository identity 与 base commit；
- 创建隔离 Git worktree；
- 固定一次性 Policy、预算、deadline 或 Private Context Grant；
- 支持独立取消、失败、重试与结果审计。

这种任务未来由独立的 execution dispatcher 交给 Local Computer。它可以复用同一个通用 ACP Adapter，但不能复用聊天 Inbox receipt，也不能把聊天消息伪装成 Run objective。

## 8. 完成与故障语义

- ACP `end_turn` 只表示本次模型 turn 结束；Discussion Inbox target 必须由成功的 `message send`、成功的 `return no-output` 或 Message Held Draft 的后续显式决策完成。Artifact Held Draft 独立于 Inbox receipt，发布或丢弃只终止该 Artifact 候选。
- Runtime 未完成任何 claimed target 就结束 turn：Local Computer 将 Session 标为失败并保留 receipt 供恢复。
- Runtime stdout/stderr 不会自动成为 Conversation Message。
- Local Computer 或 Runtime 崩溃：未完成 receipt 与 `pending | held` 本地草稿可恢复；`pending` 使用原幂等键重放，不创建第二条 Message。
- Runtime 忙碌时的新 wake 只设置 `wakePending`，不会并行调用同一 Session。
- Workspace 暂时不可用：不确认 Inbox，不伪造本地成功。
- Binding revision 不匹配：所有旧 Session 读写 fail closed，旧本地草稿标记为 `fenced`。

## 9. 验收

- 每个 Mention/WorkItem 使用独立 ACP process/session 与工作目录；
- 不同 Session 的 JSONL、receipt、held draft 与 Runtime cache 不能互相读取；
- 普通 Channel Message 不唤醒，explicit mention 拉取完整 scope delta；
- Agent Inbox 只包含 Message；Workspace Change 不投影、不唤醒；
- 首次 Prompt 包含完整 CLI 与该 Session JSONL，后续 Prompt 只有该 Session 的 wake/addendum；
- Message 与 Artifact publication 不创建或引用 Run/Attempt；
- 同 Scope Message 竞态返回精确 delta；Artifact base hash 竞态返回 current hash；两者都支持修订、原样重试、丢弃和一次 hold 后强发；
- receipt 可重放，Restart 后旧 capability 失效；
- 所有本机 Runtime 走同一个 ACP Adapter 和 Runtime catalog；
- 日志、Workspace change、audit 与 API 不泄漏本机绝对路径或 Computer Token。
