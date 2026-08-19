import { useEffect, useState } from 'react';
import { Table, Tag, Empty } from 'antd';
import {
  CheckCircleOutlined,
  ClockCircleOutlined,
  WarningOutlined,
  ExperimentOutlined,
} from '@ant-design/icons';
import EvalFlowDiagram from '../components/EvalFlowDiagram';
import { useLanguage, dimLabel } from '../i18n';

interface Stats {
  totalRuns: number;
  completedRuns: number;
  totalResults: number;
  dimensions: Array<{ name: string; count: number }>;
}

export default function Dashboard() {
  const { lang } = useLanguage();
  const [stats, setStats] = useState<Stats | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch('/api/stats')
      .then((r) => r.json())
      .then((res) => { if (res.success) setStats(res.data); })
      .catch(console.error)
      .finally(() => setLoading(false));
  }, []);

  const kpiCards = [
    { label: lang === 'en' ? 'Runs' : '评测运行', value: stats?.totalRuns ?? 0, icon: <ExperimentOutlined /> },
    { label: lang === 'en' ? 'Completed' : '已完成', value: stats?.completedRuns ?? 0, icon: <CheckCircleOutlined />, accent: true },
    { label: lang === 'en' ? 'Tasks' : '评测题目', value: stats?.totalResults ?? 0, icon: <ClockCircleOutlined /> },
    { label: lang === 'en' ? 'Dimensions' : '覆盖维度', value: stats?.dimensions.length ?? 0, icon: <WarningOutlined /> },
  ];

  return (
    <div>
      <h2 className="swiss-page-title">{lang === 'en' ? 'Evaluation Overview' : '评测总览'}</h2>

      {/* KPI 网格 */}
      <div className="swiss-kpi-grid">
        {kpiCards.map((kpi) => (
          <div key={kpi.label} className={`swiss-kpi-card ${kpi.accent ? 'accent' : ''}`}>
            <div className="kpi-label">{kpi.label}</div>
            <div className={`kpi-value ${kpi.accent ? 'accent' : ''}`}>{kpi.value}</div>
            <div className="kpi-icon">{kpi.icon}</div>
          </div>
        ))}
      </div>

      {/* 大模型评测流程图（替代原维度分布雷达图） */}
      <div className="swiss-card" style={{ marginBottom: 24 }}>
        <div className="swiss-card-title">{lang === 'en' ? 'LLM Evaluation Flow' : '大模型评测流程图'}</div>
        <EvalFlowDiagram />
      </div>

      {/* 维度分布表格 */}
      <div className="swiss-card">
        <div className="swiss-card-title">{lang === 'en' ? 'Dimension Distribution' : '维度分布'}</div>
        <Table
          dataSource={stats?.dimensions || []}
          rowKey="name"
          pagination={false}
          loading={loading}
          columns={[
            {
              title: lang === 'en' ? 'Dimension' : '维度', dataIndex: 'name', key: 'name',
              render: (v: string) => <Tag color="blue">{dimLabel(v, lang)}</Tag>,
            },
            { title: lang === 'en' ? 'Count' : '题目数', dataIndex: 'count', key: 'count' },
          ]}
        />
        {stats && stats.dimensions.length === 0 && (
          <Empty description={lang === 'en' ? 'No data' : '暂无数据'} style={{ padding: 40 }} />
        )}
      </div>
    </div>
  );
}
