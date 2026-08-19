import { useEffect, useState, useMemo, useCallback } from 'react';
import { Table, Tag, Button, Space, message, Badge } from 'antd';
import { useNavigate } from 'react-router-dom';
import { EyeOutlined, MonitorOutlined, PlayCircleOutlined, FileSearchOutlined } from '@ant-design/icons';
import ScoreFormulaTooltip from '../components/ScoreFormulaTooltip';
import { useLanguage, dimLabel } from '../i18n';

interface RunItem {
  id: string;
  name: string;
  status: string;
  createdAt: string;
  updatedAt: string;
  groupName: string | null;
  parentRunId: string | null;
  summary: { averageScore: number; totalScenarios: number; safetyRedLineCount: number; completedScenarios: number; totalOutputTokens?: number; avgTokensPerSecond?: number } | null;
  modelConfig: { name: string };
}

interface GroupedRun {
  groupKey: string;
  mainRun: RunItem;
  allRuns: RunItem[];
  totalResults: number;
  avgScore: number;
  status: string;
  modelName: string;
  createdAt: string;
  finishedAt: string | null;
  avgTokensPerSecond: number | null;
  totalOutputTokens: number | null;
}

const statusColors: Record<string, string> = {
  pending: 'default',
  running: 'processing',
  paused: 'warning',
  completed: 'success',
  failed: 'error',
  cancelled: 'warning',
};

const statusLabel = (status: string, lang: 'zh' | 'en'): string => {
  const labels: Record<string, { zh: string; en: string }> = {
    pending: { zh: '等待中', en: 'Pending' },
    running: { zh: '运行中', en: 'Running' },
    paused: { zh: '已暂停', en: 'Paused' },
    completed: { zh: '已完成', en: 'Completed' },
    failed: { zh: '已中断', en: 'Interrupted' },
    cancelled: { zh: '已取消', en: 'Cancelled' },
  };
  return labels[status]?.[lang] ?? status;
};

function formatTimeShort(t: string | null): string {
  if (!t) return '-';
  const d = new Date(t);
  const M = String(d.getMonth() + 1).padStart(2, '0');
  const D = String(d.getDate()).padStart(2, '0');
  const h = String(d.getHours()).padStart(2, '0');
  const m = String(d.getMinutes()).padStart(2, '0');
  return `${M}-${D} ${h}:${m}`;
}

