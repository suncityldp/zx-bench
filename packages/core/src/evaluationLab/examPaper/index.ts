import { snapshotHash } from '../../contracts/pack.js';
import { exactKeys, numericEqual } from '../challengeTypes.js';
import { parseAnswer } from '../methodsV2/verify.js';
import { buildOptimization, feasible, objective, solveOptimization, type Optimization } from '../frontierChallenge/optimization.js';
import { bits, bitMask } from '../frontierChallenge/types.js';
import { countMaps, parseExactExpression, type MapsProblem } from '../frontierChallenge/annihilatingMaps.js';

export const EXAM_VERSION = 'progressive-math-exam-2026-09-14-v1';
type Item = { key: string; points: number; kind: 'exact'; expected: number | boolean | string }
  | { key: string; points: number; kind: 'feasible' | 'targets' | 'optimum'; problem: Optimization; targets?: number[] };
export interface Part {
  id: string; groupId: string; number: number; points: number; hardSeconds: number;
  title: string; stem: string; task: string; items: Item[];
  question: { id: string; dimension: 'reasoning_math'; messages: { role: 'user'; content: string }[]; questionHash: string };
}
const outputPolicy = `每个评分项单独提交一个完整JSON对象：{"item":"评分项编号","answer":答案}。可逐项提交，不必等整问做完。修改同一项时最后一条完整记录为准；内容错误的完整修订也会覆盖旧答案，不完整尾部不覆盖。不要输出整份数组。数值可用精确整数或只含整数、括号、+ - * / ^的精确表达式字符串，指数0至1000。构造解用{"value":整数,"x":[0或1,...]}作为answer。只根据已提交答案评分，不根据思考过程猜测答案；不使用外部工具。`;

function makePart(groupId: string, number: number, title: string, stem: string, task: string, items: Item[]): Part {
  const points = items.reduce((s, i) => s + i.points, 0);
  const hardSeconds = [180, 360, 1200, 1200][number - 1];
  const id = `${groupId}-P${number}`;
  const prompt = `学校试卷式数学大题，第${number}/4问「${title}」，本问${points}分，时间上限${hardSeconds}秒。前面已提交的分数不受本问是否完成影响；上一问答错或未答也可继续本问。\n共同题干：${stem}\n本问：${task}\n评分项：${items.map(i => `${i.key}(${i.points}分)`).join('、')}。\n${outputPolicy}`;
  const q = { id, dimension: 'reasoning_math' as const, messages: [{ role: 'user' as const, content: prompt }] };
  return { id, groupId, number, points, hardSeconds, title, stem, task, items, question: { ...q, questionHash: snapshotHash(q) } };
}

