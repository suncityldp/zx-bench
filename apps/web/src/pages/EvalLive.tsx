import { useEffect, useState, useRef, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
  Progress, Tag, Table, Row, Col, Statistic, Button, Space, Typography,
  Spin, Alert, Tooltip, Badge, Empty, Divider, Modal, Checkbox, Tabs, message,
  InputNumber,
} from 'antd';
import {
  ArrowLeftOutlined, ReloadOutlined, CheckCircleOutlined, CloseCircleOutlined,
  LoadingOutlined, ThunderboltOutlined, FileSearchOutlined, CheckSquareOutlined,
  CalculatorOutlined, SafetyOutlined, RobotOutlined, ClockCircleOutlined,
  ExclamationCircleOutlined, EyeOutlined, PauseCircleOutlined, PlayCircleOutlined,
  StopOutlined, ThunderboltFilled, PlusOutlined, ForkOutlined, DashboardOutlined,
  ApiOutlined,
} from '@ant-design/icons';
import type { EvalProgress, DimensionProgress, QuestionLiveResult, EvalStage } from '@zxbench/types';
import { useTheme } from '../theme';
import { useLanguage, dimLabel } from '../i18n';

const { Text, Paragraph } = Typography;

// ===== 维度 key 列表（标签统一走 i18n 的 dimLabel） =====
const DIMENSION_KEYS: string[] = [
  'data_extraction',
  'instruction_following',
  'reasoning_math',
  'structured_output',
  'tool_cli_workflow',
  'safety_authority',
  'agent_workflow',
  'cli_deep_tasks',
  'program',
  'hallucination_resistance',
];

const DIMENSION_COLORS: Record<string, string> = {
  data_extraction: '#1890ff',
  instruction_following: '#52c41a',
  reasoning_math: '#722ed1',
  structured_output: '#eb2f96',
  tool_cli_workflow: '#fa8c16',
  safety_authority: '#f5222d',
  agent_workflow: '#13c2c2',
  cli_deep_tasks: '#2f54eb',
  program: '#fa541c',
  hallucination_resistance: '#8b5cf6',
};

// ===== 阶段元数据 =====
const STAGE_CONFIG: Record<EvalStage, { label: { zh: string; en: string }; icon: React.ReactNode; color: string }> = {
  queued:              { label: { zh: '排队中', en: 'Queued' },            icon: <ClockCircleOutlined />,        color: '#8c8c8c' },
  initializing:        { label: { zh: '初始化', en: 'Initializing' },      icon: <LoadingOutlined spin />,        color: '#1890ff' },
  calling_model:       { label: { zh: '调用模型', en: 'Calling model' },   icon: <ThunderboltOutlined />,         color: '#fa8c16' },
  building_metadata:   { label: { zh: '提取输出', en: 'Extracting output' }, icon: <FileSearchOutlined />,        color: '#13c2c2' },
  parsing_output:      { label: { zh: '格式验证', en: 'Format check' },    icon: <CheckSquareOutlined />,         color: '#52c41a' },
  deterministic_scoring:{ label: { zh: '确定性评分', en: 'Deterministic scoring' }, icon: <CalculatorOutlined />,  color: '#722ed1' },
  safety_check:        { label: { zh: '安全检查', en: 'Safety check' },    icon: <SafetyOutlined />,              color: '#f5222d' },
  ai_judge:            { label: { zh: 'AI Judge', en: 'AI Judge' },        icon: <RobotOutlined />,               color: '#eb2f96' },
  reasoning_limit:     { label: { zh: '思考超限', en: 'Reasoning limit' }, icon: <ClockCircleOutlined />,         color: '#fa541c' },
  environment_error:   { label: { zh: '环境故障', en: 'Environment error' }, icon: <ApiOutlined />,               color: '#fa8c16' },
  completed:           { label: { zh: '完成', en: 'Completed' },           icon: <CheckCircleOutlined />,         color: '#52c41a' },
  failed:              { label: { zh: '失败', en: 'Failed' },              icon: <CloseCircleOutlined />,         color: '#f5222d' },
};

const EVALUATION_STAGES: EvalStage[] = [
  'initializing', 'calling_model', 'building_metadata', 'parsing_output',
  'deterministic_scoring', 'safety_check', 'ai_judge',
];

interface RunInfo {
  id: string;
  name: string;
  status: string;
  modelConfig: { name: string; provider: string };
  config: Record<string, unknown>;
  createdAt: string;
  parentRunId?: string;
  groupName?: string;
  summary?: { averageScore: number; dimensionAverages: Record<string, number> } | null;
}

interface GroupRunInfo {
  id: string;
  name: string;
  status: string;
  dimensionFilter?: string[];
}

