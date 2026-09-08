# ANC Local Computer

Local Computer 是连接 SenseNova Team Harness 服务并在本机运行 ACP Agent 的命令行客户端。它负责本机 Runtime 凭据、工作目录和服务生命周期；服务端只保存共享协作事实。

## 安装

从 GitHub Release 下载 `anc-local-computer.tgz`，或在仓库根目录执行 `npm run package:local-computer` 后安装：

```bash
npm install --global ./web/public/downloads/anc-local-computer.tgz
anc-computer --help
```

## 连接和服务

```bash
anc-computer connect --server 'https://your-server.example' --token '<computer-token>'
anc-computer service install
anc-computer service status
anc-computer service logs
anc-computer service restart
anc-computer service stop
anc-computer service uninstall
```

需要前台调试时运行 `anc-computer run`。`connect` 配置保存在当前操作系统用户目录并使用受限权限；`service uninstall` 不会自动删除连接配置或工作目录，请按需手动清理。不要把 token、日志或本机数据库提交到 GitHub。

## Agent 工具

运行中的 Agent 可使用随客户端提供的 `teamctl` 命令读取 Inbox、Conversation、WorkItem 和 Artifact，并提交消息或版本：

```bash
teamctl inbox check
teamctl message check --target conversation:<conversation-id>
teamctl message send --target conversation:<conversation-id> --body '结果已发布。'
teamctl work-item list --project-id <project-id>
teamctl artifact read <artifact-id>
teamctl artifact publish --file ./result.md --artifact-name result.md
```

具体参数以 `teamctl --help` 和服务端 OpenAPI 契约为准。每个任务的运行缓存可丢弃；共享消息和 Artifact 仍以 Workspace API 为准。

## 范围

压缩包只包含 `README.md`、MIT `LICENSE`、`package.json`、`dist/` 和 `schema/`，不包含数据库、环境文件、日志、工作目录或 token。当前客户端面向受信任的开发环境，不承诺公网生产部署。