export function buildExamPaper(options = { seed: 20260915 }) {
  if (!Number.isInteger(options.seed) || options.seed < 0 || options.seed > 0x7fffffff) throw new Error('Invalid seed');
  const p = buildOptimization(options.seed, 1).problem as Optimization;
  const gold = solveOptimization(p);
  if (gold.value <= 0) throw new Error('Positive optimum required for this paper');
  const targets = [.60, .80, .95].map(ratio => Math.ceil(gold.value * ratio));
  const givenMask = (options.seed * 17) & (2 ** p.n - 1), given = bits(givenMask, p.n);
  const stem = `x为${p.n}维0/1向量，编号从0开始。最大化 F(x)=Σbias[i]x[i]+Σedges中的w·(x[i] XOR x[j])；每条边只计一次。所有约束同时满足才可行：所选个数在[minSelected,maxSelected]内，Σcosts[i]x[i]≤budget，每组parityGroups选中个数模2等于parity，每条requires=[i,j]要求x[i]≤x[j]。数据：${JSON.stringify(p)}`;
  const optimizationId = 'EX-O-' + snapshotHash({ version: EXAM_VERSION, p }).slice(0, 12);
  const parts = [
    makePart(optimizationId, 1, '代入与约束检查', stem, `给定x=${JSON.stringify(given)}。分别提交value=目标值、cost=总费用、selected=选中个数、feasible=是否满足全部约束(boolean)。`, [
      { key: 'value', kind: 'exact', points: 2.5, expected: objective(p, givenMask) },
      { key: 'cost', kind: 'exact', points: 2.5, expected: given.reduce((s, v, i) => s + v * p.costs[i], 0) },
      { key: 'selected', kind: 'exact', points: 2.5, expected: given.filter(Boolean).length },
      { key: 'feasible', kind: 'exact', points: 2.5, expected: feasible(p, givenMask) },
    ]),
    makePart(optimizationId, 2, '构造可行解', stem, '自行构造一个满足全部约束的x，提交solution及其准确目标值。可行向量15分，准确目标值5分；目标值分须同时满足可行性。', [
      { key: 'solution', kind: 'feasible', points: 20, problem: p },
    ]),
    makePart(optimizationId, 3, '逐级改进', stem, `构造满足全部约束的解，尽可能提高目标值。提交solution及准确目标值；达到${targets.join('、')}各获10分，累计最高30分。只需提交当前最好的一个解，允许改进后修订；无需证明全局最优。`, [
      { key: 'solution', kind: 'targets', points: 30, problem: p, targets },
    ]),
    makePart(optimizationId, 4, '求全局最优', stem, '提交solution：全局最大值及达到该值的可行向量。两者均正确获40分；近似解的分数已由前问衡量。本問未完成不会扣除前问所得分数。', [
      { key: 'solution', kind: 'optimum', points: 40, problem: p },
    ]),
  ];
  const mapStem = 'V是F₂上的七维向量空间。考虑有序线性算子对(A,B)，A²=B²=AB=BA=0，rank(A)=rank(B)=2。不同线性映射分别计数，不按换基或共轭取商。每问的像交集、核及和算子秩条件以该问为准。';
  const mapId = 'EX-M-' + snapshotHash({ version: EXAM_VERSION, mapStem }).slice(0, 12);
  const problem = (intersection: number, kernels: MapsProblem['kernels'] = 'unrestricted', sumRank?: number): MapsProblem => ({ n: 7, q: 2, r: 2, s: 2, intersection, kernels, ...(sumRank === undefined ? {} : { sumRank }) });
  parts.push(
    makePart(mapId, 1, '结构识别', mapStem, '设dim(im A∩im B)=1，S=im A+im B。提交d=dim(S)、m=dim(V/S)，以及annihilated=A和B是否都在S上恒为0(boolean)。', [
      { key: 'd', kind: 'exact', points: 3, expected: 3 }, { key: 'm', kind: 'exact', points: 3, expected: 4 },
      { key: 'annihilated', kind: 'exact', points: 4, expected: true },
    ]),
    makePart(mapId, 2, '无核限制的计数', mapStem, '设dim(im A∩im B)=0，不限制两核相同或不同。提交count=算子对总数。', [
      { key: 'count', kind: 'exact', points: 20, expected: countMaps(problem(0)).toString() },
    ]),
    makePart(mapId, 3, '叠加秩条件', mapStem, '设dim(im A∩im B)=1，额外要求rank(A+B)=2，不限制两核相同或不同。提交count=算子对总数。', [
      { key: 'count', kind: 'exact', points: 30, expected: countMaps(problem(1, 'unrestricted', 2)).toString() },
    ]),
    makePart(mapId, 4, '完整分类计数', mapStem, '设dim(im A∩im B)=1。分别按核相同(equal)与核不同(different)，求rank(A+B)为1、2、3的各类算子对数，提交equal_1、equal_2、equal_3、different_1、different_2、different_3。六项独立评分，其中equal_3为5分，其余每项7分。',
      (['equal', 'different'] as const).flatMap(kernels => [1, 2, 3].map(sumRank => ({ key: `${kernels}_${sumRank}`, kind: 'exact' as const,
        points: kernels === 'equal' && sumRank === 3 ? 5 : 7, expected: countMaps(problem(1, kernels, sumRank)).toString() })))),
  );
  const policy = { version: EXAM_VERSION, primary: 'timed_exam_points', pointsPerGroup: 100, partPoints: [10, 20, 30, 40],
    hardSecondsPerPart: [180, 360, 1200, 1200], highestPartTimeoutSeconds: 1200, partsSubmittedSeparately: true,
    carryPreviousSubmittedContent: true, answerFeedback: false, revisions: 'last_complete_item_record_wins',
    timeoutAndTruncation: 'grade_committed_items_keep_previous_points_missing_items_zero',
    environmentFailure: 'retain_earned_points_but_invalidate_comparable_total',
    difficultyOrder: 'intended_progression_not_yet_empirically_calibrated', tools: false, judgeCalls: 0,
    productionEligible: false, difficultyCalibrated: false };
  return { options, policy, parts, questions: parts.map(p => p.question), contractHash: snapshotHash({ options, policy, parts }) };
}
export type ExamPaper = ReturnType<typeof buildExamPaper>;
export function assertExamPaper(p: ExamPaper) { if (snapshotHash(p) !== snapshotHash(buildExamPaper(p.options))) throw new Error('Frozen exam paper mismatch'); }

