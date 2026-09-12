// ============================================================
// Structured Output 评分器 v3
// 只对实际可解析、且满足场景声明字段/约束的内容给分。格式正确不等于内容正确；
// 没有明确可验证的轴一律标记为 unmeasured，绝不以默认 100 填充。
// ============================================================

import type { AxisEvidence, ModelResponse, OutputMetadata, Scenario, ScenarioResult } from '@zxbench/types';
import type { Evaluator } from './index.js';
import { parseByFormat, type SupportedFormat } from '../parsers/index.js';

type Requirements = {
  format?: SupportedFormat;
  requiredFields?: string[];
  crossFieldRules?: string[];
  output_policy?: 'raw_only' | 'fenced_allowed';
  outputPolicy?: 'raw_only' | 'fenced_allowed';
};

const SUPPORTED_FORMATS = new Set<SupportedFormat>([
  'json', 'csv', 'xml', 'sql', 'html', 'yaml', 'regex', 'mermaid', 'markdown', 'toml',
]);

export const structuredOutputEvaluator: Evaluator = {
  name: 'schema_compliance',
  version: 'schema_compliance_v3',
  compatibleVersions: ['schema_compliance_v2'],
  aliases: ['structured_output_v2'],

  async evaluate(
    scenario: Scenario,
    modelOutput: string,
    _metadata: OutputMetadata,
    _modelResponse: ModelResponse,
  ): Promise<Partial<ScenarioResult>> {
    const axisScores: Record<string, number> = {};
    const axisEvidence: Record<string, AxisEvidence> = {};
    const evidence: string[] = [];
    const requirements = readRequirements(scenario);
    const format = detectFormat(scenario, requirements);
    const parsed = parseByFormat(format, modelOutput, {
      schema: scenario.schema,
      expectedColumns: format === 'csv' ? requirements.requiredFields : undefined,
    });
    const errors = parsed.violations.filter((v) => v.severity === 'error');

    // Syntax is intentionally independent of content constraints.
    axisScores.syntax_parse = parsed.success ? 100 : Math.max(0, 100 - errors.length * 35);
    axisEvidence.syntax_parse = 'rule';
    evidence.push(parsed.success
      ? `Format "${format}" parsed successfully`
      : `Format "${format}" parse errors: ${errors.length}`);
    for (const violation of errors.slice(0, 3)) evidence.push(`  - ${violation.message}`);

    if (scenario.schema) {
      const schemaViolations = parsed.violations.filter(
        (v) => v.type === 'schema_mismatch' || v.type === 'missing_required',
      );
      axisScores.schema_compliance = schemaViolations.length === 0 && parsed.success
        ? 100
        : Math.max(0, 100 - schemaViolations.length * 50);
      axisEvidence.schema_compliance = 'rule';
      evidence.push(schemaViolations.length === 0
        ? 'Schema validation passed'
        : `Schema violations: ${schemaViolations.length}`);
    } else {
      axisEvidence.schema_compliance = 'unmeasured';
    }

    const declaredFields = requirements.requiredFields ?? [];
    const declaredConstraints = Array.isArray(scenario.constraints) ? scenario.constraints : [];
    const checks = [
      ...declaredFields.map((field) => ({ label: `required field ${field}`, pass: hasRequiredField(format, parsed.parsed, field) })),
      ...declaredConstraints.map((constraint) => ({ label: `constraint ${constraint}`, pass: evaluateConstraint(constraint, parsed.parsed) })),
    ];
    if (checks.length > 0) {
      const passCount = checks.filter((check) => check.pass).length;
      axisScores.field_constraints = Math.round((passCount / checks.length) * 100);
      axisEvidence.field_constraints = 'rule';
      const failures = checks.filter((check) => !check.pass).map((check) => check.label);
      evidence.push(`Declared fields/constraints: ${passCount}/${checks.length} passed`);
      if (failures.length > 0) evidence.push(`Missing or invalid: ${failures.slice(0, 5).join(', ')}`);
    } else {
      axisEvidence.field_constraints = 'unmeasured';
    }

    const crossRules = requirements.crossFieldRules ?? [];
    if (crossRules.length > 0) {
      const passCount = crossRules.filter((rule) => evaluateCrossFieldRule(rule, parsed.parsed)).length;
      axisScores.cross_field_consistency = Math.round((passCount / crossRules.length) * 100);
      axisEvidence.cross_field_consistency = 'rule';
      evidence.push(`Cross-field rules: ${passCount}/${crossRules.length} passed`);
    } else {
      axisEvidence.cross_field_consistency = 'unmeasured';
    }

    // Parsing is not execution/rendering. Keep this axis absent until a sandbox or renderer is configured.
    axisEvidence.executable = 'unmeasured';
    axisScores.output_discipline = checkOutputDiscipline(modelOutput, requirements.outputPolicy ?? requirements.output_policy ?? 'raw_only');
    axisEvidence.output_discipline = 'rule';
    if (axisScores.output_discipline < 100) evidence.push('Output contains a fence or non-format text forbidden by raw_only policy');

    const totalScore = weightedMeasuredScore(axisScores, axisEvidence, {
      syntax_parse: 0.30,
      schema_compliance: 0.20,
      field_constraints: 0.40,
      cross_field_consistency: 0.05,
      output_discipline: 0.05,
    });

    return { axisScores, axisEvidence, totalScore, safetyLevel: 'safe', evidence };
  },
};

