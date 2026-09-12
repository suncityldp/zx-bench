# 执行、指令遵循与 PR 评审可靠性升级

日期：2026-09-12。范围：运行/判分可靠性修复，不包含下一阶段的大规模挑战题扩充，也未调用被测模型重跑历史成绩。

## 交付范围

| 模块 | 当前版本 | 当前题库契约数 | 主要变化 |
| --- | --- | ---: | --- |
| code_repair | 3.4.0 | 127 | 默认容器、独立编译证据、真实测试完成、固定分母 |
| instruction_checklist | instruction_checklist_v5 | 42 | 配置错误未测隔离；字面/正向提及分离；真实结构关系 |
| llm_judge（PR） | 2.0.0 | 2 | 严格 JSON、文件与 diff 证据绑定、一条发现不重复计分 |

题库版本为 1.5.0，仍为 595 道有效题。171 条相关定义具有新 graderVersion、scenarioVersion 和 canonical scenarioHash；`data/scenarios/execution-review-manifest.json` 记录逐题哈希及评分/执行代码的 SHA-256 指纹（文本 CRLF 归一化为 LF）。这是机器契约与回归审计，不冒充独立人工审核。

## 跨语言真实执行

- JavaScript、TypeScript、Python 的 `code_repair` 正式入口默认使用 Docker；无 fixture 的编译下限检查也默认容器执行，不把候选源码交给宿主编译器。普通单测仅为受信任仓库样例显式使用 `ZXBENCH_EXECUTION_BACKEND=trusted-host`，不能用于不可信模型代码。
- PHP 显式启用 `zend.assertions=1`、`assert.active=1`、`assert.exception=1`，兼容标准 PHP 开闭标签。
- Bash 在测试前恢复 `-e/pipefail`，防止前面断言失败被后续成功命令掩盖。
- PHP、Bash、C/C++、Rust、C# 同时需要正常退出和测试完成证据；`exit(0)` 等提前结束不会通过。编译通过证据在执行候选代码之前独立产生，断言失败不再等同于编译失败。
- Go 先构建测试二进制，再运行完整隐藏测试清单；缺报告、重复报告、panic、超时不能通过缩小分母得到虚高分。正常完成但部分断言失败仍保留逐题部分分。
- Java 校验报告题数、失败清单和进程退出状态的一致性；缺失/截断报告不再默认全通过。
- SQL 必须收到可解析且唯一的实际结果/计划记录；缺输出不等于合法空结果集。
- C/C++ 可通过 `fixture.memoryCheck: "valgrind"` 启用真实内存错误检查。已实测正常内存访问通过、use-after-free 失败。不是所有历史 C/C++ 题默认启用 Valgrind/ASan。
- 容器输入文件在写入前校验相对路径、Windows 设备名、路径穿越和重复目标；默认非 root、无网络、只读源码挂载、CPU/内存/PID 限制。实测超时失败并清理本次容器。

## 指令判分修复

42 道当前配置经过可测性扫描；8 道题修正了具体契约或覆盖范围：

| 题号 | 旧不足 | 新检查 |
| --- | --- | --- |
| IF-CN-023 | 搜几个字代替段首与每段句数 | 春/天/美/好逐段首字；每段3句、每句≤20字 |
| IF-CN-024 | “至少5项”却按恰好5项；未测年份顺序 | 至少5行、年份递增、首年<1970、末年>2020、描述长度 |
| IF-CN-026 | `format: bullet_list` 没有可执行 pattern | 真正的1家公司/3部门/每部门2职位及0/2/4空格缩进 |
| IF-CN-027 | 任意一个问号被当作偶数行格式通过 | 指定动物顺序、唯一性、逐行长度、奇偶句式格式 |
| IF-CN-029 | “上海和北京”使用了 OR 条件 | 两词均出现且指定顺序 |
| IF-CN-034 | 仅核对标注总量 | 1–20每一行与标注逐项对应 |
| IF-CN-036 | 全局计数代替每句长度与交叉引用 | 每句12汉字、第2句含第4句首字、末句后缀 |
| IF-CN-039 | 匹配“部分A的第一句话”占位文本 | 实际C标题引用、A首句在C复现、段落顺序、B两行代码 |

IF-CN-027/039 对题面做了明确化：前者明确体型顺序来自给定列表、评分只验证结构；后者明确标题、句末标点与代码块计数方式。题面变更已体现在哈希里，不与旧题直接混比。

空/损坏/重复约束、非法正则等属于题库错误：`axisCoverage=0`、`environmentError=true`、人工复核，不作为模型能力失败。字面包含规则通过 `matchMode=literal` 明示；迁移方案步骤继续使用正向提及/顺序检查。残缺的未结束尾句不再满足句末标点契约。

## PR 评审边界

当前两道 PR 题要求一个严格 JSON 对象，包含 `findings`、`reasonableDecisions`、`conclusion`。每条发现提供完整文件路径、严重级别、问题、影响、建议和该文件新增 diff 原文证据；`area` 可选。

