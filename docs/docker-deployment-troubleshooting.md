# 新部署的 Docker 镜像检查

正常部署请先按 [README 的完整步骤](../README.md#部署按顺序执行) 完成配置、构建和题库同步。镜像自动准备入口为：

```sh
pnpm runtime:prepare --check
pnpm runtime:prepare
pnpm runtime:check
```

`--check` 只输出计划；实际准备跳过已满足契约的镜像，公共镜像按固定 digest 拉取，自定义镜像按独立 Release 资产下载并校验后导入。可用重复的 `--dimension`、`--scenario`、`--image` 限定范围，`--cache-dir` 指向预先下载的离线资产目录。下载地址、大小和内容摘要见 [运行时清单](../docker/execution-images/runtime.json)。未发布的冻结 ID 或不支持的镜像存储模式会在下载前报告阻断原因，不会修改题库。

离线目录复用针对 manifest 中的自定义镜像资产。公共镜像需先在联网机器按固定 digest 准备并单镜像导出，在离线机器核对 SHA-256 后 `docker image load`，再运行准备检查；`--cache-dir` 本身不会禁用公共镜像拉取。归档下载支持 HTTP_PROXY/HTTPS_PROXY/NO_PROXY；Docker 拉取另用引擎自己的代理配置。

如果创建评测时提示 `Released benchmark database incomplete`，先补齐数据库题库：保持后端运行，在项目根目录执行 `node scripts/seed-benchmark.mjs`，确认失败、缺失、哈希不符均为 0，然后刷新页面重新创建评测。该错误在 Docker 执行前产生；更新代码和磁盘上的 JSON 不会自动更新 SQLite 中的题目。默认导入只新增或更新发行定义，不删除其他题目或历史成绩。

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
- `unsupported_image_architecture`：镜像平台与当前引擎架构不匹配；当前发行镜像在 linux/amd64 上验证。
- `unavailable`（镜像）：当前引擎中无法 inspect 所需镜像；看随附错误。
- `id_mismatch`：镜像存在，但实际 `.Id` 不等于题库的固定 ID。拉取同名 tag 不能保证满足契约，重新构建也可能产生不同 ID。

当前题库使用 `benchlocal/cli-40-verifier:local`、`zxbench/python-node:2026-09-26` 等自定义镜像。不能仅凭镜像名假设公共仓库有对应发布，也不能用其他镜像替换后继续声称运行的是同一冻结题包。`python-node` 的 Dockerfile 在 `data/execution/images/python-node/`，但本地重建后仍需核对固定 ID。

## 将已验证镜像迁移到新机器

如果维护者机器已经能通过检查，可以先导出这批显式镜像，在新机器导入，再检查实际 ID。这会保留导出镜像的内容；目标引擎必须能运行其架构，当前这批本地验证镜像为 Linux amd64。

维护者机器（项目根目录，需足够磁盘空间）：先按目标用户对应的发行题库检查，再从该题库生成导出清单，避免手写列表遗漏或使用过时镜像名。

```sh
node scripts/export-docker-images.mjs --dry-run --output tmp/docker-transfer/zxbench-execution-images.tar
node scripts/export-docker-images.mjs --output tmp/docker-transfer/zxbench-execution-images.tar
```

可用 `--bank path/to/benchmark.json` 指定目标发行题库。脚本拒绝缺失镜像、ID 不符、架构不符和已有输出文件；只执行 inspect 和 save，不拉取、不构建、不重写题库。实际 tar 内的 tag、配置内容 ID 和平台再次核验成功后才生成正式文件，并附带 `.manifest.json` 与 `.sha256`。失败或中断保留 `.partial`，不得交付为成功镜像包。Manifest 记录原始题库文件 SHA-256、全部显式镜像及受影响题号，不包含数据库或模型答案。

将 tar 和两个校验文件交付给部署者，先核对 tar 的 SHA-256（Windows 可用 `Get-FileHash`，Linux 可用 `sha256sum -c`）及发行题库对应关系，再在部署机器执行：

```sh
docker image load -i zxbench-execution-images.tar
node scripts/check-docker-images.mjs
```

镜像包对应所选题库的显式引用，不包含所有评分器内部的语言镜像。发布版本变化后重新检查清单；完整镜像发行还需要为评分器内部依赖提供可获取的固定镜像。不要运行 `pin-docker-pilot-images.mjs` 来掩盖新机器的 ID 不匹配：它会重写开发题包的镜像 ID 与题目哈希。

## 按需获取，避免下载完整镜像包

先执行 `pnpm runtime:check`（或上面的诊断命令），只处理缺失或 ID 不符的镜像。公共镜像按冻结 digest 获取，再恢复题库使用的本地 tag；不要遍历历史 tag 猜测。2026-10-12 通过 Docker Hub Registry 的 HEAD 请求实测，下列三个冻结 digest 均返回 200 且 `Docker-Content-Digest` 完全一致：

| 镜像 | 已验证的 digest |
| --- | --- |
| `python:3.12-alpine` | `sha256:d09d15e60962ca365d1cd544a48773bac9d33f2fb1b00f2aa0deec78ade7dc31` |
| `node:22-alpine` | `sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32` |
| `gcc:13` | `sha256:056fa682471704249f619f65ccec87d671ad5f1b20878da54d60b0b863486621` |

例如只准备 Python：

```sh
docker pull python@sha256:d09d15e60962ca365d1cd544a48773bac9d33f2fb1b00f2aa0deec78ade7dc31
docker image inspect python@sha256:d09d15e60962ca365d1cd544a48773bac9d33f2fb1b00f2aa0deec78ade7dc31 --format '{{.Id}}'
# 确认 .Id 与该题库冻结值一致后，再恢复本地 tag：
docker tag python@sha256:d09d15e60962ca365d1cd544a48773bac9d33f2fb1b00f2aa0deec78ade7dc31 python:3.12-alpine
pnpm runtime:check
```

Node 与 GCC 使用同样步骤和各自的 repository/digest/tag。网络和目标 Docker 存储模式仍需满足运行条件；HEAD 成功证明此次检查时注册表存在该内容，不代表用户端一定能下载，也不替代导入后的冻结 ID 校验。

自定义镜像或离线部署可以单镜像导出。`--image` 可重复使用；脚本只检查和导出所选镜像，manifest 的 scope 会标明这是部分包，不能当作全环境就绪凭证。

```sh
node scripts/export-docker-images.mjs --image python:3.12-alpine --output tmp/docker-transfer/python.tar
node scripts/export-docker-images.mjs --image benchlocal/cli-40-verifier:local --output tmp/docker-transfer/cli-verifier.tar
```

本机镜像层大小实测约为 Python 17 MiB、Node 55 MiB、GCC 474 MiB、CLI verifier 183 MiB、Java 281 MiB、Bash 6.5 MiB、python-node 66 MiB、workflow 18 MiB；独立 tar 还包含少量元数据。Docker Hub 固定 digest 可用，因此不必将三个公共镜像再次附进全量发行包；但全新机器执行所有题目时仍需获取所需内容，分包并不会消除实际运行依赖。工作流镜像已有 `pnpm runtime:workflow` 交付入口。

tar 是一种交付方式，并非唯一恢复途径。如果已将同一镜像发布到可访问的仓库，按内容 digest 拉取、恢复题库所需的本地 tag，并验证实际 `.Id` 一致，也可满足冻结契约。代理连通、仓库可登录或同名历史 tag 存在，都不等于目标镜像可获取；具体结论需要保留对应版本的实际检查结果。

## ID 不符也可能来自镜像存储模式

不能一律把 `.Id` 当作镜像配置摘要：classic 镜像存储使用配置 ID；containerd 后端的 inspect 使用目标 descriptor 的 digest，可能指向 OCI index 或 manifest，见 [Moby containerd inspect 实现](https://github.com/moby/moby/blob/master/daemon/containerd/image_inspect.go) 和 [classic inspect 实现](https://github.com/moby/moby/blob/master/daemon/images/image_inspect.go)。相同镜像内容在不同存储模式下可能返回不同的 `.Id`；这也会触发现有冻结校验，不足以单独证明 tag 漂移。

先收集双方环境信息，不要直接关闭 ID 校验或重写冻结题库：

```sh
docker version
docker info --format '{{json .DriverStatus}}'
docker image inspect python:3.12-alpine --format '{{.Id}} {{json .RepoDigests}}'
```

2026-10-12 维护者机器实测使用 Docker Engine 29.8.2、`io.containerd.snapshotter.v1`。当前题库 8 个显式镜像的 `.Id` 均指向 OCI index，而非平台配置。例如 `node:22-alpine` 的冻结 `.Id` 为 `sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32`，tar 中 amd64 配置摘要为 `sha256:395425e54d98ebbd748d388685a0c2de151a30fa92fffc10ba30fa63f3db64d6`。导出脚本分别记录两者，并验证 tag → index/manifest → 平台配置的摘要链。

目标端需要能保留冻结契约所用的 OCI target；classic 存储不支持 image index，见 [Docker 官方说明](https://docs.docker.com/desktop/features/containerd/)。因此 `docker load` 返回成功也不能保证冻结 ID 通过，必须重新运行镜像检查。若需要调整存储模式，先按官方说明评估：切换模式会隐藏另一个模式已有的镜像与容器。长期跨后端兼容应通过新版契约记录平台配置/manifest 的明确身份来解决，不能默默改变旧题包的比较规则。

Docker 运行恢复后，未完成的评测可继续；已生成但因环境失败的编程答案可走[保存答案恢复流程](docker-readiness-and-saved-answer-recovery.md)，避免重新生成。该 CLI 当前只支持 `code_repair` / `project_repair`，不能直接用于 CLI、工具世界或 agent 题；后者需按原冻结题包和已保存转录另行恢复，不要以环境错误当作模型失败，也不要直接覆盖历史成绩。
