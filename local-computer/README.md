# ANC Local Computer

Local Computer 是 AI-Native Collaboration 的独立本地执行客户端。它连接协作服务、检测本机 ACP Runtime，并在本机保管运行数据与凭据边界。

```bash
npm install --global 'https://your-server.example/downloads/anc-local-computer.tgz'

anc-computer connect --server 'https://your-server.example' --token '<computer-token>'
anc-computer run
```

连接配置以 `0600` 权限保存在操作系统的用户级应用数据目录。`run` 可从任意目录启动，不依赖任何 Project 的 `package.json`。

```bash
anc-computer project create --workspace <workspace-id>
anc-computer project bind --project <project-id>
anc-computer project clone --project <project-id>
anc-computer project cleanup --attempt <attempt-id>
```

Repository 路径与 Git 凭据始终留在本机；服务端只接收规范化 Repository identity 与脱敏状态。

每个 Attempt 会在 Runtime 的 `PATH` 中注入一个受控 `teamctl`。服务端只发送
`agent.inbox_changed` 轻量通知；Runtime 通过 `teamctl` 主动检查 Inbox、领取同一
Discussion Scope 的待处理消息，并将回复直接发布为普通 Conversation Message。
Runtime 不会收到用户消息正文、服务端路径、manifest 或上下文文件提示。

```bash
teamctl inbox check
teamctl message check --target conversation:<conversation-id>
teamctl message read --target conversation:<conversation-id>
teamctl message resolve <message-id>
teamctl message send --target conversation:<conversation-id> --body '结果已发布。'
teamctl return no-output --run <run-id>

teamctl artifact publish \
  --file ./result.md --name result.md --type markdown
```

更新既有 Artifact 时还必须传入当前上下文中的 `--artifact-id`、
`--expected-current-revision` 和 `--expected-content-digest`。Artifact bytes 先作为当前
Attempt 的 staged blob 上传，随后在 Run return 时提交版本 lineage；Message 则由
`teamctl message send` 立即发布并携带 claim receipt、Run、Attempt 与 Binding revision
的 provenance。Runtime 不会获得 Computer token。
