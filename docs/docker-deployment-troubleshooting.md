# 新部署的 Docker 镜像检查

如果创建评测时提示 `Released benchmark database incomplete`，先补齐数据库题库：保持后端运行，在项目根目录执行 `node scripts/seed-benchmark.mjs`，确认失败、缺失、哈希不符均为 0，然后刷新页面重新创建评测。该错误在 Docker 执行前产生；更新代码和磁盘上的 JSON 不会自动更新 SQLite 中的题目。默认导入只新增或更新发行定义，不删除其他题目或历史成绩。

启动日志也会检查题库缺失与哈希漂移。`pnpm bank:sync` 同步题库，`pnpm bank:check`（`node scripts/seed-benchmark.mjs --check`）只读检查数据库；首次部署先配置 `.env` 并运行 `pnpm db:push` 初始化表结构。后端端口或地址不同，请设置 `BASE_URL`：PowerShell 使用 `$env:BASE_URL='http://127.0.0.1:端口'`，macOS/Linux 使用 `BASE_URL=http://127.0.0.1:端口 pnpm bank:sync`。应指向运行该版本的后端，避免导入到另一套数据库。

升级到 v0.2.9 后，在后端运行期间执行 `pnpm bank:sync` 和 `pnpm bank:check`。本版未修改题库或评分规则；原题哈希和历史冻结运行保留。

在项目根目录、以运行后端的同一账号和环境执行：

```sh
node scripts/check-docker-images.mjs
node scripts/check-docker-images.mjs --json
```

命令只读取 Docker 引擎和题库显式声明的镜像，不拉取、不构建、不调用模型、不改数据库或题目哈希。失败返回退出码 1。JSON 包含完整受影响题号；可用 `--bank path/to/benchmark.json` 检查部署版本对应的题库。

检查范围是 `executionCases`、`executionWorld`、`executionShell`、Docker `agentLoop` 和 `requirements.image`。通过只表示这些镜像契约满足；评分器内置的其他语言镜像、目录挂载、编译器与实际容器执行需要另行验证。

## 如何理解结果

- `cli_missing`：后端账号的 PATH 中找不到 Docker CLI。
- `unavailable`（引擎）：Docker 未启动、连接不可达或账号没有权限；看随附的原始错误。Windows 自动启动只在 Docker Desktop 可被找到时尝试，macOS/Linux 需要自行启动引擎。远程部署应在实际运行后端的环境里检查。
- `unsupported_os`：当前引擎是 Windows containers；这些测试需要 Linux containers。
- `unavailable`（镜像）：当前引擎中无法 inspect 所需镜像；看随附错误。
- `id_mismatch`：镜像存在，但实际 `.Id` 不等于题库的固定 ID。拉取同名 tag 不能保证满足契约，重新构建也可能产生不同 ID。

当前题库使用 `benchlocal/cli-40-verifier:local`、`zxbench/python-node:2026-09-26` 等自定义镜像。不能仅凭镜像名假设公共仓库有对应发布，也不能用其他镜像替换后继续声称运行的是同一冻结题包。`python-node` 的 Dockerfile 在 `data/execution/images/python-node/`，但本地重建后仍需核对固定 ID。

`zxbench/workflow-contracts:2026-10-01` 有已发布的冻结镜像资产，可运行 `pnpm runtime:workflow` 下载并校验；其他镜像是否就绪以诊断结果为准。该命令只准备工作流技能题所需的 PyYAML 镜像。

## 将已验证镜像迁移到新机器

如果维护者机器已经能通过检查，可以先导出这批显式镜像，在新机器导入，再检查实际 ID。这会保留导出镜像的内容；目标引擎必须能运行其架构，当前这批本地验证镜像为 Linux amd64。

维护者机器（项目根目录，需足够磁盘空间）：

```sh
docker image save -o zxbench-execution-images.tar python:3.12-alpine node:22-alpine gcc:13 bash:5 zxbench-java-spring:3.2.5 benchlocal/cli-40-verifier:local zxbench/python-node:2026-09-26 zxbench/workflow-contracts:2026-10-01
```

将文件交付给部署者，在部署机器执行：

```sh
docker image load -i zxbench-execution-images.tar
node scripts/check-docker-images.mjs
```

这份列表对应当前题库的显式引用，不包含所有评分器内部的语言镜像。发布版本变化后重新检查清单；完整镜像发行还需要为评分器内部依赖提供可获取的固定镜像。不要运行 `pin-docker-pilot-images.mjs` 来掩盖新机器的 ID 不匹配：它会重写开发题包的镜像 ID 与题目哈希。

Docker 运行恢复后，未完成的评测可继续；已生成但因环境失败的答案应走[保存答案恢复流程](docker-readiness-and-saved-answer-recovery.md)，避免重新生成。
