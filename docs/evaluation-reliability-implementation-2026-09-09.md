# 评测可靠性升级：第一阶段实施记录

日期：2026-09-09。状态：代码和离线影子验证已完成，未切换正式评分规则。

## 已完成的交付

| 项目 | 当前实现 | 生效边界 |
| --- | --- | --- |
| 数学等价答案 | 新增 `typed_math_shadow_v1`，逐字段解析十进制、序列、文本；支持模板方括号、合法千分位、等价小数、路线箭头 | 独立影子接口，不注册为默认 grader；原 `exact_answer_v4` 行为未改 |
| 可执行数学核验 | 两机器流水车间模拟器、最多 8 工件的穷举最优解核验；接受所有等价最优排列 | 新数学试点；不将一条指定排列当唯一数学正解 |
| Judge 输入留痕 | 每次调用保存答案/结构化候选、输入、实际提示词、原始 Judge 响应的 SHA-256；分层和集成保留全部调用指纹 | 附加审计字段；运行服务未在本轮重启，需正常构建发布后生效 |
| Judge 扣分证据 | 显式 `judgeEvidenceContract: criterion_evidence_v1` 才启用；每个扣分项须有原文引用或明确遗漏依据；虚构引用拒收 | 新影子输入启用；旧题不被追加要求；不把引用存在等同于语义判断正确 |
| Judge 资格测试 | 44 个工程夹具：完整正确、等价格式、遗漏引用、虚构来源、评分诱导、数学错值/错推导 | 已导出请求；未调用真实 Judge，覆盖率 0，状态为未认证 |
| 版本化题包 | 20 题：8 幻觉条件配对 + 12 数学参数/边界题，整包及逐题内容指纹 | 公开开发试点、未独立审核，不进入正式榜单 |
| 可靠性统计 | 计划试验数作分母、同题全部成功率、家族平衡交付率；明确独立试验/环境故障替代/Judge-only | 独立离线事件输入，不自动从有歧义的历史结果行推断试验次数 |
| 成本统计 | 模型耗时、Judge 耗时、输出 token 分列；失败和替代请求消耗保留；每次正确交付的模型耗时 | 零成功时为 null，不制造 0 成本；混合协议指纹拒绝汇总 |

本轮未修改数据库、正式题库导出、历史模型报告或历史分数，未启动模型生成/真实 Judge 测试，未推送 GitHub。工作区原有改动保留。

## 原始答案只读回放

读取 YMQ 运行 `zxbench-pro-2026-09-08T18-17-01-406Z-db1932ad` 的冻结题包，验证整包 hash；每题取最新 `finishedAt`，时间并列则报错，不取最高分。

| 题号 | 保存的旧混合分 | 旧确定性核验 | 新影子严格核验 | 是否改答案 |
| --- | ---: | ---: | ---: | --- |
| RM-CN-011 | 15 | 10 | 100 | 否 |
| RM-CN-012 | 15 | 10 | 100 | 否 |
| RM-CN-018 | 15 | 10 | 100 | 否 |

这表明三题此前受表示形式误罚。旧混合分和新影子严格分不是同一种综合分，本表用于定位核验差异，不是新的全量成绩。RM-CN-029 的可选推导错误仍须经正确校准的语义判断或专用证明核验处理；本轮没有宣称任意自然语言推导均可自动验证。

新数学影子接口分别输出字段准确率和全部字段严格通过，不用任意权重把格式与数学错误混为一谈。它仍遵守题面要求的字段名/顺序和最后 ANSWER 行；缺字段、重复字段、多候选、错误单位、数值微小误差或非法序列不能靠模糊匹配通过。

## 题包和夹具的定位

幻觉试点包含两个封闭虚构材料家族：保修条款、库存记录。每家族有证据充分、证据缺失、新旧冲突、错误前提四个版本。所有事实以提供材料为准，不依赖互联网。

数学试点包含三个家族：流水车间排程、平移后的均值/总体方差、线性方程组的唯一解/无解/无穷多解边界。固定种子为 11、23、37、53。数学参考答案通过确定性核验，排程最优值由穷举产生。

这些是验证机制的小样本，不是已经证明能区分强模型的挑战榜单。不能把 20 题当独立同分布的 20 个能力样本，也不能将同家族变体拆散到训练/校准/盲测集合。真正的盲测题要另行构建和隔离。

Judge 夹具标签是工程预期，不冒充专家金标。即使 44 个真实裁判结果全符合夹具，工具最多给出 `fixture_passed_needs_independent_human_calibration`，不能自动宣称达到正式评分资格。缺失、不确定、坏结构、指纹错误、扣分证据不合格均阻止通过；坏数据不当成模型能力 0 分。

## 可重复运行

从项目根目录执行（输出必须是不存在的新目录，防止覆盖）：

```powershell
pnpm --filter server evaluation:lab --out reports/evaluation-lab-new
```

同时读取一个指定运行做三题影子回放：

