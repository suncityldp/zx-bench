import { useEffect, useState, useCallback } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { Table, Tag, Spin, Card, Empty, Tooltip, Segmented } from 'antd';
import { TrophyOutlined, InfoCircleOutlined } from '@ant-design/icons';
import type { ColumnsType } from 'antd/es/table';
import ScoreFormulaTooltip from '../components/ScoreFormulaTooltip';
import { useLanguage, dimLabel } from '../i18n';

/** 维度 key 的规范展示顺序（展示标签统一走 i18n 的 dimLabel） */
const DIMENSION_LABELS: Record<string, string> = {
  program: '编程能力',
  reasoning_math: '推理与数学',
  safety_authority: '安全与权限',
  cli_deep_tasks: '深度命令行任务',
  data_extraction: '数据抽取',
  agent_workflow: '智能体工作流',
  instruction_following: '指令遵循',
  tool_cli_workflow: '工具/CLI/工作流',
  hallucination_resistance: '幻觉抵抗',
  structured_output: '结构化输出',
};

interface DimensionScore {
  avg: number;
  count: number;
  passRate: number;
  redLine: number;
}

interface LeaderboardEntry {
  modelId: string;
  modelName: string;
  provider: string;
  reasoningModel?: boolean;
  maxTokens?: number;
  truncationRate?: number;
  totalScenarios: number;
  completedScenarios?: number;
  missingScenarios?: number;
  averageScore: number;
  passRate: number;
  passCount: number;
  redLineCount: number;
  dimensionScores: Record<string, DimensionScore>;
  runCount: number;
  evaluatedAt: string;
  latestRunId: string;
}

function scoreColor(score: number): string {
  if (score >= 80) return '#52c41a';
  if (score >= 60) return '#1890ff';
  if (score >= 40) return '#faad14';
  return '#f5222d';
}

function rankStyle(rank: number): { color: string; fontSize: number; fontWeight: number } {
  if (rank === 1) return { color: '#faad14', fontSize: 24, fontWeight: 700 };
  if (rank === 2) return { color: '#bfbfbf', fontSize: 22, fontWeight: 700 };
  if (rank === 3) return { color: '#d48806', fontSize: 20, fontWeight: 700 };
  return { color: 'var(--text-secondary)', fontSize: 16, fontWeight: 400 };
}

