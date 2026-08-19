import { createContext, useContext, useState, useEffect, type ReactNode } from 'react';

export type Language = 'zh' | 'en';

interface LanguageContextValue {
  lang: Language;
  setLang: (l: Language) => void;
  t: (key: string) => string;
}

const LanguageContext = createContext<LanguageContextValue>({
  lang: 'zh',
  setLang: () => {},
  t: (k) => k,
});

const STORAGE_KEY = 'zxbench-lang';

const dict: Record<string, { zh: string; en: string }> = {
  // 侧边栏菜单
  'menu.dashboard': { zh: '总览', en: 'Dashboard' },
  'menu.create': { zh: '创建评测', en: 'Create Eval' },
  'menu.live': { zh: '实时监控', en: 'Live Monitor' },
  'menu.history': { zh: '评测历史', en: 'Eval History' },
  'menu.reports': { zh: '评测报告', en: 'Reports' },
  'menu.leaderboard': { zh: '排行榜', en: 'Leaderboard' },
  'menu.scenarios': { zh: '题目管理', en: 'Scenarios' },
  'menu.compare': { zh: '模型对比', en: 'Model Compare' },
  'menu.value': { zh: '模型性价比', en: 'Cost-effectiveness' },
  'menu.settings': { zh: '系统设置', en: 'System Settings' },
  // 通用
  'common.appName': { zh: '智秀大模型评测', en: 'ZxBench · LLM Evaluation' },
  'common.light': { zh: '切换到亮色', en: 'Switch to light' },
  'common.dark': { zh: '切换到暗色', en: 'Switch to dark' },
  'common.save': { zh: '保存', en: 'Save' },
  'common.cancel': { zh: '取消', en: 'Cancel' },
  'common.delete': { zh: '删除', en: 'Delete' },
  'common.edit': { zh: '编辑', en: 'Edit' },
  // 创建评测
  'eval.testMode': { zh: '测试模式', en: 'Test mode' },
  'eval.single': { zh: '单模型（原模式）', en: 'Single model' },
  'eval.batch': { zh: '多模型并行', en: 'Multi-model parallel' },
  'eval.name': { zh: '评测名称', en: 'Evaluation name' },
  'eval.model': { zh: '被测模型', en: 'Model under test' },
  'eval.dimensions': { zh: '评测维度', en: 'Dimensions' },
  'eval.maxTokens': { zh: 'Max Tokens', en: 'Max Tokens' },
  'eval.temperature': { zh: 'Temperature', en: 'Temperature' },
  'eval.runsPerQuestion': { zh: '每题运行次数', en: 'Runs per question' },
  'eval.aiJudge': { zh: 'AI Judge', en: 'AI Judge' },
  'eval.escalation': { zh: '争议升级', en: 'Escalation' },
  'eval.safetyCheck': { zh: '安全红线检查', en: 'Safety red-line' },
  'eval.hiddenTests': { zh: '隐藏测试', en: 'Hidden tests' },
  'eval.structuredOutput': { zh: '结构化输出', en: 'Structured output' },
  'eval.judgeModel': { zh: 'AI Judge 模型', en: 'AI Judge model' },
  'eval.parallelism': { zh: '并发题目数', en: 'Concurrency' },
  'eval.parallelMode': { zh: '并行模式', en: 'Parallel mode' },
  'eval.globalPool': { zh: '全局并发池（轮转交叉）', en: 'Global pool (round-robin)' },
  'eval.perDimension': { zh: '维度独立并行（各维度独立 worker）', en: 'Per-dimension workers' },
  'eval.answerFirst': { zh: '先答案后原因', en: 'Answer first' },
  'eval.maxReasoningTokens': { zh: '思考链上限 (token)', en: 'Reasoning cap (token)' },
  'eval.maxAnswerTokens': { zh: '答案上限 (token)', en: 'Answer cap (token)' },
  'eval.hardTimeLimitSec': { zh: '单题硬时限 (秒)', en: 'Time limit (s)' },
  'eval.onLimit': { zh: '超限处置', en: 'On-limit policy' },
  'eval.onLimit.fail': { zh: '判 0 分', en: 'Fail (score 0)' },
  'eval.onLimit.degrade': { zh: '降权', en: 'Degrade' },
  'eval.onLimit.flag': { zh: '标记人工复核', en: 'Flag for review' },
  'eval.start': { zh: '开始评测', en: 'Start Evaluation' },
  'eval.startBatch': { zh: '开始并行评测', en: 'Start Parallel' },
  'eval.advanced': { zh: '高级选项', en: 'Advanced' },
  'eval.constraints': { zh: '思考约束（反拖尾）', en: 'Reasoning constraints (anti-tailspin)' },
  // 模型配置
  'model.title': { zh: '模型配置', en: 'Model Config' },
  'model.add': { zh: '添加模型', en: 'Add model' },
  'model.id': { zh: '模型 ID', en: 'Model ID' },
  'model.displayName': { zh: '模型名称（可选）', en: 'Display name (optional)' },
  'model.type': { zh: '模型类型', en: 'Model type' },
  'model.tested': { zh: '被测模型（参与评测的模型）', en: 'Tested model' },
  'model.judge': { zh: 'AI Judge（评分复核模型）', en: 'AI Judge (re-scorer)' },
  'model.provider': { zh: 'Provider', en: 'Provider' },
  'model.baseUrl': { zh: 'Base URL', en: 'Base URL' },
  'model.apiKey': { zh: 'API Key', en: 'API Key' },
  'model.reasoning': { zh: '推理模型', en: 'Reasoning model' },
  'model.testConn': { zh: '测试连接', en: 'Test connection' },
  'model.testedList': { zh: '被测模型', en: 'Tested models' },
  'model.judgeList': { zh: 'AI Judge 模型', en: 'AI Judge models' },
  // 报告
  'report.generate': { zh: '生成 AI 报告', en: 'Generate AI report' },
  'report.regenerate': { zh: '重新生成', en: 'Regenerate' },
  'report.generating': { zh: '生成中...', en: 'Generating...' },
  'report.title': { zh: '评测报告', en: 'Evaluation Report' },
  'report.back': { zh: '返回', en: 'Back' },
  'report.compositeScore': { zh: '综合分', en: 'Composite Score' },
  'report.passRate': { zh: '通过率', en: 'Pass Rate' },
  'report.radarTitle': { zh: '维度雷达图', en: 'Dimension Radar' },
  'report.rankTitle': { zh: '维度排名', en: 'Dimension Ranking' },
  'report.distTitle': { zh: '分数分布', en: 'Score Distribution' },
};

