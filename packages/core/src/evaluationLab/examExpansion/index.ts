/** Opt-in development paper. Frozen pilot and production scores stay separate. */
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { snapshotHash } from '../../contracts/pack.js';
import { committedItems, quoteLongIntegerLiterals, type ExamSubmission, type ExamAnswer } from '../examPaper/index.js';
import { parseExactExpression } from '../frontierChallenge/annihilatingMaps.js';
import { verifyLinearOptimization, type LinearOptimization } from '../linearOptimizationCertificate.js';
import { exactKeys, rational, add, mul, type Rational } from '../challengeTypes.js';

type FlowProblem = { n: number; edges: number[][] };
type AssignmentProblem = { cost: number[][]; banned: number[][] };
type MomentProblem = { support: number[]; moments: number[]; objective: number[] };
export type Item = { key: string; points: number; kind: 'exact'; expected: unknown }
  | { key: string; points: number; kind: 'lp'; problem: LinearOptimization; reference: unknown }
  | { key: string; points: number; kind: 'flow'; problem: FlowProblem; reference: unknown }
  | { key: string; points: number; kind: 'assignment'; problem: AssignmentProblem; reference: unknown }
  | { key: string; points: number; kind: 'moment'; problem: MomentProblem; reference: unknown };
type Group = { id: string; family: string; title: string; stem: string; capstoneChange: string; difficultyRisk: string; parts: { task: string; items: Item[] }[] };
export type Submission = ExamSubmission;
// 用 readFileSync 而非 `import ... with { type: 'json' }`（2026-09-16）：
// Node 26 对 JSON 模块强制要求 import attribute，若产物（dist）由不会输出该 attribute 的
// 构建/旧 tsc 生成，会在启动时抛 ERR_IMPORT_ATTRIBUTE_MISSING——实测曾导致 watchdog 连续
// 3 次启动失败后放弃重启，整个 run 转由非托管进程执行且日志全丢（R2）。
// 显式读文件与 Node 版本、构建产物、模块系统解耦；路径基于 import.meta.url，
// 在 src（vitest）与 dist（node）下都成立。
const PAPER_SOURCE_URL = new URL('./math-candidates.json', import.meta.url);
type PaperSource = { version: string; points: number[]; hardSeconds: number[]; groups: Group[] };

// 2026-09-16（R3）：**按文件内容自动重载**，不再在模块加载时固化一份快照。
// 事故背景：改完 math-candidates.json 只重新播种、没重启服务时，题面来自题库（新）、
// 评分项 key 来自内存里的旧评卷表（旧）→ 模型提交新 key 被判「未知评分项」→
// **静默 0 分且不报错**，实测一次回归因此得出「5/12 题 0 分」的假结论。
// 现在每次读取都校验 sha256：内容一变就重读，进程内不再可能持有过期评卷表。
let cachedSource: PaperSource | null = null;
let cachedIdentity = '';

export function loadPaperSource(): { source: PaperSource; identity: string } {
  const raw = readFileSync(PAPER_SOURCE_URL, 'utf8');
  const identity = createHash('sha256').update(raw).digest('hex').slice(0, 16);
  if (cachedSource === null || identity !== cachedIdentity) {
    cachedSource = JSON.parse(raw) as PaperSource;
    cachedIdentity = identity;
  }
  return { source: cachedSource, identity };
}

/** 当前已加载评卷表的内容指纹（供 /api/health 与判分守卫核对）。 */
export function paperSourceIdentity(): string {
  return loadPaperSource().identity;
}