/** Commit complete top-level JSON records; never close or guess a cut-off object. */
/**
 * 题面把评分项印成 `key(points分)`（见 examExpansion 的 `评分项：A_20(10分)、…`），
 * 而提交格式只说明 item 填「评分项编号」——模型照抄带分值后缀的标签是对该指令的
 * 合理理解。分值后缀属于题面排版、不属于答案内容，因此在匹配前剥掉，否则
 * 答案正确却因为标签多了「(10分)」被判 rejected（实测 MX3-16-P1：answer=627 正确，
 * item 写作 `A_20(10分)` → 0 分；同一题写 `A_20` → 100 分）。
 */
function normalizeItemKey(value: string): string {
  return value.trim().replace(/[（(]\s*\d+\s*分\s*[)）]\s*$/, '').trim();
}

/**
 * 保护超过 2^53−1 的整数字面量。
 *
 * 题面明确允许「数字可用数值或精确等价数字字符串」提交，但 JSON.parse 会先把它
 * 变成 double：实测模型提交 `{"item":"c30","answer":9221519018813407615}`，
 * 与 gold 完全相同，却在解析后变成 ...616，被 parseExactExpression 判为不等 → 0 分。
 * 这是评分器造成的假阴性（与能力无关），且会命中所有答案超过 16 位的题
 * （如 MX3-13-P2 的 24 位生成树数、MX3-16-P3 的 p(2000)）。
 *
 * 修法：在 JSON.parse 之前，把「字符串字面量之外的、整数位 ≥16 且后面不是
 * `.`/`e`」的整数用引号包起来，让它以字符串形态进入精确表达式解析。
 */
export function quoteLongIntegerLiterals(text: string): string {
  let out = '', inString = false, escaped = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      out += ch;
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; out += ch; continue; }
    if (ch === '-' || (ch >= '0' && ch <= '9')) {
      const match = /^-?\d+/.exec(text.slice(i));
      if (match && match[0].replace('-', '').length >= 16 && !/^[.eE]/.test(text.slice(i + match[0].length))) {
        out += `"${match[0]}"`;
        i += match[0].length - 1;
        continue;
      }
    }
    out += ch;
  }
  return out;
}

export function committedItems(content: string, allowed: string[]) {
  const items = new Map<string, unknown>(); let start = -1, depth = 0, quoted = false, escape = false, accepted = 0, rejected = 0;
  const overflow = content.length > 2_000_000;
  content = content.slice(0, 2_000_000);
  for (let i = 0; i < content.length; i++) {
    const ch = content[i];
    if (start < 0) { if (ch !== '{') continue; start = i; depth = 1; quoted = false; escape = false; continue; }
    if (quoted) { if (escape) escape = false; else if (ch === '\\') escape = true; else if (ch === '"') quoted = false; continue; }
    if (ch === '"') quoted = true; else if (ch === '{') depth++; else if (ch === '}' && --depth === 0) {
      try {
        const record = parseAnswer(quoteLongIntegerLiterals(content.slice(start, i + 1)));
        const key = typeof (record as { item?: unknown }).item === 'string'
          ? normalizeItemKey((record as { item: string }).item) : '';
        if (exactKeys(record, ['item', 'answer']) && key && allowed.includes(key)) { items.set(key, record.answer); accepted++; }
        else rejected++;
      } catch { rejected++; }
      start = -1;
    }
  }
  return { items, accepted, rejected, incompleteTail: start >= 0, overflow };
}

function gradeItem(item: Item, answer: unknown) {
  if (item.kind === 'exact') {
    const value = parseExactExpression(answer);
    const correct = typeof item.expected === 'boolean' ? answer === item.expected : !!value && value[1] === 1n && value[0] === BigInt(item.expected);
    return { earned: correct ? item.points : 0, correct };
  }
  const solution = exactKeys(answer, ['x', 'value']) ? answer : null;
  const mask = solution ? bitMask(solution.x, item.problem.n) : null;
  const valid = mask !== null && feasible(item.problem, mask);
  const value = mask === null ? null : objective(item.problem, mask);
  const consistent = value !== null && numericEqual(solution?.value, value);
  const gold = solveOptimization(item.problem), gap = valid ? gold.value - value! : null;
  const earned = item.kind === 'feasible' ? valid ? (consistent ? item.points : item.points * .75) : 0
    : !valid || !consistent ? 0 : item.kind === 'targets' ? item.points * item.targets!.filter(t => value! >= t).length / item.targets!.length
      : value === gold.value ? item.points : 0;
  return { earned, correct: earned === item.points, feasible: valid, valueConsistent: consistent, objective: value, optimum: gold.value, gap };
}

