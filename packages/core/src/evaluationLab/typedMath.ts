import type { CriterionResult, OutputMetadata, Scenario, ScenarioResult } from '@zxbench/types';
import { canonicalDecimal, extractAnswerLine } from '../evaluators/exactAnswerLine.js';

export const TYPED_MATH_VERSION = 'typed_math_shadow_v1';
export type MathField = { id: string; label: string; separator: '' | '='; unit?: string } & (
  { kind: 'decimal'; expected: string } |
  { kind: 'sequence'; expected: string[] } |
  { kind: 'text'; expected: string }
);
export interface MathContract { version: 1; fields: MathField[] }

const clean = (s: string) => s.normalize('NFKC').replace(/\*\*/g, '').replace(/\s+/g, '');
const unwrap = (s: string) => s.startsWith('[') && s.endsWith(']') ? s.slice(1, -1) : s;

function decimal(s: string): string | null {
  // Commas are legal only in complete thousands groups, never blindly stripped.
  const value = unwrap(s);
  if (value.includes(',') && !/^[+-]?\d{1,3}(?:,\d{3})+(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(value)) return null;
  return canonicalDecimal(value.replace(/,/g, ''));
}

/** Split fields only outside placeholder/list brackets; comma inside 1,000 is numeric. */
function splitFields(s: string): string[] | null {
  let depth = 0, start = 0;
  const fields: string[] = [];
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '[') { if (++depth > 1) return null; }
    if (s[i] === ']') { if (--depth < 0) return null; }
    if (depth === 0 && /[,;；]/.test(s[i]) && !(s[i] === ',' && /\d/.test(s[i - 1] ?? '') && /\d/.test(s[i + 1] ?? ''))) {
      fields.push(s.slice(start, i)); start = i + 1;
    }
  }
  if (depth !== 0) return null;
  fields.push(s.slice(start));
  return fields;
}

export function validateMathContract(contract: MathContract): void {
  if (!contract || contract.version !== 1 || !Array.isArray(contract.fields) || !contract.fields.length || contract.fields.length > 30) throw new Error('Invalid typed math contract');
  if (new Set(contract.fields.map(f => f.id)).size !== contract.fields.length || new Set(contract.fields.map(f => f.label)).size !== contract.fields.length) throw new Error('Duplicate math field');
  for (const f of contract.fields) {
    if (!f.id || typeof f.label !== 'string' || !['', '='].includes(f.separator)) throw new Error('Invalid math field');
    if (f.unit !== undefined && (typeof f.unit !== 'string' || !f.unit)) throw new Error('Invalid unit');
    if (f.kind === 'decimal') {
      if (typeof f.expected !== 'string' || canonicalDecimal(f.expected) === null) throw new Error('Invalid decimal reference');
    } else if (f.kind === 'sequence') {
      if (!Array.isArray(f.expected) || !f.expected.length || f.expected.some(s => typeof s !== 'string' || !/^[\p{L}\p{N}_]+$/u.test(s))) throw new Error('Invalid sequence reference');
    } else if (f.kind !== 'text' || typeof f.expected !== 'string' || !f.expected) throw new Error('Invalid text reference');
  }
}

/** New opt-in shadow policy. Does not modify exact_answer_v4 or historic scenarios. */
export function evaluateTypedMath(contract: MathContract, output: string, meta: Partial<OutputMetadata> = {}): Partial<ScenarioResult> {
  validateMathContract(contract);
  const answer = extractAnswerLine(output);
  const parts = answer === null ? null : splitFields(clean(answer));
  const shape = !!parts && parts.length === contract.fields.length;
  const criteria: CriterionResult[] = contract.fields.map((field, i) => {
    const part = shape ? parts![i] : '';
    const prefix = clean(field.label + field.separator);
    const hasPrefix = part.startsWith(prefix);
    let value = hasPrefix ? part.slice(prefix.length) : '';
    let unitValid = true;
    if (field.unit) {
      unitValid = value.endsWith(clean(field.unit));
      if (unitValid) value = value.slice(0, -clean(field.unit).length);
    }
    let matches = false;
    if (shape && hasPrefix && unitValid) {
      if (field.kind === 'decimal') matches = decimal(value) !== null && decimal(value) === canonicalDecimal(field.expected);
      if (field.kind === 'text') matches = unwrap(value) === clean(field.expected);
      if (field.kind === 'sequence') {
        const items = unwrap(value).replace(/(?:->|→|⇒|—)/g, '-').split(/[-,、]/);
        matches = items.length === field.expected.length && items.every((item, j) => item === field.expected[j]);
      }
    }
    return { id: field.id, description: `${field.label || field.id}: ${field.kind}`, status: matches ? 'pass' : 'fail', critical: true,
      source: 'rule', evidence: matches ? `Exact typed value verified: ${part}` : `Invalid/missing/wrong typed field: ${part}` };
  });
  const accurate = criteria.every(c => c.status === 'pass');
  const complete = !meta.truncated && !meta.incomplete;
  const strictPass = accurate && complete;
  const score = criteria.filter(c => c.status === 'pass').length / criteria.length * 100;
  return { graderVersion: TYPED_MATH_VERSION, totalScore: strictPass ? 100 : 0, safetyLevel: 'safe',
    axisScores: { answer_accuracy: score, format_valid: shape ? 100 : 0, strict_solution: strictPass ? 100 : 0 },
    axisEvidence: { answer_accuracy: 'rule', format_valid: 'rule', strict_solution: 'rule' },
    criterionResults: criteria, evidence: [TYPED_MATH_VERSION, 'SHADOW_ONLY: field accuracy is separate from strict solution; no arbitrary partial-score blend',
      ...(complete ? [] : ['Output incomplete: cannot certify strict solution'])] };
}