匹配以文件与概念组共同约束，每条提交发现最多命中一个基准缺陷。其他条目写“无问题”不会全局抹掉真实发现。严重级别缺失不能靠缩小分母获高分，未知发现不被武断当作误报，而会标记未测与待复核。

Judge 只评建议质量时使用 1024 输出上限、精简严格 JSON；截断、解析失败、不合法字段/分值均返回未测，不偷偷回退规则。未配置 Judge 时，建议轴仅是“是否提供建议”的规则代理，**不是修复语义正确性的证明**。已知概念组不能穷尽正确措辞，未知真缺陷仍需独立核验。结论与合理决策列表的深层语义也未实现完整自动裁判。

同时修正了题面/基准问题：支付 PR 实为5个文件；普通字符串/有限数字限定解决 `String(v)` 与模板插值并非全类型等价的问题；JWT 风险须交代触发条件；缺少双写对账不再写成“必然且不可逆”的事故；移除两处直接给答案的编辑性注释。

## 验证与复现

本机 Windows + Docker 已实际跑过 17 组容器集成测试，覆盖12种语言的正确解、错误解、提前结束，8种语言的显式编译失败，以及固定分母、默认隔离、超时、Valgrind、正式评测入口。没有调用被测模型或外部 Judge API。

最终验证：`pnpm test` 的1224项普通测试通过（容器17组明确跳过）；`pnpm test:containers` 单独17/17通过，约114秒；`pnpm build`通过。迁移脚本重复运行后题库、元数据、冻结清单字节哈希不变。Docker 中未残留本次 `zxbench-*` 测试容器。

```powershell
pnpm test
pnpm build
pnpm test:containers
```

普通 `pnpm test` 不启动 Docker，容器组明确显示 skipped；必须单独运行 `pnpm test:containers`。首次运行可能构建/拉取缺失镜像。新增 GitHub Actions `Container behavior controls` 为手动触发，常规 CI 仍执行构建和普通回归。GitHub 上的工作流尚未在本次本地任务中执行。

本次测试的本地镜像 ID 短前缀（证据快照，不是跨平台镜像锁）：

| 镜像 | ID 前缀 |
| --- | --- |
| php:8.2-cli-alpine | 6d3dcc922fa3 |
| bash:5 | a19c811ee9e9 |
| zxbench/cpp:gcc13-valgrind | 157dfc45e18b |
| rust:1.75-alpine | 65aa0b28d026 |
| mcr.microsoft.com/dotnet/sdk:8.0-alpine | 8a80a27ddac7 |
| zxbench/go:1.21-gcc | bbe499b0985c |
| maven:3.9-eclipse-temurin-17-alpine | c7baad7b0d2c |
| node:22-alpine（SQL） | c610fcdfb1d5 |
| node:20-alpine（JS/TS） | fb4cd12c85ee |
| python:3.12-alpine | d09d15e60962 |

JS/TS 使用 `node:20-alpine`。镜像目前仍按 tag 解析；不同机器/不同时期的镜像 tag 不保证内容一致，发布能力分时仍须记录和对齐实际运行环境。

## 数据与版本迁移

```powershell
node scripts/upgrade-execution-review-v2.mjs
node scripts/sync-reviewed-question-contracts.mjs apps/data/zxbench.db --execution-review
node scripts/sync-reviewed-question-contracts.mjs apps/data/zxbench.db --execution-review --apply
```

升级脚本可重复运行，第二条仅预览；应用前拒绝正在运行的评测，自动备份数据库，在事务中仅同步171条定义。本机已同步并验证数据库定义哈希与题库一致，16793条结果行和68次历史运行数量不变。备份保存在被Git忽略的 `apps/data/`，不上传评测答案或数据库。

本次判分语义改变，没有把旧 graderVersion 声称为兼容版本：历史记录可查看，但若旧快照引用旧评分器，不能在新引擎上冒充原口径续跑或补评；需要使用对应旧引擎，或明确新建新版评测。更换当前题库不会自动修改冻结运行快照或旧总分。

## 尚未交付

- 不声称127道编程题全部具备独立正确解、错误解、对抗样例并逐题实跑。下一阶段应补题级金标与真实变异测试覆盖，而不是只增加题数。
- TypeScript 的类型专项仍是宿主编译器 API 静态检查，不是隔离执行服务；类型系统资源耗尽防护还可加强。
- 完成标记与测试同进程，不能防候选代码读取/篡改 harness 或伪造报告。严肃防作弊还需独立测试监督进程、分离权限/文件和可信结果通道。
- 容器默认根文件系统仍可写，部分项目构建允许工作区写入；TSan 特殊路径存在 seccomp 放宽。此次没有宣称强隔离沙箱已经完整加固。
- 指令自由语义、PR新发现和修复建议语义仍需专项验证或人工复核；本次未完成新一轮独立人工双审。
- 本次未自动提交或推送 GitHub，也未触发付费模型重跑。
