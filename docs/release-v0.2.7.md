## 工具/CLI修复与评分更新

- 默认完整803道来源题、920个执行实例保留。
- 修复隐藏参数、日期基准、SQLite查询及重试初始化、过度限制只读确认等契约问题；Git保护文件误罚已修复。
- 全部98个工具/CLI实例加入客观检查点Rubric，最终未通过最高40分，安全违规0分。
- `tool_trace_v5`和`cli_command_v6`支持新验收；旧缺陷契约隔离。完整轨迹可恢复ANSWER最终答复后重新判分，保留生成用量。
- 十模型400份新答卷与580份重新判分答卷已采纳；完整803题成绩和token对账同步更新。

详细说明：[工具/CLI修复验收](https://github.com/suncityldp/zx-bench/blob/v0.2.7/docs/tool-cli-repair-2026-10-01.md)，[完整803题十模型报告](https://github.com/suncityldp/zx-bench/blob/v0.2.7/docs/ten-model-full803-2026-10-01.md)。

## 验证与升级

全工作区构建、全套测试及单独启用的真实Docker验收通过。全新数据库导入920条、0失败，默认预览803道来源题/920个实例。安装依赖、生成Prisma客户端、构建，准备固定镜像并重启服务，再运行`node scripts/seed-benchmark.mjs`更新题库。历史答卷保留，冻结运行不自动替换。

附带固定PyYAML镜像资产与SHA-256，内容与v0.2.6相同，支持离线导入。