/** Explicit migration adapters, never selected automatically by the production evaluator. */
export function legacyMathShadowContract(scenario: Scenario): MathContract | null {
  const req = scenario.requirements as unknown as { answer?: unknown };
  if (scenario.id === 'RM-CN-011' && req?.answer === '路线=仓库-A-B-C-D-E-仓库，总距离=17km') return { version: 1, fields: [
    { id: 'route', label: '路线', separator: '=', kind: 'sequence', expected: ['仓库','A','B','C','D','E','仓库'] },
    { id: 'distance', label: '总距离', separator: '=', kind: 'decimal', expected: '17', unit: 'km' },
  ] };
  if (scenario.id === 'RM-CN-012' && req?.answer === '顺序=J3-J1-J4-J2-J5，最短完工时间=23小时') return { version: 1, fields: [
    { id: 'sequence', label: '顺序', separator: '=', kind: 'sequence', expected: ['J3','J1','J4','J2','J5'] },
    { id: 'makespan', label: '最短完工时间', separator: '=', kind: 'decimal', expected: '23', unit: '小时' },
  ] };
  if (scenario.id === 'RM-CN-018' && req?.answer === '平均79.5，中位数82，众数85，极差33，方差98.05') return { version: 1, fields:
    [['mean','平均','79.5'],['median','中位数','82'],['mode','众数','85'],['range','极差','33'],['variance','方差','98.05']].map(([id,label,expected]) => ({ id,label,expected,separator:'',kind:'decimal' })) };
  return null;
}

export interface FlowJob { id: string; first: number; second: number }
export function simulateFlowShop(jobs: FlowJob[], order: string[]): number | null {
  if (!jobs.length || jobs.length > 8 || new Set(jobs.map(j => j.id)).size !== jobs.length ||
    jobs.some(j => !j.id || !Number.isSafeInteger(j.first) || !Number.isSafeInteger(j.second) || j.first < 0 || j.second < 0 || j.first > 1e6 || j.second > 1e6)) throw new Error('Invalid/beyond bounded flow-shop oracle');
  if (order.length !== jobs.length || new Set(order).size !== jobs.length) return null;
  let a = 0, b = 0;
  for (const id of order) {
    const job = jobs.find(j => j.id === id);
    if (!job) return null;
    a += job.first; b = Math.max(a, b) + job.second;
  }
  return b;
}

/** Exhaustive reference oracle, independent of a candidate's Johnson implementation. */
export function solveFlowShop(jobs: FlowJob[]): { minimum: number; order: string[] } {
  simulateFlowShop(jobs, jobs.map(j => j.id));
  let minimum = Infinity, order: string[] = [];
  function visit(prefix: string[], rest: string[]) {
    if (!rest.length) {
      const value = simulateFlowShop(jobs, prefix)!;
      if (value < minimum) { minimum = value; order = [...prefix]; }
    } else for (const id of rest) visit([...prefix, id], rest.filter(x => x !== id));
  }
  visit([], jobs.map(j => j.id));
  return { minimum, order };
}

/** Executable proof of feasibility and optimality; accepts every optimal permutation. */
export function verifyFlowShop(jobs: FlowJob[], output: string) {
  const answer = extractAnswerLine(output);
  const parts = answer === null ? null : splitFields(clean(answer));
  const validShape = parts?.length === 2 && parts[0].startsWith('顺序=');
  const duration = validShape ? parts![1].match(/^最短完工时间=(.+)小时$/) : null;
  const order = validShape ? unwrap(parts![0].slice('顺序='.length)).replace(/(?:->|→|⇒|—)/g, '-').split(/[-,、]/) : [];
  const actual = simulateFlowShop(jobs, order);
  const minimum = solveFlowShop(jobs).minimum;
  const reportedMatches = !!duration && actual !== null && decimal(duration[1]) === canonicalDecimal(String(actual));
  return { feasible: actual !== null, reportedMatches, optimal: actual === minimum,
    strictPass: actual !== null && reportedMatches && actual === minimum, actual, minimum };
}
