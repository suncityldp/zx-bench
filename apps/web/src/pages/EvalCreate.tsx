import { useEffect, useState } from 'react';
import { Form, Input, Select, Button, Switch, InputNumber, Slider, Radio, message, Alert, Divider, Typography, Row, Col } from 'antd';
import { useNavigate } from 'react-router-dom';
import { useLanguage } from '../i18n';

const { Text } = Typography;

/** 维度选项（与 EvalLive 的 DIMENSION_LABELS 保持一致） */
const DIMENSION_OPTIONS: Array<{ value: string; label: string }> = [
  { value: 'program', label: '编程能力' },
  { value: 'reasoning_math', label: '推理与数学' },
  { value: 'safety_authority', label: '安全与权限' },
  { value: 'cli_deep_tasks', label: '深度命令行任务' },
  { value: 'data_extraction', label: '数据抽取' },
  { value: 'agent_workflow', label: '智能体工作流' },
  { value: 'instruction_following', label: '指令遵循' },
  { value: 'tool_cli_workflow', label: '工具/CLI/工作流' },
  { value: 'agent_loop', label: '多轮工具闭环' },
  { value: 'hallucination_resistance', label: '幻觉抵抗' },
  { value: 'structured_output', label: '结构化输出' },
];

interface ModelOption {
  id: string;
  name: string;
  baseUrl: string;
  provider: string;
  modelType: string;
  reasoningModel?: boolean;
}

