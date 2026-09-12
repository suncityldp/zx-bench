import {describe,it,expect} from 'vitest';
import {fileURLToPath} from 'node:url';
import {isolatedJudgeFixtures} from './isolatedJudgeFixtures.js';
import {anchoredPublicItem} from './anchoredAtomicJudge.js';
const root=fileURLToPath(new URL('../../../../',import.meta.url));
describe('single-item isolation experiment',()=>{
  const fixtures=isolatedJudgeFixtures(root);
  it('keeps four diagnostic real answers and eight fresh temporal controls',()=>{expect(fixtures).toHaveLength(12);expect(fixtures.filter(f=>f.split==='development')).toHaveLength(4);expect(fixtures.filter(f=>f.split==='holdout')).toHaveLength(8);expect(new Set(fixtures.map(f=>f.item.id)).size).toBe(12);});
  it('has balanced pass/fail controls without exposing gold or model identity',()=>{for(const split of ['development','holdout']){const fs=fixtures.filter(f=>f.split===split);expect(fs.filter(f=>f.expected==='pass').length).toBe(fs.length/2);}for(const f of fixtures){const publicItem=anchoredPublicItem(f.item);expect(Object.keys(publicItem).sort()).toEqual(['candidate','candidateSegments','dimension','focus','id','sources']);}});
  it('diagnoses the actual prior mistake with unchanged evidence eligibility',()=>{expect(fixtures[0].item.sources.D32).toContain('[D06]');expect(fixtures[1].item.sources.D32).toContain('[D72]');expect(fixtures[0].item.candidate).toContain('refuted');expect(fixtures[1].item.candidate).toContain('insufficient');expect(fixtures[2].item.candidate).toContain('conflict');});
  it('uses genuinely different temporal-state controls, not eight model outputs',()=>{const hold=fixtures.filter(f=>f.split==='holdout');expect(new Set(hold.map(f=>(f.oracleEvidence as any).questionId)).size).toBe(4);expect(hold.filter(f=>(f.oracleEvidence as any).origin==='authored_status_mutation_not_model_answer')).toHaveLength(4);});
});