function readRequirements(scenario: Scenario): Requirements {
  const raw = scenario.requirements as unknown;
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Requirements : {};
}

function detectFormat(scenario: Scenario, requirements: Requirements): SupportedFormat {
  if (requirements.format && SUPPORTED_FORMATS.has(requirements.format)) return requirements.format;
  const schemaFormat = scenario.schema && (scenario.schema as Record<string, unknown>).format;
  if (typeof schemaFormat === 'string' && SUPPORTED_FORMATS.has(schemaFormat as SupportedFormat)) {
    return schemaFormat as SupportedFormat;
  }
  const grader = scenario.grader.toLowerCase();
  for (const format of SUPPORTED_FORMATS) if (grader.includes(format)) return format;
  return 'json';
}

function hasRequiredField(format: SupportedFormat, parsed: unknown, field: string): boolean {
  if (format === 'json') return getPath(parsed, field) !== undefined;
  if (format === 'csv') return Boolean(
    parsed && typeof parsed === 'object' && Array.isArray((parsed as { headers?: unknown }).headers)
      && ((parsed as { headers: string[] }).headers.includes(field)),
  );

  const text = typeof parsed === 'string' ? parsed : '';
  if (!text) return false;
  const escaped = escapeRegExp(field);
  switch (format) {
    case 'yaml':
      return new RegExp(`^\\s*${escaped}\\s*:`, 'mi').test(text);
    case 'toml':
      return new RegExp(`(?:^\\s*\\[${escaped}\\]\\s*$|^\\s*${escaped}\\s*=)`, 'mi').test(text);
    case 'xml':
      return new RegExp(`<(?:\\w+:)?${escaped}(?:\\s|>|/)`, 'i').test(text)
        || new RegExp(`\\s${escaped}\\s*=`, 'i').test(text);
    case 'html':
      if (field.toUpperCase() === 'DOCTYPE') return /^<!doctype\s+html/i.test(text);
      return new RegExp(`<(?:${escaped})(?:\\s|>)`, 'i').test(text);
    case 'sql':
      return new RegExp(`\\b${escaped.replace(/\\ /g, '\\s+')}\\b`, 'i').test(text);
    case 'mermaid':
    case 'markdown':
    case 'regex':
      return text.includes(field);
    default:
      return false;
  }
}

function getPath(value: unknown, path: string): unknown {
  const parts = path.replace(/\[(\d+)\]/g, '.$1').split('.').filter(Boolean);
  let current = value;
  for (const part of parts) {
    if (Array.isArray(current)) current = current[Number(part)];
    else if (current && typeof current === 'object') current = (current as Record<string, unknown>)[part];
    else return undefined;
  }
  return current;
}

function evaluateConstraint(constraint: string, data: unknown): boolean {
  if (constraint.startsWith('required:')) return getPath(data, constraint.slice(9).trim()) !== undefined;
  const type = constraint.match(/^type:([^=]+)=(\w+)$/);
  if (type) return typeof getPath(data, type[1].trim()) === type[2];
  return false;
}

/** Small, explicit rule language: equal:a,b | different:a,b | nonempty:a */
function evaluateCrossFieldRule(rule: string, data: unknown): boolean {
  const [kind, payload] = rule.split(':', 2);
  if (!payload) return false;
  if (kind === 'nonempty') {
    const value = getPath(data, payload.trim());
    return value !== undefined && value !== null && value !== '';
  }
  const [left, right] = payload.split(',').map((part) => getPath(data, part.trim()));
  if (left === undefined || right === undefined) return false;
  if (kind === 'equal') return left === right;
  if (kind === 'different') return left !== right;
  return false;
}

function checkOutputDiscipline(output: string, policy: 'raw_only' | 'fenced_allowed'): number {
  const trimmed = output.trim();
  if (!trimmed) return 0;
  const exactFence = /^```[\w-]*\s*\n?[\s\S]*?\n?```$/.test(trimmed);
  if (policy === 'fenced_allowed') return exactFence || !trimmed.includes('```') ? 100 : 0;
  return trimmed.includes('```') ? 0 : 100;
}

function weightedMeasuredScore(
  scores: Record<string, number>,
  evidence: Record<string, AxisEvidence>,
  weights: Record<string, number>,
): number {
  let numerator = 0;
  let denominator = 0;
  for (const [axis, weight] of Object.entries(weights)) {
    if (evidence[axis] === 'unmeasured' || scores[axis] === undefined) continue;
    numerator += scores[axis] * weight;
    denominator += weight;
  }
  return denominator === 0 ? 0 : Math.round(numerator / denominator);
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