/** 当前已加载评卷表声明的版本号（math-candidates.json 的 version 字段）。 */
export function paperSourceVersion(): string {
  return loadPaperSource().source.version;
}
const eq = (a: Rational, b: Rational) => a[0] === b[0] && a[1] === b[1];
const le = (a: Rational, b: Rational) => a[0] * b[1] <= b[0] * a[1];
const q = (n: number) => rational(BigInt(n));
const sum = (v: Rational[]) => v.reduce(add, q(0));
const dot = (a: Rational[], b: Rational[]) => sum(a.map((v, i) => mul(v, b[i])));
function normalizeCertificate(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeCertificate);
  if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, normalizeCertificate(v)]));
  const n = parseExactExpression(value);
  return n ? (n[1] === 1n ? String(n[0]) : `${n[0]}/${n[1]}`) : value;
}
function vector(a: unknown, n: number): Rational[] | null {
  if (!Array.isArray(a) || a.length !== n) return null;
  const v = a.map(parseExactExpression);
  return v.every(x => x !== null) ? v as Rational[] : null;
}
function integers(a: unknown, n: number): number[] | null {
  const v = vector(a, n);
  return v && v.every(x => x[1] === 1n && x[0] >= -1000000n && x[0] <= 1000000n) ? v.map(x => Number(x[0])) : null;
}

/** Numeric equivalence in structured answers; labels and booleans remain exact. */
export function exactAnswer(expected: unknown, answer: unknown): boolean {
  if (Array.isArray(expected)) return Array.isArray(answer) && answer.length === expected.length && expected.every((e, i) => exactAnswer(e, answer[i]));
  if (expected !== null && typeof expected === 'object') {
    const e = expected as Record<string, unknown>;
    return exactKeys(answer, Object.keys(e)) && Object.keys(e).every(k => exactAnswer(e[k], answer[k]));
  }
  const value = parseExactExpression(expected);
  if (value) { const a = parseExactExpression(answer); return !!a && eq(a, value); }
  return answer === expected;
}

/** Accept any valid certificate, never only the answer-key witness. */
export function validCertificate(item: Exclude<Item, { kind: 'exact' }>, answer: unknown): boolean {
  try {
    if (item.kind === 'lp') return verifyLinearOptimization(item.problem, normalizeCertificate(answer)).pass;
    if (item.kind === 'flow') {
      if (!exactKeys(answer, ['flow', 'cut', 'value'])) return false;
      const { n, edges } = item.problem, f = integers(answer.flow, edges.length), value = parseExactExpression(answer.value);
      if (!Array.isArray(answer.cut) || answer.cut.length > n) return false;
      const cut = integers(answer.cut, answer.cut.length);
      if (!f || !value || !cut || new Set(cut).size !== cut.length || cut.some(v => v < 0 || v >= n) || !cut.includes(0) || cut.includes(n - 1)) return false;
      const balance = Array(n).fill(0) as number[];
      for (let i = 0; i < edges.length; i++) {
        const [u, v, cap] = edges[i];
        if (f[i] < 0 || f[i] > cap) return false;
        balance[u] += f[i]; balance[v] -= f[i];
      }
      const capacity = edges.reduce((s, [u, v, c]) => s + (cut.includes(u) && !cut.includes(v) ? c : 0), 0);
      return balance.slice(1, -1).every(v => v === 0) && balance[0] === -balance[n - 1] && balance[0] === capacity && eq(value, q(capacity));
    }
    if (item.kind === 'assignment') {
      if (!exactKeys(answer, ['permutation', 'u', 'v', 'value'])) return false;
      const { cost, banned } = item.problem, n = cost.length;
      const p = integers(answer.permutation, n), u = vector(answer.u, n), v = vector(answer.v, n), value = parseExactExpression(answer.value);
      if (!p || !u || !v || !value || new Set(p).size !== n || p.some(j => j < 0 || j >= n)) return false;
      const forbidden = (i: number, j: number) => banned.some(([a, b]) => a === i && b === j);
      return !p.some((j, i) => forbidden(i, j)) && cost.every((row, i) => row.every((c, j) => forbidden(i, j) || le(add(u[i], v[j]), q(c)))) &&
        eq(value, q(p.reduce((s, j, i) => s + cost[i][j], 0))) && eq(value, add(sum(u), sum(v)));
    }
    if (!exactKeys(answer, ['weights', 'dual', 'value'])) return false;
    const { support, moments, objective } = item.problem;
    const w = vector(answer.weights, support.length), y = vector(answer.dual, moments.length), value = parseExactExpression(answer.value);
    if (!w || !y || !value || w.some(v => v[0] < 0n)) return false;
    return moments.every((m, k) => eq(dot(support.map(x => q(x ** k)), w), q(m))) &&
      support.every((x, i) => le(q(objective[i]), dot(y, moments.map((_, k) => q(x ** k))))) &&
      eq(value, dot(w, objective.map(q))) && eq(value, dot(y, moments.map(q)));
  } catch { return false; }
}

