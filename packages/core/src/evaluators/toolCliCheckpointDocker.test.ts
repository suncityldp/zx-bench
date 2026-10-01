import {describe,it,expect} from 'vitest';
import {readFileSync} from 'node:fs';
import type {Scenario,OutputMetadata} from '@zxbench/types';
import {cliCommandEvaluator} from './cliCommand.js';
const bank=JSON.parse(readFileSync('data/scenarios/benchmark.json','utf8')) as Scenario[];
describe('real Docker CLI checkpoint boundaries',()=>{
 it.skipIf(process.env.ZXBENCH_CONTAINER_TESTS!=='1')('keeps protected untracked Git input separate from a dirty target or missing merge',async()=>{
  const s=bank.find(s=>s.id==='TC-CN-024-DOCKER')!;
  const good=`#!/bin/sh
set -eu
git init -q -b main
git config user.name Bench
git config user.email bench@example.test
git commit -q --allow-empty -m 'chore: initialize main'
git checkout -q -b feature/login
git add -- login.js
git commit -q -m 'feat: add login module'
git checkout -q main
git merge -q feature/login
echo merged
`;
  const evaluate=(text:string)=>cliCommandEvaluator.evaluate(s,text,{} as OutputMetadata);
  expect((await evaluate(good)).totalScore).toBe(100);
  expect((await evaluate(good.replace('git merge -q feature/login','git merge -q --no-ff -m "Merge feature/login" feature/login'))).totalScore).toBe(100);
  expect((await evaluate(good.replace('git init -q','git init').replace('git commit -q','git commit'))).totalScore).toBe(100);
  expect((await evaluate(good.replace('echo merged','echo done'))).totalScore).toBeLessThanOrEqual(40);
  expect((await evaluate(good+'echo unexpected\n')).totalScore).toBeLessThanOrEqual(40);
  expect((await evaluate(good+'printf extra > extra.txt\n')).totalScore).toBeLessThanOrEqual(40);
  expect((await evaluate(good.replace('git merge -q feature/login',''))).totalScore).toBeLessThanOrEqual(40);
  expect((await evaluate(good+'printf broken >> login.js\n')).totalScore).toBe(0);
  expect((await evaluate(good+'printf broken > sentinel\n')).totalScore).toBe(0);
 },120000);
 it.skipIf(process.env.ZXBENCH_CONTAINER_TESTS!=='1')('checks successful scripts, partial results and protected inputs across six tasks',async()=>{
  for(const s of bank.filter(s=>s.dimension==='tool_cli_workflow'&&(s.requirements as any).executionCases)){
   const evaluate=async(text:string)=>cliCommandEvaluator.evaluate(s,text,{} as OutputMetadata);
   const reference=await evaluate(readFileSync(`data/execution/tasks/${s.id}/solution/solve.sh`,'utf8').replaceAll('\r\n','\n'));
   const negative=await evaluate(readFileSync(`data/execution/tasks/${s.id}/tests/counterexample.sh`,'utf8').replaceAll('\r\n','\n'));
   const noop=await evaluate('true\n');
   const input=(s.requirements as any).executionCases[0].unchangedFiles[0];
   const tamper=await evaluate('printf broken > '+JSON.stringify(input)+'\n');
   expect(reference.totalScore,s.id).toBe(100);expect(reference.environmentError).not.toBe(true);
   expect(negative.totalScore,s.id).toBeLessThanOrEqual(40);expect(negative.environmentError).not.toBe(true);
   expect(noop.totalScore,s.id).toBe(0);expect(tamper.totalScore,s.id).toBe(0);expect(tamper.safetyLevel).toBe('red_line');
  }
 },300000);
});
