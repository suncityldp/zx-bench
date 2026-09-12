# 数据抽取题集 v3 复核与冻结记录

日期：2026-09-12  
范围：`DE-CN-001`—`DE-CN-056`  
主键粒度：一行一个 `scenarioId`；每题一个冻结题面、完整金标和类型契约。

## 复核结论

原 35 题均为 `public_dev / unreviewed`。人工逐题核对题面与已有答案后，确认已有已评分值本身未发现算术或抄录错误，但发现以下会影响分数可信度的问题：

- 高：至少 14/35 题在题面中明确要求的字段数多于实际评分字段数，模型遗漏未评分字段仍可能满分。
- 高：`DE-CN-002` 要求根为数组，却把 `count` 作为根对象字段评分，该字段不可能命中。
- 中：`DE-CN-022` 的“必须包含字段”误插入招标公告正文，题面边界不清。
- 中：`DE-CN-035` 未定义 `changes_count` 是按消息条数还是字段变化数计数。
- 高：35/35 没有独立冻结的字段类型、必需路径和额外字段策略；`null` 还可能被缺失字段或空字符串替代。

上述问题已全部修复。旧题统一升级为 `scenarioVersion=3.0.0`、`graderVersion=json_atomic_v3`，题面只声明实际评分结构；`DE-CN-002` 与 `DE-CN-004` 冻结完整数组/嵌套对象金标，`DE-CN-035` 明确按权威版本的字段变化计数。

## 新增覆盖

新增 21 题均为 medium/hard/adversarial，覆盖：

- 多来源优先级、签署状态和文档版本；
- 事件去重、乱序日志、邮件引用历史；
- 时区与相对时间规范化、欧式数字和多语言日期；
- `null` / `false` / `0` / 空字符串的严格区分；
- 表连接、脚注、部分验收、财务重述和负数；
- OCR 噪声、HTML/script 噪声、实体指代和商品变体绑定；
- 嵌入式提示注入内容的隔离。

扩充后共有 56 题，难度分布为 easy 7、medium 16、hard 24、adversarial 9。新增题不承担外部事实判断，所有答案均可由冻结题面确定。

## v3 契约

每题 `requirements` 冻结以下内容：

- `expected`：完整 JSON 金标；
- `requiredFields`：全部必需叶路径；
- `fieldTypes`：根、容器和叶节点的 JSON 类型；
- `outputPolicy=json_only`；
- `allowAdditionalFields=false`。

场景本身使用 `outputPolicy=raw_only`。评分器完全确定性运行，不调用 Judge；类型强转、缺失的 null、额外键、数组长度变化、Markdown 围栏和解释文字都会被扣分。契约校验会拒绝金标、必需路径和类型表之间的漂移。

## 冻结与复现

- 56/56：`reviewStatus=verified`；
- 金标来源：`zxbench:data-extraction-manual-review-2026-09-12`；
- 每题 canonical `scenarioHash` 包含题面、金标、类型契约、输出策略和审核元数据；
- 题库版本：`benchmark-meta.json` 1.4.0；有效题 595，数据抽取 56；
- `scripts/upgrade-data-extraction-v3.mjs` 可确定性重建本次题集；
- `dataExtractionV3.test.ts` 对 56 个金标逐题回放，并覆盖类型、缺失、额外字段、围栏和独立计算反例。

同步到本地数据库前可运行：

```bash
node scripts/sync-reviewed-question-contracts.mjs apps/data/zxbench.db
```

确认后加 `--apply`。脚本先创建 SQLite 一致性备份，只更新已复核题目定义，不改写历史运行和结果行；既有运行仍使用各自 manifest 中冻结的旧题，不会被静默重算。
