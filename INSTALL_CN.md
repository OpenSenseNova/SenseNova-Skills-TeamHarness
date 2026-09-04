# 安装指南

AI-Native Collaboration 使用 Node.js 24 和 npm 从源码运行。完成身份系统、密钥轮换、备份、监控和限流等安全措施前，请只在可信开发网络中使用。

## 服务端

```bash
git clone https://github.com/lgl0980/ai_native_collaboration.git
cd ai_native_collaboration
cp .env.example .env
npm ci
npm run dev
```

API 使用配置的服务端端口，Vite 开发页面默认在 `http://localhost:5173`。启动前编辑 `.env`；其中可能包含会话、数据库或 Runtime 密钥，禁止提交到 Git。

本地生产模式：

```bash
npm run build
NODE_ENV=production npm start
```

生产进程会提供编译后的 Web 静态资源，并暴露 `/health` 和 `/openapi.json`。默认 SQLite 数据目录由环境变量控制，实验前请先备份。

## Local Computer

本地构建 release 压缩包并安装：

```bash
npm run package:local-computer
npm install --global ./web/public/downloads/anc-local-computer.tgz
anc-computer --help
anc-computer connect --server 'http://localhost:3000' --token '<computer-token>'
anc-computer service install
```

压缩包只包含可执行产物、schema、包元数据、README 和 MIT 许可证，不包含数据库、`.env`、日志、工作目录或 token。命令和服务生命周期见 [local-computer/README.md](local-computer/README.md)。

## 校验与排查

```bash
npm run verify:public
npm run build
```

端口冲突时修改 `.env` 中的配置。Local Computer 无法连接时检查服务端 URL、token 权限、HTTPS/代理和 `anc-computer service logs`。不要在 Issue 中粘贴 token 或私有 Workspace 数据，漏洞请按 [SECURITY_CN.md](SECURITY_CN.md) 方式报告。
