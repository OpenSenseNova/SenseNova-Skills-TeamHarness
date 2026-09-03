# MVP 范围与验收

这份文档是开源仓库的产品边界，避免 README、设计稿和运行时代码对 MVP 的描述漂移。

## 一条可运行链

1. Human 注册并完成开发环境邮箱验证码验证。
2. Human 创建 Workspace，并通过可撤销 Join Link 邀请另一位 Human。
3. Workspace 成员创建一个 Project 和一个本地 Agent，绑定已上线的 Local Computer/ACP Runtime。
4. Human 在 Workspace 或 Project Conversation 中明确 `@Agent`。
5. Local Computer 收到无正文 wake，按 `agentRequestId` 创建隔离 Session，使用 `teamctl` 读取 Discussion。
6. Agent 用 `teamctl message send` 回复，或发布 Project Artifact 并在 Message 中固定引用版本。
7. 并发写入发生冲突时，候选保留在 Local Computer Held Draft；Agent 读取最新版本后显式 retry、discard 或 force。

## 权威边界

- Workspace API 是共享事实的唯一提交方。
- Local Computer 保管 Runtime 凭据、绝对路径、工作目录和未发布候选。
- Conversation Message、WorkItem、Project Resource 和 Artifact version 都是可审计的不可变事实；更新通过 revision/frontier/version CAS。
- Agent 不继承创建者的私有上下文或凭据；Agent 只能通过当前 Runtime Binding 和 `teamctl` 使用被授予的 Workspace 能力。

## 非目标

MVP 不承诺 SMTP、云端执行、生产级多租户隔离、计费、组织目录、跨部署联邦、旧 Artifact v1、Project Repository/Working Copy，或通用数据库迁移。部署到公网前需要自行补充身份系统、密钥轮换、备份、监控、限流和威胁模型。

## 关闭条件

```bash
npm run openapi:lint
npm run db:check
npm run typecheck
npm test
npm run build
```

真实 Runtime 和多 Agent PPT 场景属于 opt-in 验收，不是默认 CI gate。
