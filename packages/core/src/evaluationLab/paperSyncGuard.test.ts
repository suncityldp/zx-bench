import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { buildExamPaper, loadPaperSource, paperSourceIdentity, paperSourceVersion, referenceOutput } from './examExpansion/index.js';
import { buildEvidenceExam, referenceOutput as evidenceReferenceOutput } from './evidenceExam/index.js';
import { ultraBatchPartEvaluator } from '../evaluators/ultraBatchPart.js';
import type { OutputMetadata, Scenario } from '@zxbench/types';

const SOURCE_URL = new URL('./examExpansion/math-candidates.json', import.meta.url);

describe('评卷表版本自检（R3：杜绝"题库已更新、内存仍旧表"导致的静默 0 分）', () => {
  it('paperSourceIdentity 等于源文件内容的 sha256 前 16 位，且与试卷对象一致', () => {
    const raw = readFileSync(SOURCE_URL, 'utf8');
    const expectIdentity = createHash('sha256').update(raw).digest('hex').slice(0, 16);
    expect(paperSourceIdentity()).toBe(expectIdentity);
    expect(buildExamPaper().sourceIdentity).toBe(expectIdentity);
    expect(paperSourceVersion()).toBe(loadPaperSource().source.version);
  });

  it('每次构建都反映磁盘上的当前内容（不存在固化快照）', () => {
    // 结构性不变量：题面必须列出该问的全部评分项 key，且印出的时限必须等于执行的 hardSeconds。
    // 这条不变量正是「题面（题库）新、评分项（内存）旧」那类事故的探测器。
    for (const part of buildExamPaper().parts) {
      const prompt = part.question.messages[0].content;
      for (const item of part.items) expect(prompt).toContain(item.key);
      expect(prompt).toContain(`时限${part.hardSeconds}秒`);
      expect(part.points).toBe(part.items.reduce((s, i) => s + i.points, 0));
    }
  });

  it('题库 questionHash 与评卷表不一致时判为环境错误（fail-closed，不再静默判 0）', async () => {
    const paper = buildExamPaper();
    const part = paper.parts.find((p) => p.id === 'MX3-16-P2')!;
    const stale: Scenario = {
      id: part.id,
      requirements: { questionHash: 'deadbeefdeadbeef' }, // 模拟题库已换成另一版题面
    } as unknown as Scenario;
    const graded = await ultraBatchPartEvaluator.evaluate(stale, referenceOutput(part), {} as OutputMetadata);
    expect(graded.environmentError).toBe(true);
    expect(graded.totalScore).toBe(0);
    expect((graded.evidence ?? []).join('\n')).toContain('STALE_GRADER_PAPER');
  });

  it('questionHash 一致时正常判分，参考输出满分', async () => {
    const part = buildExamPaper().parts.find((p) => p.id === 'MX3-16-P2')!;
    const fresh: Scenario = {
      id: part.id,
      requirements: { questionHash: part.question.questionHash },
    } as unknown as Scenario;
    const graded = await ultraBatchPartEvaluator.evaluate(fresh, referenceOutput(part), {} as OutputMetadata);
    expect(graded.environmentError).toBeUndefined();
    expect(graded.totalScore).toBe(100);
  });

  it('冻结证据题仅有历史时限文字漂移时仍按当前确定性评分表正常判分', async () => {
    const part = buildEvidenceExam().parts.find((p) => p.id === 'DX3-01-P2')!;
    const frozen: Scenario = {
      id: part.id,
      dimension: part.question.dimension,
      promptTemplate: part.question.messages[0].content.replace('时限600秒', '时限360秒'),
      requirements: { questionHash: 'legacy-time-limit-hash' },
    } as unknown as Scenario;
    const graded = await ultraBatchPartEvaluator.evaluate(frozen, evidenceReferenceOutput(part), {} as OutputMetadata);
    expect(graded.environmentError).toBeUndefined();
    expect(graded.totalScore).toBe(100);
  });

  it('冻结题除时限外还有题面漂移时仍 fail-closed', async () => {
    const part = buildEvidenceExam().parts.find((p) => p.id === 'DX3-01-P2')!;
    const frozen: Scenario = {
      id: part.id,
      dimension: part.question.dimension,
      promptTemplate: part.question.messages[0].content.replace('时限600秒', '时限360秒').replace('批次B1', '批次B9'),
      requirements: { questionHash: 'legacy-time-limit-hash' },
    } as unknown as Scenario;
    const graded = await ultraBatchPartEvaluator.evaluate(frozen, evidenceReferenceOutput(part), {} as OutputMetadata);
    expect(graded.environmentError).toBe(true);
    expect(graded.totalScore).toBe(0);
    expect((graded.evidence ?? []).join('\\n')).toContain('STALE_GRADER_PAPER');
  });

  it('未记录 questionHash 的旧题库行仍按原逻辑评分（守卫只在该字段存在时生效）', async () => {
    const part = buildExamPaper().parts.find((p) => p.id === 'MX3-16-P2')!;
    const legacy: Scenario = { id: part.id, requirements: {} } as unknown as Scenario;
    const graded = await ultraBatchPartEvaluator.evaluate(legacy, referenceOutput(part), {} as OutputMetadata);
    expect(graded.totalScore).toBe(100);
  });
});
