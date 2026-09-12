import {describe, expect, it} from 'vitest';
import {API_CONTROL_PROVIDERS, buildApiControlPlan, apiControlBody, allowedReturnedModel, gradeApiControl} from './apiControlPlan.js';
import {oracle} from './methodsV2/verify.js';
import {probabilityReference} from './adaptiveProbability.js';
const plan = buildApiControlPlan();
const answers = () => plan.questions.map(q => {const e = plan.evidence.cases.find(c => c.id === q.id), p = plan.probability.cases.find(c => c.id === q.id);
  return {id: q.id, questionHash: q.questionHash, outcome: 'completed' as const, output: JSON.stringify(e ? oracle(e) : probabilityReference(p!.problem).answer)};});
describe('registered fourteen-question API control', () => {
  it('selects exactly original eight evidence and six probability questions', () => {
    expect(plan.questions).toHaveLength(14); expect(plan.questions.filter(q => q.dimension === 'hallucination_resistance')).toHaveLength(8);
    expect(plan.policy.maximumRequests).toBe(28); expect(plan.policy.automaticRetries).toBe(0);
  });
  it('sends only original messages, no gold, tools, previous answers or forced JSON', () => {
    for (const provider of API_CONTROL_PROVIDERS) {const b = apiControlBody(provider, plan.questions[0]);
      expect(b.messages).toEqual(plan.questions[0].messages); expect(b.max_tokens).toBe(90000); expect(b).not.toHaveProperty('tools'); expect(b).not.toHaveProperty('response_format');}
  });
  it('does not claim DeepSeek has an effective temperature setting', () => {
    expect(apiControlBody(API_CONTROL_PROVIDERS[0], plan.questions[0])).not.toHaveProperty('temperature'); expect(plan.policy.sameDecodingAsLocal).toBe(false);
  });
  it('records documented Flash aliases but rejects Pro or unrelated models', () => {
    expect(allowedReturnedModel('deepseek-v4-flash', ['deepseek-flash', 'deepseek-v4.1-flash'])).toBe(true);
    expect(allowedReturnedModel('deepseek-v4-flash', ['deepseek-v4-pro'])).toBe(false);
    expect(allowedReturnedModel('glm-5.2', ['glm-5.3'])).toBe(false); expect(allowedReturnedModel('glm-5.2', [])).toBe(false);
  });
  it('scores dimensions separately without inventing a combined score', () => {
    const r = gradeApiControl(plan, 'glm-5.2', 'test', answers()); expect(r.dimensions.map(d => d.score)).toEqual([100, 100]); expect(r.combinedScore).toBeNull();
  });
  it('does not drop missing answers or select a duplicated attempt', () => {
    const a = answers(); a.pop(); expect(gradeApiControl(plan, 'glm-5.2', 'test', a).dimensions[1].score).toBeNull();
    a.push(a[0]); expect(() => gradeApiControl(plan, 'glm-5.2', 'test', a)).toThrow();
  });
});
