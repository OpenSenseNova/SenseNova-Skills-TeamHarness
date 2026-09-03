# ANC Local Computer

Local Computer 是 AI-Native Collaboration 的独立本地执行客户端。它连接协作服务、检测本机 ACP Runtime，并在本机保管运行数据与凭据边界。

```bash
npm install --global 'https://your-server.example/downloads/anc-local-computer.tgz'

anc-computer connect --server 'https://your-server.example' --token '<computer-token>'
anc-computer service install
```

连接配置以 `0600` 权限保存在操作系统的用户级应用数据目录。macOS 的 `service install`
会安装用户级 LaunchAgent、立即启动 Local Computer，并在以后登录时自动运行。它常驻轻量
Computer supervisor，并为每个 Mention/WorkItem logical Session 维持独立 ACP runtime cache；`teamctl` 权限绑定
Agent 的 Runtime Binding revision 与 Session key，在 Agent 重启、删除或换绑后失效。

```bash
anc-computer service status
anc-computer service restart
anc-computer service stop
anc-computer service logs
anc-computer service uninstall
```

`stop` 只停止当前登录会话，LaunchAgent 仍保留并会在下次登录时启动；`uninstall` 删除
LaunchAgent，但不会删除连接配置、数据库或 Agent 工作目录。需要临时前台调试时可运行
`anc-computer run`；前台与后台实例不能同时运行。

Agent 任务使用本机隔离的临时 scratch 目录；Project 不再绑定 Repository 或 Working Copy。

每个 logical Session 会在 Runtime 的 `PATH` 中注入一个受控 `teamctl`。服务端只发送
`agent.inbox_changed` 轻量通知；Runtime 通过 `teamctl` 在当前 Session 内检查 Inbox、领取对应
Mention 的消息与 Discussion change，并通过本地候选与 Workspace 原子 freshness check 发布普通 Conversation Message。
Runtime 不会收到用户消息正文、服务端路径、manifest 或上下文文件提示。

```bash
teamctl work-item list [--project-id <project-id>]
teamctl work-item read <work-item-id>
teamctl work-item comment <work-item-id> --body '进展或结果' [--mention <agent-id> ...]
teamctl work-item block <work-item-id> --reason '等待访问权限'
teamctl work-item submit <work-item-id> --artifact-version-id <artifact-version-id> [--comment-id <result-comment-id>]
teamctl inbox check
teamctl message check --target conversation:<conversation-id>
teamctl message read --target conversation:<conversation-id>
teamctl message resolve <message-id> --target conversation:<conversation-id>
teamctl message send --target conversation:<conversation-id> --body '结果已发布。' [--artifact-version-id <version-id> ...]
teamctl message draft get --target conversation:<conversation-id>
teamctl message send --target conversation:<conversation-id> --send-draft [--anyway]
teamctl message draft discard --target conversation:<conversation-id>
teamctl artifact read <artifact-id>
teamctl return no-output --target <discussion-target>

teamctl artifact publish --file ./result.md --artifact-name result.md
teamctl artifact publish --file ./result.md \
  --artifact-id <artifact-id> --expected-latest-version-id <version-id>
teamctl artifact publish --file ./derived.pdf \
  --parent-version-id <parent-version-id> --artifact-path reports/derived.pdf

teamctl artifact publish --send-draft --draft-id <draft-id> [--anyway]
teamctl artifact draft get --draft-id <draft-id>
teamctl artifact draft discard --draft-id <draft-id>
```

`work-item list/read` 返回当前 Agent 有效 Project Membership 下可读取的非终态 WorkItem，以及可选的来源 Conversation、Message、Thread ID；读取资格不会自动唤醒 Agent。分配、WorkItem 评论中的显式 `@mention` 或明确触发才会产生注意事件。`block` 和 `submit` 会先读取当前 WorkItem，再携带 `revision + assignmentRevision` 提交，因而旧分配上的延迟命令会被服务端拒绝。Agent 先通过 `artifact publish` 发布结果文件，再用 `work-item submit --artifact-version-id` 创建独立 Result Submission；`--comment-id` 仅用于附加说明，不是交付物本身。

Local Computer 按 `Agent × (Mention agentRequestId | WorkItem workItemId)` 隔离 ACP Session、Gateway、receipt、held draft 和工作目录。Runtime Session 只是可丢弃缓存，Session Input 会从 Workspace 事实重建 JSONL；不同 Session 不共享上下文。

在 `message send` 或 Discussion `return no-output` 前必须再次运行 `message check`。Message 发送返回
`status: "held"` 是可处理结果，不是工具故障：正文仍只保存在本机，Workspace 没有创建 Message。
Agent 可用新 `--body` 修订、用 `--send-draft` 原样重试、用 `message draft discard` 丢弃，或在至少
一次 hold 后用 `--send-draft --anyway` 知情强发。

Artifact 追加使用 `expected-latest-version-id` 做 CAS；并发冲突会耐久保存为 Held Draft。返回 `held` 时 Workspace 没有创建或更新 Artifact，Local Computer 会在当前 Logical Session 显式发起复核 turn。Agent 必须先 `artifact read` 当前版本，再用同一 `draftId` 原样重试、丢弃，或在 hold 后使用 `--anyway` 强制发布。成功发布会生成 Workspace change history，但不会生成 Agent Inbox Item 或 Runtime wake。

Artifact 是 Project 内的文件级结果系列，不再有 Markdown/File/URL 类型、Current State、Snapshot 或在线编辑。Message 固定引用发送时的 Artifact version；Resource 和外部 Link 只能通过对应 Project API 读取，Agent 没有写入口。Runtime 不会获得 Computer token。