export type Outcome = 'completed' | 'timeout' | 'truncated' | 'environment_error';
export interface ExamAnswer { id: string; questionHash: string; outcome: Outcome; output: string }
export interface ExamSubmission { contractHash: string; runId: string; modelId: string; modelFamily: string; answers: ExamAnswer[] }
export function gradePart(part: Part, output: string) {
  const parsed = committedItems(output, part.items.map(i => i.key));
  const items = part.items.map(item => ({ key: item.key, points: item.points, submitted: parsed.items.has(item.key),
    ...(parsed.items.has(item.key) ? gradeItem(item, parsed.items.get(item.key)) : { earned: 0, correct: false }) }));
  return { earned: items.reduce((s, i) => s + i.earned, 0), points: part.points, items,
    acceptedRecords: parsed.accepted, rejectedRecords: parsed.rejected, incompleteTail: parsed.incompleteTail, overflow: parsed.overflow };
}
export function scoreExam(paper: ExamPaper, input: ExamSubmission) {
  assertExamPaper(paper);
  if (!input || input.contractHash !== paper.contractHash || !Array.isArray(input.answers) || [input.runId, input.modelId, input.modelFamily].some(s => typeof s !== 'string' || !s.trim())) throw new Error('Invalid exam submission');
  const seen = new Set<string>();
  for (const answer of input.answers) {
    if (!exactKeys(answer, ['id', 'questionHash', 'outcome', 'output']) || seen.has(answer.id) || typeof answer.output !== 'string' ||
      !['completed', 'timeout', 'truncated', 'environment_error'].includes(answer.outcome) || !paper.parts.some(p => p.id === answer.id && p.question.questionHash === answer.questionHash)) throw new Error('Unknown/duplicate/stale exam answer');
    seen.add(answer.id);
  }
  const rows = paper.parts.map(part => {
    const a = input.answers.find(a => a.id === part.id);
    return { id: part.id, groupId: part.groupId, number: part.number, hardSeconds: part.hardSeconds,
      state: a?.outcome ?? 'not_attempted', ...gradePart(part, a?.output ?? '') };
  });
  const groups = [...new Set(rows.map(r => r.groupId))].map(groupId => {
    const parts = rows.filter(r => r.groupId === groupId), comparable = parts.every(p => !['not_attempted', 'environment_error'].includes(p.state));
    const earned = parts.reduce((s, p) => s + p.earned, 0), points = parts.reduce((s, p) => s + p.points, 0);
    return { groupId, earned, points, score: comparable ? 100 * earned / points : null, comparable };
  });
  const earned = rows.reduce((s, r) => s + r.earned, 0), points = rows.reduce((s, r) => s + r.points, 0), comparable = groups.every(g => g.comparable);
  return { version: EXAM_VERSION, contractHash: paper.contractHash, modelId: input.modelId, modelFamily: input.modelFamily, rows, groups,
    earned, points, score: comparable ? 100 * earned / points : null, comparable, productionEligible: false, difficultyCalibrated: false };
}

/** Same-group submitted content only; no gold, scores, or hidden reasoning. */
export function examMessages(paper: ExamPaper, part: Part, answers: ExamAnswer[]) {
  const previous = paper.parts.filter(p => p.groupId === part.groupId && p.number < part.number);
  const messages: { role: 'user' | 'assistant'; content: string }[] = [];
  for (const p of previous) {
    const answer = answers.find(a => a.id === p.id);
    if (!answer || answer.outcome === 'environment_error') continue;
    const committed = committedItems(answer.output, p.items.map(i => i.key));
    messages.push(...p.question.messages, { role: 'assistant', content: committed.items.size
      ? [...committed.items].map(([item, value]) => JSON.stringify({ item, answer: value })).join('\n') : '本问未提交完整答案。' });
  }
  messages.push(...part.question.messages); return messages;
}

export function referenceOutput(part: Part) {
  return part.items.map(item => JSON.stringify({ item: item.key, answer: item.kind === 'exact' ? item.expected : (() => {
    const gold = solveOptimization(item.problem); return { value: gold.value, x: gold.x };
  })() })).join('\n');
}