```powershell
pnpm --filter server evaluation:lab --out reports/evaluation-lab-replay-new --db apps/data/zxbench.db --run zxbench-pro-2026-09-08T18-17-01-406Z-db1932ad
```

最终验证产物位于 `reports/evaluation-reliability-pilot-2026-09-09-v1/verified/`：

- `pilot-pack.json`：20 题、参考答案、题目家族及 hash；不是正式 `BenchmarkPack` 导入文件。
- `judge-fixtures.json`：44 个预期标签及对应输入，仅给审核/资格检查使用。
- `judge-requests.json`：待 Judge 处理的系统/用户提示及指纹；不要额外把夹具预期标签传给 Judge。
- `validation.json`：数学参考核验、Judge 真实覆盖率、只读历史回放。

上级目录保留首次生成的中间产物；以后核查使用 `verified` 子目录，不混用不同生成版本的请求指纹。

### 导入真实 Judge 结果（仍不调用模型）

输入 JSON 数组，每项为：

```json
{
  "fixtureId": "从 judge-requests.json 复制",
  "inputHash": "原请求指纹",
  "promptHash": "原提示词指纹",
  "judgeIdentity": "固定供应商、模型、采样参数和输出预算的配置标识",
  "response": {"verdict":"correct","confidence":0.95,"factuality":1,"critical_error":false,"rubric_scores":{"answer":1,"evidence":1,"boundaries":1},"score_evidence":{}}
}
```

例子仅说明幻觉响应结构，不是裁判结果。数学响应使用 `math_correctness`、`reasoning_validity`、`task_completeness`。扣分项必须补充 `score_evidence`。对有意遗漏引用的夹具，证据类型应为 `omission`，不能伪造一句原文当遗漏证据。

```powershell
pnpm --filter server evaluation:lab --out reports/evaluation-lab-judge-qa-new --judge-results path/to/judge-observations.json
```

重复 Judge 试验分别导出、分别校准；同一份输入出现重复 fixtureId 会报错，不保留最高裁判分。资格检查同时验证输入与实际提示词指纹，防止答案没变、Judge 输入却变了。

### 导入可靠性事件

`--trial-events` 接受 `{ "plan": [...], "events": [...] }`。plan 每项声明 `scenarioId/family/trials`；events 按发生顺序排列，含 `id/scenarioId/trial/protocolHash/kind/replaces/candidateHash/strictPass/environmentError/modelMs/judgeMs/outputTokens`。

- `protocolHash` 应由冻结题包、模型/量化/后端/硬件、采样参数、并发、时间与 token 上限、Judge 策略共同生成；单次汇总不混配置。
- `independent` 是事先计划的新模型试验，同一个试验编号只建一次。
- `replacement` 必须指向当前的环境错误记录；不能因模型答错就替代它。
- `judge_only` 必须指向当前记录且保持候选指纹、环境状态不变，模型耗时/token 必须为零；Judge 耗时仍保留。
- `environmentError` 在这个接口专指模型执行环境错误；缺 Judge 用 `strictPass: null`，不能把两者混用。
- 缺试验或缺 Judge 保留为未覆盖；交付成功率使用完整计划分母，已测成功率另报，不能只报后者。
- 家族汇总先平均家族内题目，再平均家族；大量同模板变体不会获得额外家族权重。
- 幻觉条件汇总 API 必须传入完整计划的题目（缺结果用 null），不能只给成功/已测行。

本阶段不做置信区间或模型排名宣称。跨模型配对重采样、固定预算多档实验和前台展示属于下一阶段。

## 验证结果

- 全套 Vitest：39 个文件，634/634 测试通过。
- 新增本阶段测试：数学/试点/可靠性 49 项，Judge 审计 7 项。
- `@zxbench/types` 构建、`@zxbench/core` 类型检查、`server` 类型检查通过。
- `git diff --check` 无空白错误。
- 12/12 数学试点参考通过；3/3 历史原答案新核验通过；真实 Judge 调用数为 0。
- 全套回归最初发现两个旧测试替身缺接口：排行榜 mock 缺 `addHook`，恢复评测 mock 未模拟 Prisma 的 `include.modelConfig`。只补齐测试替身，没有删除断言或修改生产路由。

## 后续放行顺序

1. 用固定的真实 Judge 配置处理资格请求，报告误放行/误杀和覆盖率；独立人工核查事实与证据含义。失败则改夹具或裁判策略，不能为了过关修改预期标签。
2. 校准通过后，以同一冻结试点题包、同一部署条件测候选模型；先小规模，明示单题硬时限和总预算。
3. 扩充有代表性的挑战题，按家族隔离开发/校准/盲测；在更广模型池验证题目难度和区分度。
4. 冻结正式新题包/评分器版本，接入前台和正式聚合，再重测候选模型。旧榜单和旧报告保留，单独发布新口径。

代码位置：`packages/core/src/evaluationLab/`、`packages/core/src/judge/integrity.ts`、`packages/core/src/scripts/evaluation-lab.ts`。原调查依据见 `docs/rubric-discrimination-review-2026-09-09.md`。
