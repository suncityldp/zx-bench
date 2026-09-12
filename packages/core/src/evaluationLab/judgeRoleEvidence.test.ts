import {describe,expect,it} from 'vitest';
import {judgeRoleEvidence,type BoundedJudgeControl,type BoundedJudgeRealSignal} from './judgeRoleEvidence.js';
const control=(scope:string,modelName='pro'):BoundedJudgeControl=>({scope,modelName,calls:2,rows:[1,2].map(()=>({fullContextVerified:true,allMatch:true,mappingReviewed:true}))});
const signal=(scope:string,modelName='pro'):BoundedJudgeRealSignal=>({scope,modelName,calls:1,reviewedIssues:1,originalAnswerUnchanged:true,automaticScoreChanged:false,entireProofMeasured:false});
describe('bounded Judge role evidence',()=>{
  it('does not transfer qualification when the configured model changes',()=>{
    const r=judgeRoleEvidence('flash',[control('endpoint')],[signal('endpoint')]);
    expect(r.effectiveForEvidenceModelAndExactScopes).toBe(true);expect(r.currentConfiguredModelQualified).toBe(false);
    expect(r.automaticScoreAuthority).toBe(false);expect(r.generalizedProofJudgeQualified).toBe(false);
  });
  it('qualifies the exact evidence model only for matched scopes',()=>{
    const r=judgeRoleEvidence('pro',[control('endpoint'),control('boundary')],[signal('endpoint'),signal('boundary')]);
    expect(r.currentConfiguredModelQualified).toBe(true);expect(r.scopes).toEqual(['endpoint','boundary']);expect(r.productionEligible).toBe(false);
  });
  it.each([
    ()=>judgeRoleEvidence('pro',[{...control('x'),calls:1}],[signal('x')]),
    ()=>judgeRoleEvidence('pro',[{...control('x'),rows:[{fullContextVerified:true,allMatch:false,mappingReviewed:true}]}],[signal('x')]),
    ()=>judgeRoleEvidence('pro',[control('x','a')],[signal('x','b')]),
    ()=>judgeRoleEvidence('pro',[control('x')],[{...signal('x'),reviewedIssues:0}]),
    ()=>judgeRoleEvidence('pro',[control('x')],[{...signal('x'),automaticScoreChanged:true}]),
    ()=>judgeRoleEvidence('pro',[control('x')],[signal('y')]),
  ])('rejects incomplete or overclaimed evidence',fn=>expect(fn).toThrow());
});