export default function EvalHistory() {
  const [runs, setRuns] = useState<RunItem[]>([]);
  const [loading, setLoading] = useState(true);
  const navigate = useNavigate();
  const { lang } = useLanguage();

  const fetchRuns = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const res = await fetch('/api/runs');
      const json = await res.json();
      if (json.success) setRuns(json.data);
    } catch (e) {
      console.error(e);
    } finally {
      if (!silent) setLoading(false);
    }
  }, []);

  // 初次加载 + 每 5 秒轮询，使重测/重试后的综合分实时变动
  useEffect(() => {
    setLoading(true);
    fetchRuns(false);
    const timer = window.setInterval(() => fetchRuns(true), 5000);
    return () => window.clearInterval(timer);
  }, [fetchRuns]);

  // 按 groupName 分组（过滤掉已取消的评测，避免历史页堆积同名 cancelled 组）
  const groupedRuns = useMemo<GroupedRun[]>(() => {
    const groups = new Map<string, RunItem[]>();
    for (const run of runs) {
      if (run.status === 'cancelled') continue; // 已取消的不展示
      const key = run.groupName || `solo-${run.id}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(run);
    }

    const result: GroupedRun[] = [];
    for (const [key, groupRuns] of groups) {
      // 主运行：取最新的 completed，否则取最新的
      const main = groupRuns.find((r) => r.status === 'completed') || groupRuns[0];
      // 组状态：有 running/pending → running；有 paused → paused；全 failed → failed；否则取主运行状态
      let groupStatus = main.status;
      if (groupRuns.some((r) => r.status === 'running' || r.status === 'pending')) groupStatus = 'running';
      else if (groupRuns.some((r) => r.status === 'paused')) groupStatus = 'paused';

      // 聚合分数：取「最新一次」completed 运行的加权综合分（重测/重试后实时跟随最新结果，而非历史最高）
      const completedRuns = groupRuns.filter((r) => r.status === 'completed' && r.summary);
      const latestCompleted = completedRuns.length > 0
        ? completedRuns.reduce((a, b) => (new Date(b.updatedAt).getTime() > new Date(a.updatedAt).getTime() ? b : a))
        : null;
      const latestScore = latestCompleted ? latestCompleted.summary!.averageScore : (main.summary?.averageScore ?? 0);

      // 完成时间：取所有子运行中最大的 updatedAt（仅 completed 运行）
      const completedRunsAll = groupRuns.filter((r) => r.status === 'completed');
      const finishedAt = completedRunsAll.length > 0
        ? completedRunsAll.map((r) => r.updatedAt).sort((a, b) => new Date(b).getTime() - new Date(a).getTime())[0]
        : null;

      // Token 速度：取所有 completed 运行中最高的 avgTokensPerSecond
      const completedWithTokens = completedRuns.filter((r) => r.summary?.avgTokensPerSecond != null);
      const bestTps = completedWithTokens.length > 0
        ? Math.max(...completedWithTokens.map((r) => r.summary!.avgTokensPerSecond!))
        : null;
      const totalOutput = completedRuns.reduce((sum, r) => sum + (r.summary?.totalOutputTokens || 0), 0);

      result.push({
        groupKey: key,
        mainRun: main,
        allRuns: groupRuns.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()),
        totalResults: completedRuns.reduce((sum, r) => sum + (r.summary?.completedScenarios ?? 0), 0),
        avgScore: latestScore,
        status: groupStatus,
        modelName: main.modelConfig?.name || '-',
        createdAt: main.createdAt,
        finishedAt,
        avgTokensPerSecond: bestTps,
        totalOutputTokens: totalOutput > 0 ? totalOutput : null,
      });
    }
    return result.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  }, [runs]);

  // 恢复评测
  const handleResume = async (runId: string) => {
    try {
      const res = await fetch(`/api/runs/${runId}/resume`, { method: 'POST' });
      const data = await res.json();
      if (data.success) {
        message.success(lang === 'en' ? 'Evaluation resumed, redirecting to live monitor...' : '评测已恢复，正在跳转实时监控...');
        navigate(`/eval/live/${runId}`);
      } else {
        message.error(data.error || (lang === 'en' ? 'Resume failed' : '恢复失败'));
      }
    } catch {
      message.error(lang === 'en' ? 'Request failed' : '请求失败');
    }
  };

  // 子运行展开表
  const expandedRowRender = (group: GroupedRun) => (
    <Table
      dataSource={group.allRuns}
      rowKey="id"
      size="small"
      pagination={false}
      columns={[
        { title: lang === 'en' ? 'Run ID' : '运行ID', dataIndex: 'id', key: 'id', width: 280, render: (v: string) => <code style={{ fontSize: 11 }}>{v}</code> },
        {
          title: lang === 'en' ? 'Status' : '状态', dataIndex: 'status', key: 'status', width: 90,
          render: (s: string) => <Tag color={statusColors[s]}>{statusLabel(s, lang)}</Tag>,
        },
        {
          title: lang === 'en' ? 'Scenarios' : '题数', key: 'scenarios', width: 80,
          render: (_: unknown, r: RunItem) => r.summary?.completedScenarios ?? '-',
        },
        {
          title: (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
              {lang === 'en' ? 'Composite Score' : '综合分'}
              <ScoreFormulaTooltip placement="bottom" />
            </span>
          ),
          key: 'score', width: 70,
          render: (_: unknown, r: RunItem) => r.summary?.averageScore != null ? r.summary.averageScore.toFixed(2) : '-',
        },
        {
          title: lang === 'en' ? 'Token Speed' : 'Token速度', key: 'tokenSpeed', width: 90,
          render: (_: unknown, r: RunItem) => {
            const tps = r.summary?.avgTokensPerSecond;
            if (tps == null) return '-';
            return (
              <Tag color={tps >= 100 ? 'green' : tps >= 30 ? 'blue' : 'orange'} style={{ fontSize: 11 }}>
                {tps >= 1000 ? `${(tps / 1000).toFixed(1)}K` : tps} t/s
              </Tag>
            );
          },
        },
        { title: lang === 'en' ? 'Time' : '时间', dataIndex: 'createdAt', key: 'createdAt', width: 110, render: (v: string) => formatTimeShort(v) },
        {
          title: lang === 'en' ? 'Actions' : '操作', key: 'action', width: 150,
          render: (_: unknown, r: RunItem) => (
            <Space size={4}>
              <Button icon={<EyeOutlined />} size="small" onClick={() => navigate(`/eval/${r.id}`)}>{lang === 'en' ? 'Details' : '详情'}</Button>
              {(r.status === 'paused' || r.status === 'failed') && (
                <Button type="primary" icon={<PlayCircleOutlined />} size="small" onClick={() => handleResume(r.id)}>
                  {r.status === 'paused' ? (lang === 'en' ? 'Continue' : '继续') : (lang === 'en' ? 'Resume' : '恢复')}
                </Button>
              )}
            </Space>
          ),
        },
      ]}
    />
  );

  return (
    <div>
      <h2 className="swiss-page-title">{lang === 'en' ? 'Eval History' : '评测历史'}</h2>
      <div className="swiss-card">
        <Table
          dataSource={groupedRuns}
          rowKey="groupKey"
          loading={loading}
          expandable={{
            expandedRowRender,
            rowExpandable: (g) => g.allRuns.length > 1,
          }}
          columns={[
            {
              title: lang === 'en' ? 'Eval Name' : '评测名称', key: 'name', width: 300,
              render: (_: unknown, g: GroupedRun) => (
                <div>
                  <span style={{ fontWeight: 500 }}>{g.mainRun.name}</span>
                  {g.allRuns.length > 1 && (
                    <Badge count={g.allRuns.length} size="small" style={{ marginLeft: 8, backgroundColor: '#1890ff' }} />
                  )}
                </div>
              ),
            },
            { title: lang === 'en' ? 'Model' : '模型', key: 'model', width: 220, render: (_: unknown, g: GroupedRun) => g.modelName },
            {
              title: lang === 'en' ? 'Status' : '状态', key: 'status', width: 90,
              render: (_: unknown, g: GroupedRun) => <Tag color={statusColors[g.status]}>{statusLabel(g.status, lang)}</Tag>,
            },
            {
              title: (
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                  {lang === 'en' ? 'Composite Score' : '综合分'}
                  <ScoreFormulaTooltip placement="bottom" />
                </span>
              ),
              key: 'score', width: 80,
              render: (_: unknown, g: GroupedRun) => {
                const s = g.avgScore;
                return <span style={{ fontWeight: 600, color: s >= 80 ? '#52c41a' : s >= 60 ? '#1890ff' : '#f5222d' }}>{s || '-'}</span>;
              },
            },
            {
              title: lang === 'en' ? 'Token Speed' : 'Token速度', key: 'tokenSpeed', width: 100,
              render: (_: unknown, g: GroupedRun) => {
                if (g.avgTokensPerSecond == null) return '-';
                const tps = g.avgTokensPerSecond;
                return (
                  <Tag color={tps >= 100 ? 'green' : tps >= 30 ? 'blue' : 'orange'}>
                    {tps >= 1000 ? `${(tps / 1000).toFixed(1)}K` : tps} t/s
                  </Tag>
                );
              },
              sorter: (a: GroupedRun, b: GroupedRun) => (a.avgTokensPerSecond || 0) - (b.avgTokensPerSecond || 0),
            },
            {
              title: lang === 'en' ? 'Start Time' : '开始时间', key: 'createdAt', width: 110,
              render: (_: unknown, g: GroupedRun) => formatTimeShort(g.createdAt),
            },
            {
              title: lang === 'en' ? 'Finish Time' : '完成时间', key: 'finishedAt', width: 110,
              render: (_: unknown, g: GroupedRun) => (
                <span style={{ color: g.finishedAt ? undefined : 'var(--text-helper)' }}>
                  {formatTimeShort(g.finishedAt)}
                </span>
              ),
            },
            {
              title: lang === 'en' ? 'Actions' : '操作', key: 'action', width: 250,
              render: (_: unknown, g: GroupedRun) => {
                const mainId = g.mainRun.id;
                const activeRun = g.allRuns.find((r) => r.status === 'running' || r.status === 'pending');
                const pausedRun = g.allRuns.find((r) => r.status === 'paused');
                const failedRun = g.allRuns.find((r) => r.status === 'failed');

                return (
                  <Space size={4}>
                    {activeRun && (
                      <Button type="primary" icon={<MonitorOutlined />} size="small" onClick={() => navigate(`/eval/live/${activeRun.id}`)}>
                        {lang === 'en' ? 'Live Monitor' : '实时监控'}
                      </Button>
                    )}
                    {(pausedRun || failedRun) && !activeRun && (
                      <Button type="primary" icon={<PlayCircleOutlined />} size="small" onClick={() => handleResume((pausedRun || failedRun)!.id)}>
                        {lang === 'en' ? 'Resume' : '恢复'}
                      </Button>
                    )}
                    <Button icon={<EyeOutlined />} size="small" onClick={() => navigate(`/eval/${mainId}`)}>
                      {lang === 'en' ? 'Details' : '详情'}
                    </Button>
                    <Button icon={<FileSearchOutlined />} size="small" onClick={() => navigate(`/report/${mainId}`)}>
                      {lang === 'en' ? 'Report' : '报告'}
                    </Button>
                  </Space>
                );
              },
            },
          ]}
        />
      </div>
    </div>
  );
}