## 工作流修复与评分更新

- 修复19道来源题涉及的题目契约及只读确认评分问题；默认仍为803道来源题 / 920个执行实例。
- 87个智能体执行实例加入客观检查点rubric：最终未通过最高40分，安全违规0分。
- 修复明确先答要求下的ANSWER/SAY解析衔接；完整旧轨迹可恢复最终答复后重新判分，保留生成Token。
- 隔离已确认有缺陷的题目旧版本；语义Judge继续只复核最终表述，不覆盖实际执行与安全失败。
- 提供冻结PyYAML Docker镜像资产与校验脚本，支持 `pnpm runtime:workflow` 自动准备及离线导入。
- 同步最新十模型完整803题分数与去重Token报告。

详细说明：[修复与验收](https://github.com/suncityldp/zx-bench/blob/v0.2.6/docs/workflow-repair-2026-10-01.md)，[完整803题十模型报告](https://github.com/suncityldp/zx-bench/blob/v0.2.6/docs/ten-model-full803-2026-10-01.md)。

## 验证

发布目录全工作区构建通过；1882项测试通过、214项环境依赖测试跳过。另行通过50次真实Docker验收；固定镜像压缩包及image ID校验通过。干净数据库导入920条、0失败，默认预览803道来源题 / 920个实例。

## 升级

安装依赖、生成Prisma客户端、构建；运行 `pnpm runtime:workflow` 准备新增固定镜像。重启服务后运行 `node scripts/seed-benchmark.mjs` 导入修复题库。历史答卷保留，运行中的冻结题集不自动替换。本次发布不重新调用被测模型。
