# 安全说明

AI-Native Collaboration 当前是早期自托管项目，本身不是生产安全边界。对公网开放前，请补充经过加固的身份系统、TLS 和代理策略、密钥轮换、备份、监控、限流及威胁模型评审。

请保护 `.env`、session secret、computer token、SQLite 文件、Local Computer 工作目录和服务日志。Runtime Binding 使用最小权限，泄露的 Join Link 或 computer token 要及时撤销。Artifact 和 Conversation 内容都应按敏感 Workspace 数据处理。

## 漏洞报告

可利用的漏洞不要创建公开 Issue。请通过 GitHub Security Advisory 或部署方配置的维护者私密联系方式报告，并附上受影响版本/tag、最小复现、影响范围和已脱敏日志。我们会确认收到报告，协调修复，并在适合披露时发布变更说明。

当前支持最新的 `v0.1.x` tag。安全策略完善前，其他 tag 和自定义部署均需要自行评估。
