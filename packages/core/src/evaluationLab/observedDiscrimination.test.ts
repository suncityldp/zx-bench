import {describe,expect,it} from 'vitest';
import {observedDiscrimination,type ObservedDimensionModel} from './observedDiscrimination.js';
const model=(id:string,family:string,bits:(boolean|null)[],executionClass:'local_unsloth'|'provider_api'='provider_api'):ObservedDimensionModel=>({modelId:id,modelFamily:family,executionClass,
  rows:bits.map((pass,i)=>({id:`q${i}`,family:i<2?'a':'b',pass,state:pass===null?'missing':'completed'}))});
describe('observed same-question discrimination',()=>{
  it('reports separation across three declared families without calling it calibrated',()=>{
    const r=observedDiscrimination('d',[model('qwen','Qwen',[true,false,true],'local_unsloth'),model('deep','DeepSeek',[true,true,true]),model('glm','GLM',[false,false,true])]);
    expect(r.screeningSignal).toBe('observed_same_question_separation');expect(r.scoreSpread).toBeCloseTo(66.6667,3);
    expect(r.separatingItems).toBe(2);expect(r.strictSameRuntimeComparison).toBe(false);expect(r.difficultyCalibrated).toBe(false);
  });
  it('flags a possible dimension ceiling only with enough families',()=>{
    expect(observedDiscrimination('d',[model('a','A',[true,true]),model('b','B',[true,true]),model('c','C',[true,true])]).screeningSignal).toBe('possible_dimension_ceiling');
    expect(observedDiscrimination('d',[model('a','A',[true,true]),model('b','B',[true,true])]).screeningSignal).toBe('insufficient_declared_model_families');
  });
  it('reports pairwise discordance rather than averaging retries',()=>{
    const r=observedDiscrimination('d',[model('a','A',[true,false]),model('b','B',[false,false]),model('c','C',[true,true])]);
    expect(r.pairs.map(p=>p.discordantItems)).toEqual([1,1,2]);expect(r.combinedScore).toBeNull();
  });
  it.each([
    ()=>observedDiscrimination('',[model('a','A',[true]),model('b','B',[false])]),
    ()=>observedDiscrimination('d',[model('a','A',[true]),model('a','B',[false])]),
    ()=>observedDiscrimination('d',[model('a','A',[true]),model('b','B',[true,false])]),
    ()=>observedDiscrimination('d',[model('a','A',[null]),model('b','B',[true])]),
    ()=>observedDiscrimination('d',[model('a','A',[true]),{...model('b','B',[false]),rows:[{id:'q0',family:'changed',pass:false,state:'completed'}]}]),
  ])('rejects incomparable inputs',fn=>expect(fn).toThrow());
});
