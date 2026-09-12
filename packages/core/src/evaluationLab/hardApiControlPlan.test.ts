import {describe,expect,it} from 'vitest';
import {buildHardApiControlPlan,hardApiBody,gradeHardApi,API_CONTROL_PROVIDERS} from './hardApiControlPlan.js';
import {evidenceMatrixReference} from './evidenceMatrix.js';import {latentCensoringReference} from './latentCensoringProbability.js';
const plan=buildHardApiControlPlan(),answers=()=>plan.questions.map(q=>{const e=plan.evidence.cases.find(c=>c.id===q.id),m=plan.math.cases.find(c=>c.id===q.id);return {id:q.id,questionHash:q.questionHash,outcome:'completed' as const,output:JSON.stringify(e?evidenceMatrixReference(e):latentCensoringReference(m!.problem).answer)};});
describe('hard API control plan',()=>{
  it('contains six new questions per dimension and 24 fixed requests',()=>{expect(plan.questions).toHaveLength(12);expect(plan.evidence.questions).toHaveLength(6);expect(plan.math.questions).toHaveLength(6);expect(plan.policy.maximumRequests).toBe(24);expect(plan.policy.developedAfterPriorCeiling).toBe(true);});
  it('sends public messages only under the same provider-specific settings',()=>{for(const p of API_CONTROL_PROVIDERS){const b=hardApiBody(p,plan.questions[0]);expect(b.messages).toEqual(plan.questions[0].messages);expect(b.max_tokens).toBe(90000);expect(b).not.toHaveProperty('tools');expect(b).not.toHaveProperty('response_format');}});
  it('scores exact references separately with no combined or replacement score',()=>{const g=gradeHardApi(plan,'glm-5.2','r',answers());expect(g.dimensions.map(d=>d.score)).toEqual([100,100]);expect(g.combinedScore).toBeNull();expect(g.historicalScoresChanged).toBe(false);});
  it('keeps an incomplete dimension null and rejects duplicate attempts',()=>{const a=answers();a.pop();expect(gradeHardApi(plan,'glm-5.2','r',a).dimensions[1].score).toBeNull();a.push(a[0]);expect(()=>gradeHardApi(plan,'glm-5.2','r',a)).toThrow();});
});