export default function Leaderboard() {
  const navigate = useNavigate();
  const location = useLocation();
  const { lang } = useLanguage();
  const [data, setData] = useState<LeaderboardEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [rankBy, setRankBy] = useState<string>('overall');
  const [scope, setScope] = useState<'latest' | 'best'>('latest');

  const fetchData = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const res = await fetch(`/api/leaderboard?scope=${scope}`);
      const json = await res.json();
      if (json.success) setData(json.data);
    } catch (e) {
      console.error(e);
    } finally {
      if (!silent) setLoading(false);
    }
  }, [scope]);

  // 初次加载 + 每 8 秒轮询，重测/重试后的分数实时变动
  useEffect(() => {
    setLoading(true);
    fetchData(false);
    const timer = window.setInterval(() => fetchData(true), 8000);
    return () => window.clearInterval(timer);
  }, [location.key, scope, fetchData]);

  if (loading) return <div style={{ padding: 80, textAlign: 'center' }}><Spin size="large" /></div>;
  if (!data || data.length === 0) return <Empty description={lang === 'en' ? 'No models with completed evaluations yet' : '暂无已完成评测的模型'} style={{ padding: 80 }} />;

  // ===== 按维度排名：过滤出该维度有成绩的模型，并按维度均分排序 =====
  const isDimMode = rankBy !== 'overall';
  const ranked: LeaderboardEntry[] = isDimMode
    ? data
        .filter((e) => e.dimensionScores && (e.dimensionScores[rankBy]?.count ?? 0) > 0)
        .sort((a, b) => (b.dimensionScores[rankBy]?.avg ?? 0) - (a.dimensionScores[rankBy]?.avg ?? 0))
    : data;

  /** 当前排名模式下的主分数（维度模式=维度均分，总览模式=加权综合分） */
  const mainScore = (e: LeaderboardEntry): number =>
    isDimMode ? (e.dimensionScores[rankBy]?.avg ?? 0) : e.averageScore;
  const mainPassRate = (e: LeaderboardEntry): number =>
    isDimMode ? (e.dimensionScores[rankBy]?.passRate ?? 0) : e.passRate;

  // 排名切换选项：总览 + 实际有数据的维度
  const dimsPresent = Array.from(new Set(data.flatMap((e) => Object.keys(e.dimensionScores || {}).filter((d) => (e.dimensionScores[d]?.count ?? 0) > 0))));
  const rankOptions = [
    { value: 'overall', label: lang === 'en' ? 'Overview' : '总览' },
    ...Object.keys(DIMENSION_LABELS).filter((d) => dimsPresent.includes(d)).map((d) => ({ value: d, label: dimLabel(d, lang) })),
  ];

  const columns: ColumnsType<LeaderboardEntry> = [
    {
      title: lang === 'en' ? 'Rank' : '排名',
      key: 'rank',
      width: 80,
      fixed: 'left',
      render: (_: unknown, _record: LeaderboardEntry, index: number) => (
        <div style={rankStyle(index + 1)}>
          {index + 1 <= 3 ? <TrophyOutlined /> : null} {index + 1}
        </div>
      ),
    },
    {
      title: lang === 'en' ? 'Model Name' : '模型名称',
      dataIndex: 'modelName',
      key: 'modelName',
      width: 240,
      fixed: 'left',
      render: (name: string, record: LeaderboardEntry) => (
        <div>
          <span style={{ fontWeight: 600 }}>{name}</span>
          <div style={{ fontSize: 11, color: 'var(--text-helper)' }}>{record.provider}</div>
        </div>
      ),
    },
    {
      title: lang === 'en' ? 'Type' : '类型',
      key: 'type',
      width: 90,
      render: (_: unknown, record: LeaderboardEntry) => (
        <Tag color={record.reasoningModel ? 'purple' : 'blue'} style={{ marginRight: 0 }}>
          {record.reasoningModel ? (lang === 'en' ? 'Reasoning' : '推理') : (lang === 'en' ? 'Non-reasoning' : '非推理')}
        </Tag>
      ),
    },
    {
      title: (
        <Tooltip title={lang === 'en' ? 'Eval config: maxTokens sets the per-question generation budget (too-small budgets penalize reasoning models via truncated chains); truncation rate is the share of outputs truncated. Compare models under comparable configs.' : '评测配置：maxTokens 决定单题生成预算（推理模型过小会因思考链截断被压低分数）；截断率为输出被截断的结果占比。不同模型应使用可比配置再比较排名'}>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            {lang === 'en' ? 'Eval Config' : '评测配置'}
            <InfoCircleOutlined style={{ fontSize: 12, color: 'var(--text-helper)' }} />
          </span>
        </Tooltip>
      ),
      key: 'config',
      width: 150,
      render: (_: unknown, record: LeaderboardEntry) => {
        const mt = record.maxTokens ?? 8192;
        const trunc = record.truncationRate ?? 0;
        return (
          <div>
            <div style={{ fontSize: 12, color: 'var(--text-helper)' }}>
              maxTokens: {mt >= 32768 ? `${mt / 1024}K` : mt}
              {record.reasoningModel && mt < 16384 && <span style={{ color: '#f5222d', marginLeft: 4 }}>⚠{lang === 'en' ? 'insufficient' : '不足'}</span>}
            </div>
            <div style={{ fontSize: 12, color: trunc > 30 ? '#f5222d' : 'var(--text-helper)' }}>
              {lang === 'en' ? 'Truncation: ' : '截断率: '}{trunc}%
            </div>
          </div>
        );
      },
    },
    {
      title: (
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
          {isDimMode ? `${dimLabel(rankBy, lang)} ${lang === 'en' ? 'Score' : '成绩'}` : (lang === 'en' ? 'Composite Score' : '综合分')}
          <ScoreFormulaTooltip placement="bottom" />
        </span>
      ),
      key: 'averageScore',
      width: 120,
      sorter: (a, b) => mainScore(a) - mainScore(b),
      defaultSortOrder: 'descend',
      render: (_: unknown, record: LeaderboardEntry) => {
        const score = mainScore(record);
        const dimCount = isDimMode ? (record.dimensionScores[rankBy]?.count ?? 0) : 0;
        return (
          <div>
            <span style={{ fontSize: 22, fontWeight: 800, color: scoreColor(score) }}>{score.toFixed(2)}</span>
            {isDimMode && <div style={{ fontSize: 11, color: 'var(--text-helper)' }}>{dimCount} {lang === 'en' ? 'questions' : '题'}</div>}
          </div>
        );
      },
    },
    {
      title: lang === 'en' ? 'Pass Rate' : '通过率',
      key: 'passRate',
      width: 110,
      sorter: (a, b) => mainPassRate(a) - mainPassRate(b),
      render: (_: unknown, record: LeaderboardEntry) => {
        const pr = mainPassRate(record);
        return (
          <div>
            <span style={{ fontWeight: 600, color: pr >= 70 ? '#52c41a' : '#faad14' }}>{pr}%</span>
            {!isDimMode && (
              <>
                <div style={{ fontSize: 11, color: 'var(--text-helper)' }}>{record.passCount}/{record.totalScenarios} {lang === 'en' ? 'questions' : '题'}</div>
                {(record.missingScenarios ?? 0) > 0 && (
                  <div style={{ fontSize: 11, color: '#f5222d' }}>⚠ {lang === 'en' ? `Missing ${record.missingScenarios} questions` : `缺失 ${record.missingScenarios} 题`}</div>
                )}
              </>
            )}
          </div>
        );
      },
    },
    {
      title: lang === 'en' ? 'Evaluated At' : '评测时间',
      dataIndex: 'evaluatedAt',
      key: 'evaluatedAt',
      width: 130,
      render: (t: string) => <span style={{ fontSize: 12, color: 'var(--text-helper)' }}>{new Date(t).toLocaleDateString(lang === 'en' ? 'en-US' : 'zh-CN')}</span>,
    },
    {
      title: lang === 'en' ? 'Actions' : '操作',
      key: 'action',
      width: 100,
      fixed: 'right',
      render: (_: unknown, record: LeaderboardEntry) => (
        <a onClick={() => navigate(`/report/${record.latestRunId}`)}>{lang === 'en' ? 'View Report' : '查看报告'}</a>
      ),
    },
  ];

  // 前三名奖牌卡片
  const top3 = ranked.slice(0, 3);
  const medalColors = ['#faad14', '#bfbfbf', '#d48806'];
  const medalLabels = lang === 'en' ? ['Champion', 'Runner-up', 'Third Place'] : ['冠军', '亚军', '季军'];

  return (
    <div style={{ maxWidth: 1280, margin: '0 auto' }}>
      <h2 className="swiss-page-title" style={{ marginBottom: 16, display: 'inline-flex', alignItems: 'center', gap: 8 }}>
        {lang === 'en' ? 'Model Leaderboard' : '模型排行榜'}
        <ScoreFormulaTooltip placement="bottom" icon={true} />
      </h2>

      {/* 分数口径：最新 run（默认）或跨 run 最优 */}
      <div style={{ marginBottom: 12 }}>
        <span style={{ fontSize: 13, color: 'var(--text-secondary)', marginRight: 8 }}>{lang === 'en' ? 'Score basis: ' : '分数口径：'}</span>
        <Segmented
          options={[
            { value: 'latest', label: lang === 'en' ? 'Latest run' : '最新 run' },
            { value: 'best', label: lang === 'en' ? 'Best across runs' : '跨 run 最优' },
          ]}
          value={scope}
          onChange={(v) => setScope(v as 'latest' | 'best')}
        />
      </div>

      {/* 排名依据切换：总览（加权综合分）或单一维度均分 */}
      <div style={{ marginBottom: 16 }}>
        <Segmented
          options={rankOptions}
          value={rankBy}
          onChange={(v) => setRankBy(v as string)}
          size="large"
        />
        <div style={{ fontSize: 12, color: 'var(--text-helper)', marginTop: 8 }}>
          {isDimMode
            ? (lang === 'en'
              ? `Ranked by difficulty-weighted average score on the ${dimLabel(rankBy, lang)} dimension; only models with scores in this dimension are counted`
              : `按「${dimLabel(rankBy, lang)}」维度的难度加权均分排名，仅统计在该维度有成绩的模型`)
            : (scope === 'best'
              ? (lang === 'en' ? 'Ranked by best composite score across runs (dimension weights: see score formula)' : '按跨 run 最优的加权综合分排名（各维度权重见分数公式）')
              : (lang === 'en' ? 'Ranked by composite score of the latest run (dimension weights: see score formula)' : '按最新一次 run 的加权综合分排名（各维度权重见分数公式）'))}
        </div>
      </div>

      {/* Top 3 Cards */}
      {top3.length > 0 && (
        <div style={{ display: 'flex', gap: 16, marginBottom: 24, flexWrap: 'wrap' }}>
          {top3.map((entry, i) => (
            <Card
              key={entry.modelId}
              className="swiss-card"
              style={{
                flex: '1 1 220px',
                borderColor: `${medalColors[i]}44`,
                borderWidth: 2,
                cursor: 'pointer',
              }}
              onClick={() => navigate(`/report/${entry.latestRunId}`)}
            >
              <div style={{ textAlign: 'center' }}>
                <TrophyOutlined style={{ fontSize: 32, color: medalColors[i] }} />
                <div style={{ fontSize: 14, color: 'var(--text-helper)', marginTop: 8 }}>
                  {isDimMode ? `${dimLabel(rankBy, lang)} · ${medalLabels[i]}` : medalLabels[i]}
                </div>
                <div style={{ fontSize: 16, fontWeight: 700, margin: '4px 0' }}>{entry.modelName}</div>
                <div style={{ fontSize: 40, fontWeight: 800, color: scoreColor(mainScore(entry)) }}>
                  {mainScore(entry).toFixed(2)}
                </div>
                <div style={{ fontSize: 12, color: 'var(--text-helper)' }}>
                  {lang === 'en' ? 'Pass rate' : '通过率'} {mainPassRate(entry)}%
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}

      {/* Full Table */}
      <Card className="swiss-card">
        <Table
          columns={columns}
          dataSource={ranked}
          rowKey="modelId"
          scroll={{ x: 1100 }}
          pagination={false}
          size="middle"
          locale={isDimMode ? { emptyText: lang === 'en' ? `No models have scores in the ${dimLabel(rankBy, lang)} dimension` : `暂无模型在「${dimLabel(rankBy, lang)}」维度有成绩` } : undefined}
        />
      </Card>
    </div>
  );
}