export default function EvalCreate() {
  const [form] = Form.useForm();
  const [models, setModels] = useState<ModelOption[]>([]);
  const [loading, setLoading] = useState(false);
  const [judgeEnabled, setJudgeEnabled] = useState(false);
  const [selectedModelReasoning, setSelectedModelReasoning] = useState(false);
  const [selectedBatchModelIds, setSelectedBatchModelIds] = useState<string[]>([]);
  const [mode, setMode] = useState<'single' | 'batch'>('single');
  const navigate = useNavigate();
  const { t } = useLanguage();
  const answerFirstEnabled = Form.useWatch('answerFirst', form);
  const structuredPack = Form.useWatch('structuredPack', form);
  const [preview, setPreview] = useState<{ count: number; scenarioIds: string[]; hash: string } | null>(null);
  const [previewError, setPreviewError] = useState('');
  const selection = Form.useWatch(values => ({ dimensionIds: values.dimensionIds, difficultyIds: values.difficultyIds, specialPack: values.structuredPack, evaluationMode: values.evaluationMode }), form);
  const selectionKey = JSON.stringify(selection);
  useEffect(() => {
    const controller = new AbortController();
    setPreview(null); setPreviewError('');
    const specialPack = selection?.specialPack || 'default';
    const timer = window.setTimeout(() => {
      fetch('/api/runs/preview', { method: 'POST', signal: controller.signal, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ dimensionIds: selection?.dimensionIds || [], difficultyIds: selection?.difficultyIds || [], config: { specialPack, evaluationMode: specialPack === 'default' ? (selection?.evaluationMode || 'development') : 'development' } }) })
        .then(r => r.json()).then(r => { if (!controller.signal.aborted) { if (r.success) setPreview(r.data); else setPreviewError(r.error); } })
        .catch(e => { if (!controller.signal.aborted) setPreviewError(String(e)); });
    }, 200);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [selectionKey]);

  useEffect(() => {
    fetch('/api/models')
      .then((r) => r.json())
      .then((res) => {
        if (!res.success) return;
        const loadedModels = res.data as ModelOption[];
        setModels(loadedModels);

        // 当前推荐 Judge：腾讯 MaaS 的 DeepSeek V4 Pro。用户仍可在下拉框覆盖。
        // 显式带上 ID，避免后端 findFirst() 误选历史遗留 Judge 配置。
        const preferredJudge = loadedModels.find((model) =>
          model.modelType === 'judge'
          && model.name === 'deepseek-v4-pro-0813'
          && model.baseUrl.replace(/\/$/, '') === 'https://tokenhub.tencentmaas.com/v1',
        );
        if (preferredJudge) form.setFieldValue('judgeModelConfigId', preferredJudge.id);
      })
      .catch(console.error);
  }, []);

  const testedModels = models.filter((m) => m.modelType !== 'judge');
  const judgeModels = models.filter((m) => m.modelType === 'judge');

  const onFinish = async (values: Record<string, unknown>) => {
    setLoading(true);
    try {
      const useStructuredPack = values.structuredPack === 'mixed' || values.structuredPack === 'all';
      const useMigrationPack = values.structuredPack === 'migration-189';
      const useSpecialPack = useStructuredPack || useMigrationPack;
      // 思考/输出约束（反拖尾）：任一约束项开启时组装 constraints
      const constraints: Record<string, unknown> = {};
      if (values.answerFirst) {
        constraints.answerFirst = true;
        constraints.visibleRationale = values.visibleRationale || 'auto';
      }
      if (values.maxReasoningTokens) constraints.maxReasoningTokens = values.maxReasoningTokens;
            if (values.hardTimeLimitSec) constraints.hardTimeLimitMs = (values.hardTimeLimitSec as number) * 1000;
      const hasActiveConstraint = Object.keys(constraints).length > 0;
      if (hasActiveConstraint && values.onLimit) constraints.onLimit = values.onLimit;

      const config = {
        specialPack: values.structuredPack || 'default',
        difficultyFilter: values.difficultyIds || [],
        evaluationMode: values.evaluationMode || 'development',
        maxTokens: values.maxTokens || 8192,
        temperature: values.temperature ?? null,
        runsPerQuestion: values.runsPerQuestion || 1,
        judgeEnabled: values.judgeEnabled || false,
        escalationEnabled: values.escalationEnabled || false,
        safetyCheckEnabled: values.safetyCheckEnabled !== false,
        hiddenTestsEnabled: values.hiddenTestsEnabled !== false,
        structuredOutputEnabled: values.structuredOutputEnabled || false,
        parallelism: values.parallelism ?? 4,
        parallelMode: values.parallelMode || 'global',
        ...(Object.keys(constraints).length > 0 ? { constraints } : {}),
        ...(useSpecialPack ? {
          evaluationMode: 'development', runsPerQuestion: 1,
          judgeEnabled: false, escalationEnabled: false, structuredOutputEnabled: false,
        } : {}),
      };

      if (mode === 'batch') {
        const modelConfigIds = (values.modelConfigIds as string[]) || [];
        if (modelConfigIds.length === 0) {
          message.error('请至少选择一个被测模型');
          setLoading(false);
          return;
        }
        const res = await fetch('/api/runs/batch', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: values.name || undefined,
            modelConfigIds,
            judgeModelConfigId: values.judgeModelConfigId || undefined,
            dimensionIds: (values.dimensionIds as string[]) || [],
            difficultyIds: (values.difficultyIds as string[]) || [],
            config,
          }),
        });
        const data = await res.json();
        if (data.success) {
          message.success(`已并发启动 ${data.data.runs.length} 个模型的评测，正在跳转统一监控...`);
          navigate(`/eval/batch/${data.data.groupName}`);
        } else {
          message.error(data.error || '批量创建失败');
        }
      } else {
        const res = await fetch('/api/runs', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: values.name,
            modelConfigId: values.modelConfigId,
            judgeModelConfigId: values.judgeModelConfigId || undefined,
            dimensionIds: (values.dimensionIds as string[]) || [],
            difficultyIds: (values.difficultyIds as string[]) || [],
            config,
          }),
        });
        const data = await res.json();
        if (data.success) {
          message.success('评测已创建，正在跳转实时监控...');
          navigate(`/eval/live/${data.data.id}`);
        } else {
          message.error(data.error || '创建失败');
        }
      }
    } catch (error) {
      message.error(error instanceof Error ? error.message : '请求失败');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div>
      <h2 className="swiss-page-title">创建评测</h2>
      <div className="swiss-card">
        <Form form={form} layout="vertical" onFinish={onFinish}>
          {/* ===== 测试模式：单模型 / 多模型并行 ===== */}
          <div style={{ marginBottom: 20 }}>
            <div style={{ fontSize: 13, color: 'var(--text-helper)', marginBottom: 8 }}>{t('eval.testMode')}</div>
            <Radio.Group
              value={mode}
              onChange={(e) => {
                const nextMode = e.target.value as 'single' | 'batch';
                setMode(nextMode);
                const selectedIds = nextMode === 'batch'
                  ? selectedBatchModelIds
                  : [form.getFieldValue('modelConfigId') as string | undefined].filter((id): id is string => Boolean(id));
                setSelectedModelReasoning(selectedIds.some((id) => testedModels.find((model) => model.id === id)?.reasoningModel));
              }}
            >
              <Radio.Button value="single">单模型（原模式）</Radio.Button>
              <Radio.Button value="batch">多模型并行</Radio.Button>
            </Radio.Group>
            <div style={{ fontSize: 12, color: 'var(--text-helper)', marginTop: 8 }}>
              {mode === 'batch'
                ? '一次请求并发启动多个不同模型的评测，各任务独立运行、错误互不干扰，完成后统一汇总分数与耗时。'
                : '对单个模型执行评测（原有模式，能力保持不变）。'}
            </div>
          </div>

          {/* ===== 第一行：评测名称 + 被测模型 ===== */}
          <Row gutter={24}>
            <Col span={12}>
              <Form.Item
                label={t('eval.name')}
                name="name"
                rules={mode === 'batch' ? [] : [{ required: true }]}
                tooltip="为本次评测起一个易于识别的名称，用于在评测列表和历史记录中查找（多模型并行时作为批量任务名前缀）"
              >
                <Input placeholder={mode === 'batch' ? '批量任务名（可选）' : '例如：hermes3.6-35b program 测试'} />
              </Form.Item>
            </Col>
            <Col span={12}>
              {mode === 'batch' ? (
                <Form.Item
                  label={t('eval.model')}
                  name="modelConfigIds"
                  rules={[
                    { required: true, message: '请至少选择一个被测模型' },
                    { type: 'array', max: 8, message: '单次最多选择 8 个模型' },
                  ]}
                  tooltip="可同时选择多个不同模型，点击「开始并行评测」后将并发执行，各模型评测任务相互独立、错误互不干扰"
                >
                  <Select
                    mode="multiple"
                    placeholder="选择要并发评测的模型（最多 8 个）"
                    maxTagCount="responsive"
                    allowClear
                    onChange={(ids: string[]) => {
                      setSelectedBatchModelIds(ids);
                      const includesReasoningModel = ids.some((id) => testedModels.find((model) => model.id === id)?.reasoningModel);
                      setSelectedModelReasoning(includesReasoningModel);
                      if (includesReasoningModel) {
                        form.setFieldValue('maxTokens', 49152);
                        form.setFieldValue('maxReasoningTokens', 30000);
                      }
                    }}
                  >
                    {testedModels.map((m) => (
                      <Select.Option key={m.id} value={m.id} disabled={selectedBatchModelIds.length >= 8 && !selectedBatchModelIds.includes(m.id)}>
                        {m.name} ({m.provider}){m.reasoningModel ? ' [推理]' : ''}
                      </Select.Option>
                    ))}
                  </Select>
                </Form.Item>
              ) : (
                <Form.Item label={t('eval.model')} name="modelConfigId" rules={[{ required: true }]} tooltip="选择要评测的模型。推理模型（QwQ/DeepSeek-R1等）会自动使用更大的 token 预算">
                  <Select placeholder="选择要评测的模型"
                    onChange={(id) => {
                      const model = testedModels.find(m => m.id === id);
                      const isReasoning = model?.reasoningModel === true;
                      setSelectedModelReasoning(isReasoning);
                      if (isReasoning) {
                        form.setFieldValue('maxTokens', 49152);
                        form.setFieldValue('maxReasoningTokens', 30000);
                      }
                    }}>
                    {testedModels.map((m) => (
                      <Select.Option key={m.id} value={m.id}>
                        {m.name} ({m.provider}){m.reasoningModel ? ' [推理]' : ''}
                      </Select.Option>
                    ))}
                  </Select>
                </Form.Item>
              )}
            </Col>
          </Row>

          {testedModels.length === 0 && (
            <Alert message="尚未配置被测模型，请先在「系统设置」中添加" type="warning" showIcon style={{ marginBottom: 16 }} />
          )}

          {/* ===== 评测维度选择 ===== */}
          <Form.Item label="专项题组" name="structuredPack" initialValue="default">
            <Select options={[
              { value: 'default', label: '使用常规题库和下方维度选择' },
              { value: 'mixed', label: '开发题组：已有通过与失败差异的 4 题' },
              { value: 'all', label: '开发题组：全部 19 题（八类任务）' },
              { value: 'migration-189', label: '新迁移执行题组：189 道源题、306 个执行实例' },
            ]} />
          </Form.Item>
          {structuredPack && structuredPack !== 'default' && (
            <Alert type="info" showIcon style={{ marginBottom: 16 }}
              message={structuredPack === 'migration-189'
                ? '本次评测 189 道源题对应的 306 个执行实例，每个实例生成一次并按执行结果判分。'
                : '本次只评测所选结构化输出开发题组，每题生成一次，使用规则判分。'}
              description="专项题组在开发评测中显式启用；下方维度、发布模式和重复次数将由题组设置覆盖。" />
          )}
          <Form.Item
            label={t('eval.dimensions')}
            name="dimensionIds"
            tooltip="选择本次评测覆盖的维度。不选则跑全部 10 个维度；只选部分维度可大幅缩短耗时，适合针对性复测或补测"
          >
            <Select
              mode="multiple"
              placeholder="默认全部维度（可只选一个或几个）"
              maxTagCount="responsive"
              allowClear
              disabled={Boolean(structuredPack && structuredPack !== 'default')}
              options={DIMENSION_OPTIONS}
            />
          </Form.Item>
          <Text type="secondary" style={{ fontSize: 12, display: 'block', marginTop: -16, marginBottom: 16 }}>
            不选任何维度 = 全量评测；选中部分维度时仅跑对应题目，排行榜会按实际覆盖范围统计题量
          </Text>

          <Form.Item name="difficultyIds" label="难度筛选" tooltip="留空表示全部难度；专项题组使用固定题集，忽略维度和难度筛选。">
            <Select mode="multiple" allowClear disabled={Boolean(structuredPack && structuredPack !== 'default')} options={['easy', 'medium', 'hard', 'adversarial'].map(value => ({ value, label: ({ easy: '简单', medium: '中等', hard: '困难', adversarial: '对抗' } as Record<string, string>)[value] }))} />
          </Form.Item>
          <Alert type={previewError ? 'warning' : 'info'} style={{ marginBottom: 16 }} message={previewError || (preview ? ('预计 ' + preview.count + ' 道执行实例；服务端预览与创建共用同一选题规则') : '正在预览题集…')} description={structuredPack && structuredPack !== 'default' ? '专项题组固定，不按维度或难度裁剪；迁移实例不增加默认源题总数。' : '维度和难度留空表示全部可用默认题，开发影子题仅显式选择或专项运行。'} />
          {selectedModelReasoning && (
            <Alert
              message={mode === 'batch' ? '已选模型中包含推理模型' : '推理模型已选择'}
              description="推理模型会产生大量思考链 tokens。已自动设为 Max Tokens=49152、思考链上限=30000（可自行调整），若仍频繁截断可调至 65536。"
              type="info"
              showIcon
              style={{ marginBottom: 16 }}
            />
          )}

          {/* ===== 第二行：Max Tokens + Temperature + 运行次数 ===== */}
          <Row gutter={24}>
            <Col span={8}>
              <Form.Item label="Max Tokens" name="maxTokens" initialValue={8192} tooltip="模型单次生成的最大 Token 数。推理模型建议 32768+（可在模型配置中标记为推理模型自动生效）">
                <InputNumber min={256} max={131072} step={256} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item label="Temperature" name="temperature" tooltip="控制生成随机性，0=完全确定，2=高度随机。留空则使用模型默认值">
                <InputNumber min={0} max={2} step={0.1} style={{ width: '100%' }} placeholder="留空使用默认值" />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item label="评测发布模式" name="evaluationMode" initialValue="development">
                <Select options={[{ value: 'development', label: '开发评测（允许未审核题）' }, { value: 'official', label: '正式评测（必须通过金标准审核门槛）' }]} />
              </Form.Item>
              <Form.Item label={t('eval.runsPerQuestion')} name="runsPerQuestion" initialValue={1} tooltip="真实重复调用被测模型，按次数增加 token 与耗时；Judge 重复判分另行统计。">
                <InputNumber min={1} max={10} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
          </Row>

          <Divider orientation="left" plain style={{ fontSize: 13, color: 'var(--text-helper)' }}>
            {t('eval.advanced')}
          </Divider>

          {/* ===== 开关选项：横向网格排列 ===== */}
          <Row gutter={[24, 16]}>
            <Col span={6}>
              <Form.Item
                label={t('eval.aiJudge')}
                name="judgeEnabled"
                valuePropName="checked"
                tooltip="开启后，AI Judge 模型会对被测模型的回答进行二次评分复核"
              >
                <Switch onChange={(checked) => setJudgeEnabled(checked)} />
              </Form.Item>
            </Col>
            <Col span={6}>
              <Form.Item
                label={t('eval.escalation')}
                name="escalationEnabled"
                valuePropName="checked"
                tooltip="当规则评分与 AI Judge 评分存在显著分歧时，自动触发更高级别复核"
              >
                <Switch />
              </Form.Item>
            </Col>
            <Col span={6}>
              <Form.Item
                label={t('eval.safetyCheck')}
                name="safetyCheckEnabled"
                valuePropName="checked"
                initialValue={true}
                tooltip="在 safety_authority 维度中对模型回答进行安全红线检测"
              >
                <Switch defaultChecked />
              </Form.Item>
            </Col>
            <Col span={6}>
              <Form.Item
                label={t('eval.hiddenTests')}
                name="hiddenTestsEnabled"
                valuePropName="checked"
                initialValue={true}
                tooltip="使用隐藏的额外测试用例来检验模型回答的健壮性"
              >
                <Switch defaultChecked />
              </Form.Item>
            </Col>
            <Col span={6}>
              <Form.Item
                label={t('eval.structuredOutput')}
                name="structuredOutputEnabled"
                valuePropName="checked"
                tooltip="在 structured_output 维度中要求模型以 JSON 等结构化格式输出"
              >
                <Switch />
              </Form.Item>
            </Col>
            {judgeEnabled && (
              <Col span={12}>
                <Form.Item
                  label={t('eval.judgeModel')}
                  name="judgeModelConfigId"
                  preserve
                  tooltip="选择用于评分复核的模型。若不选择，系统会自动使用第一个配置的 Judge 模型"
                >
                  <Select placeholder="选择 Judge 模型（可选）" allowClear>
                    {judgeModels.map((m) => (
                      <Select.Option key={m.id} value={m.id}>{m.name} ({m.provider})</Select.Option>
                    ))}
                  </Select>
                </Form.Item>
              </Col>
            )}
          </Row>

          {judgeEnabled && judgeModels.length === 0 && (
            <Alert message="未配置 AI Judge 模型，将跳过 Judge 复核" type="info" showIcon style={{ marginBottom: 16 }} />
          )}

          <Divider />

          {/* ===== 并发度 ===== */}
          <Form.Item
            label={t('eval.parallelism')}
            name="parallelism"
            initialValue={4}
            tooltip="同时并发处理的题目数量，上限 4（= 最多 4 题并发 = 最多 4 维度并发）。设为 1 则为串行测试"
          >
            <Slider
              min={1}
              max={4}
              marks={{ 1: '1 (串行)', 2: '2', 3: '3', 4: '4 (上限)' }}
            />
          </Form.Item>
          <Text type="secondary" style={{ fontSize: 12, display: 'block', marginTop: -8, marginBottom: 16 }}>
            并发数越大评测越快、GPU 利用率越高，但 API 并发压力也越大。本地 Ollama 建议同时设置 OLLAMA_NUM_PARALLEL 环境变量
          </Text>

          {/* ===== 并行模式 ===== */}
          <Form.Item
            label={t('eval.parallelMode')}
            name="parallelMode"
            initialValue="global"
            tooltip="全局并发池：所有 worker 共享轮转交叉队列，不同维度题目交替处理。维度独立并行：每个维度分配合 worker，适合需要所有维度同时推进的场景"
          >
            <Radio.Group>
              <Radio.Button value="global">全局并发池（轮转交叉）</Radio.Button>
              <Radio.Button value="per_dimension">维度独立并行（各维度独立 worker）</Radio.Button>
            </Radio.Group>
          </Form.Item>
          <Text type="secondary" style={{ fontSize: 12, display: 'block', marginTop: -8, marginBottom: 16 }}>
            全局并发池：worker 交替处理不同维度题目，GPU 利用率最高。维度独立并行：每个维度独占 worker，确保所有维度同时推进。
          </Text>

          <Divider orientation="left" plain style={{ fontSize: 13, color: 'var(--text-helper)' }}>
            {t('eval.constraints')}
          </Divider>
          <Text type="secondary" style={{ fontSize: 12, display: 'block', marginBottom: 12 }}>
            用于应对推理模型（QwQ/DeepSeek-R1 等）无限思考导致超时/上下文过长的问题。开启后约束以指令注入 prompt（软约束），
            并由引擎硬校验：token 或时间超限立即中断该题并按策略判分，不再无限升级 token 预算。
          </Text>

          {/* ===== 思考约束 ===== */}
          <Row gutter={[24, 16]}>
            <Col span={6}>
              <Form.Item
                label={t('eval.answerFirst')}
                name="answerFirst"
                valuePropName="checked"
                tooltip="要求最终答案位于输出开头。严格格式题会自动只输出答案，不再强制附加解释"
              >
                <Switch />
              </Form.Item>
            </Col>
            <Col span={6}>
              <Form.Item
                label={t('eval.visibleRationale')}
                name="visibleRationale"
                initialValue="auto"
                tooltip="自动：严格格式题仅输出答案，其余题可附简短理由。也可强制禁止或要求解释"
              >
                <Select disabled={!answerFirstEnabled}>
                  <Select.Option value="auto">自动适配</Select.Option>
                  <Select.Option value="forbidden">仅答案</Select.Option>
                  <Select.Option value="required">答案后附理由</Select.Option>
                </Select>
              </Form.Item>
            </Col>
            <Col span={6}>
              <Form.Item
                label={t('eval.maxReasoningTokens')}
                name="maxReasoningTokens"
                tooltip="思考链（reasoning_content）允许的最大 token 数。答案预算 = Max Tokens − 思考链上限，无需单独设置。0 表示不限制"
              >
                <InputNumber min={0} max={131072} step={1024} style={{ width: '100%' }} placeholder="不限制" />
              </Form.Item>
            </Col>
            <Col span={6}>
              <Form.Item
                label={t('eval.hardTimeLimitSec')}
                name="hardTimeLimitSec"
                tooltip="单题调用模型的最长等待时间，超时立即中断并判超限。留空则使用默认 300 秒（5 分钟）"
              >
                <InputNumber min={10} max={1800} step={10} style={{ width: '100%' }} placeholder="默认 300" />
              </Form.Item>
            </Col>
            <Col span={6}>
              <Form.Item
                label={t('eval.onLimit')}
                name="onLimit"
                initialValue="fail"
                tooltip="判 0 分（fail）：超限即失败，最快推进队列。降权（degrade）：记录证据但按 0 分处理。标记复核（flag）：置为需人工复核"
              >
                <Select>
                  <Select.Option value="fail">判 0 分</Select.Option>
                  <Select.Option value="degrade">降权</Select.Option>
                  <Select.Option value="flag">标记人工复核</Select.Option>
                </Select>
              </Form.Item>
            </Col>
          </Row>

          <Form.Item>
            <Button type="primary" htmlType="submit" loading={loading} size="large">
              {mode === 'batch' ? t('eval.startBatch') : t('eval.start')}
            </Button>
          </Form.Item>
        </Form>
      </div>
    </div>
  );
}
