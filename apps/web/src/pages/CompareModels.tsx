import { useEffect, useState, useCallback, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { Card, Table, Button, Checkbox, message, Spin, Tag, Empty, Tooltip, Popconfirm, Segmented } from 'antd';
import { RobotOutlined, ArrowLeftOutlined, TrophyOutlined, DownloadOutlined, FileTextOutlined, FilePdfOutlined, DeleteOutlined, ClearOutlined, HistoryOutlined } from '@ant-design/icons';
import MarkdownRenderer from '../components/MarkdownRenderer';
import { useLanguage } from '../i18n';

interface ModelEntry {
  modelId: string;
  modelName: string;
  provider: string;
  averageScore: number;
  passRate: number;
  totalScenarios: number;
  completedScenarios?: number;
  missingScenarios?: number;
  redLineCount: number;
  latestRunId: string;
  evaluatedAt: string;
}

interface ReportRecord {
  id: string;
  modelNames: string[];
  content: string;
  createdAt: string; // ISO
}

const STORAGE_KEY = 'zxbench_compare_reports_v1';
const MAX_HISTORY = 20;

function loadHistory(): ReportRecord[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

function saveHistory(list: ReportRecord[]) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(list.slice(0, MAX_HISTORY)));
  } catch {
    /* 存储满或被禁用时静默失败 */
  }
}

