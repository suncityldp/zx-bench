import { useEffect, useState } from 'react';
import { Table, Tag, Select, Space, Button, Modal, Input, message, Popconfirm } from 'antd';
import { PlusOutlined, EditOutlined, DeleteOutlined, CloudDownloadOutlined } from '@ant-design/icons';

interface ScenarioItem {
  id: string;
  dimension: string;
  category: string;
  difficulty: string;
  language: string;
  status: string;
  grader: string;
  scenarioVersion: string;
  [key: string]: unknown;
}

const difficultyColors: Record<string, string> = {
  easy: 'green',
  medium: 'blue',
  hard: 'orange',
  adversarial: 'red',
};

const statusColors: Record<string, string> = {
  valid: 'green',
  invalid: 'red',
  ambiguous: 'orange',
  needs_context: 'blue',
  retired: 'default',
};

/** 新增题目的默认模板 */
const NEW_SCENARIO_TEMPLATE = {
  id: 'program-new-001',
  dimension: 'program',
  category: 'cp_v1_basic',
  difficulty: 'medium',
  language: 'javascript',
  status: 'valid',
  tier: 'public_dev',
  promptTemplate: '请实现以下函数：\n\n{{source_code}}',
  sourceCode: 'function add(a, b) {\n  // TODO: implement\n}',
  functionName: 'add',
  expectedVerdict: null,
  grader: 'code_repair',
  scoring: {
    type: 'code_repair',
    weights: { pass_rate: 1.0 },
    partialCredit: true,
  },
  hiddenTests: [
    { id: 'ht1', type: 'public', testCode: 'console.assert(add(2,3)===5)', expectedExitCode: 0 },
  ],
};

/** Pack 短名选项 */
  const PACK_OPTIONS = [
  { short: 'all', label: '全量包 (9维度)' },
  { short: 'de', label: 'DE 数据抽取' },
  { short: 'if', label: 'IF 指令遵循' },
  { short: 'rm', label: 'RM 推理数学' },
  { short: 'so', label: 'SO 结构化输出' },
  { short: 'tc', label: 'TC 工具CLI' },
  { short: 'sa', label: 'SA 安全权限' },
  { short: 'aw', label: 'AW 智能体工作流' },
  { short: 'cli', label: 'CLI 深度命令行' },
  { short: 'pr', label: 'PR 编程能力' },
];