export function buildExamPaper(options?: { groupIds?: string[] }) {
  const { source, identity } = loadPaperSource();
  const groups = source.groups;
  const groupIds = options?.groupIds ?? groups.map(g => g.id);
  if (!Array.isArray(groupIds) || !groupIds.length || new Set(groupIds).size !== groupIds.length || groupIds.some(id => !groups.some(g => g.id === id))) throw new Error('Unknown/duplicate/empty group selection');
  const selected = groups.filter(g => groupIds.includes(g.id)); // canonical order
  const policy = { version: source.version, primary: 'timed_exam_points', pointsPerGroup: 100, partPoints: source.points,
    hardSecondsPerPart: source.hardSeconds, partsSubmittedSeparately: true, carryPreviousSubmittedContent: true,
    answerFeedback: false, tools: false, judgeCalls: 0, automaticRetries: 0, maxModelCallsAcrossAllExports: 16,
    maxGroupsPerScreeningRun: 2, productionEligible: false, difficultyCalibrated: false,
    scoringScope: 'exact_structured_answers_and_checked_certificates', difficultyOrder: 'design_intent_not_measured' };
  const parts = selected.flatMap(g => g.parts.map((p, i) => {
    const id = `${g.id}-P${i + 1}`, hardSeconds = source.hardSeconds[i], points = p.items.reduce((s, x) => s + x.points, 0);
    const prompt = `数学大题「${g.title}」，第${i + 1}/4问，${points}分，时限${hardSeconds}秒。\n共同题干：${g.stem}\n本问：${p.task}\n` +
      `评分项：${p.items.map(x => `${x.key}(${x.points}分)`).join('、')}。每项单独提交完整JSON：{"item":"评分项编号","answer":答案}。` +
      '可逐项提交和修订；最后一条完整记录为准。超时、截断保留完整提交项的得分，未完成项0分；前问得分不受影响。每项原分值中数学内容占90%、规范提交占10%；规范提交且正确可得该项全分。完整合并JSON对象中可明确识别的正确评分项获得90%的该项分值，错误项0分，不补全截断对象。数值可提交精确整数、分数或仅用整数及+-*/^括号的表达式字符串。不要提交代码，不使用外部工具。';
    const question = { id, dimension: 'reasoning_math' as const, messages: [{ role: 'user' as const, content: prompt }] };
    return { id, groupId: g.id, family: g.family, number: i + 1, points, hardSeconds, items: p.items,
      question: { ...question, questionHash: snapshotHash(question) } };
  }));
  const canonicalOptions = { groupIds: selected.map(g => g.id) };
  return { options: canonicalOptions, policy, sourceIdentity: identity, groups: selected.map(({ parts: _, stem: __, ...g }) => g), parts,
    questions: parts.map(p => p.question), contractHash: snapshotHash({ options: canonicalOptions, policy, parts }) };
}
export type ExamPaper = ReturnType<typeof buildExamPaper>;
export function assertExamPaper(p: ExamPaper) {
  if (!p || snapshotHash(p) !== snapshotHash(buildExamPaper(p.options))) throw new Error('Candidate paper mismatch');
}
export function referenceOutput(part: ExamPaper['parts'][number]) {
  return part.items.map(i => JSON.stringify({ item: i.key, answer: i.kind === 'exact' ? i.expected : i.reference })).join('\n');
}
export function gradePart(part: ExamPaper['parts'][number], output: string) {
  const parsed = committedItems(output, part.items.map(i => i.key));
  const items = part.items.map(i => {
    const submitted = parsed.items.has(i.key), a = parsed.items.get(i.key);
    const correct = submitted && (i.kind === 'exact' ? exactAnswer(i.expected, a) : validCertificate(i, a));
    return { key: i.key, points: i.points, submitted, correct, earned: correct ? i.points : 0 };
  });
  return { items, points: part.points, earned: items.reduce((s, i) => s + i.earned, 0),
    acceptedRecords: parsed.accepted, rejectedRecords: parsed.rejected, incompleteTail: parsed.incompleteTail, overflow: parsed.overflow };
}
/** Content credit for one complete combined object; canonical item records keep full points.
 * Only recognized keys and exact values count. Never guess a truncated record.
 */
