# Artifact v2 与 Project 资源

Project 资源由三个产品区域组成：`resources` 是可变的项目资料文件树，`artifacts` 是单文件结果及其不可变版本链，`links` 是不抓取内容的外部链接元数据。三者都以 Project 为边界，读取和预览需要当前 Project 成员权限。

## API

- `GET/POST /v1/projects/:projectId/resources`：列出或上传资料；`/folders` 创建目录。
- `GET/PUT/PATCH/DELETE /v1/project-resources/:resourceId`：读取、按 revision 替换、整理、回收和恢复资料。
- `GET/POST /v1/projects/:projectId/artifacts`：文件发布。发布已有 Artifact 时必须提交 `artifactId` 和 `expectedLatestVersionId`；冲突会生成 Held Draft。
- 发布请求支持 `Idempotency-Key`；Agent 侧以 `draftId` 作为稳定发布身份，响应丢失后的重放返回原版本而不会重复追加。
- `POST /v1/projects/:projectId/artifacts/from-resource`：读取发布瞬间的 Resource 内容，并记录实际 revision/digest。
- `POST /v1/projects/:projectId/artifacts/from-resources`：按文件独立发布；使用 `items[]` 时可为每个文件指定 `artifactId`、CAS 版本和项目路径，返回逐文件成功/失败结果。
- `GET /v1/artifact-v2/:artifactId/versions`、`GET /v1/artifact-versions/:versionId/{preview,download,context}`：历史、预览、下载和创作上下文。
- `GET/POST /v1/projects/:projectId/links`：创建和列出链接；locator 创建后不可变。
- Agent 运行时使用 `/v1/computers/self/agents/:agentId/projects/:projectId/...` 读取 Resource/Link 元数据、读取 Artifact 元数据并发布 Artifact；该命名空间没有 Resource/Link 写接口。

版本号是 Artifact 内单调递增的 `v1/v2/...`，同时使用 UUID `versionId`。版本和资源删除进入 7 天回收期，内容清理后保留墓碑。派生 Artifact 只接受创建时显式提交的同 Project `parentVersionIds[]`，不会按文件名、路径或内容推断。

开发数据库按 Workspace 与 Local Node schema v1 直接重建；旧开发数据库不作为受支持输入。Agent 可读 Resource/Link 元数据，并通过 Artifact 发布接口上传结果，但不能写 Resource、Link 或删除项目资源。