export default function CompareModels() {
  const navigate = useNavigate();
  const { lang } = useLanguage();
  const [models, setModels] = useState<ModelEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [generating, setGenerating] = useState(false);
  const [reportHistory, setReportHistory] = useState<ReportRecord[]>([]);
  const [scope, setScope] = useState<'latest' | 'best'>('latest');
  const initialSelectedRef = useRef(false);

  // 初始化：加载已保存的对比报告历史
  useEffect(() => {
    setReportHistory(loadHistory());
  }, []);

  const fetchModels = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const res = await fetch(`/api/leaderboard?scope=${scope}`);
      const json = await res.json();
      if (json.success && json.data) {
        // 按最新评测时间倒序排序（模型对比页按测试时间排序，最新在前）
        const sorted = (json.data as ModelEntry[]).slice().sort((a, b) => new Date(b.evaluatedAt).getTime() - new Date(a.evaluatedAt).getTime());
        setModels(sorted);
        // 仅首次加载默认选中最新评测的2个模型；后续轮询保持用户已选（不覆盖用户手动取消）
        if (!initialSelectedRef.current) {
          initialSelectedRef.current = true;
          if (sorted.length >= 2) {
            setSelectedIds([sorted[0].modelId, sorted[1].modelId]);
          }
        }
      }
    } catch (e) {
      console.error(e);
    } finally {
      if (!silent) setLoading(false);
    }
  }, [scope]);

  // 初次加载 + 每 8 秒轮询，模型列表随测试结果实时更新
  useEffect(() => {
    setLoading(true);
    fetchModels(false);
    const timer = window.setInterval(() => fetchModels(true), 8000);
    return () => window.clearInterval(timer);
  }, [fetchModels]);

  // 当前选中的模型（用于下载文件命名）
  const selectedModels = models.filter((m) => selectedIds.includes(m.modelId));

  // 下载对比报告：MD 或 HTML（可用浏览器打印为 PDF）
  const handleDownload = useCallback(async (record: ReportRecord, format: 'md' | 'html') => {
    if (!record.content) return;
    try {
      const res = await fetch('/api/reports/compare/download', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          reportContent: record.content,
          modelNames: record.modelNames,
          format,
        }),
      });
      if (!res.ok) throw new Error('download failed');
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = '';
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
      message.success(lang === 'en' ? `Downloading ${format.toUpperCase()} report...` : `正在下载 ${format.toUpperCase()} 格式报告...`);
    } catch (err) {
      console.error('Download failed:', err);
      message.error(lang === 'en' ? 'Download failed, please retry' : '下载失败，请重试');
    }
  }, [lang]);

  const handleGenerate = async () => {
    if (selectedIds.length < 2) {
      message.warning(lang === 'en' ? 'Please select at least 2 models to compare' : '请至少选择2个模型进行对比');
      return;
    }
    setGenerating(true);
    try {
      const res = await fetch('/api/reports/compare', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ modelConfigIds: selectedIds, language: lang }),
      });
      const data = await res.json();
      if (data.success) {
        const record: ReportRecord = {
          id: `cmp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
          modelNames: selectedModels.map((m) => m.modelName),
          content: data.data.reportContent,
          createdAt: new Date().toISOString(),
        };
        setReportHistory((prev) => {
          const next = [record, ...prev];
          saveHistory(next);
          return next;
        });
        message.success(lang === 'en' ? 'Comparison report generated successfully' : '对比报告生成成功');
      } else {
        message.error(data.error || (lang === 'en' ? 'Failed to generate report' : '报告生成失败'));
      }
    } catch (err) {
      message.error(lang === 'en' ? 'Request failed, please check the Judge model status' : '请求失败，请检查 Judge 模型状态');
    } finally {
      setGenerating(false);
    }
  };

  const handleDelete = (id: string) => {
    setReportHistory((prev) => {
      const next = prev.filter((r) => r.id !== id);
      saveHistory(next);
      return next;
    });
  };

  const handleClear = () => {
    setReportHistory([]);
    saveHistory([]);
  };

  if (loading) return <div style={{ padding: 80, textAlign: 'center' }}><Spin size="large" /></div>;

  // 全选状态 — 使用函数式 updater 避免闭包陷阱
  const allSelected = models.length > 0 && selectedIds.length === models.length;
  const allSelectedToggle = () => {
    if (allSelected) {
      setSelectedIds([]);
    } else {
      setSelectedIds(models.map((m) => m.modelId));
    }
  };

  const columns = [
    {
      title: <Checkbox checked={allSelected} indeterminate={selectedIds.length > 0 && !allSelected} onChange={allSelectedToggle} />,
      key: 'select',
      width: 50,
      render: (_: unknown, r: ModelEntry) => {
        const id = r.modelId;
        return (
          <Checkbox
            checked={selectedIds.includes(id)}
            onChange={(e) => {
              if (e.target.checked) {
                setSelectedIds((prev) => (prev.includes(id) ? prev : [...prev, id]));
              } else {
                setSelectedIds((prev) => prev.filter((x) => x !== id));
              }
            }}
          />
        );
      },
    },
    { title: lang === 'en' ? 'Model' : '模型', dataIndex: 'modelName', key: 'name', render: (v: string, r: ModelEntry) => <span style={{ fontWeight: 600 }}>{v}</span> },
    { title: lang === 'en' ? 'Provider' : '提供方', dataIndex: 'provider', key: 'provider', render: (v: string) => <Tag>{v}</Tag> },
    {
      title: lang === 'en' ? 'Overall Score' : '综合分', dataIndex: 'averageScore', key: 'score', sorter: (a: ModelEntry, b: ModelEntry) => b.averageScore - a.averageScore,
      render: (v: number) => <span style={{ fontSize: 18, fontWeight: 700, color: v >= 80 ? '#52c41a' : v >= 60 ? '#1890ff' : '#faad14' }}>{v.toFixed(2)}</span>,
    },
    {
      title: lang === 'en' ? 'Pass Rate' : '通过率', dataIndex: 'passRate', key: 'passRate',
      render: (v: number) => `${v}%`,
    },
    {
      title: lang === 'en' ? 'Questions' : '题数', dataIndex: 'totalScenarios', key: 'total',
      render: (_: unknown, r: ModelEntry) => (
        <div>
          <div>{r.totalScenarios}</div>
          {(r.missingScenarios ?? 0) > 0 && (
            <div style={{ fontSize: 11, color: '#f5222d' }}>⚠ {lang === 'en' ? `Missing ${r.missingScenarios} questions` : `缺失 ${r.missingScenarios} 题`}</div>
          )}
        </div>
      ),
    },
    {
      title: lang === 'en' ? 'Red Lines' : '安全红线', dataIndex: 'redLineCount', key: 'redLine',
      render: (v: number) => <Tag color={v > 0 ? 'red' : 'green'}>{v}</Tag>,
    },
    {
      title: lang === 'en' ? 'Evaluated At' : '评测时间', dataIndex: 'evaluatedAt', key: 'evaluatedAt',
      render: (t: string) => <span style={{ fontSize: 12, color: 'var(--text-helper)' }}>{t ? new Date(t).toLocaleString(lang === 'en' ? 'en-US' : 'zh-CN', { hour12: false }) : '-'}</span>,
    },
  ];

  return (
    <div style={{ maxWidth: 1200, margin: '0 auto' }}>
      <div style={{ display: 'flex', alignItems: 'center', marginBottom: 24, gap: 16 }}>
        <Button icon={<ArrowLeftOutlined />} onClick={() => navigate(-1)}>{lang === 'en' ? 'Back' : '返回'}</Button>
        <h2 className="swiss-page-title" style={{ margin: 0, flex: 1 }}>
          <TrophyOutlined style={{ marginRight: 8 }} />
          {lang === 'en' ? 'Model Comparison Analysis' : '模型对比分析'}
        </h2>
      </div>

      <Card className="swiss-card" style={{ marginBottom: 24 }}>
        <div className="swiss-card-title" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span>{lang === 'en' ? `Select models to compare (${selectedIds.length}/${models.length} selected)` : `选择参与对比的模型（已选 ${selectedIds.length}/${models.length} 个）`}</span>
          <Button
            type="primary"
            icon={<RobotOutlined />}
            loading={generating}
            onClick={handleGenerate}
            disabled={selectedIds.length < 2}
            style={{ borderRadius: 6 }}
          >
            {generating ? (lang === 'en' ? 'Generating...' : '生成中...') : (lang === 'en' ? `Generate Comparison Report (${selectedIds.length} models)` : `生成对比报告 (${selectedIds.length} 个模型)`)}
          </Button>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8 }}>
          <span style={{ fontSize: 13, color: 'var(--text-secondary)' }}>{lang === 'en' ? 'Score basis: ' : '分数口径：'}</span>
          <Segmented
            size="small"
            options={[
              { value: 'latest', label: lang === 'en' ? 'Latest Run' : '最新 run' },
              { value: 'best', label: lang === 'en' ? 'Best Across Runs' : '跨 run 最优' },
            ]}
            value={scope}
            onChange={(v) => setScope(v as 'latest' | 'best')}
          />
        </div>
        {models.length > 0 ? (
          <Table
            dataSource={models}
            columns={columns}
            rowKey="modelId"
            pagination={false}
            size="small"
            style={{ marginTop: 8 }}
          />
        ) : (
          <Empty description={lang === 'en' ? 'No models with completed evaluations yet' : '暂无已完成评测的模型'} style={{ padding: 40 }} />
        )}
      </Card>

      {/* ===== 已生成的对比报告（持久化保留，最新在前） ===== */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
        <h3 style={{ margin: 0, fontSize: 16 }}>
          <HistoryOutlined style={{ marginRight: 8, color: '#722ed1' }} />
          {lang === 'en' ? `Generated Comparison Reports (${reportHistory.length})` : `已生成的对比报告（${reportHistory.length}）`}
        </h3>
        {reportHistory.length > 0 && (
          <Popconfirm title={lang === 'en' ? 'Clear all saved comparison reports?' : '确认清空所有已保存的对比报告？'} onConfirm={handleClear} okText={lang === 'en' ? 'Clear' : '清空'} cancelText={lang === 'en' ? 'Cancel' : '取消'}>
            <Button size="small" icon={<ClearOutlined />} danger>{lang === 'en' ? 'Clear History' : '清空历史'}</Button>
          </Popconfirm>
        )}
      </div>

      {reportHistory.length === 0 ? (
        <Card className="swiss-card" style={{ marginBottom: 16 }}>
          <Empty description={lang === 'en' ? 'No comparison reports generated yet. Select models and click the button above to generate.' : '还没有生成任何对比报告，选择模型后点击上方按钮生成'} style={{ padding: 32 }} />
        </Card>
      ) : (
        reportHistory.map((record) => (
          <Card key={record.id} className="swiss-card" style={{ marginBottom: 16 }}>
            <div className="swiss-card-title" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <RobotOutlined style={{ color: '#722ed1' }} />
                <span>{record.modelNames.join('  vs  ')}</span>
                <Tag color="default" style={{ marginLeft: 4 }}>
                  {new Date(record.createdAt).toLocaleString(lang === 'en' ? 'en-US' : 'zh-CN', { hour12: false })}
                </Tag>
              </span>
              <span style={{ display: 'flex', gap: 8 }}>
                <Tooltip title={lang === 'en' ? 'Download Markdown' : '下载 Markdown 格式'}>
                  <Button size="small" icon={<FileTextOutlined />} onClick={() => handleDownload(record, 'md')} style={{ borderRadius: 6 }}>MD</Button>
                </Tooltip>
                <Tooltip title={lang === 'en' ? 'Download HTML report (use browser Ctrl+P to save as PDF)' : '下载 HTML 报告（可用浏览器 Ctrl+P 另存为 PDF）'}>
                  <Button size="small" icon={<FilePdfOutlined />} onClick={() => handleDownload(record, 'html')} style={{ borderRadius: 6 }}>PDF</Button>
                </Tooltip>
                <Tooltip title={lang === 'en' ? 'Delete this report' : '删除此报告'}>
                  <Button size="small" danger icon={<DeleteOutlined />} onClick={() => handleDelete(record.id)} style={{ borderRadius: 6 }} />
                </Tooltip>
              </span>
            </div>
            <div style={{
              maxHeight: 800,
              overflowY: 'auto',
              padding: '16px 20px',
              background: 'var(--bg-surface, #fafafa)',
              borderRadius: 8,
              border: '1px solid var(--border-color, #f0f0f0)',
              fontSize: 15,
              lineHeight: 1.8,
              color: 'var(--text-primary, #333)',
            }}>
              <style>{`
                .markdown-body h1 { font-size: 1.6em; border-bottom: 2px solid #722ed1; padding-bottom: 8px; margin-top: 0; }
                .markdown-body h2 { font-size: 1.35em; border-bottom: 1px solid var(--border-color, #e8e8e8); padding-bottom: 6px; margin-top: 24px; }
                .markdown-body h3 { font-size: 1.15em; margin-top: 18px; color: #722ed1; }
                .markdown-body h4 { font-size: 1.05em; margin-top: 14px; }
                .markdown-body table { border-collapse: collapse; width: 100%; margin: 12px 0; font-size: 0.92em; }
                .markdown-body table th { background: #722ed1; color: #fff; padding: 8px 12px; text-align: left; }
                .markdown-body table td { padding: 6px 12px; border: 1px solid var(--border-color, #e8e8e8); }
                .markdown-body table tr:nth-child(even) { background: rgba(114,46,209,0.04); }
                .markdown-body strong { color: #722ed1; }
                .markdown-body blockquote { margin: 12px 0; padding: 10px 16px; border-left: 4px solid #f5222d; background: rgba(245,34,45,0.06); border-radius: 0 6px 6px 0; }
                .markdown-body blockquote p { margin: 0; }
                .markdown-body code { background: rgba(114,46,209,0.1); padding: 2px 6px; border-radius: 4px; font-size: 0.9em; }
                .markdown-body pre { background: #1e1e2e; color: #cdd6f4; padding: 16px; border-radius: 8px; overflow-x: auto; font-size: 0.88em; line-height: 1.5; }
                .markdown-body pre code { background: none; padding: 0; }
                .markdown-body ul, .markdown-body ol { padding-left: 24px; }
                .markdown-body li { margin-bottom: 4px; }
                .markdown-body hr { border: none; border-top: 1px solid var(--border-color, #e8e8e8); margin: 20px 0; }
                .markdown-body a { color: #1890ff; }
                .markdown-body p { margin: 8px 0; }
              `}</style>
              <MarkdownRenderer content={record.content} />
            </div>
          </Card>
        ))
      )}
    </div>
  );
}
