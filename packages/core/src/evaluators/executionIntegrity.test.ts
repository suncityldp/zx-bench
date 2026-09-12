import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Scenario, OutputMetadata } from '@zxbench/types';
import { codeRepairEvaluator } from './codeRepair.js';
import { projectRepairEvaluator } from './projectRepair.js';
import { isDockerAvailable, runInContainer } from '../execution/index.js';
import { runReplacedCodeTest, runReplacedCodeTestPython } from '../sandbox/index.js';
import { applyCoverageDiscount } from '../scoring.js';

vi.mock('../execution/index.js', async original => ({
  ...await original<object>(), isDockerAvailable: vi.fn(), runInContainer: vi.fn(),
}));
const metadata = { incomplete: false } as OutputMetadata;
const testCase = { id: 'descending', type: 'hidden' as const,
  testCode: "if (JSON.stringify(sortDesc([2,10,1])) !== '[10,2,1]') throw Error('descending');", expectedExitCode: 0 };
const scenario = (): Scenario => ({ id: 'integrity', dimension: 'program', language: 'javascript',
  functionName: 'sortDesc', sourceCode: 'function sortDesc(nums) { return nums.sort(); }',
  hiddenTests: [testCase], requirements: {}, scoring: {}, grader: 'code_repair', graderVersion: '3.2.0',
} as unknown as Scenario);
const score = (code: string, s = scenario()) => codeRepairEvaluator.evaluate(s, '```\n' + code + '\n```', metadata, {} as any);

describe('candidate syntax and genuine test completion', () => {
  it('retains behavioral discrimination without a Judge', async () => {
    const wrong = await score('function sortDesc(nums) { return nums.sort(); }');
    const right = await score('function sortDesc(nums) { return nums.sort((a,b) => b-a); }');
    expect(wrong.axisScores).toMatchObject({ compilation: 100, test_pass: 0 });
    expect(right.axisScores).toMatchObject({ compilation: 100, test_pass: 100 });
    expect(right.axisCoverage).toBeCloseTo(1);
  });
  it('does not call a syntactically invalid candidate compiled', async () => {
    const result = await score('function sortDesc(nums) { invalid syntax !!! }');
    expect(result.axisScores).toMatchObject({ compilation: 0, test_pass: 0 });
    expect(result.runtimeEvaluation?.compilePassed).toBe(false);
    expect(result.runtimeEvaluation?.compileError).toContain('syntax');
  });
  it.each([
    'process.exit(0);',
    'process.send({type:"done",completed:true}); process.exit(0);',
    'return;',
  ])('rejects a skipped test: %s', async bypass => {
    const result = await score('function sortDesc() { return []; }\n' + bypass);
    expect(result.axisScores?.test_pass).toBe(0);
    expect(result.runtimeEvaluation?.details[0].stderr).toContain('TEST_EXECUTION_INCOMPLETE');
  });
  it('matching stdout cannot override an aborted or failing test', async () => {
    const tc = { ...testCase, expectedOutput: 'PASS', testCode: 'throw Error("must run");' };
    expect((await runReplacedCodeTest('console.log("PASS"); process.exit(0);', tc)).passed).toBe(false);
    expect((await runReplacedCodeTest('console.log("PASS");', tc)).passed).toBe(false);
  });
  it('waits for asynchronous assertions', async () => {
    expect((await runReplacedCodeTest('', { ...testCase, testCode: 'await new Promise(r => setTimeout(r, 5)); throw Error("async fail");' })).passed).toBe(false);
    expect((await runReplacedCodeTest('', { ...testCase, testCode: 'await Promise.resolve(); console.log("PASS");', expectedOutput: 'PASS' })).passed).toBe(true);
  });
  it('rejects Python early exit and still accepts a real assertion', async () => {
    const tc = { ...testCase, testCode: 'assert answer() == 42' };
    const wrong = await runReplacedCodeTestPython('def answer(): return 0\nimport sys\nsys.exit(0)', tc);
    const right = await runReplacedCodeTestPython('def answer(): return 42', tc);
    expect(wrong.passed).toBe(false);
    expect(wrong.stderr).toContain('TEST_EXECUTION_INCOMPLETE');
    expect(right.passed).toBe(true);
    expect(right.stdout).toBe('');
  });
  it('reports Python syntax failure as compile failure', async () => {
    const s = scenario(); s.language = 'python'; s.functionName = 'answer';
    s.hiddenTests = [{ ...testCase, testCode: 'assert answer() == 42' }];
    const result = await score('def answer(:\n  return 42', s);
    expect(result.axisScores?.compilation).toBe(0);
    expect(result.runtimeEvaluation?.compilePassed).toBe(false);
  });
  it('does not normalize missing coverage to 1 or label absent tests verified', async () => {
    const s = scenario(); s.hiddenTests = [];
    const result = await score('function sortDesc(nums) { return nums.sort((a,b) => a-b); }', s);
    expect(result.axisCoverage).toBeCloseTo(.6);
    expect(result.axisEvidence?.test_pass).toBe('unmeasured');
    expect(result.humanReviewRequired).toBe(true);
  });
});

describe('project execution evidence and final workspace checks', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(isDockerAvailable).mockResolvedValue(true);
    vi.mocked(runInContainer).mockResolvedValue({ success: false, stdout: '', stderr: 'AssertionError', exitCode: 1, timedOut: false, durationMs: 1 });
  });
  const project = () => ({ id: 'project', language: 'javascript', requirements: {
    files: [{ path: 'main.js', content: 'export class Queue {}' }, { path: 'other.js', content: 'export const value = 1;' }],
    hiddenTestFiles: [{ path: 'test.js', content: 'Queue;' }],
    hiddenTests: [{ script: 'node test.js', description: 'uses Queue' }], functionName: 'Queue',
  }, scoring: {} } as unknown as Scenario);
  it('a hidden test mentioning the removed API cannot grant API retention credit', async () => {
    const result = await projectRepairEvaluator.evaluate(project(), '### file: ./main.js\n```js\nexport const gone = true;\n```', metadata);
    expect(result.axisScores?.api_stability).toBe(0);
    expect(result.axisScores?.test_pass).toBe(0);
    expect(result.axisEvidence?.test_pass).toBe('verified');
  });
  it('preserves an entry in an unchanged file', async () => {
    const result = await projectRepairEvaluator.evaluate(project(), '### file: other.js\n```js\nexport const value = 2;\n```', metadata);
    expect(result.axisScores?.api_stability).toBe(100);
  });
  it('missing tests remain unmeasured and coverage reaches the existing discount policy', async () => {
    const s = project(); (s.requirements as any).hiddenTests = []; delete (s.requirements as any).functionName;
    const result = await projectRepairEvaluator.evaluate(s, '### file: other.js\n```js\nexport const value = 2;\n```', metadata);
    expect(runInContainer).not.toHaveBeenCalled();
    expect(result.axisEvidence?.test_pass).toBe('unmeasured');
    expect(result.axisCoverage).toBeCloseTo(.3);
    expect(applyCoverageDiscount(result.totalScore!, result.axisCoverage!)).toBe(30);
    expect(result.humanReviewRequired).toBe(true);
  });
});