export function LanguageProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Language>(() => {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === 'en' || saved === 'zh') return saved;
    return 'zh';
  });

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, lang);
    document.documentElement.setAttribute('lang', lang);
  }, [lang]);

  const setLang = (l: Language) => setLangState(l);
  const t = (key: string) => dict[key]?.[lang] ?? key;

  return (
    <LanguageContext.Provider value={{ lang, setLang, t }}>
      {children}
    </LanguageContext.Provider>
  );
}

export function useLanguage() {
  return useContext(LanguageContext);
}

/** 维度名 → 中英文标签（全站图表统一使用） */
export const DIMENSION_LABELS: Record<string, { zh: string; en: string }> = {
  program: { zh: '编程能力', en: 'Programming' },
  reasoning_math: { zh: '推理与数学', en: 'Reasoning & Math' },
  hallucination_resistance: { zh: '幻觉抵抗', en: 'Hallucination Resistance' },
  instruction_following: { zh: '指令遵循', en: 'Instruction Following' },
  safety_authority: { zh: '安全权限', en: 'Safety & Authority' },
  agent_workflow: { zh: '智能体工作流', en: 'Agent Workflow' },
  tool_cli_workflow: { zh: '工具/CLI', en: 'Tool/CLI Workflow' },
  data_extraction: { zh: '数据抽取', en: 'Data Extraction' },
  cli_deep_tasks: { zh: '深度命令行', en: 'Deep CLI Tasks' },
  structured_output: { zh: '结构化输出', en: 'Structured Output' },
};

export function dimLabel(dim: string, lang: 'zh' | 'en'): string {
  return DIMENSION_LABELS[dim]?.[lang] ?? dim;
}
