import { useEffect, useState } from 'react';
import { Alert, Button, Checkbox, Descriptions, Drawer, Form, Input, InputNumber, message, Select, Space, Table, Tag, Tabs } from 'antd';
import type { CalibrationRecord, CalibrationReview, CalibrationSplit } from '@zxbench/types';

interface QueueRow {
  id: string; scenarioId: string; dimension: string; difficulty: string; state: string;
  split: CalibrationSplit; snapshotOrigin: string; reviewerCount: number; exportable: boolean; exclusionReasons: string[];
}
async function api(url: string, body?: unknown) {
  const response = await fetch(url, body === undefined ? undefined : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await response.json();
  if (!response.ok || data.success === false) throw new Error(data.error || `HTTP ${response.status}`);
  return data.data ?? data;
}
const splits = ['development', 'calibration', 'blind_holdout'].map(value => ({ value, label: value }));

export default function Calibration() {
  const [rows, setRows] = useState<QueueRow[]>([]);
  const [runs, setRuns] = useState<Array<{ id: string; name: string }>>([]);
  const [runIds, setRunIds] = useState<string[]>([]);
  const [count, setCount] = useState(60);
  const [reviewer, setReviewer] = useState('');
  const [split, setSplit] = useState<CalibrationSplit>('calibration');
  const [state, setState] = useState<string>();
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [stored, setStored] = useState(0);
  const [scanned, setScanned] = useState(0);
  const [selected, setSelected] = useState<React.Key[]>([]);
  const [detail, setDetail] = useState<(CalibrationRecord & { blindReview: boolean })>();
  const [adjudicate, setAdjudicate] = useState(false);
  const [busy, setBusy] = useState(false);
  const [qa, setQA] = useState<Record<string, unknown>>();
  const [form] = Form.useForm();
  const load = async () => {
    const data = await api(`/api/calibration?limit=30&offset=${(page - 1) * 30}&split=${split}${state ? `&state=${state}` : ''}`);
    setRows(data.candidates); setTotal(data.total); setStored(data.stored); setScanned(data.scanned);
  };
  useEffect(() => { load().catch(e => message.error(String(e))); }, [page, split, state]);
  useEffect(() => { api('/api/runs').then(data => setRuns(data.filter((r: { status: string }) => ['completed', 'failed', 'cancelled'].includes(r.status)))).catch(e => message.error(String(e))); }, []);
  const open = async (row: QueueRow) => {
    if (reviewer.trim().length < 2) { message.warning('先填写实际审核者姓名/标识，再打开样本'); return; }
    const data = await api(`/api/calibration/${row.id}?reviewer=${encodeURIComponent(reviewer)}&adjudicate=${adjudicate}`);
    setDetail(data); form.resetFields(); form.setFieldsValue({ outcome: 'usable', sourceVerified: false });
  };
  const intake = async () => {
    setBusy(true);
    try {
      const result = await api('/api/calibration/intake', { runIds, count, includeControls: true });
      message.success(`入队 ${result.inserted}，已有 ${result.duplicates}，其中历史题面补配 ${result.currentDefinitionSnapshots}`);
      await load();
    } catch (e) { message.error(String(e)); } finally { setBusy(false); }
  };
  const submit = async (values: Omit<CalibrationReview, 'reviewer'>) => {
    if (!detail) return;
    setBusy(true);
    try {
      const data = await api(`/api/calibration/${detail.candidate.id}/reviews`, {
        expectedRevision: detail.summary.revision, kind: adjudicate ? 'adjudicate' : 'review', review: { ...values, reviewer },
      });
      setDetail(data); await load(); message.success('标注已保存到审计记录');
    } catch (e) { message.error(String(e)); } finally { setBusy(false); }
  };
  const exportSelected = async () => {
    setBusy(true);
    try {
      const content = await api('/api/calibration/export', { candidateIds: selected, split });
      const url = URL.createObjectURL(new Blob([JSON.stringify(content, null, 2)], { type: 'application/json' }));
      const link = document.createElement('a'); link.href = url; link.download = `calibration-${content.hash.slice(0, 12)}.json`; link.click(); URL.revokeObjectURL(url);
    } catch (e) { message.error(String(e)); } finally { setBusy(false); }
  };
  return <>
    <Alert showIcon type="info" style={{ marginBottom: 16 }} message="P1 · 人工校准与评分规则审计"
      description="入队不等于 gold。需要两名实际独立审核者一致标注，或第三人仲裁；题目来源必须核验。这里不会自动修改正式题库的 verified 状态。审核身份由本地用户自行填写，并非身份认证。" />
    <Tabs items={[
      { key: 'queue', label: '待审队列', children: <>
        <Space wrap style={{ marginBottom: 16 }}>
          <Select mode="multiple" style={{ minWidth: 380, maxWidth: 650 }} placeholder="选择已结束的评测运行（最多 20 个）" value={runIds} onChange={setRunIds} options={runs.map(r => ({ value: r.id, label: r.name }))} />
          <InputNumber min={1} max={500} value={count} onChange={n => setCount(n ?? 60)} />
          <Button loading={busy} disabled={!runIds.length} onClick={intake}>分层抽样入队（含正常对照）</Button>
        </Space>
        <Space wrap style={{ marginBottom: 16 }}>
          <Input style={{ width: 220 }} placeholder="实际审核者姓名 / 标识" value={reviewer} onChange={e => { setReviewer(e.target.value); setDetail(undefined); }} />
          <Checkbox checked={adjudicate} onChange={e => { setAdjudicate(e.target.checked); setDetail(undefined); }}>第三人仲裁模式</Checkbox>
          <Select value={split} onChange={v => { setSplit(v); setPage(1); setSelected([]); }} options={splits} style={{ width: 160 }} />
          <Select allowClear placeholder="审核状态" value={state} onChange={v => { setState(v); setPage(1); setSelected([]); }} options={['unreviewed', 'in_review', 'agreed', 'disputed', 'adjudicated', 'excluded', 'needs_context'].map(value => ({ value, label: value }))} style={{ width: 170 }} />
          <Button onClick={() => load().catch(e => message.error(String(e)))}>刷新</Button>
          <Button disabled={!selected.length || split === 'blind_holdout'} onClick={exportSelected} loading={busy}>冻结并导出已审核样本</Button>
        </Space>
        <div style={{ marginBottom: 12 }}>库内 {stored} 个候选 · 当前筛选 {total} 个。数据集划分按题目固定，同一题的不同模型回答不会跨集合。</div>
        {stored > scanned && <Alert type="warning" message={`当前只扫描最近 ${scanned}/${stored} 个样本；请缩小入队范围或扩展服务端分页。`} />}
        {split === 'blind_holdout' && <Alert style={{ marginBottom: 12 }} type="warning" message="盲测样本不参与 Rubric QA，也不在此页面一键导出；受控导出须显式确认。" />}
        <Table rowKey="id" dataSource={rows} pagination={{ current: page, pageSize: 30, total, onChange: setPage, showSizeChanger: false }}
          rowSelection={{ selectedRowKeys: selected, onChange: setSelected, getCheckboxProps: r => ({ disabled: !r.exportable }) }}
          columns={[
            { title: '题目', dataIndex: 'scenarioId' }, { title: '维度', dataIndex: 'dimension' }, { title: '难度', dataIndex: 'difficulty' },
            { title: '来源', render: (_: unknown, r: QueueRow) => <Tag color={r.snapshotOrigin === 'run_manifest' ? 'green' : 'orange'}>{r.snapshotOrigin === 'run_manifest' ? '冻结题面' : '当前题面补配'}</Tag> },
            { title: '审核', render: (_: unknown, r: QueueRow) => <span>{r.state} · {r.reviewerCount} 人</span> },
            { title: '可导出', render: (_: unknown, r: QueueRow) => <span title={r.exclusionReasons.join('\n')}>{r.exportable ? '是' : '否'}</span> },
            { title: '操作', render: (_: unknown, r: QueueRow) => <Button onClick={() => open(r).catch(e => message.error(String(e)))}>打开审核</Button> },
          ]} />
      </> },
      { key: 'qa', label: 'Rubric QA', children: <>
        <Alert showIcon type="info" message="仅分析已完成来源核验的开发/校准样本；不读取盲测标签。恒通过、恒失败及冗余只产生审查建议，不能自动删除安全约束。" />
        <Button style={{ margin: '16px 0' }} onClick={() => api('/api/calibration/rubric-qa').then(setQA).catch(e => message.error(String(e)))}>计算离线诊断（不调用模型）</Button>
        {qa && <><Descriptions column={3} bordered size="small">
          <Descriptions.Item label="已审核样本">{String(qa.reviewedCandidates)}</Descriptions.Item>
          <Descriptions.Item label="逐条可比标签">{String(qa.comparisons)}</Descriptions.Item>
          <Descriptions.Item label="与人工一致率">{qa.agreement == null ? 'N/A' : `${(Number(qa.agreement) * 100).toFixed(1)}%`}</Descriptions.Item>
          <Descriptions.Item label="标签覆盖率">{qa.labelCoverage == null ? 'N/A' : `${(Number(qa.labelCoverage) * 100).toFixed(1)}%`}</Descriptions.Item>
          <Descriptions.Item label="关键约束误放行">{String(qa.criticalFalsePasses)}</Descriptions.Item>
          <Descriptions.Item label="已隔离盲测">{String(qa.excludedHoldout)}</Descriptions.Item>
        </Descriptions><pre style={{ whiteSpace: 'pre-wrap', maxHeight: 700, overflow: 'auto' }}>{JSON.stringify(qa, null, 2)}</pre></>}
      </> },
    ]} />
    <Drawer open={!!detail} onClose={() => setDetail(undefined)} width="min(1100px, 95vw)" title={`独立审核 · ${detail?.candidate.scenario.id ?? ''}`}>
      {detail && <>
        <Alert type={detail.candidate.snapshotOrigin === 'run_manifest' ? 'info' : 'warning'} showIcon
          message={detail.blindReview ? '盲审：隐藏模型、自动分数及其他审核人的标签' : '已提交 / 仲裁视图'}
          description={detail.candidate.snapshotOrigin === 'current_definition' ? '历史运行没有冻结题面。这里是当前题库版本，不能据此推定当时输入相同；请查证原始来源后再勾选核验。' : '请独立核验题目、标准答案与约束，并记录来源。'} />
        <h3>题面与参考材料</h3>
        <pre style={{ whiteSpace: 'pre-wrap', maxHeight: 380, overflow: 'auto' }}>{detail.candidate.scenario.promptTemplate}</pre>
        <details><summary>完整题目快照与 hash</summary><pre style={{ whiteSpace: 'pre-wrap' }}>{JSON.stringify({ hash: detail.candidate.scenarioContentHash, scenario: detail.candidate.scenario }, null, 2)}</pre></details>
        <h3>候选回答</h3><pre style={{ whiteSpace: 'pre-wrap', maxHeight: 480, overflow: 'auto' }}>{detail.candidate.modelOutput || '（空回答）'}</pre>
        <Form form={form} layout="vertical" onFinish={submit}>
          {detail.candidate.criteria.map(c => <Form.Item key={c.id} name={['labels', c.id]} label={`${c.critical ? '[关键] ' : ''}${c.id} · ${c.description}`} rules={[{ required: true, message: '请选择判定' }]}>
            <Select options={[{ value: 'pass', label: '通过' }, { value: 'fail', label: '不通过' }, { value: 'unmeasured', label: '无法判断 / 约束有缺陷' }]} />
          </Form.Item>)}
          <Form.Item name="outcome" label="样本用途" rules={[{ required: true }]}><Select options={[{ value: 'usable', label: '可作为校准样本' }, { value: 'exclude', label: '排除' }, { value: 'needs_context', label: '需要补充上下文' }]} /></Form.Item>
          <Form.Item name="rationale" label="判定依据 / 仲裁理由" rules={[{ required: true, min: 8 }]}><Input.TextArea rows={3} /></Form.Item>
          <Form.Item name="sourceEvidence" label="来源证据（原始题面/独立求解/执行证据的具体位置）" rules={[{ required: true, min: 8 }]}><Input.TextArea rows={2} /></Form.Item>
          <Form.Item name="sourceVerified" valuePropName="checked"><Checkbox>我已独立核验来源与参考答案；对于补配题面，另已核实原始输入一致</Checkbox></Form.Item>
          <Button type="primary" htmlType="submit" loading={busy}>{adjudicate ? '提交第三人仲裁' : '提交独立标注'}</Button>
        </Form>
        <div style={{ marginTop: 16 }}>状态：{detail.summary.state} · 版本 {detail.summary.revision}</div>
        {detail.summary.exclusionReasons.map(reason => <div key={reason}>{reason}</div>)}
        {!!detail.events.length && <details><summary>只追加审核日志</summary><pre style={{ whiteSpace: 'pre-wrap' }}>{JSON.stringify(detail.events, null, 2)}</pre></details>}
      </>}
    </Drawer>
  </>;
}