export default function EvalLive() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { mode } = useTheme();
  const { lang } = useLanguage();
  const [progress, setProgress] = useState<EvalProgress | null>(null);
  const [runInfo, setRunInfo] = useState<RunInfo | null>(null);
  const [wsConnected, setWsConnected] = useState(false);
  const [wsReconnectAttempt, setWsReconnectAttempt] = useState(0);
  const [actionLoading, setActionLoading] = useState(false);
  const [forkModalOpen, setForkModalOpen] = useState(false);
  const [forkDimensions, setForkDimensions] = useState<string[]>([]);
  const [forkLoading, setForkLoading] = useState(false);
  const [groupRuns, setGroupRuns] = useState<GroupRunInfo[]>([]);
  const [retryingIds, setRetryingIds] = useState<string[]>([]);
  // 生成额度（maxTokens）：展示当前值，支持实时修改（运行中后续题目立即生效）
  const [maxTokensValue, setMaxTokensValue] = useState<number>(8192);
  const [configSaving, setConfigSaving] = useState(false);
  const [configNotice, setConfigNotice] = useState<string | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectCount = useRef(0);
  const heartbeatTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const progressStatusRef = useRef<string | undefined>(undefined);
  // 保持 ref 同步
  useEffect(() => {
    progressStatusRef.current = progress?.status;
  }, [progress?.status]);

  // 同步 runInfo 中的生成额度到编辑框
  useEffect(() => {
    if (runInfo?.config && typeof runInfo.config.maxTokens === 'number') {
      setMaxTokensValue(runInfo.config.maxTokens);
    }
  }, [runInfo?.config]);

  // 获取评测基本信息
  const fetchRunInfo = useCallback(async () => {
    if (!id) return;
    try {
      const res = await fetch(`/api/runs/${id}`);
      const json = await res.json();
      if (json.success) setRunInfo(json.data);
    } catch (err) {
      console.error('Failed to fetch run info:', err);
    }
  }, [id]);

  // 实时修改生成额度
  const handleUpdateConfig = useCallback(async () => {
    if (!id) return;
    setConfigSaving(true);
    setConfigNotice(null);
    try {
      const res = await fetch(`/api/runs/${id}/config`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ maxTokens: maxTokensValue }),
      });
      const json = await res.json();
      if (json.success) {
        setConfigNotice(json.data.notice || (lang === 'en' ? 'Updated' : '已更新'));
        message.success(lang === 'en' ? 'Generation budget updated' : '生成额度已更新');
        fetchRunInfo();
      } else {
        message.error(json.error || (lang === 'en' ? 'Update failed' : '更新失败'));
      }
    } catch {
      message.error(lang === 'en' ? 'Update failed, check server status' : '更新失败，请检查服务器状态');
    } finally {
      setConfigSaving(false);
    }
  }, [id, maxTokensValue, fetchRunInfo, lang]);

  // 从 REST API 获取进度（后备方案：WS 无缓存时使用）
  const fetchProgress = useCallback(async () => {
    if (!id) return;
    try {
      const res = await fetch(`/api/runs/${id}/progress`);
      const json = await res.json();
      if (json.success && json.data) {
        setProgress(json.data as EvalProgress);
      }
    } catch (err) {
      console.error('Failed to fetch progress:', err);
    }
  }, [id]);

  // WebSocket 连接
  const connectWs = useCallback(() => {
    if (!id) return;
    // 关闭旧连接
    if (wsRef.current) {
      // 标记为主动关闭：其异步触发的 onclose 不应再次发起重连（否则会形成重连风暴）
      (wsRef.current as WebSocket & { __closing?: boolean }).__closing = true;
      wsRef.current.close();
      wsRef.current = null;
    }
    // 清掉可能存在的旧重连定时器，避免叠加
    if (reconnectTimer.current) {
      clearTimeout(reconnectTimer.current);
      reconnectTimer.current = null;
    }
    // 清理旧心跳
    if (heartbeatTimer.current) {
      clearInterval(heartbeatTimer.current);
      heartbeatTimer.current = null;
    }

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/ws?runId=${id}`;
    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.onopen = () => {
      setWsConnected(true);
      setWsReconnectAttempt(0); // 连接成功，重置 UI 重试计数
      reconnectCount.current = 0;   // 同步重置 ref 计数器，防止永久断连

      // 客户端心跳：每 20s 发 JSON ping
      heartbeatTimer.current = setInterval(() => {
        if (ws.readyState === 1) {
          try { ws.send(JSON.stringify({ type: 'ping', ts: Date.now() })); } catch { /* ignore */ }
        }
      }, 20000);
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === 'progress' && msg.data) {
          setProgress((prev) => {
            const wsProgress = msg.data as EvalProgress;

            // 无 WS 数据时，保留上一次的 currentScenarios 和 activeDimensions
            if (prev) {
              if (prev.currentScenarios && !wsProgress.currentScenarios) {
                wsProgress.currentScenarios = prev.currentScenarios;
              }
              if ((!wsProgress.activeDimensions || wsProgress.activeDimensions.length === 0)
                  && prev.activeDimensions && prev.activeDimensions.length > 0) {
                wsProgress.activeDimensions = prev.activeDimensions;
              }
            }

            // 合并 dimensionProgress：保留 prev 中有但 WS 中缺失的维度
            if (prev?.dimensionProgress && prev.dimensionProgress.length > 0) {
              const wsDimNames = new Set((wsProgress.dimensionProgress || []).map(d => d.dimension));
              const extraDims = prev.dimensionProgress.filter(d => !wsDimNames.has(d.dimension));
              if (extraDims.length > 0) {
                wsProgress.dimensionProgress = [...(wsProgress.dimensionProgress || []), ...extraDims];
              }
            }

            return wsProgress;
          });
        }
        // pong 响应忽略（仅用于保活）
      } catch (err) {
        console.error('Failed to parse WS message:', err);
      }
    };

    ws.onclose = () => {
      setWsConnected(false);
      if (heartbeatTimer.current) {
        clearInterval(heartbeatTimer.current);
        heartbeatTimer.current = null;
      }
      // 主动替换/卸载导致的关闭：不触发重连，直接返回（修复重连风暴）
      if ((ws as WebSocket & { __closing?: boolean }).__closing) return;

      // 尝试重连：使用 ref 中的状态 + 从服务器获取最新状态
      const tryReconnect = async () => {
        let status = progressStatusRef.current;
        // ref 可能过期，从服务器获取真实状态
        if (!status || status === 'completed' || status === 'failed') {
          try {
            const res = await fetch(`/api/runs/${id}`);
            const json = await res.json();
            if (json.success) status = json.data.status;
          } catch { /* use ref status */ }
        }
        if (status === 'running' || status === 'pending' || status === 'paused') {
          const nextAttempt = reconnectCount.current + 1;
          if (nextAttempt <= 5) {
            reconnectCount.current = nextAttempt;
            setWsReconnectAttempt(nextAttempt);
            const delay = Math.min(3000 * Math.pow(2, nextAttempt - 1), 60000);
            reconnectTimer.current = setTimeout(() => connectWs(), delay);
          }
        }
      };
      tryReconnect();
    };

    ws.onerror = () => {
      setWsConnected(false);
    };
  }, [id]);

  // 暂停评测
  const handlePause = useCallback(async () => {
    if (!id) return;
    setActionLoading(true);
    try {
      await fetch(`/api/runs/${id}/pause`, { method: 'POST' });
      // 立即刷新状态
      fetchRunInfo();
      fetchProgress();
    } catch (err) {
      console.error('Pause failed:', err);
    } finally {
      setActionLoading(false);
    }
  }, [id, fetchRunInfo, fetchProgress]);

  // 继续评测
  const handleResume = useCallback(async () => {
    if (!id) return;
    setActionLoading(true);
    try {
      const res = await fetch(`/api/runs/${id}/resume`, { method: 'POST' });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || !json.success) {
        const errMsg = json.error || (lang === 'en' ? `Resume failed (HTTP ${res.status})` : `恢复失败 (HTTP ${res.status})`);
        message.error(errMsg);
        setActionLoading(false);
        return;
      }
      // 立即刷新状态
      fetchRunInfo();
      fetchProgress();
      // 仅在当前连接已断开时重建（恢复后服务端会在原连接上推送 running 状态）
      if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
        setTimeout(() => connectWs(), 500);
      }
    } catch (err) {
      console.error('Resume failed:', err);
      message.error(lang === 'en' ? 'Failed to resume evaluation, check server status' : '恢复评测失败，请检查服务器状态');
    } finally {
      setActionLoading(false);
    }
  }, [id, connectWs, fetchRunInfo, fetchProgress, lang]);

  // 取消评测
  const handleCancel = useCallback(async () => {
    if (!id) return;
    setActionLoading(true);
    try {
      await fetch(`/api/runs/${id}/cancel`, { method: 'POST' });
      fetchRunInfo();
      fetchProgress();
    } catch (err) {
      console.error('Cancel failed:', err);
    } finally {
      setActionLoading(false);
    }
  }, [id, fetchRunInfo, fetchProgress]);

  // 获取同组运行列表（仅用于侧边栏展示，不合并兄弟的活跃题目）
  const fetchGroupRuns = useCallback(async () => {
    if (!id) return;
    try {
      const res = await fetch(`/api/runs/${id}/group-progress`);
      const json = await res.json();
      if (json.success && json.data?.runs) {
        setGroupRuns(json.data.runs);
      }
    } catch { /* ignore */ }
  }, [id]);

  // 添加维度并行测试（合并到同一 Run）
  const handleFork = useCallback(async () => {
    if (!id || forkDimensions.length === 0) return;
    setForkLoading(true);
    try {
      const res = await fetch(`/api/runs/${id}/fork`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dimensionIds: forkDimensions }),
      });
      const json = await res.json();
      if (json.success) {
        setForkModalOpen(false);
        setForkDimensions([]);
        message.success(lang === 'en' ? 'Dimension added, evaluation is restarting...' : '维度已添加，评测正在重启...');
        // 刷新进度和运行信息
        setTimeout(() => {
          fetchRunInfo();
          fetchProgress();
          if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
            connectWs();
          }
        }, 1500);
      } else {
        message.error(json.error || (lang === 'en' ? 'Failed to add dimension' : '添加维度失败'));
      }
    } catch (err) {
      console.error('Fork failed:', err);
      message.error(lang === 'en' ? 'Failed to add dimension' : '添加维度失败');
    } finally {
      setForkLoading(false);
    }
  }, [id, forkDimensions, fetchRunInfo, fetchProgress, connectWs, lang]);

  // 单题重试（最多同时4题）
  const handleRetry = useCallback(async (scenarioId: string) => {
    if (!id || retryingIds.includes(scenarioId) || retryingIds.length >= 4) return;
    setRetryingIds((prev) => [...prev, scenarioId]);
    try {
      const res = await fetch(`/api/runs/${id}/results/${scenarioId}/retry`, { method: 'POST' });
      const json = await res.json();
      if (!json.success) {
        console.error('Retry failed:', json.error);
      }
    } catch (err) {
      console.error('Retry failed:', err);
    } finally {
      setRetryingIds((prev) => prev.filter((id) => id !== scenarioId));
    }
  }, [id]);

  useEffect(() => {
    fetchRunInfo();
    fetchProgress();
    connectWs();
    fetchGroupRuns();

    // 定期刷新 runInfo（检测状态变化）
    const interval = setInterval(fetchRunInfo, 10000);

    // 定期刷新组运行列表
    const groupInterval = setInterval(fetchGroupRuns, 15000);

    // 后备：如果 WS 连接后 2 秒内没收到进度数据，从 REST API 拉取
    const fallbackTimer = setTimeout(() => {
      setProgress((prev) => {
        if (!prev) fetchProgress();
        return prev;
      });
    }, 2000);

    // 页面可见性恢复：切回 tab 时检查 WS 并重连
    const handleVisibility = () => {
      if (document.visibilityState === 'visible') {
        // 刷新数据
        fetchRunInfo();
        fetchProgress();
        fetchGroupRuns();
        // 检查 WS 是否存活，不活则重连
        const ws = wsRef.current;
        if (!ws || ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) {
          reconnectCount.current = 0;
          setWsReconnectAttempt(0);
          connectWs();
        }
      }
    };
    document.addEventListener('visibilitychange', handleVisibility);

    return () => {
      if (wsRef.current) {
        (wsRef.current as WebSocket & { __closing?: boolean }).__closing = true;
        wsRef.current.close();
      }
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
      if (heartbeatTimer.current) clearInterval(heartbeatTimer.current);
      clearInterval(interval);
      clearInterval(groupInterval);
      clearTimeout(fallbackTimer);
      document.removeEventListener('visibilitychange', handleVisibility);
    };
  }, [fetchRunInfo, fetchProgress, connectWs, fetchGroupRuns]);

  // ===== 渲染 =====

  if (!runInfo && !progress) {
    return (
      <div style={{ textAlign: 'center', padding: 80 }}>
        <Spin size="large" tip={lang === 'en' ? 'Connecting...' : '连接中...'} />
      </div>
    );
  }

  const isRunning = progress?.status === 'running' || runInfo?.status === 'running' || runInfo?.status === 'pending';
  const isPaused = progress?.status === 'paused' || runInfo?.status === 'paused';
  const isCompleted = progress?.status === 'completed' || runInfo?.status === 'completed';
  const isFailed = progress?.status === 'failed' || runInfo?.status === 'failed';
  const isActive = isRunning || isPaused;

  const currentStage = progress?.currentStage || 'queued';
  const stageConfig = STAGE_CONFIG[currentStage];

  const dimProgress = progress?.dimensionProgress || [];
  const recentResults = progress?.recentResults || [];

  // 计算总体统计
  const totalPassed = dimProgress.reduce((sum, d) => sum + d.passed, 0);
  const totalFailed = dimProgress.reduce((sum, d) => sum + d.failed, 0);
  const totalRedLine = dimProgress.reduce((sum, d) => sum + d.redLine, 0);
  // 综合分 — 已完成运行优先使用后端难度加权+维度加权综合分，实时运行使用完成数加权近似均分
  const overallAvg = runInfo?.summary?.averageScore != null
    ? runInfo.summary.averageScore
    : dimProgress.length > 0
      ? dimProgress.reduce((sum, d) => sum + d.avgScore * d.completed, 0) / Math.max(dimProgress.reduce((sum, d) => sum + d.completed, 0), 1)
      : 0;

  // ETA / Token speed 格式化
  const tokensPerSec = progress?.tokensPerSecond;
  const speedText = tokensPerSec != null
    ? tokensPerSec >= 1000
      ? `${(tokensPerSec / 1000).toFixed(1)}K t/s`
      : `${tokensPerSec} t/s`
    : (lang === 'en' ? 'Calculating...' : '计算中...');

  const totalTokensText = progress?.totalTokens != null
    ? progress.totalTokens >= 1000000
      ? `${(progress.totalTokens / 1000000).toFixed(1)}M`
      : progress.totalTokens >= 1000
        ? `${(progress.totalTokens / 1000).toFixed(1)}K`
        : `${progress.totalTokens}`
    : null;

  // 组内总题数（聚合所有并行运行的 total）

  return (
    <div>
      {/* ===== Header ===== */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <Space>
          <Button icon={<ArrowLeftOutlined />} onClick={() => navigate('/eval/history')}>{lang === 'en' ? 'Back' : '返回'}</Button>
          <h2 className="swiss-page-title" style={{ margin: 0 }}>{runInfo?.name || (lang === 'en' ? `Eval ${id}` : `评测 ${id}`)}</h2>
          <Badge
            status={wsConnected ? 'success' : 'error'}
            text={wsConnected
              ? (lang === 'en' ? 'Live' : '实时连接')
              : (wsReconnectAttempt > 0
                  ? (lang === 'en' ? `Reconnecting (${wsReconnectAttempt}/5)...` : `重连中(${wsReconnectAttempt}/5)...`)
                  : (lang === 'en' ? 'Reconnecting...' : '断开重连中...'))}
          />
        </Space>
        <Space>
          {isRunning && (
            <Button
              icon={<PauseCircleOutlined />}
              onClick={handlePause}
              loading={actionLoading}
              danger
            >
              {lang === 'en' ? 'Pause' : '暂停'}
            </Button>
          )}
          {isPaused && (
            <Button
              type="primary"
              icon={<PlayCircleOutlined />}
              onClick={handleResume}
              loading={actionLoading}
            >
              {lang === 'en' ? 'Resume' : '继续评测'}
            </Button>
          )}
          {isFailed && (
            <Button
              type="primary"
              icon={<PlayCircleOutlined />}
              onClick={handleResume}
              loading={actionLoading}
            >
              {lang === 'en' ? 'Resume from interruption' : '从中断处恢复'}
            </Button>
          )}
          {isActive && (
            <Button
              icon={<StopOutlined />}
              onClick={handleCancel}
              loading={actionLoading}
              danger
            >
              {lang === 'en' ? 'Cancel' : '取消'}
            </Button>
          )}
          {isActive && (
            <Button
              icon={<ForkOutlined />}
              onClick={() => {
                // 预选所有可用的维度（排除已完成和已在测试中的）
                const activeDims = new Set(progress?.activeDimensions || []);
                for (const gr of groupRuns) {
                  if (gr.id !== id && gr.status === 'running') {
                    if (gr.dimensionFilter) {
                      for (const d of gr.dimensionFilter) activeDims.add(d);
                    }
                  }
                }
                const available = DIMENSION_KEYS.filter((dim) => {
                  if (activeDims.has(dim)) return false;
                  const dp = dimProgress.find((d) => d.dimension === dim);
                  return !dp || dp.completed < dp.total; // 未完成或不存在
                });
                setForkDimensions(available);
                setForkModalOpen(true);
              }}
              style={{ borderColor: '#722ed1', color: '#722ed1' }}
            >
              {lang === 'en' ? 'Add dimension test' : '添加维度测试'}
            </Button>
          )}
          {isCompleted && (
            <Button type="primary" icon={<EyeOutlined />} onClick={() => navigate(`/eval/${id}`)}>
              {lang === 'en' ? 'View full details' : '查看完整详情'}
            </Button>
          )}
          <Button icon={<ReloadOutlined />} onClick={() => { fetchRunInfo(); connectWs(); }}>{lang === 'en' ? 'Refresh' : '刷新'}</Button>
        </Space>
      </div>

      {/* ===== 状态横幅 ===== */}
      {isPaused && (
        <Alert
          message={lang === 'en' ? 'Evaluation paused' : '评测已暂停'}
          description={lang === 'en'
            ? 'Evaluation is paused. Completed results are saved. Click "Resume" to continue from where it stopped.'
            : '评测已暂停，已完成的题目结果已保存。点击「继续评测」可从中断处恢复。'}
          type="warning"
          showIcon
          icon={<PauseCircleOutlined />}
          style={{ marginBottom: 16 }}
        />
      )}
      {isFailed && (
        <Alert
          message={lang === 'en' ? 'Evaluation interrupted' : '评测异常中断'}
          description={lang === 'en'
            ? 'An error occurred or the evaluation was interrupted. Completed results are saved. Click "Resume from interruption" to continue.'
            : '评测过程中发生错误或被中断。已完成的题目结果已保存。点击「从中断处恢复」可继续未完成的测试。'}
          type="error"
          showIcon
          style={{ marginBottom: 16 }}
        />
      )}
      {isCompleted && (
        <Alert
          message={lang === 'en' ? 'Evaluation complete' : '评测完成'}
          description={lang === 'en'
            ? `${progress?.total || 0} questions, composite score ${overallAvg.toFixed(2)}, ${totalPassed} passed, ${totalFailed} failed${totalRedLine > 0 ? `, ${totalRedLine} red-line` : ''}.`
            : `共 ${progress?.total || 0} 题，综合分 ${overallAvg.toFixed(2)}，通过 ${totalPassed} 题，失败 ${totalFailed} 题${totalRedLine > 0 ? `，安全红线 ${totalRedLine} 题` : ''}。`}
          type="success"
          showIcon
          style={{ marginBottom: 16 }}
        />
      )}

      {/* ===== 并行运行组 ===== */}
      {groupRuns.length > 1 && (
        <div className="swiss-card" style={{ marginBottom: 16 }}>
          <div className="swiss-card-title">
            <Space>
              <ForkOutlined />
              <span>{lang === 'en' ? `Parallel runs (${groupRuns.length} runs)` : `并行测试组 (${groupRuns.length} 个运行)`}</span>
            </Space>
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            {groupRuns.map((gr) => (
              <Tag
                key={gr.id}
                color={gr.id === id ? 'blue' : gr.status === 'running' ? 'green' : gr.status === 'completed' ? 'success' : 'default'}
                style={{ cursor: gr.id !== id ? 'pointer' : 'default', fontSize: 12, padding: '2px 10px' }}
                onClick={() => gr.id !== id && navigate(`/eval/live/${gr.id}`)}
              >
                {gr.id === id ? '● ' : ''}{gr.name}
                {gr.status === 'running' && <LoadingOutlined style={{ marginLeft: 4 }} />}
                {gr.status === 'completed' && <CheckCircleOutlined style={{ marginLeft: 4 }} />}
              </Tag>
            ))}
          </div>
        </div>
      )}

      {/* ===== 总体进度 ===== */}
      <div className="swiss-card" style={{ marginBottom: 16 }}>
        {/* 生成额度：实时展示 + 可修改（运行中后续题目立即生效） */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
          <ThunderboltOutlined style={{ color: '#fa8c16' }} />
          <Text strong style={{ fontSize: 13 }}>{lang === 'en' ? 'Generation budget (maxTokens)' : '生成额度 (maxTokens)'}</Text>
          <Text type="secondary" style={{ fontSize: 12 }}>{lang === 'en'
            ? 'Reasoning budget for the model; insufficient budget truncates reasoning and lowers scores'
            : '推理模型思考链长，额度不足会被截断压低分数'}</Text>
          <InputNumber
            min={1024}
            max={131072}
            step={1024}
            value={maxTokensValue}
            onChange={(v) => setMaxTokensValue(v ?? 8192)}
            style={{ width: 130 }}
            disabled={isCompleted || isFailed}
          />
          <Button
            size="small"
            type="primary"
            onClick={handleUpdateConfig}
            loading={configSaving}
            disabled={isCompleted || isFailed}
          >
            {lang === 'en' ? 'Save' : '保存'}
          </Button>
          {configNotice && (
            <Text type="success" style={{ fontSize: 12 }}>{configNotice}</Text>
          )}
          {!isCompleted && !isFailed && runInfo?.config && typeof runInfo.config.maxTokens === 'number' && runInfo.config.maxTokens !== maxTokensValue && (
            <Tag color="orange" style={{ fontSize: 11 }}>{lang === 'en' ? 'Unsaved' : '未保存'}</Tag>
          )}
        </div>
        <Row gutter={24} align="middle">
          <Col span={16}>
            <div style={{ marginBottom: 8 }}>
              <Text strong style={{ fontSize: 16 }}>
                {isRunning ? (lang === 'en' ? 'Running' : '正在评测中') : isCompleted ? (lang === 'en' ? 'Completed' : '评测完成') : (lang === 'en' ? 'Status' : '评测状态')}
              </Text>
              <Text type="secondary" style={{ marginLeft: 12 }}>
                {progress?.completed || 0} / {progress?.total || 0} {lang === 'en' ? 'questions' : '题'}
              </Text>
              {progress?.totalTokens != null && totalTokensText && (
                <Tag icon={<DashboardOutlined />} color="blue" style={{ marginLeft: 8 }}>
                  {lang === 'en' ? 'Total' : '累计'} {totalTokensText} tokens
                </Tag>
              )}
              {isRunning && tokensPerSec != null && (
                <Tag icon={<ThunderboltFilled />} color="orange" style={{ marginLeft: 8 }}>
                  {speedText}
                </Tag>
              )}
            </div>
            <Progress
              percent={progress?.percentage || 0}
              status={isCompleted ? 'success' : isFailed ? 'exception' : 'active'}
              strokeColor={{ from: '#1890ff', to: '#52c41a' }}
              size={['100%', 20]}
            />
          </Col>
          <Col span={8}>
            <Row gutter={16}>
              <Col span={6}>
                <Statistic title={lang === 'en' ? 'Passed' : '通过'} value={totalPassed} valueStyle={{ color: '#52c41a' }} />
              </Col>
              <Col span={6}>
                <Statistic title={lang === 'en' ? 'Failed' : '失败'} value={totalFailed} valueStyle={{ color: '#f5222d' }} />
              </Col>
              <Col span={6}>
                <Statistic title={lang === 'en' ? 'Red-line' : '红线'} value={totalRedLine} valueStyle={{ color: totalRedLine > 0 ? '#f5222d' : undefined }} />
              </Col>
              <Col span={6}>
                <Statistic title={lang === 'en' ? 'Composite Score' : '综合分'} value={overallAvg} suffix={lang === 'en' ? '' : '分'} precision={2} />
              </Col>
            </Row>
          </Col>
        </Row>
      </div>

      {/* ===== 当前正在测试的题目（Tab 页展示并行维度）===== */}
      {isActive && progress && (() => {
        // 构建 tab 列表：优先用 currentScenarios，回退到旧字段
        const cs = progress.currentScenarios;
        const hasScenarios = cs && Object.keys(cs).length > 0;
        const activeDims = progress.activeDimensions || [];

        // 如果有 currentScenarios 映射，直接用它构建 tab
        if (hasScenarios) {
          const tabItems = Object.entries(cs!).map(([key, info]) => {
            const dim = info.dimension || key;
            const cfg = STAGE_CONFIG[info.stage as EvalStage];
            return {
              key,
              label: (
                <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span style={{
                    width: 8, height: 8, borderRadius: '50%',
                    background: DIMENSION_COLORS[dim] || '#1890ff',
                    display: 'inline-block',
                    boxShadow: `0 0 6px ${DIMENSION_COLORS[dim] || '#1890ff'}`,
                  }} />
                  {dimLabel(dim, lang)}
                </span>
              ),
              children: (
                <div>
                  <Row gutter={16}>
                    <Col span={6}>
                      <div style={{ marginBottom: 8 }}>
                        <Text type="secondary">{lang === 'en' ? 'Question ID' : '题目 ID'}</Text>
                        <div><Text code copyable>{info.scenarioId}</Text></div>
                      </div>
                      <div style={{ marginBottom: 8 }}>
                        <Text type="secondary">{lang === 'en' ? 'Dimension' : '维度'}</Text>
                        <div>
                          <Tag color={DIMENSION_COLORS[dim] || '#1890ff'}>
                            {dimLabel(dim, lang)}
                          </Tag>
                        </div>
                      </div>
                    </Col>
                    <Col span={6}>
                      {info.difficulty && (
                        <div style={{ marginBottom: 8 }}>
                          <Text type="secondary">{lang === 'en' ? 'Difficulty' : '难度'}</Text>
                          <div>
                            <Tag color={
                              info.difficulty === 'hard' ? 'red' :
                              info.difficulty === 'medium' ? 'orange' : 'green'
                            }>
                              {info.difficulty === 'hard' ? (lang === 'en' ? 'Hard' : '困难') :
                               info.difficulty === 'medium' ? (lang === 'en' ? 'Medium' : '中等') : (lang === 'en' ? 'Easy' : '简单')}
                            </Tag>
                          </div>
                        </div>
                      )}
                      {info.language && (
                        <div style={{ marginBottom: 8 }}>
                          <Text type="secondary">{lang === 'en' ? 'Language' : '语言'}</Text>
                          <div><Tag color="blue">{info.language}</Tag></div>
                        </div>
                      )}
                    </Col>
                    <Col span={12}>
                      <Text type="secondary">{lang === 'en' ? 'Question preview' : '题目预览'}</Text>
                      <Paragraph
                        ellipsis={{ rows: 4, expandable: true, symbol: lang === 'en' ? 'Expand' : '展开' }}
                        style={{
                          marginTop: 4, padding: 12,
                          background: 'var(--grey-1)', borderRadius: 0,
                          fontSize: 13, fontFamily: 'var(--mono)',
                          whiteSpace: 'pre-wrap', maxHeight: 120,
                          overflow: 'auto', border: '1px solid var(--border-subtle)',
                        }}
                      >
                        {info.promptPreview || (lang === 'en' ? '(No preview)' : '(无预览)')}
                      </Paragraph>
                    </Col>
                  </Row>

                  {/* 阶段指示器 */}
                  {cfg && (
                    <>
                    <Divider style={{ margin: '10px 0' }} />
                    <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexWrap: 'wrap' }}>
                      {EVALUATION_STAGES.map((stage, idx) => {
                        const sc = STAGE_CONFIG[stage];
                        const isActive = info.stage === stage;
                        const stageIdx = EVALUATION_STAGES.indexOf(info.stage as EvalStage);
                        const isPassed = stageIdx >= 0 && stageIdx > idx;
                        return (
                          <div key={stage} style={{ display: 'flex', alignItems: 'center' }}>
                            <Tooltip title={sc.label[lang]}>
                              <div style={{
                                display: 'flex', alignItems: 'center', gap: 6,
                                padding: '3px 10px', borderRadius: 16, fontSize: 11,
                                fontWeight: isActive ? 600 : 400,
                                background: isActive ? sc.color + '15' : isPassed ? '#f6ffed' : '#fafafa',
                                border: `1px solid ${isActive ? sc.color : isPassed ? '#b7eb8f' : '#d9d9d9'}`,
                                color: isActive ? sc.color : isPassed ? '#52c41a' : '#8c8c8c',
                                transition: 'all 0.3s',
                                ...(isActive ? { boxShadow: `0 0 6px ${sc.color}40` } : {}),
                              }}>
                                <span style={{ fontSize: 13 }}>{sc.icon}</span>
                                <span>{sc.label[lang]}</span>
                              </div>
                            </Tooltip>
                            {idx < EVALUATION_STAGES.length - 1 && (
                              <div style={{ width: 12, height: 2, background: isPassed ? '#52c41a' : '#d9d9d9', margin: '0 2px' }} />
                            )}
                          </div>
                        );
                      })}
                    </div>
                    </>
                  )}
                </div>
              ),
            };
          });

          return (
            <div className="swiss-card" style={{ marginBottom: 16 }}>
              <div className="swiss-card-title">
                <Space>
                  {isPaused ? <PauseCircleOutlined /> : <LoadingOutlined spin />}
                  <span>{isPaused ? (lang === 'en' ? 'Paused' : '已暂停') : (lang === 'en' ? 'Testing' : '正在测试')}</span>
                  {activeDims.length > 1 && (
                    <Tag icon={<ThunderboltFilled />} color="blue">{lang === 'en' ? `Parallel ${activeDims.length} dims` : `并行 ${activeDims.length} 维度`}</Tag>
                  )}
                </Space>
              </div>
              <Tabs
                size="small"
                items={tabItems}
                defaultActiveKey={tabItems[0]?.key}
                style={{ marginTop: -8 }}
                tabBarStyle={{ marginBottom: 12 }}
              />
            </div>
          );
        }

        // 回退：无 currentScenarios，用旧字段展示单题
        if (!progress.currentScenarioId) {
          return (
            <div className="swiss-card" style={{ marginBottom: 16 }}>
              <div className="swiss-card-title">
                <Space>
                  {isPaused ? <PauseCircleOutlined /> : <LoadingOutlined spin />}
                  <span>{isPaused ? (lang === 'en' ? 'Paused' : '已暂停') : (lang === 'en' ? 'Waiting for data...' : '等待数据...')}</span>
                </Space>
              </div>
              <Empty description={lang === 'en' ? 'Waiting for question data...' : '等待题目数据...'} image={Empty.PRESENTED_IMAGE_SIMPLE} />
            </div>
          );
        }

        return (
          <div className="swiss-card" style={{ marginBottom: 16 }}>
            <div className="swiss-card-title">
              <Space>
                {isPaused ? <PauseCircleOutlined /> : <LoadingOutlined spin />}
                <span>{isPaused ? (lang === 'en' ? 'Paused' : '已暂停') : (lang === 'en' ? 'Testing' : '正在测试')}</span>
                {activeDims.length > 1 && (
                  <Tag icon={<ThunderboltFilled />} color="blue">{lang === 'en' ? `Parallel ${activeDims.length} dims` : `并行 ${activeDims.length} 维度`}</Tag>
                )}
              </Space>
            </div>
            <Row gutter={16}>
            <Col span={6}>
              <div style={{ marginBottom: 8 }}>
                <Text type="secondary">{lang === 'en' ? 'Question ID' : '题目 ID'}</Text>
                <div>
                  <Text code copyable>{progress.currentScenarioId}</Text>
                </div>
              </div>
              <div style={{ marginBottom: 8 }}>
                <Text type="secondary">{lang === 'en' ? 'Dimension' : '维度'}</Text>
                <div>
                  <Tag color={DIMENSION_COLORS[progress.currentDimension || ''] || '#1890ff'}>
                    {progress.currentDimension ? dimLabel(progress.currentDimension, lang) : '-'}
                  </Tag>
                </div>
              </div>
            </Col>
            <Col span={6}>
              <div style={{ marginBottom: 8 }}>
                <Text type="secondary">{lang === 'en' ? 'Difficulty' : '难度'}</Text>
                <div>
                  <Tag color={
                    progress.currentDifficulty === 'hard' ? 'red' :
                    progress.currentDifficulty === 'medium' ? 'orange' : 'green'
                  }>
                    {progress.currentDifficulty === 'hard' ? (lang === 'en' ? 'Hard' : '困难') :
                     progress.currentDifficulty === 'medium' ? (lang === 'en' ? 'Medium' : '中等') :
                     progress.currentDifficulty === 'easy' ? (lang === 'en' ? 'Easy' : '简单') :
                     progress.currentDifficulty || '-'}
                  </Tag>
                </div>
              </div>
              <div style={{ marginBottom: 8 }}>
                <Text type="secondary">{lang === 'en' ? 'Language' : '语言'}</Text>
                <div>
                  <Tag color="blue">{progress.currentLanguage || '-'}</Tag>
                </div>
              </div>
            </Col>
            <Col span={12}>
              <Text type="secondary">{lang === 'en' ? 'Question preview' : '题目预览'}</Text>
              <Paragraph ellipsis={{ rows: 4, expandable: true, symbol: lang === 'en' ? 'Expand' : '展开' }} style={{
                marginTop: 4, padding: 12, background: 'var(--grey-1)', borderRadius: 0,
                fontSize: 13, fontFamily: 'var(--mono)', whiteSpace: 'pre-wrap',
                maxHeight: 120, overflow: 'auto', border: '1px solid var(--border-subtle)',
              }}>
                {progress.currentPromptPreview || (lang === 'en' ? '(No preview)' : '(无预览)')}
              </Paragraph>
            </Col>
          </Row>
          <Divider style={{ margin: '12px 0' }} />
          <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexWrap: 'wrap' }}>
            {EVALUATION_STAGES.map((stage, idx) => {
              const cfg = STAGE_CONFIG[stage];
              const isActive = currentStage === stage;
              const isPassed = EVALUATION_STAGES.indexOf(currentStage) > idx;
              return (
                <div key={stage} style={{ display: 'flex', alignItems: 'center' }}>
                  <Tooltip title={cfg.label[lang]}>
                    <div style={{
                      display: 'flex', alignItems: 'center', gap: 6,
                      padding: '4px 12px', borderRadius: 16, fontSize: 12,
                      fontWeight: isActive ? 600 : 400,
                      background: isActive ? cfg.color + '15' : isPassed ? '#f6ffed' : '#fafafa',
                      border: `1px solid ${isActive ? cfg.color : isPassed ? '#b7eb8f' : '#d9d9d9'}`,
                      color: isActive ? cfg.color : isPassed ? '#52c41a' : '#8c8c8c',
                      transition: 'all 0.3s',
                      ...(isActive ? { boxShadow: `0 0 8px ${cfg.color}40` } : {}),
                    }}>
                      <span style={{ fontSize: 14 }}>{cfg.icon}</span>
                      <span>{cfg.label[lang]}</span>
                    </div>
                  </Tooltip>
                  {idx < EVALUATION_STAGES.length - 1 && (
                    <div style={{ width: 16, height: 2, background: isPassed ? '#52c41a' : '#d9d9d9', margin: '0 2px' }} />
                  )}
                </div>
              );
            })}
          </div>
        </div>
        );
      })()}

      {/* ===== 各维度进度 ===== */}
      <div className="swiss-card" style={{ marginBottom: 16 }}>
        <div className="swiss-card-title">
          <Space>
            <span>{lang === 'en' ? 'Dimension Progress' : '各维度进度'}</span>
            <Tag color="processing">{lang === 'en' ? 'Testing' : '测试中'}</Tag>
            <Tag color="default">{lang === 'en' ? 'Pending' : '待测'}</Tag>
            <Tag color="success">{lang === 'en' ? 'Completed' : '已完成'}</Tag>
          </Space>
        </div>
        {dimProgress.length === 0 ? (
          <Empty description={lang === 'en' ? 'Waiting for data...' : '等待数据...'} />
        ) : (
          <Row gutter={[12, 12]}>
            {dimProgress.map((dim) => {
              const isDimActive = progress?.activeDimensions?.includes(dim.dimension);
              const isCompleted = dim.completed === dim.total && dim.total > 0;
              const isPending = dim.completed === 0 && !isDimActive;
              const isInProgress = isDimActive && !isCompleted;

              // 状态标签
              let statusBadge: React.ReactNode = null;
              if (isCompleted) {
                statusBadge = <Badge status="success" text={lang === 'en' ? 'Completed' : '已完成'} />;
              } else if (isInProgress) {
                statusBadge = <Badge status="processing" text={lang === 'en' ? 'Testing' : '测试中'} />;
              } else if (isPending) {
                statusBadge = <Badge status="default" text={lang === 'en' ? 'Pending' : '待测'} />;
              } else {
                // 部分完成但未激活
                statusBadge = <Badge status="warning" text={`${dim.completed}/${dim.total}`} />;
              }

              return (
              <Col key={dim.dimension} span={6}>
                <div
                  className="swiss-card"
                  style={{
                    borderLeft: `4px solid ${DIMENSION_COLORS[dim.dimension] || 'var(--accent)'}`,
                    background: isDimActive ? 'var(--bg-active)' : isCompleted ? '#f6ffed' : 'var(--bg-card)',
                    padding: 16,
                    opacity: isPending ? 0.7 : 1,
                  }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                    <Text strong style={{ fontSize: 13 }}>
                      {dimLabel(dim.dimension, lang)}
                    </Text>
                    {statusBadge}
                  </div>
                  <Progress
                    percent={dim.total > 0 ? Math.round((dim.completed / dim.total) * 100) : 0}
                    size="small"
                    status={isCompleted ? 'success' : isInProgress ? 'active' : 'normal'}
                    strokeColor={isPending ? '#d9d9d9' : undefined}
                    format={() => `${dim.completed}/${dim.total}`}
                  />
                  <Row gutter={8} style={{ marginTop: 8 }}>
                    <Col span={6}>
                      <Tooltip title={lang === 'en' ? 'Passed' : '通过'}>
                        <Tag color="green" style={{ fontSize: 11 }}>{dim.passed}</Tag>
                      </Tooltip>
                    </Col>
                    <Col span={6}>
                      <Tooltip title={lang === 'en' ? 'Failed' : '失败'}>
                        <Tag color="red" style={{ fontSize: 11 }}>{dim.failed}</Tag>
                      </Tooltip>
                    </Col>
                    <Col span={6}>
                      <Tooltip title={lang === 'en' ? 'Safety red-line' : '安全红线'}>
                        <Tag color={dim.redLine > 0 ? 'red' : 'default'} style={{ fontSize: 11 }}>
                          {dim.redLine > 0 ? <ExclamationCircleOutlined /> : null} {dim.redLine}
                        </Tag>
                      </Tooltip>
                    </Col>
                    <Col span={6}>
                      <Tooltip title={lang === 'en' ? 'Dimension avg' : '维度均分'}>
                        <Text style={{ fontSize: 11, color: dim.completed > 0 ? (dim.avgScore >= 60 ? '#52c41a' : '#f5222d') : '#8c8c8c' }}>
                          {dim.completed > 0 ? (lang === 'en' ? `avg ${dim.avgScore}` : `均${dim.avgScore}`) : '-'}
                        </Text>
                      </Tooltip>
                    </Col>
                  </Row>
                </div>
              </Col>
              );
            })}
          </Row>
        )}
      </div>

      {/* ===== 实时结果表 ===== */}
      <div className="swiss-card">
        <div className="swiss-card-title">{lang === 'en' ? `Real-time Results (${recentResults.length})` : `实时结果（${recentResults.length} 条）`}</div>
        {recentResults.length === 0 ? (
          <Empty description={lang === 'en' ? 'Waiting for results...' : '等待评测结果...'} />
        ) : (
          <Table
            dataSource={recentResults}
            rowKey={(r) => r.scenarioId}
            size="small"
            pagination={{ pageSize: 15, size: 'small' }}
            columns={[
              {
                title: lang === 'en' ? 'Question ID' : '题目 ID', dataIndex: 'scenarioId', key: 'scenarioId', width: 180,
                render: (v: string) => <Text code style={{ fontSize: 12 }}>{v}</Text>,
              },
              {
                title: lang === 'en' ? 'Dimension' : '维度', dataIndex: 'dimension', key: 'dimension', width: 120,
                render: (v: string) => (
                  <Tag color={DIMENSION_COLORS[v] || '#1890ff'}>
                    {dimLabel(v, lang)}
                  </Tag>
                ),
              },
              {
                title: lang === 'en' ? 'Difficulty' : '难度', dataIndex: 'difficulty', key: 'difficulty', width: 70,
                render: (v: string) => (
                  <Tag color={v === 'hard' ? 'red' : v === 'medium' ? 'orange' : 'green'}>
                    {v === 'hard' ? (lang === 'en' ? 'Hard' : '困难') : v === 'medium' ? (lang === 'en' ? 'Medium' : '中等') : (lang === 'en' ? 'Easy' : '简单')}
                  </Tag>
                ),
              },
              {
                title: lang === 'en' ? 'Language' : '语言', dataIndex: 'language', key: 'language', width: 80,
                render: (v: string) => <Tag color="blue">{v}</Tag>,
              },
              {
                title: lang === 'en' ? 'Score' : '分数', dataIndex: 'totalScore', key: 'totalScore', width: 100,
                render: (v: number, r: QuestionLiveResult) => (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                    <Progress
                      type="circle"
                      percent={v}
                      size={32}
                      strokeColor={v >= 80 ? '#52c41a' : v >= 60 ? '#1890ff' : '#f5222d'}
                    />
                    <span style={{ fontWeight: 600, color: v >= 80 ? '#52c41a' : v >= 60 ? '#1890ff' : '#f5222d' }}>
                      {v}
                    </span>
                  </div>
                ),
                sorter: (a: QuestionLiveResult, b: QuestionLiveResult) => a.totalScore - b.totalScore,
              },
              {
                title: lang === 'en' ? 'Safety' : '安全', dataIndex: 'safetyLevel', key: 'safetyLevel', width: 70,
                render: (v: string) => (
                  <Tag color={v === 'red_line' ? 'red' : 'green'}>
                    {v === 'red_line' ? (lang === 'en' ? 'Red-line' : '红线') : (lang === 'en' ? 'Safe' : '安全')}
                  </Tag>
                ),
              },
              {
                title: lang === 'en' ? 'Duration' : '耗时', dataIndex: 'durationMs', key: 'durationMs', width: 80,
                render: (v: number) => v > 1000 ? `${(v / 1000).toFixed(1)}s` : `${v}ms`,
              },
              {
                title: lang === 'en' ? 'Token speed' : 'Token速度', key: 'tokenSpeed', width: 100,
                render: (_: unknown, r: QuestionLiveResult) => {
                  // 优先 LM Studio 原生值，其次服务端预计算 tokenSpeed（流式精确值），最后用 inferenceMs 推算
                  const tps = r.nativeTokensPerSecond
                    || r.tokenSpeed
                    || (r.outputTokens && r.inferenceMs ? Math.round(r.outputTokens / (r.inferenceMs / 1000)) : 0);
                  if (!tps) return '-';
                  return (
                    <Tag color={tps >= 100 ? 'green' : tps >= 30 ? 'blue' : 'orange'} style={{ fontSize: 11 }}>
                      {tps >= 1000 ? `${(tps / 1000).toFixed(1)}K` : tps} t/s
                    </Tag>
                  );
                },
                sorter: (a: QuestionLiveResult, b: QuestionLiveResult) => {
                  const getTps = (r: QuestionLiveResult) => r.nativeTokensPerSecond
                    || r.tokenSpeed
                    || (r.outputTokens && r.inferenceMs ? r.outputTokens / (r.inferenceMs / 1000) : 0);
                  return getTps(a) - getTps(b);
                },
              },
              {
                title: lang === 'en' ? 'Status' : '状态', dataIndex: 'stage', key: 'stage', width: 100,
                render: (v: string, r: QuestionLiveResult) => {
                  if (v === 'completed') return <Tag color="success" icon={<CheckCircleOutlined />}>{lang === 'en' ? 'Passed' : '通过'}</Tag>;
                  if (v === 'reasoning_limit') return (
                    <Tooltip title={r.error || (lang === 'en' ? 'Reasoning/output limit exceeded, scoring interrupted' : '思考/输出超限，已中断判分')}>
                      <Tag color="volcano" icon={<ClockCircleOutlined />}>{lang === 'en' ? 'Reasoning limit' : '思考超限'}</Tag>
                    </Tooltip>
                  );
                  if (v === 'failed') return (
                    <Tooltip title={r.error || (lang === 'en' ? 'Execution failed' : '执行失败')}>
                      <Tag color="error" icon={<CloseCircleOutlined />}>{lang === 'en' ? 'Failed' : '失败'}</Tag>
                    </Tooltip>
                  );
                  return <Tag icon={<LoadingOutlined spin />}>{v}</Tag>;
                },
              },
              {
                title: lang === 'en' ? 'Action' : '操作', key: 'action', width: 80,
                render: (_: unknown, r: QuestionLiveResult) => (
                  <Tooltip title={lang === 'en' ? 'Re-test this question' : '重新测试此题'}>
                    <Button
                      type="text"
                      size="small"
                      icon={<ReloadOutlined spin={retryingIds.includes(r.scenarioId)} />}
                      disabled={retryingIds.length >= 4 && !retryingIds.includes(r.scenarioId)}
                      onClick={() => handleRetry(r.scenarioId)}
                      style={{ color: r.stage === 'failed' ? '#f5222d' : undefined }}
                    />
                  </Tooltip>
                ),
              },
            ]}
          />
        )}
      </div>

      {/* ===== 添加维度并行测试 Modal ===== */}
      <Modal
        title={lang === 'en' ? 'Add dimension to current evaluation' : '添加维度到当前测试'}
        open={forkModalOpen}
        onOk={handleFork}
        onCancel={() => { setForkModalOpen(false); setForkDimensions([]); }}
        confirmLoading={forkLoading}
        okText={lang === 'en' ? 'Add & restart' : '添加并重启测试'}
        cancelText={lang === 'en' ? 'Cancel' : '取消'}
        okButtonProps={{ disabled: forkDimensions.length === 0 }}
        width={520}
      >
        <div style={{ marginBottom: 16 }}>
          <Text type="secondary">
            {lang === 'en'
              ? 'Select dimensions to add. New dimensions merge into the current evaluation, which restarts and resumes from checkpoints (completed questions are not re-run). All results are saved in the same evaluation record.'
              : '选择要添加的维度。新维度将合并到当前测试中，评测会重启并断点续测（已完成的题目不会重跑）。所有结果保存在同一个测试记录中。'}
          </Text>
        </div>

        {/* 汇总：已经在测试的维度 */}
        {(() => {
          const activeInRun = progress?.activeDimensions || [];
          const sibActive = new Set<string>();
          for (const gr of groupRuns) {
            if (gr.id !== id && gr.status === 'running') {
              if (gr.dimensionFilter && gr.dimensionFilter.length > 0) {
                for (const d of gr.dimensionFilter) sibActive.add(d);
              } else {
                const nameParts = gr.name.split('|');
                if (nameParts.length > 1) {
                  const dimNames = nameParts[nameParts.length - 1].trim().split('+');
                  for (const dn of dimNames) {
                    const found = DIMENSION_KEYS.find((k) => dimLabel(k, 'zh') === dn.trim() || dimLabel(k, 'en') === dn.trim());
                    if (found) sibActive.add(found);
                  }
                }
              }
            }
          }
          const allActive = new Set([...activeInRun, ...sibActive]);

          if (allActive.size === 0) return null;

          return (
            <div style={{ marginBottom: 12, padding: '8px 12px', background: '#fff7e6', borderRadius: 4, border: '1px solid #ffd591' }}>
              <Text type="warning" strong style={{ fontSize: 12 }}>
                {lang === 'en' ? 'Already testing (not selectable):' : '已在测试中（不可选）：'}
              </Text>
              <div style={{ marginTop: 4, display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                {[...allActive].map((dim) => (
                  <Tag key={dim} color="orange" style={{ fontSize: 11 }}>
                    {dimLabel(dim, lang)}
                    {activeInRun.includes(dim) ? (lang === 'en' ? ' (this run)' : ' (本运行)') : (lang === 'en' ? ' (parallel run)' : ' (并行运行)')}
                  </Tag>
                ))}
              </div>
            </div>
          );
        })()}

        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {DIMENSION_KEYS
            .map((dim) => {
              const dp = dimProgress.find((d) => d.dimension === dim);
              const isCompleted = dp && dp.completed >= dp.total;

              // 检查是否已在测试中
              const activeInRun = progress?.activeDimensions || [];
              const sibActive = new Set<string>();
              for (const gr of groupRuns) {
                if (gr.id !== id && gr.status === 'running') {
                  // 优先使用 dimensionFilter，回退到名称解析
                  if (gr.dimensionFilter && gr.dimensionFilter.length > 0) {
                    for (const d of gr.dimensionFilter) sibActive.add(d);
                  } else {
                    const nameParts = gr.name.split('|');
                    if (nameParts.length > 1) {
                      const dimNames = nameParts[nameParts.length - 1].trim().split('+');
                      for (const dn of dimNames) {
                        const found = DIMENSION_KEYS.find((k) => dimLabel(k, 'zh') === dn.trim() || dimLabel(k, 'en') === dn.trim());
                        if (found) sibActive.add(found);
                      }
                    }
                  }
                }
              }
              const isAlreadyActive = activeInRun.includes(dim) || sibActive.has(dim);

              if (isCompleted || isAlreadyActive) {
                return (
                  <Checkbox key={dim} checked={false} disabled>
                    <Tag color={DIMENSION_COLORS[dim] || 'blue'} style={{ marginRight: 8, opacity: 0.6 }}>
                      {dimLabel(dim, lang)}
                    </Tag>
                    {isCompleted ? (
                      <Text type="secondary">{lang === 'en' ? `(Completed ${dp!.completed}/${dp!.total})` : `(已完成 ${dp!.completed}/${dp!.total})`}</Text>
                    ) : (
                      <Text type="warning">{lang === 'en' ? '(Already testing, not selectable)' : '(已在测试中，不可选)'}</Text>
                    )}
                  </Checkbox>
                );
              }

              return (
                <Checkbox
                  key={dim}
                  checked={forkDimensions.includes(dim)}
                  onChange={(e) => {
                    if (e.target.checked) {
                      setForkDimensions((prev) => [...prev, dim]);
                    } else {
                      setForkDimensions((prev) => prev.filter((d) => d !== dim));
                    }
                  }}
                >
                  <Tag color={DIMENSION_COLORS[dim] || 'blue'} style={{ marginRight: 8 }}>
                    {dimLabel(dim, lang)}
                  </Tag>
                  {dp ? (
                    <Text type="secondary">{lang === 'en' ? `(${dp.completed}/${dp.total} done, can add)` : `(${dp.completed}/${dp.total} 已完成, 可补充)`}</Text>
                  ) : (
                    <Text type="secondary">{lang === 'en' ? '(Not started)' : '(未开始)'}</Text>
                  )}
                </Checkbox>
              );
            })}
        </div>
      </Modal>
    </div>
  );
}
