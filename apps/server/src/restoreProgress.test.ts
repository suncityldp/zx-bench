import {describe,it,expect,vi} from 'vitest';
vi.mock('./index.js',()=>({prisma:{evalRun:{findUnique:vi.fn()},scenarioDefinition:{findMany:vi.fn()}}}));
import {prisma} from './index.js';
import {createBenchmarkPack} from '@zxbench/core';
import {registerRoutes} from './routes/index.js';
describe('REST progress after backend reload',()=>{
 it('counts the full frozen run, selecting the latest answer and bounding only recent display rows',async()=>{
  const scenarios=Array.from({length:920},(_,i)=>({id:'s'+i,dimension:'reasoning_math'}));
  const results=scenarios.map((s,i)=>({id:'r'+i,scenarioId:s.id,dimension:s.dimension,totalScore:100,safetyLevel:'safe',environmentError:false,startedAt:new Date(i),finishedAt:new Date(i+1)}));
  results.push({...results[0],id:'retry',totalScore:0,environmentError:true,finishedAt:new Date(10000)});
  const query=vi.mocked(prisma.evalRun.findUnique).mockResolvedValue({id:'test',status:'completed',manifest:JSON.stringify({benchmarkPack:createBenchmarkPack(scenarios as any)}),results} as any);
  const handlers=new Map<string,any>();const app:any={addHook:()=>{},get:(p:string,h:any)=>handlers.set(p,h),post:()=>{},put:()=>{},patch:()=>{},delete:()=>{}};await registerRoutes(app);
  const result=await handlers.get('/api/runs/:id/progress')({params:{id:'test'}});
  expect(result.data).toMatchObject({total:920,completed:920,percentage:100,currentStage:'completed'});
  expect(result.data.recentResults).toHaveLength(50);expect(result.data.dimensionProgress[0]).toMatchObject({completed:920,passed:919,failed:0});
  const args=query.mock.calls.at(-1)?.[0] as any;expect(args.include.results.take).toBeUndefined();expect(args.include.results.select.modelOutput).toBeUndefined();expect(prisma.scenarioDefinition.findMany).not.toHaveBeenCalled();
 });
});
