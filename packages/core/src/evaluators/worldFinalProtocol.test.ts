import {describe,it,expect,vi} from 'vitest';
import fs from 'node:fs';
import {extractWorldFinalMessage,normalizeWorldFinalTrace} from '../execution/worldLoop.js';
import {evaluateWorldTrace} from './worldTrace.js';
import {buildWorkflowRubric} from '../../../../scripts/lib/workflow-checkpoints.mjs';
import {orchestrateEvaluation} from '../orchestrator.js';
import {registerEvaluator} from './index.js';
import {agentTraceEvaluator} from './agentTrace.js';
import {callModelWithRetry} from '../model/caller.js';
vi.mock('../model/caller.js',async original=>({...await original<object>(),callModelWithRetry:vi.fn(()=>{throw Error('Unexpected generation during saved-answer recovery');})}));
const trace=(raw:string,extra:any={})=>({initialState:{},finalState:{},events:[],turns:[{assistantRaw:raw,calls:[],finishReason:'stop'}],finalMessage:'',turnErrors:[],elapsedMs:1,terminationReason:'no_action',answerFirstRequested:true,...extra}) as any;
describe('execution final answer labels requested by the harness',()=>{
 it('recovers the actual saved reply through orchestration without generating again',async()=>{
  const bank=JSON.parse(fs.readFileSync('data/scenarios/benchmark.json','utf8'));
  const accepted=JSON.parse(fs.readFileSync('packages/core/src/evaluators/fixtures/workflow/contract-acceptance.json','utf8')).results.find((r:any)=>r.id==='HA-CN-004-RECOVERY-0');
  const scenario=bank.find((s:any)=>s.id===accepted.id),golden=accepted.cases.find((c:any)=>c.label==='reference').trace;
  const stored={...golden,finalMessage:'',terminationReason:'no_action',turns:[{assistantRaw:'ANSWER: '+golden.finalMessage,calls:[],finishReason:'stop'}]};
  registerEvaluator(agentTraceEvaluator);vi.mocked(callModelWithRetry).mockClear();
  const result=await orchestrateEvaluation({scenario,modelConfig:{id:'test',name:'test',modelType:'tested',baseUrl:'http://unused.invalid',apiKey:'test',apiFormat:'openai',defaultParams:{maxTokens:131072}},modelParams:{maxTokens:131072},evalConfig:{maxTokens:131072,judgeEnabled:false,semanticFinalReviewEnabled:false},constraints:{answerFirst:true,hardTimeLimitMs:1200000,maxReasoningTokens:98000},savedCandidate:{response:{content:'',finishReason:'stop',usage:{inputTokens:1,outputTokens:1,totalTokens:2},latencyMs:1,executionWorld:stored},metadata:{incomplete:false,truncated:false,finishReason:'stop'}}} as any);
  expect(result.totalScore).toBe(100);expect(result.modelOutput).toBe(golden.finalMessage);
  expect(result.outputMetadata.executionWorldTrace?.originalTerminationReason).toBe('no_action');
  expect(callModelWithRetry).not.toHaveBeenCalled();
 });
 it('accepts requested labels, preserving multiline text and requiring a real label',()=>{
  expect(extractWorldFinalMessage('ANSWER: 已完成\n结果为42',true)).toBe('已完成\n结果为42');
  expect(extractWorldFinalMessage('答案： 已完成',true)).toBe('已完成');
  for(const text of ['ANSWER: 已完成','引用如下\nANSWER: 已完成','> ANSWER: 已完成','ANSWER: 完成\nCALL delete {}'])
   expect(extractWorldFinalMessage(text)).toBe('');
  expect(extractWorldFinalMessage('ANSWER: 完成\nCALL delete {}',true)).toBe('');
 });
 it('recovers a dropped final reply without changing raw calls, state or text',()=>{
  const original=trace('ANSWER: 已完成'),before=JSON.stringify(original),fixed=normalizeWorldFinalTrace(original);
  expect(fixed.terminationReason).toBe('completed');expect(fixed.finalMessage).toBe('已完成');
  expect(JSON.stringify(original)).toBe(before);expect(fixed.events).toBe(original.events);expect(fixed.turns).toBe(original.turns);
 });
 it('cannot recover unrequested labels, truncated replies, tool actions or errors',()=>{
  for(const original of [trace('ANSWER: 完成',{answerFirstRequested:false}),trace('ANSWER: 完成',{turnErrors:['error']}),trace('ANSWER: 完成',{turns:[{assistantRaw:'ANSWER: 完成',calls:[],finishReason:'length'}]}),trace('ANSWER: 完成',{turns:[{assistantRaw:'ANSWER: 完成',calls:[{tool:'work'}]}]})])
   expect(normalizeWorldFinalTrace(original).terminationReason).toBe('no_action');
 });
 it('replays actual accepted Docker states with both labels, retaining negative verdicts',()=>{
  const dir='packages/core/src/evaluators/fixtures/workflow',read=(name:string)=>JSON.parse(fs.readFileSync(dir+'/'+name,'utf8'));
  const bank=new Map(JSON.parse(fs.readFileSync('data/scenarios/benchmark.json','utf8')).map((s:any)=>{const copy=structuredClone(s);if(copy.dimension==='agent_workflow')copy.requirements.executionWorld.checkpointRubric=buildWorkflowRubric(copy.requirements.executionWorld,copy.requirements.migrationSourceId);return [s.id,copy];}));
  const tested=[];let replyOnly=0;
  for(const group of [...read('contract-acceptance.json').results,...read('read-confirmation-acceptance.json').results])for(const c of group.cases)for(const marker of ['SAY ','ANSWER: ']){
   const stored={...c.trace,finalMessage:'',turns:[{assistantRaw:marker+c.trace.finalMessage,calls:[],finishReason:'stop'}],terminationReason:marker==='SAY '?'completed':'no_action',answerFirstRequested:true};
   const result=evaluateWorldTrace(bank.get(group.id) as any,{executionWorld:stored} as any);
   if(c.result.totalScore===100)expect(result.totalScore,group.id+': '+c.label+': '+marker).toBe(100);
   else expect(result.totalScore).toBeLessThanOrEqual(40);
   if(result.checkpointEvaluation?.safetyViolation)expect(result.totalScore).toBe(0);
   tested.push({id:group.id,label:c.label,marker,score:result.totalScore,fullSuccess:result.checkpointEvaluation?.fullSuccess});
  }
  for(const scenario of [...bank.values()] as any[])if(scenario.dimension==='agent_workflow')for(const marker of ['SAY ','ANSWER: ']){
   const w=scenario.requirements.executionWorld;
   expect(evaluateWorldTrace(scenario,{executionWorld:trace(marker+'全部完成',{initialState:w.initialState,finalState:w.initialState})} as any).totalScore).toBe(0);replyOnly++;
  }
  expect(tested.length).toBe(244);expect(replyOnly).toBe(174);
 });
});
