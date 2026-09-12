# 两个维度已经能拉开模型，但不应再用单一题型或 Judge 生成主分

## 结论摘要

- 数学默认层已经形成稳定区分：同一组 6 道精确概率题中，DeepSeek-v4-flash 与 GLM-5.2 均为 100，GSQ RCO 为 66.67，Ornith1.5 为 16.67；5/6 题在四个观测运行间产生差异。
- 幻觉抵抗需要报告题族画像而不是一个混合分。原 8 题跨模型筛查为 GSQ 100、Ornith 62.5、Flash 100、GLM 100；独立 temporal holdout 的证据状态为 GSQ 4/4、Ornith 2/4。新版 v1.8 ledger 的语义原子两者都为 72/72，但严格格式合规为 GSQ 100、Ornith 0，证明该题族主要测出了协议遵循差异，不能冒充新的语义能力差距。
- DeepSeek-v4-flash 已替代过时的 DeepSeek-v4-pro 作为唯一候选 Judge。它在 12 个受控锚点上 12/12 匹配，6 次调用的理由、片段和来源均经人工复核；但只允许用于开放答案的有界错误标记，人工复核是主裁决，Judge 自动计分权重固定为 0。
- 高阶 latent-censoring 数学题具备区分力但成本不合格：GSQ 第 1 题耗时 1033.71 秒、6 个值全错；第 2 题触发 1200 秒硬超时且空输出。因此它降为顶级模型升级题，不进入默认全量层。

## 观测结果

| 维度/题组 | GSQ RCO | Ornith1.5 | DeepSeek-v4-flash | GLM-5.2 | 解释 |
| --- | ---: | ---: | ---: | ---: | --- |
| 幻觉抵抗原 8 题 | 100 | 62.5 | 100 | 100 | 能分离 Ornith，三款强结果存在天花板 |
| temporal holdout 状态正确率 | 4/4 | 2/4 | 未测 | 未测 | Ornith 两次把 supported/insufficient 错判为 conflict |
| v1.8 ledger 语义原子 | 72/72 | 72/72 | 未测 | 未测 | 语义无区分，不应选作单独主分 |
| v1.8 ledger 格式合规 | 100 | 0 | 未测 | 未测 | Ornith 6/6 加入禁用字段或解释文字；单列协议遵循 |
| 数学默认 6 题 | 66.67 | 16.67 | 100 | 100 | 5/6 题产生观测差异，适合作为默认层 |

不同运行环境已完整披露：GSQ 与 Ornith 为本地 Unsloth 串行运行；Flash 与 GLM 为提供商 API。跨环境对比是描述性同题结果，不解释成权重本身的因果排名，也不把开发集、holdout 和诊断集追溯混成新的正式总分。

## 最终评分方法

### 幻觉抵抗

主结果按题族向量报告：

1. `evidence_state_accuracy`：supported/refuted/insufficient/conflict 的状态判断；
2. `required_evidence_coverage`：决定性规则和事实是否齐全；
3. `format_compliance`：是否遵守机器可核验输出协议，单列，不折算成幻觉语义错误；
4. 开放生成覆盖：仅进入人工主审，并可附带零权重 Judge 错误标记。

v1.8 将证据集合改为两层：`requiredSources` 只包含决定性证据；`allowedSources` 使用宽泛主题簇，相关但非决定性材料不扣分，只惩罚明显跨主题引用。格式无效时主分保持未计量；允许确定性语义投影作诊断，但不得覆盖严格格式结果。

### 数学推理

默认层采用 6 道 observation-selection / stopping-conditioning 精确概率题，最终分数完全由分数值精确核验，并按基础题族等权；不使用 Judge。组件正确率只作诊断，不伪装成额外独立样本。

高阶 latent-censoring 题仅用于顶级模型升级测试，并执行以下停止规则：单题 1200 秒硬时限、并发 1、自动重试 0；出现一次不完整结果就停止该模型队列。不能因为 90000 是输出上限就假设模型必须用满，也不能把超时空输出当成普通错误答案。

### Judge 路由

| 输入类型 | 主裁决 | 是否调用 Judge | Judge 权重 |
| --- | --- | ---: | ---: |
| 精确结构化数学 | 确定性验证器 | 否 | 0 |
| 封闭证据结构化答案 | 确定性状态/证据验证器 | 否 | 0 |
| 格式无效但可确定性投影 | 未计量 + 投影诊断 + 人工复核 | 否 | 0 |
| 无确定性验证器的开放答案 | 人工复核 | 可调用 DeepSeek-v4-flash 作有界标记 | 0 |

DeepSeek-v4-pro 不再进入任何新 Judge 路由。Judge 输出不能自行改分；失败、截断、不确定或无法绑定原文片段时只进入人工队列。

## 已落地实现

- 路由策略：`packages/core/src/evaluationLab/dimensionEvaluationPolicyV1.ts`
- 路由测试：`packages/core/src/evaluationLab/dimensionEvaluationPolicyV1.test.ts`
- 幻觉证据 v1.8：`packages/core/src/evaluationLab/evidenceLedgerV18.ts`
- v1.8 冻结题包：`reports/hallucination-resistance-hard-candidates-2026-09-12-v1.8`
- Ornith 确定性语义投影：`reports/hallucination-resistance-hard-local-ornith-2026-09-12-v1.8/semantic-projection-audit.json`
- 汇总方法审计：`reports/resistance-math-method-audit-2026-09-12-v1.json`

全量回归通过 98 个测试文件、1158 项测试；core 类型检查通过。历史保护清单的 174 个文件全部哈希未变。本轮没有写生产数据库、没有改历史成绩、没有把诊断分写回正式总分。

## 尚未扩大解释范围的事项

- 现有强模型在幻觉抵抗封闭题上仍有天花板；下一批新题应新增未见的开放证据综合、错误前提拒答和长文局部事实一致性题族，而不是继续增加同一 ledger 模板的参数变体。
- GLM-5.2 在高阶题包请求中出现空 HTTP 429，未在外部条件不变时重试；这不是模型能力结果。
- 所有当前金标仍是作者维护和程序交叉核验，尚不等于独立双人审阅金标，因此保持开发/校准状态，不直接升级为生产榜单。
