import { useEffect, useState, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { Spin, Tag, Progress, Row, Col, Card, Statistic, Button, Empty, Tooltip, message, Dropdown, Table, Alert } from 'antd';
import { ArrowLeftOutlined, TrophyOutlined, WarningOutlined, CheckCircleOutlined, RobotOutlined, ReloadOutlined, DownloadOutlined, FileTextOutlined, FilePdfOutlined, ThunderboltOutlined } from '@ant-design/icons';
import ReactECharts from 'echarts-for-react';
import MarkdownRenderer from '../components/MarkdownRenderer';
import ScoreFormulaTooltip from '../components/ScoreFormulaTooltip';
import { useTheme } from '../theme';
import { useLanguage } from '../i18n';

interface DimensionReport {
  dimension: string;
  dimensionLabel: string;
  count: number;
  averageScore: number;
  maxScore: number;
  minScore: number;
  medianScore: number;
  passRate: number;
  passCount: number;
  failCount: number;
  redLineCount: number;
  formatFailCount: number;
  distribution: Record<string, number>;
  axisAvg: Record<string, number>;
  /** 证据强度披露：verified/rule/llm/unmeasured 轴数 */
  evidence?: Record<string, number>;
}

interface ReportData {
  runId: string;
  runName: string;
  runStatus: string;
  createdAt: string;
  reportContent?: string | null;
  model: {
    name: string;
    provider: string;
    baseUrl: string;
    maxTokens: number;
    temperature: number | null;
    runsPerQuestion: number;
    judgeEnabled: boolean;
  };
  totalScenarios: number;
  completedScenarios?: number;
  missingScenarios?: number;
  averageScore: number;
  passRate: number;
  passCount: number;
  redLineCount: number;
  formatFailCount: number;
  globalDistribution: Record<string, number>;
  dimensions: DimensionReport[];
  strengths: { dimension: string; score: number; passRate: number }[];
  weaknesses: { dimension: string; score: number; passRate: number }[];
  radarData: { name: string; value: number }[];
  /** 幻觉抵抗专项指标（仅当该维度有结果时存在） */
  hallucinationStats?: {
    hrs: number;
    overRefusalRate: number;
    answerableCount: number;
    labelDistribution: Record<string, number>;
  } | null;
  /** 长任务工程能力专项（编程维度 long_task_* 子项；仅当有长任务结果时存在） */
  longTaskStats?: {
    count: number;
    averageScore: number;
    passRate: number;
    distribution: Record<string, number>;
    subCategories: Array<{ category: string; count: number; averageScore: number }>;
  } | null;
  tokenStats?: {
    totalInputTokens: number;
    totalOutputTokens: number;
    totalTokens: number;
    avgTokensPerSecond: number;
  };
  /** 全局证据强度摘要（全部结果的轴证据类型分布） */
  evidenceSummary?: Record<string, number>;
}

// 维度颜色映射
const DIM_COLORS: Record<string, string> = {
  agent_workflow: '#52c41a',
  instruction_following: '#1890ff',
  tool_cli_workflow: '#13c2c2',
  data_extraction: '#2f54eb',
  structured_output: '#722ed1',
  program: '#eb2f96',
  cli_deep_tasks: '#fa8c16',
  safety_authority: '#f5222d',
  reasoning_math: '#faad14',
  hallucination_resistance: '#8b5cf6',
};

function scoreColor(score: number): string {
  if (score >= 80) return '#52c41a';
  if (score >= 60) return '#1890ff';
  if (score >= 40) return '#faad14';
  return '#f5222d';
}

// 评分证据强度元数据
const EVIDENCE_META: Record<string, { label: Record<'zh' | 'en', string>; color: string; desc: Record<'zh' | 'en', string> }> = {
  verified: { label: { zh: '真实执行', en: 'Verified' }, color: '#52c41a', desc: { zh: '沙箱测试 / 编译验证', en: 'Sandbox test / compile verify' } },
  rule: { label: { zh: '规则判定', en: 'Rule' }, color: '#1890ff', desc: { zh: '确定性规则匹配', en: 'Deterministic rule match' } },
  llm: { label: { zh: 'AI 判分', en: 'AI Judge' }, color: '#722ed1', desc: { zh: 'AI Judge 语义评估', en: 'AI semantic assessment' } },
  unmeasured: { label: { zh: '未测量', en: 'Unmeasured' }, color: '#8c8c8c', desc: { zh: '该能力未覆盖（未参与加权）', en: 'Not covered (excluded from weighting)' } },
};

/** 证据强度徽标组 */
function EvidenceTags({ ev }: { ev?: Record<string, number> }) {
  const { lang } = useLanguage();
  const items = Object.entries(ev || {}).filter(([, v]) => v > 0);
  if (items.length === 0) return <span style={{ color: 'var(--text-helper)', fontSize: 12 }}>—</span>;
  return (
    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
      {items.map(([k, v]) => {
        const meta = EVIDENCE_META[k];
        if (!meta) return null;
        return (
          <Tooltip key={k} title={`${meta.label[lang]} (${meta.desc[lang]}): ${v} ${lang === 'en' ? 'axes' : '个评分轴'}`}>
            <Tag color={meta.color} style={{ marginRight: 0, cursor: 'help' }}>
              {meta.label[lang]} {v}
            </Tag>
          </Tooltip>
        );
      })}
    </div>
  );
}

export default function Report() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [report, setReport] = useState<ReportData | null>(null);
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [aiReport, setAiReport] = useState<string | null>(null);
  const chartRef = useRef<ReactECharts>(null);
  const { mode } = useTheme();
  const { t, lang } = useLanguage();

  useEffect(() => {
    if (!id) return;
    fetch(`/api/runs/${id}/report?lang=${lang}`)
      .then((r) => r.json())
      .then((res) => {
        if (res.success) {
          setReport(res.data);
          if (res.data.reportContent) {
            setAiReport(res.data.reportContent);
          }
        }
      })
      .catch(console.error)
      .finally(() => setLoading(false));
  }, [id, lang]);

  const handleGenerateReport = async () => {
    if (!id) return;
    setGenerating(true);
    try {
      const res = await fetch(`/api/runs/${id}/report/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ language: lang }),
      });
      const data = await res.json();
      if (data.success) {
        setAiReport(data.data.reportContent);
        message.success('AI 报告生成成功');
      } else {
        message.error(data.error || '报告生成失败');
      }
    } catch (err) {
      message.error('请求失败，请检查 Judge 模型状态');
    } finally {
      setGenerating(false);
    }
  };

  // 下载报告
  const handleDownload = (format: 'md' | 'pdf') => {
    if (!id) return;
    const url = `/api/runs/${id}/report/download?format=${format}`;
    const link = document.createElement('a');
    link.href = url;
    link.download = '';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    message.success(`正在下载 ${format.toUpperCase()} 格式报告...`);
  };

  if (loading) return <div style={{ padding: 80, textAlign: 'center' }}><Spin size="large" /></div>;
  if (!report) return <Empty description="未找到报告数据" style={{ padding: 80 }} />;

  // ===== 图表文字/数字配色 =====
  // ECharts 用 canvas 渲染，无法解析 CSS 变量（var(--xxx)），这里用具体色值并按主题切换，提升对比度
  const isDark = mode === 'dark';
  const cAxisLabel = isDark ? '#ece7df' : '#1c1c1c';   // 轴标签 / 维度名（高对比）
  const cAxisSub = isDark ? '#c9c2b8' : '#4a4a4a';     // 刻度数字 / 次级标签
  const cValue = isDark ? '#ffffff' : '#111111';       // 柱顶/柱侧数值标签
  const cGrid = isDark ? 'rgba(210,205,198,0.16)' : 'rgba(20,20,20,0.12)'; // 网格线
  const cArea = isDark ? ['rgba(210,205,198,0.02)', 'rgba(210,205,198,0.05)'] : ['rgba(20,20,20,0.02)', 'rgba(20,20,20,0.045)'];

  // 雷达图配置
  const radarOption = {
    tooltip: { trigger: 'item' },
    radar: {
      indicator: report.radarData.map((d) => ({ name: d.name, max: 100 })),
      shape: 'polygon',
      splitNumber: 5,
      axisName: { color: cAxisLabel, fontSize: 14, fontWeight: 'bold' },
      axisLabel: { show: true, color: cAxisSub, fontSize: 10 },
      splitLine: { lineStyle: { color: cGrid } },
      splitArea: { areaStyle: { color: cArea } },
      axisLine: { lineStyle: { color: cGrid } },
    },
    series: [{
      type: 'radar',
      data: [{
        value: report.radarData.map((d) => d.value),
        name: report.model.name,
        areaStyle: { color: 'rgba(24,144,255,0.25)' },
        lineStyle: { color: '#1890ff', width: 2 },
        itemStyle: { color: '#1890ff' },
        symbolSize: 6,
      }],
    }],
  };

  // 全局分数分布柱状图
  const distOption = {
    tooltip: { trigger: 'axis' },
    grid: { left: '3%', right: '4%', bottom: '3%', containLabel: true },
    xAxis: {
      type: 'category',
      data: Object.keys(report.globalDistribution),
      axisLabel: { color: cAxisLabel, fontWeight: 600 },
    },
    yAxis: {
      type: 'value',
      axisLabel: { color: cAxisSub },
    },
    series: [{
      data: Object.values(report.globalDistribution).map((v, i) => ({
        value: v,
        itemStyle: { color: ['#f5222d', '#fa541c', '#faad14', '#52c41a', '#1890ff'][i] },
      })),
      type: 'bar',
      barWidth: '50%',
      label: { show: true, position: 'top', color: cValue, fontWeight: 700, fontSize: 14 },
    }],
  };

  // 维度排名横向柱状图
  const rankOption = {
    tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
    grid: { left: '3%', right: '8%', bottom: '3%', containLabel: true },
    xAxis: { type: 'value', max: 100, axisLabel: { color: cAxisSub } },
    yAxis: {
      type: 'category',
      data: [...report.dimensions].reverse().map((d) => d.dimensionLabel),
      axisLabel: { color: cAxisLabel, fontSize: 13, fontWeight: 600 },
    },
    series: [{
      type: 'bar',
      data: [...report.dimensions].reverse().map((d) => ({
        value: d.averageScore,
        itemStyle: { color: scoreColor(d.averageScore) },
      })),
      barWidth: '50%',
      label: { show: true, position: 'right', formatter: '{c}', color: cValue, fontWeight: 700, fontSize: 13 },
    }],
  };

  return (
    <div style={{ maxWidth: 1200, margin: '0 auto' }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', marginBottom: 24, gap: 16 }}>
        <Button icon={<ArrowLeftOutlined />} onClick={() => navigate(-1)}>{t('report.back')}</Button>
        <h2 className="swiss-page-title" style={{ margin: 0, flex: 1 }}>
          {t('report.title')} — {report.model.name}
        </h2>
        <Tag color={report.runStatus === 'completed' ? 'green' : 'orange'}>{report.runStatus}</Tag>
      </div>

      {/* Top KPI Cards */}
      <Row gutter={[16, 16]} style={{ marginBottom: 24 }}>
        <Col xs={12} sm={6} md={4}>
          <Card className="swiss-card" bodyStyle={{ padding: 20 }}>
            <Statistic
              title={
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                  {t('report.compositeScore')}
                  <ScoreFormulaTooltip placement="bottom" />
                </span>
              }
              value={report.averageScore}
              suffix="/100"
              precision={2}
              valueStyle={{ color: scoreColor(report.averageScore), fontSize: 32, fontWeight: 700 }}
            />
          </Card>
        </Col>
        <Col xs={12} sm={6} md={4}>
          <Card className="swiss-card" bodyStyle={{ padding: 20 }}>
            <Statistic
              title={t('report.passRate')}
              value={report.passRate}
              suffix="%"
              valueStyle={{ color: report.passRate >= 70 ? '#52c41a' : '#faad14', fontSize: 32, fontWeight: 700 }}
            />
            <div style={{ fontSize: 12, color: 'var(--text-helper)' }}>{report.passCount}/{report.totalScenarios} 题</div>
          </Card>
        </Col>
        <Col xs={12} sm={6} md={4}>
          <Card className="swiss-card" bodyStyle={{ padding: 20 }}>
            <Statistic
              title="安全红线"
              value={report.redLineCount}
              suffix="个"
              valueStyle={{ color: report.redLineCount > 0 ? '#f5222d' : '#52c41a', fontSize: 32, fontWeight: 700 }}
              prefix={report.redLineCount > 0 ? <WarningOutlined /> : <CheckCircleOutlined />}
            />
          </Card>
        </Col>
        <Col xs={12} sm={6} md={4}>
          <Card className="swiss-card" bodyStyle={{ padding: 20 }}>
            <Statistic
              title="总题数"
              value={report.totalScenarios}
              suffix="/404"
              valueStyle={{ fontSize: 32, fontWeight: 700, color: (report.missingScenarios ?? 0) > 0 ? '#faad14' : '#13c2c2' }}
            />
            <div style={{ fontSize: 12, color: 'var(--text-helper)', marginTop: 4 }}>
              {(report.completedScenarios ?? report.totalScenarios)} 题已评测
              {(report.missingScenarios ?? 0) > 0 && (
                <span style={{ color: '#f5222d', marginLeft: 6 }}>⚠ 缺失 {report.missingScenarios} 题未评测</span>
              )}
            </div>
          </Card>
        </Col>
        <Col xs={12} sm={6} md={4}>
          <Card className="swiss-card" bodyStyle={{ padding: 20 }}>
            <Statistic
              title="Token 速度"
              value={report.tokenStats?.avgTokensPerSecond ?? '-'}
              suffix={report.tokenStats ? 't/s' : ''}
              valueStyle={{
                color: (() => {
                  const tps = report.tokenStats?.avgTokensPerSecond ?? 0;
                  return tps >= 100 ? '#52c41a' : tps >= 30 ? '#1890ff' : '#fa8c16';
                })(),
                fontSize: 32, fontWeight: 700,
              }}
              prefix={<ThunderboltOutlined />}
            />
            {report.tokenStats && (
              <div style={{ fontSize: 12, color: 'var(--text-helper)' }}>
                输出 {report.tokenStats.totalOutputTokens >= 1000
                  ? `${(report.tokenStats.totalOutputTokens / 1000).toFixed(1)}K`
                  : report.tokenStats.totalOutputTokens} tokens
              </div>
            )}
          </Card>
        </Col>
        <Col xs={12} sm={6} md={4}>
          <Card className="swiss-card" bodyStyle={{ padding: 20 }}>
            <Statistic
              title="总 Token"
              value={report.tokenStats?.totalTokens != null
                ? (report.tokenStats.totalTokens >= 1000
                  ? `${(report.tokenStats.totalTokens / 1000).toFixed(1)}K`
                  : report.tokenStats.totalTokens)
                : '-'}
              valueStyle={{ fontSize: 32, fontWeight: 700, color: '#2f54eb' }}
            />
            {report.tokenStats && (
              <div style={{ fontSize: 12, color: 'var(--text-helper)' }}>
                输入 {report.tokenStats.totalInputTokens >= 1000
                  ? `${(report.tokenStats.totalInputTokens / 1000).toFixed(1)}K`
                  : report.tokenStats.totalInputTokens} / 输出 {report.tokenStats.totalOutputTokens >= 1000
                  ? `${(report.tokenStats.totalOutputTokens / 1000).toFixed(1)}K`
                  : report.tokenStats.totalOutputTokens}
              </div>
            )}
          </Card>
        </Col>
      </Row>

      {/* Model Info */}
      <Card className="swiss-card" style={{ marginBottom: 16 }}>
        <div className="swiss-card-title">{lang === 'en' ? 'Model Info' : '模型信息'}</div>
        <Row gutter={[24, 8]}>
          <Col span={6}><span style={{ color: 'var(--text-secondary)' }}>{lang === 'en' ? 'Model: ' : '模型名称：'}</span><b>{report.model.name}</b></Col>
          <Col span={6}><span style={{ color: 'var(--text-secondary)' }}>{lang === 'en' ? 'Provider: ' : '提供方：'}</span><b>{report.model.provider}</b></Col>
          <Col span={12}><span style={{ color: 'var(--text-secondary)' }}>Base URL：</span><b>{report.model.baseUrl}</b></Col>
          <Col span={6}><span style={{ color: 'var(--text-secondary)' }}>Max Tokens：</span><b>{report.model.maxTokens}</b></Col>
          <Col span={6}><span style={{ color: 'var(--text-secondary)' }}>Temperature：</span><b>{report.model.temperature ?? 'default'}</b></Col>
          <Col span={6}><span style={{ color: 'var(--text-secondary)' }}>{lang === 'en' ? 'Runs/question: ' : '每题运行次数：'}</span><b>{report.model.runsPerQuestion}</b></Col>
          <Col span={6}><span style={{ color: 'var(--text-secondary)' }}>{lang === 'en' ? 'AI Judge: ' : 'AI Judge：'}</span><b>{report.model.judgeEnabled ? (lang === 'en' ? 'Enabled' : '启用') : (lang === 'en' ? 'Disabled' : '禁用')}</b></Col>
        </Row>
      </Card>

      {/* Radar + Rank */}
      <Row gutter={[16, 16]} style={{ marginBottom: 16 }}>
        <Col xs={24} lg={12}>
          <Card className="swiss-card" style={{ height: '100%' }}>
            <div className="swiss-card-title">{t('report.radarTitle')}</div>
            <ReactECharts ref={chartRef} option={radarOption} style={{ height: 380 }} />
          </Card>
        </Col>
        <Col xs={24} lg={12}>
          <Card className="swiss-card" style={{ height: '100%' }}>
            <div className="swiss-card-title">{t('report.rankTitle')}</div>
            <ReactECharts option={rankOption} style={{ height: 380 }} />
          </Card>
        </Col>
      </Row>

      {/* 难度分布披露：跨维度比较需谨慎 */}
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 16 }}
        message={lang === 'en' ? 'Cross-dimension comparison caveat' : '跨维度比较需谨慎'}
        description={
          lang === 'en'
            ? 'Difficulty labels are uneven across dimensions: agent_workflow / cli_deep_tasks are ~84-86% hard/adversarial, while reasoning_math / structured_output are only 32-36%. The same score therefore sits on a different difficulty baseline in different dimensions.'
            : '各维度难度标签分布不均：agent_workflow / cli_deep_tasks 约 84-86% 为 hard/adversarial，而 reasoning_math / structured_output 仅 32-36%。同一分数在不同维度上的难度基线不同，横向比较需谨慎。'
        }
      />

      {/* Score Distribution */}
      <Card className="swiss-card" style={{ marginBottom: 16 }}>
        <div className="swiss-card-title">{t('report.distTitle')}</div>
        <ReactECharts option={distOption} style={{ height: 260 }} />
      </Card>

      {/* 幻觉抵抗专项 */}
      {report.hallucinationStats && (() => {
        const hs = report.hallucinationStats;
        const labelMeta: Array<{ key: string; label: string; color: string }> = [
          { key: 'correct', label: lang === 'en' ? 'Correct' : '正确回答', color: '#52c41a' },
          { key: 'correct_refusal', label: lang === 'en' ? 'Correct Refusal' : '正确拒答', color: '#1890ff' },
          { key: 'partial', label: lang === 'en' ? 'Partial' : '部分正确', color: '#faad14' },
          { key: 'hallucination', label: lang === 'en' ? 'Hallucination' : '幻觉', color: '#f5222d' },
          { key: 'wrong_refusal', label: lang === 'en' ? 'Over-refusal' : '过度拒答', color: '#eb2f96' },
          { key: 'accepted_false_premise', label: lang === 'en' ? 'Accepted False Premise' : '接受错误前提', color: '#fa541c' },
        ];
        return (
          <Card className="swiss-card" style={{ marginBottom: 16 }}>
            <div className="swiss-card-title">
              {lang === 'en' ? 'Hallucination Resistance' : '幻觉抵抗专项'}
              <span style={{ fontSize: 12, color: 'var(--text-helper)', marginLeft: 12, fontWeight: 400 }}>
                {lang === 'en' ? 'Tests whether the model should answer, resists prompting, and avoids fabrication' : '测模型「是否该回答、会不会被诱导、会不会编造」'}
              </span>
            </div>
            <Row gutter={16} style={{ marginBottom: 16 }}>
              <Col span={8}>
                <Statistic
                  title={lang === 'en' ? 'HRS Score' : '幻觉抵抗分 (HRS)'}
                  value={hs.hrs}
                  suffix="分"
                  precision={1}
                  valueStyle={{ color: scoreColor(hs.hrs), fontSize: 30 }}
                />
                <div style={{ fontSize: 12, color: 'var(--text-helper)' }}>{lang === 'en' ? 'Higher = more resistant, max 100' : '越高越能抵抗幻觉，满分 100'}</div>
              </Col>
              <Col span={8}>
                <Statistic
                  title={lang === 'en' ? 'Over-refusal Rate' : '过度拒答率'}
                  value={hs.overRefusalRate}
                  suffix="%"
                  valueStyle={{ color: hs.overRefusalRate > 30 ? '#f5222d' : hs.overRefusalRate > 15 ? '#faad14' : '#52c41a', fontSize: 30 }}
                />
                <div style={{ fontSize: 12, color: 'var(--text-helper)' }}>
                  {lang === 'en' ? 'Wrong refusals of answerable questions (' + hs.answerableCount + ' answerable)' : '对可回答的题错误拒答的比例（' + hs.answerableCount + ' 道可答题）'}
                </div>
              </Col>
              <Col span={8}>
                <div style={{ fontSize: 13, color: 'var(--text-helper)', marginBottom: 8 }}>{lang === 'en' ? 'Verdict Distribution' : '判定分布'}</div>
                {labelMeta.map((m) => (
                  <div key={m.key} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                    <span style={{ width: 14, height: 14, background: m.color, borderRadius: 3, display: 'inline-block' }} />
                    <span style={{ fontSize: 13, minWidth: 100 }}>{m.label}</span>
                    <span style={{ fontSize: 13, fontWeight: 600 }}>{hs.labelDistribution[m.key] ?? 0}</span>
                  </div>
                ))}
              </Col>
            </Row>
          </Card>
        );
      })()}

      {/* 长任务工程能力专项（编程维度子项） */}
      {report.longTaskStats && (() => {
        const lt = report.longTaskStats;
        const distMeta: Array<{ key: string; label: string; color: string }> = [
          { key: '0-20', label: '0-20', color: '#f5222d' },
          { key: '21-40', label: '21-40', color: '#fa541c' },
          { key: '41-60', label: '41-60', color: '#faad14' },
          { key: '61-80', label: '61-80', color: '#a0d911' },
          { key: '81-100', label: '81-100', color: '#52c41a' },
        ];
        return (
          <Card className="swiss-card" style={{ marginBottom: 16 }}>
            <div className="swiss-card-title">
              {lang === 'en' ? 'Long-task Engineering (Program Sub-category)' : '长任务工程能力（编程维度子项）'}
              <span style={{ fontSize: 12, color: 'var(--text-helper)', marginLeft: 12, fontWeight: 400 }}>
                {lang === 'en'
                  ? 'Multi-file / multi-step / cross-turn context management — agentic coding core; aggregation weight 3.0'
                  : '多文件/多步骤/跨轮上下文管理（agentic coding 核心）；聚合权重 3.0，单独出分'}
              </span>
            </div>
            <Row gutter={16} style={{ marginBottom: 16 }}>
              <Col span={8}>
                <Statistic
                  title={lang === 'en' ? 'Long-task Score' : '长任务工程能力分'}
                  value={lt.averageScore}
                  suffix={lang === 'en' ? '' : '分'}
                  precision={1}
                  valueStyle={{ color: scoreColor(lt.averageScore), fontSize: 30 }}
                />
                <div style={{ fontSize: 12, color: 'var(--text-helper)' }}>
                  {lang === 'en' ? `${lt.count} long-task scenarios (debug / implement / refactor)` : `共 ${lt.count} 道长任务题（调试 / 实现 / 重构）`}
                </div>
              </Col>
              <Col span={8}>
                <Statistic
                  title={lang === 'en' ? 'Pass Rate' : '通过率'}
                  value={lt.passRate}
                  suffix="%"
                  valueStyle={{ color: scoreColor(lt.passRate), fontSize: 30 }}
                />
                <div style={{ fontSize: 12, color: 'var(--text-helper)' }}>
                  {lang === 'en' ? 'Partial credit gradient shows how far the model gets' : 'partial credit 有梯度，反映模型能走多远'}
                </div>
              </Col>
              <Col span={8}>
                <div style={{ fontSize: 13, color: 'var(--text-helper)', marginBottom: 8 }}>{lang === 'en' ? 'Score Distribution' : '分数分布'}</div>
                {distMeta.map((m) => (
                  <div key={m.key} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                    <span style={{ width: 14, height: 14, background: m.color, borderRadius: 3, display: 'inline-block' }} />
                    <span style={{ fontSize: 13, minWidth: 100 }}>{m.label}</span>
                    <span style={{ fontSize: 13, fontWeight: 600 }}>{lt.distribution[m.key] ?? 0}</span>
                  </div>
                ))}
              </Col>
            </Row>
            {lt.subCategories.length > 0 && (
              <Row gutter={16}>
                {lt.subCategories.map((c) => (
                  <Col span={8} key={c.category}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                      <span style={{ fontSize: 14, minWidth: 90 }}>{c.category}</span>
                      <Progress
                        percent={Math.round(c.averageScore)}
                        size="small"
                        strokeColor={scoreColor(c.averageScore)}
                        style={{ flex: 1, margin: 0 }}
                        format={() => c.averageScore.toFixed(1)}
                      />
                      <span style={{ fontSize: 12, color: 'var(--text-helper)' }}>{c.count} {lang === 'en' ? 'questions' : '题'}</span>
                    </div>
                  </Col>
                ))}
              </Row>
            )}
          </Card>
        );
      })()}

      {/* 评分证据构成 */}
      <Card className="swiss-card" style={{ marginBottom: 16 }}>
        <div className="swiss-card-title">
          {lang === 'en' ? 'Evidence Composition' : '评分证据构成'}
          <span style={{ fontSize: 12, color: 'var(--text-helper)', marginLeft: 12, fontWeight: 400 }}>
            {lang === 'en' ? 'How each dimension total is supported (unmeasured axes excluded from weighting)' : '每个维度的总分由哪些证据支撑（未测量轴不计入加权）'}
          </span>
        </div>
        <Table
          size="small"
          rowKey="dimension"
          pagination={false}
          dataSource={report.dimensions}
          columns={[
            {
              title: lang === 'en' ? 'Dimension' : '维度', dataIndex: 'dimensionLabel', key: 'dimensionLabel', width: 160,
              render: (v: string) => <span style={{ fontWeight: 500 }}>{v}</span>,
            },
            {
              title: lang === 'en' ? 'Avg' : '均分', dataIndex: 'averageScore', key: 'averageScore', width: 100,
              render: (v: number) => <span style={{ color: scoreColor(v), fontWeight: 600 }}>{v}</span>,
            },
            {
              title: lang === 'en' ? 'Evidence' : '证据构成', key: 'evidence',
              render: (_: unknown, r: DimensionReport) => <EvidenceTags ev={r.evidence} />,
            },
          ]}
          summary={() => (
            <Table.Summary.Row>
              <Table.Summary.Cell index={0}><b>{lang === 'en' ? 'Total (all dimension axes)' : '全局（全部维度轴数合计）'}</b></Table.Summary.Cell>
              <Table.Summary.Cell index={1} />
              <Table.Summary.Cell index={2}><EvidenceTags ev={report.evidenceSummary} /></Table.Summary.Cell>
            </Table.Summary.Row>
          )}
        />
      </Card>

      {/* Strengths & Weaknesses */}
      <Row gutter={[16, 16]} style={{ marginBottom: 16 }}>
        <Col xs={24} sm={12}>
          <Card className="swiss-card" style={{ height: '100%' }}>
            <div className="swiss-card-title">
              <TrophyOutlined style={{ color: '#52c41a', marginRight: 8 }} />
              {lang === 'en' ? 'Strengths' : '优势维度'}
            </div>
            {report.strengths.length > 0 ? (
              report.strengths.map((s, i) => (
                <div key={i} style={{ display: 'flex', alignItems: 'center', marginBottom: 12, gap: 12 }}>
                  <span style={{ fontSize: 14, minWidth: 100 }}>{s.dimension}</span>
                  <Progress
                    percent={s.score}
                    size="small"
                    strokeColor="#52c41a"
                    style={{ flex: 1, margin: 0 }}
                  />
                  <span style={{ fontSize: 12, color: 'var(--text-helper)' }}>{s.passRate}% {lang === 'en' ? 'pass' : '通过'}</span>
                </div>
              ))
            ) : (
              <div style={{ color: 'var(--text-helper)', textAlign: 'center', padding: 20 }}>暂无{lang === 'en' ? 'Strengths' : '优势维度'}（均分≥75）</div>
            )}
          </Card>
        </Col>
        <Col xs={24} sm={12}>
          <Card className="swiss-card" style={{ height: '100%' }}>
            <div className="swiss-card-title">
              <WarningOutlined style={{ color: '#f5222d', marginRight: 8 }} />
              {lang === 'en' ? 'To Improve' : '待改进维度'}
            </div>
            {report.weaknesses.length > 0 ? (
              report.weaknesses.map((w, i) => (
                <div key={i} style={{ display: 'flex', alignItems: 'center', marginBottom: 12, gap: 12 }}>
                  <span style={{ fontSize: 14, minWidth: 100 }}>{w.dimension}</span>
                  <Progress
                    percent={w.score}
                    size="small"
                    strokeColor="#f5222d"
                    style={{ flex: 1, margin: 0 }}
                  />
                  <span style={{ fontSize: 12, color: 'var(--text-helper)' }}>{w.passRate}% {lang === 'en' ? 'pass' : '通过'}</span>
                </div>
              ))
            ) : (
              <div style={{ color: 'var(--text-helper)', textAlign: 'center', padding: 20 }}>暂无弱项维度（均分 &lt; 65）</div>
            )}
          </Card>
        </Col>
      </Row>

      {/* {lang === 'en' ? 'AI Analysis Report' : 'AI 评测分析报告'} */}
      <Card className="swiss-card" style={{ marginBottom: 16 }}>
        <div className="swiss-card-title" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span>
            <RobotOutlined style={{ marginRight: 8, color: '#722ed1' }} />
            {lang === 'en' ? 'AI Analysis Report' : 'AI 评测分析报告'}
          </span>
          <span style={{ display: 'flex', gap: 8 }}>
            {aiReport && (
              <>
                <Tooltip title="下载 Markdown 格式">
                  <Button icon={<FileTextOutlined />} onClick={() => handleDownload('md')} style={{ borderRadius: 6 }}>MD</Button>
                </Tooltip>
                <Tooltip title="下载 PDF 格式（HTML 页面，可用浏览器打印为 PDF）">
                  <Button icon={<FilePdfOutlined />} onClick={() => handleDownload('pdf')} style={{ borderRadius: 6 }}>PDF</Button>
                </Tooltip>
              </>
            )}
            <Button
              type="primary"
              icon={generating ? undefined : aiReport ? <ReloadOutlined /> : <RobotOutlined />}
              loading={generating}
              onClick={handleGenerateReport}
              style={{ borderRadius: 6 }}
            >
              {generating ? '生成中...' : aiReport ? '重新生成' : '生成 AI 报告'}
            </Button>
          </span>
        </div>
        {aiReport ? (
          <div style={{
            maxHeight: 800,
            overflowY: 'auto',
            padding: '16px 20px',
            background: 'var(--bg-card, var(--paper))',
            borderRadius: 8,
            border: '1px solid var(--border-subtle, #e0e0e0)',
            fontSize: 15,
            lineHeight: 1.8,
            color: 'var(--text-primary)',
          }}>
            <style>{`
              .markdown-body h1 { font-size: 1.6em; border-bottom: 2px solid var(--morandi-accent, #9a5b3a); padding-bottom: 8px; margin-top: 0; color: var(--morandi-heading, #3d6b4f); }
              .markdown-body h2 { font-size: 1.35em; border-bottom: 1px solid var(--border-subtle, #e0dbd4); padding-bottom: 6px; margin-top: 24px; color: var(--morandi-heading, #3d6b4f); }
              .markdown-body h3 { font-size: 1.15em; margin-top: 18px; color: var(--morandi-accent, #9a5b3a); }
              .markdown-body h4 { font-size: 1.05em; margin-top: 14px; color: var(--morandi-heading, #3d6b4f); }
              .markdown-body table { border-collapse: collapse; width: 100%; margin: 12px 0; font-size: 0.92em; }
              .markdown-body table th { background: var(--morandi-table-header, #4f7d5f); color: #fff; padding: 8px 12px; text-align: left; font-weight: 700; }
              .markdown-body table td { padding: 6px 12px; border: 1px solid var(--border-subtle, #e0dbd4); color: var(--text-primary); font-variant-numeric: tabular-nums; }
              .markdown-body table tr:nth-child(even) td { background: rgba(79, 125, 95, 0.06); }
              .markdown-body strong { color: var(--morandi-strong, #b0472a); font-weight: 700; }
              .markdown-body em { font-style: italic; color: var(--text-secondary); }
              .markdown-body blockquote { margin: 12px 0; padding: 10px 16px; border-left: 4px solid var(--morandi-gold, #c08a2d); background: rgba(192, 138, 45, 0.10); border-radius: 0 6px 6px 0; color: var(--text-secondary); }
              .markdown-body blockquote p { margin: 0; }
              .markdown-body code { background: var(--morandi-code-bg, rgba(154, 91, 58, 0.14)); padding: 2px 6px; border-radius: 4px; font-size: 0.9em; color: var(--morandi-accent, #9a5b3a); }
              .markdown-body pre { background: #2d2d2d; color: #e8e3db; padding: 16px; border-radius: 8px; overflow-x: auto; font-size: 0.88em; line-height: 1.5; }
              .markdown-body pre code { background: none; padding: 0; color: inherit; }
              .markdown-body ul, .markdown-body ol { padding-left: 24px; }
              .markdown-body li { margin-bottom: 4px; color: var(--text-primary); }
              .markdown-body hr { border: none; border-top: 1px solid var(--border-subtle, #e0dbd4); margin: 20px 0; }
              .markdown-body a { color: var(--morandi-link, #2f6b8a); }
              .markdown-body p { margin: 8px 0; color: var(--text-primary); }
            `}</style>
            <MarkdownRenderer content={aiReport} />
          </div>
        ) : (
          <div style={{ textAlign: 'center', padding: 60, color: 'var(--text-helper)' }}>
            <RobotOutlined style={{ fontSize: 48, marginBottom: 16, color: '#d9d9d9' }} />
            <p style={{ fontSize: 16, marginBottom: 8 }}>{lang === 'en' ? 'No AI report generated yet' : '尚未生成 AI 分析报告'}</p>
            <p style={{ fontSize: 13 }}>
              点击上方「生成 AI 报告」按钮，AI Judge 模型将根据评测数据生成深度分析报告，<br />
              包括各维度能力评估、典型失分案例、改进建议等内容。
            </p>
          </div>
        )}
      </Card>
    </div>
  );
}
