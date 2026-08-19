import { useEffect, useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { Table, Tag, Card, Spin, Empty, Tooltip } from 'antd';
import { DollarOutlined, InfoCircleOutlined } from '@ant-design/icons';
import ReactECharts from 'echarts-for-react';
import { useTheme } from '../theme';
import { useLanguage, dimLabel } from '../i18n';

interface ValueEntry {
  modelId: string;
  modelName: string;
  provider: string;
  reasoningModel?: boolean;
  averageScore: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalTokens: number;
  latestRunId: string;
}

function fmtTokens(n: number): string {
  if (!n || n <= 0) return '-';
  if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return String(n);
}

/** 性价比指数 = 综合分 ÷ (输出token/100万)，即每消耗 100 万输出 token 能拿多少综合分 */
function valueIndex(d: ValueEntry): number {
  return d.totalOutputTokens > 0 ? (d.averageScore * 1e6) / d.totalOutputTokens : 0;
}

/** token 数据是否可信：输入 token 过少（<2 万）说明本地框架没回报 prompt token，输出大概率也被少报 */
function tokenReliable(d: ValueEntry): boolean {
  return (d.totalInputTokens ?? 0) >= 20000;
}

function shortName(name: string): string {
  const parts = name.split('/');
  const last = parts[parts.length - 1];
  return last.length > 18 ? last.slice(0, 17) + '…' : last;
}

function scoreColor(v: number): string {
  if (v >= 80) return '#52c41a';
  if (v >= 60) return '#1890ff';
  return '#faad14';
}

export default function ModelValue() {
  const navigate = useNavigate();
  const { mode } = useTheme();
  const { lang } = useLanguage();
  const [data, setData] = useState<ValueEntry[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchData = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const res = await fetch('/api/leaderboard?scope=latest');
      const json = await res.json();
      if (json.success && json.data) setData(json.data as ValueEntry[]);
    } catch (e) {
      console.error(e);
    } finally {
      if (!silent) setLoading(false);
    }
  }, []);

  useEffect(() => {
    setLoading(true);
    fetchData(false);
    const t = window.setInterval(() => fetchData(true), 8000);
    return () => window.clearInterval(t);
  }, [fetchData]);

  const isDark = mode === 'dark';
  const axisLabelColor = isDark ? '#ece7df' : '#1c1c1c';
  const axisSubColor = isDark ? '#c9c2b8' : '#4a4a4a';
  const gridColor = isDark ? 'rgba(210,205,198,0.16)' : 'rgba(20,20,20,0.12)';

  // 散点图：X=综合分，Y=输出 token（对数刻度）
  const scatterOption = {
    tooltip: {
      trigger: 'item' as const,
      backgroundColor: isDark ? '#232838' : '#fff',
      borderColor: gridColor,
      textStyle: { color: axisLabelColor },
      formatter: (p: { dataIndex: number }) => {
        const d = data[p.dataIndex];
        if (!d) return '';
        return (
          '<b>' + d.modelName + '</b><br/>' + (lang === 'en' ? 'Score: ' : '综合分: ') + d.averageScore.toFixed(2) +
          '<br/>' + (lang === 'en' ? 'Output tokens: ' : '输出 token: ') + fmtTokens(d.totalOutputTokens) +
          '<br/>' + (lang === 'en' ? 'Total tokens: ' : '总 token: ') + fmtTokens(d.totalTokens) +
          (tokenReliable(d)
            ? '<br/>' + (lang === 'en' ? 'Value: <b>' : '性价比: <b>') + valueIndex(d).toFixed(1) + (lang === 'en' ? '</b> per 1M output tokens' : '</b> 分/百万输出token')
            : '<br/><span style="color:#faad14">⚠ ' + (lang === 'en' ? 'token data unverified; value unreliable' : 'token 数据待核实，性价比不可信') + '</span>')
        );
      },
    },
    grid: { left: 90, right: 30, top: 30, bottom: 50 },
    xAxis: {
      type: 'value' as const,
      name: lang === 'en' ? 'Composite Score' : '综合分',
      nameTextStyle: { color: axisSubColor },
      axisLabel: { color: axisLabelColor, fontWeight: 600 },
      splitLine: { lineStyle: { color: gridColor } },
    },
    yAxis: {
      type: 'log' as const,
      name: lang === 'en' ? 'Output tokens (log)' : '输出 token（对数）',
      nameTextStyle: { color: axisSubColor },
      axisLabel: { color: axisSubColor, formatter: (v: number) => fmtTokens(v) },
      splitLine: { lineStyle: { color: gridColor } },
    },
    series: [{
      type: 'scatter' as const,
      data: data.map((d) => ({
        value: [d.averageScore, d.totalOutputTokens > 0 ? d.totalOutputTokens : 1],
        name: d.modelName,
        itemStyle: { color: tokenReliable(d) ? (d.reasoningModel ? '#722ed1' : '#1890ff') : '#bfbfbf', borderColor: '#fff', borderWidth: 1 },
      })),
      symbolSize: 16,
      label: {
        show: true,
        position: 'top' as const,
        fontSize: 11,
        color: axisLabelColor,
        formatter: (p: { name: string }) => shortName(String(p.name)),
      },
    }],
  };

  const sorted = [...data].sort((a, b) => (tokenReliable(b) ? valueIndex(b) : -1) - (tokenReliable(a) ? valueIndex(a) : -1));

  const columns = [
    {
      title: lang === 'en' ? 'Model' : '模型', dataIndex: 'modelName', key: 'name', width: 260,
      render: (v: string, r: ValueEntry) => (
        <div>
          <span style={{ fontWeight: 600 }}>{v}</span>
          {r.reasoningModel && <Tag color="purple" style={{ marginLeft: 6, marginRight: 0 }}>{lang === 'en' ? 'Reasoning' : '推理'}</Tag>}
          {!tokenReliable(r) && <Tooltip title={lang === 'en' ? 'Token data may be under-reported by the local framework; value unreliable' : 'token 数据可能被本地框架少报，性价比暂不可信'}><Tag color="orange" style={{ marginLeft: 6, marginRight: 0 }}>{lang === 'en' ? '⚠ token unverified' : '⚠ token 待核实'}</Tag></Tooltip>}
          <div style={{ fontSize: 11, color: 'var(--text-helper)' }}>{r.provider}</div>
        </div>
      ),
    },
    {
      title: lang === 'en' ? 'Composite Score' : '综合分', dataIndex: 'averageScore', key: 'score', width: 100,
      sorter: (a: ValueEntry, b: ValueEntry) => a.averageScore - b.averageScore,
      defaultSortOrder: 'descend' as const,
      render: (v: number) => <span style={{ fontSize: 17, fontWeight: 700, color: scoreColor(v) }}>{v.toFixed(2)}</span>,
    },
    {
      title: lang === 'en' ? 'Output tokens' : '输出 token', dataIndex: 'totalOutputTokens', key: 'out', width: 120,
      sorter: (a: ValueEntry, b: ValueEntry) => a.totalOutputTokens - b.totalOutputTokens,
      render: (v: number) => <span style={{ color: 'var(--text-primary)' }}>{fmtTokens(v)}</span>,
    },
    {
      title: lang === 'en' ? 'Total tokens' : '总 token', dataIndex: 'totalTokens', key: 'total', width: 120,
      sorter: (a: ValueEntry, b: ValueEntry) => a.totalTokens - b.totalTokens,
      render: (v: number) => <span style={{ color: 'var(--text-primary)' }}>{fmtTokens(v)}</span>,
    },
    {
      title: (
        <Tooltip title={lang === 'en' ? 'Value = Score ÷ (output tokens / 1M). Higher means more score per 1M output tokens' : '性价比 = 综合分 ÷ (输出token/100万)。越高表示每消耗 100 万输出 token 拿到的分越多'}>
          <span>{lang === 'en' ? 'Value' : '性价比'} <InfoCircleOutlined style={{ fontSize: 12, opacity: 0.6 }} /></span>
        </Tooltip>
      ),
      key: 'value', width: 130,
      sorter: (a: ValueEntry, b: ValueEntry) => (tokenReliable(a) ? valueIndex(a) : -1) - (tokenReliable(b) ? valueIndex(b) : -1),
      defaultSortOrder: 'descend' as const,
      render: (_: unknown, r: ValueEntry) => tokenReliable(r)
        ? <span style={{ fontSize: 15, fontWeight: 700, color: '#722ed1' }}>{valueIndex(r).toFixed(1)}</span>
        : <Tag color="orange" style={{ margin: 0 }}>{lang === 'en' ? '⚠ unverified' : '⚠ 待核实'}</Tag>,
    },
    {
      title: lang === 'en' ? 'Action' : '操作', key: 'action', width: 100,
      render: (_: unknown, r: ValueEntry) => <a onClick={() => navigate('/report/' + r.latestRunId)}>{lang === 'en' ? 'View report' : '查看报告'}</a>,
    },
  ];

  return (
    <div style={{ maxWidth: 1280, margin: '0 auto' }}>
      <h2 className="swiss-page-title" style={{ marginBottom: 4, display: 'inline-flex', alignItems: 'center', gap: 8 }}>
        <DollarOutlined style={{ color: '#722ed1' }} />
        {lang === 'en' ? 'Model Cost-effectiveness' : '模型性价比'}
      </h2>
      <div style={{ fontSize: 13, color: 'var(--text-helper)', marginBottom: 16 }}>
        {lang === 'en' ? 'Y-axis: output tokens (total output per eval run, lower is cheaper); X-axis: composite score (higher is better). Bottom-right = high score + low consumption = great value.' : '纵轴：输出 token（跑一次评测的总输出，越低越省）；横轴：综合分（越高越好）。右下角 = 高分 + 低消耗 = 性价比高。'}
      </div>

      <Card className="swiss-card" style={{ marginBottom: 16 }}>
        <div className="swiss-card-title">{lang === 'en' ? 'Composite Score vs Output Tokens (scatter, click points)' : '综合分 vs 输出 token（散点图，点可点击）'}</div>
        {data.length > 0 ? (
          <ReactECharts
            option={scatterOption}
            style={{ height: 440 }}
            onEvents={{ click: (p: { dataIndex: number }) => { const d = data[p.dataIndex]; if (d) navigate('/report/' + d.latestRunId); } }}
          />
        ) : (
          <Empty description={lang === 'en' ? 'No finished evals yet' : '暂无已完成评测的模型'} style={{ padding: 40 }} />
        )}
      </Card>

      <Card className="swiss-card">
        <div className="swiss-card-title">{lang === 'en' ? 'Value Ranking (by value index, descending)' : '性价比排名（按性价比指数降序）'}</div>
        <Table
          columns={columns}
          dataSource={sorted}
          rowKey="modelId"
          pagination={false}
          size="middle"
          loading={loading}
          locale={{ emptyText: lang === 'en' ? 'No data' : '暂无数据' }}
        />
      </Card>
    </div>
  );
}
