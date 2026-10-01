import {describe,it,expect} from 'vitest';
import {evaluateWorldTrace} from './worldTrace.js';
import type {Scenario,ModelResponse} from '@zxbench/types';

function score(expectedState: unknown[], state: Record<string,unknown>) {
  const scenario={requirements:{executionWorld:{initialState:{},tools:[],expectedState,scoreMode:'strict'}}} as unknown as Scenario;
  const response={executionWorld:{initialState:{},finalState:state,events:[],turns:[],
    finalMessage:'完成',turnErrors:[],elapsedMs:1,terminationReason:'completed'}} as unknown as ModelResponse;
  return evaluateWorldTrace(scenario,response).totalScore;
}
describe('read confirmation does not invalidate successful work',()=>{
  it('allows repeated reads but requires a real integer count',()=>{
    const state=[{path:'reads',atLeast:1}];
    expect(score(state,{reads:2})).toBe(100);
    for(const reads of [0,-1,1.5,Infinity,'2',undefined])expect(score(state,{reads})).toBe(0);
  });
  it('preserves mandatory read-before-write and rejects repeated mutations',()=>{
    const state=[{path:'operations',equals:['list','create'],allowExtraReadValues:['list']}];
    expect(score(state,{operations:['list','list','create','list']})).toBe(100);
    for(const operations of [['create','list'],['list'],['list','create','create'],['list','create','delete']])
      expect(score(state,{operations})).toBe(0);
  });
  it('does not let repeated searches admit a different topic',()=>{
    const state=[{path:'searches',equals:['Python'],allowExtraReadValues:['Python']}];
    expect(score(state,{searches:['Python','Python']})).toBe(100);
    for(const searches of [[],['Rust'],['Python','Rust']])expect(score(state,{searches})).toBe(0);
  });
});