export function gradeReviewedMathPart(part: ExamPaper['parts'][number], output: string) {
  const original=gradePart(part,output);
  const text=output.trim().replace(/^```(?:json)?\s*|\s*```$/g,'');
  if(!text||text.length>2_000_000)return {...original,contentEarned:original.earned,protocolValid:original.rejectedRecords===0&&!original.incompleteTail};
  let combined:unknown;
  try{combined=JSON.parse(quoteLongIntegerLiterals(text));}catch{return {...original,contentEarned:original.earned,protocolValid:original.rejectedRecords===0&&!original.incompleteTail};}
  if(!combined||typeof combined!=='object'||Array.isArray(combined)
    ||!Object.keys(combined).length||Object.keys(combined).some(k=>!part.items.some(i=>i.key===k)))
    return {...original,contentEarned:original.earned,protocolValid:original.rejectedRecords===0&&!original.incompleteTail};
  const records=Object.entries(combined).map(([item,answer])=>JSON.stringify({item,answer})).join('\n');
  const content=gradePart(part,records);
  return {...content,earned:content.earned*.9,contentEarned:content.earned,protocolValid:false};
}
export function scoreExam(paper: ExamPaper, input: Submission) {
  assertExamPaper(paper);
  if (!input || input.contractHash !== paper.contractHash || !Array.isArray(input.answers) || [input.runId, input.modelId, input.modelFamily].some(x => typeof x !== 'string' || !x.trim())) throw new Error('Invalid submission');
  const seen = new Set<string>();
  for (const a of input.answers) {
    if (!exactKeys(a, ['id', 'questionHash', 'outcome', 'output']) || seen.has(a.id) || typeof a.output !== 'string' ||
      !['completed', 'truncated', 'timeout', 'environment_error'].includes(a.outcome) || !paper.parts.some(p => p.id === a.id && p.question.questionHash === a.questionHash)) throw new Error('Unknown/duplicate/stale answer');
    seen.add(a.id);
  }
  const rows = paper.parts.map(p => {
    const a = input.answers.find(a => a.id === p.id);
    return { id: p.id, groupId: p.groupId, number: p.number, hardSeconds: p.hardSeconds, state: a?.outcome ?? 'not_attempted', ...gradeReviewedMathPart(p, a?.output ?? '') };
  });
  const scores = paper.groups.map(g => {
    const r = rows.filter(r => r.groupId === g.id), earned = r.reduce((s, x) => s + x.earned, 0), points = r.reduce((s, x) => s + x.points, 0);
    const comparable = r.every(x => !['not_attempted', 'environment_error'].includes(x.state));
    return { groupId: g.id, earned, points, comparable, score: comparable ? 100 * earned / points : null };
  });
  const earned = scores.reduce((s, x) => s + x.earned, 0), points = scores.reduce((s, x) => s + x.points, 0), comparable = scores.every(x => x.comparable);
  return { contractHash: paper.contractHash, modelId: input.modelId, modelFamily: input.modelFamily, rows, groups: scores, earned, points,
    score: comparable ? 100 * earned / points : null, comparable, productionEligible: false, difficultyCalibrated: false };
}
export function examMessages(paper: ExamPaper, part: ExamPaper['parts'][number], answers: ExamAnswer[]) {
  const messages: { role: 'user' | 'assistant'; content: string }[] = [];
  for (const p of paper.parts.filter(p => p.groupId === part.groupId && p.number < part.number)) {
    const a = answers.find(a => a.id === p.id);
    if (!a || a.outcome === 'environment_error') continue;
    const committed = committedItems(a.output, p.items.map(i => i.key));
    messages.push(...p.question.messages, { role: 'assistant', content: committed.items.size
      ? [...committed.items].map(([item, answer]) => JSON.stringify({ item, answer })).join('\n') : '本问未提交完整答案。' });
  }
  messages.push(...part.question.messages); return messages;
}