export default function Scenarios() {
  const [scenarios, setScenarios] = useState<ScenarioItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [dimensionFilter, setDimensionFilter] = useState<string>('');
  const [searchText, setSearchText] = useState('');
  const [difficultyFilter, setDifficultyFilter] = useState<string[]>([]);
  const [categoryFilter, setCategoryFilter] = useState<string>('');
  const [editorOpen, setEditorOpen] = useState(false);
  const [editorValue, setEditorValue] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [packOpen, setPackOpen] = useState(false);
  const [packUrl, setPackUrl] = useState('http://127.0.0.1:4545/packs/zxbench-pro-cr.tar.gz');
  const [importing, setImporting] = useState(false);

  const loadScenarios = () => {
    setLoading(true);
    const url = '/api/scenarios';
    fetch(url)
      .then((r) => r.json())
      .then((res) => { if (res.success) setScenarios(res.data); })
      .catch(console.error)
      .finally(() => setLoading(false));
  };

  useEffect(() => { loadScenarios(); }, []);

  const openNew = () => {
    setEditingId(null);
    setEditorValue(JSON.stringify(NEW_SCENARIO_TEMPLATE, null, 2));
    setEditorOpen(true);
  };

  const openEdit = (record: ScenarioItem) => {
    setEditingId(record.id);
    // 剔除 DB 元数据字段，只保留题目定义
    const { createdAt, updatedAt, ...rest } = record;
    setEditorValue(JSON.stringify(rest, null, 2));
    setEditorOpen(true);
  };

  const handleSave = async () => {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(editorValue);
    } catch {
      message.error('JSON 格式错误，请检查语法');
      return;
    }
    setSaving(true);
    try {
      const res = await fetch('/api/scenarios', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(parsed),
      });
      const body = await res.json();
      if (body.success) {
        message.success(editingId ? `题目 ${editingId} 已更新` : `题目 ${parsed.id} 已创建`);
        setEditorOpen(false);
        loadScenarios();
      } else {
        message.error(body.error || '保存失败');
      }
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (id: string) => {
    await fetch(`/api/scenarios/${id}`, { method: 'DELETE' });
    message.success(`题目 ${id} 已删除`);
    loadScenarios();
  };

  const handleImportPack = async () => {
    setImporting(true);
    try {
      const res = await fetch('/api/migrate/pack', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: packUrl }),
      });
      const body = await res.json();
      if (body.success) {
        const d = body.data;
        message.success(`导入完成：${d.packId} · ${d.imported}/${d.total} 题（维度: ${d.dimensionFilter}）`);
        setPackOpen(false);
        loadScenarios();
      } else {
        message.error(body.error || '导入失败');
      }
    } catch (err) {
      message.error(`导入失败: ${String(err)}`);
    } finally {
      setImporting(false);
    }
  };

  const dimensions = [...new Set(scenarios.map((s) => s.dimension))];
  const categories = [...new Set(scenarios.map((x) => x.category))].sort();
  const filteredScenarios = scenarios.filter((x) =>
    (!dimensionFilter || x.dimension === dimensionFilter) &&
    (difficultyFilter.length === 0 || difficultyFilter.includes(x.difficulty)) &&
    (!categoryFilter || x.category === categoryFilter) &&
    (!searchText || x.id.toLowerCase().includes(searchText.toLowerCase())));

  return (
    <div>
      <h2 className="swiss-page-title">题目管理</h2>
      <Space style={{ marginBottom: 16 }}>
        <Select
          placeholder="按维度筛选"
          allowClear
          style={{ width: 200 }}
          onChange={(v) => setDimensionFilter(v || '')}
        >
          {dimensions.map((d) => <Select.Option key={d} value={d}>{d}</Select.Option>)}
        </Select>
        <Select
          placeholder="按难度筛选"
          allowClear
          mode="multiple"
          style={{ width: 220 }}
          onChange={(v) => setDifficultyFilter(v || [])}
          options={[
            { value: 'easy', label: '简单 easy' },
            { value: 'medium', label: '中等 medium' },
            { value: 'hard', label: '困难 hard' },
            { value: 'adversarial', label: '对抗 adversarial' },
          ]}
        />
        <Select
          placeholder="按类别筛选"
          allowClear
          showSearch
          style={{ width: 200 }}
          onChange={(v) => setCategoryFilter(v || '')}
        >
          {categories.map((cat) => <Select.Option key={cat} value={cat}>{cat}</Select.Option>)}
        </Select>
        <Input.Search
          placeholder="按 ID 搜索"
          allowClear
          style={{ width: 200 }}
          onSearch={(v) => setSearchText(v.trim())}
        />
        <Button type="primary" icon={<PlusOutlined />} onClick={openNew}>新增题目</Button>
        <Button icon={<CloudDownloadOutlined />} onClick={() => setPackOpen(true)}>导入测试包</Button>
      </Space>

      <Table
        dataSource={filteredScenarios}
        rowKey="id"
        loading={loading}
        pagination={{ pageSize: 20 }}
        columns={[
          { title: 'ID', dataIndex: 'id', key: 'id', width: 120 },
          { title: '维度', dataIndex: 'dimension', key: 'dimension', render: (v: string) => <Tag color="blue">{v}</Tag> },
          { title: '类别', dataIndex: 'category', key: 'category' },
          {
            title: '难度', dataIndex: 'difficulty', key: 'difficulty',
            render: (v: string) => <Tag color={difficultyColors[v] || 'default'}>{v}</Tag>,
          },
          { title: '语言', dataIndex: 'language', key: 'language' },
          {
            title: '状态', dataIndex: 'status', key: 'status',
            render: (v: string) => <Tag color={statusColors[v] || 'default'}>{v}</Tag>,
          },
          { title: '评分器', dataIndex: 'grader', key: 'grader' },
          { title: '版本', dataIndex: 'scenarioVersion', key: 'scenarioVersion' },
          {
            title: '操作', key: 'actions', width: 120,
            render: (_: unknown, record: ScenarioItem) => (
              <Space size="small">
                <Button size="small" icon={<EditOutlined />} onClick={() => openEdit(record)} />
                <Popconfirm title={`删除题目 ${record.id}？`} onConfirm={() => handleDelete(record.id)}>
                  <Button size="small" danger icon={<DeleteOutlined />} />
                </Popconfirm>
              </Space>
            ),
          },
        ]}
      />

      <Modal
        title={editingId ? `编辑题目：${editingId}` : '新增题目（JSON）'}
        open={editorOpen}
        onOk={handleSave}
        onCancel={() => setEditorOpen(false)}
        confirmLoading={saving}
        okText="保存"
        cancelText="取消"
        width={760}
      >
        <Input.TextArea
          value={editorValue}
          onChange={(e) => setEditorValue(e.target.value)}
          rows={22}
          style={{ fontFamily: 'monospace', fontSize: 12 }}
        />
      </Modal>

      <Modal
        title="导入测试包（Pack）"
        open={packOpen}
        onOk={handleImportPack}
        onCancel={() => setPackOpen(false)}
        confirmLoading={importing}
        okText="下载并导入"
        cancelText="取消"
        width={640}
      >
        <p style={{ color: 'var(--text-helper)', marginBottom: 8 }}>
          从本地 pack 服务下载 tar.gz 测试包，自动提取题目、隐藏测试并入库。同 ID 题目会被更新（upsert）。
        </p>
        <Space wrap style={{ marginBottom: 12 }}>
          {PACK_OPTIONS.map((p) => (
            <Tag
              key={p.short}
              color={packUrl.includes(`-${p.short}.tar.gz`) ? 'blue' : 'default'}
              style={{ cursor: 'pointer' }}
              onClick={() => setPackUrl(`http://127.0.0.1:4545/packs/zxbench-pro-${p.short}.tar.gz`)}
            >
              {p.label}
            </Tag>
          ))}
        </Space>
        <Input
          value={packUrl}
          onChange={(e) => setPackUrl(e.target.value)}
          placeholder="http://127.0.0.1:4545/packs/zxbench-pro-cr.tar.gz"
        />
      </Modal>
    </div>
  );
}
