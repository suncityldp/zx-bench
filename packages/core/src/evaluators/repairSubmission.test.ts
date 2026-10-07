import {describe,expect,it} from 'vitest';
import {heuristicExtractCode} from './codeRepair.js';
import {materializeTypeRepair,stripRepairAnswerLabel} from './repairSubmission.js';
import {splitGoSubmission} from '../execution/goSubmission.js';

describe('repair submission context preservation',()=>{
 it('strips bilingual labels without editing code strings',()=>{
  const code='function f(){return "ANSWER:/答案: preserved";}';
  expect(stripRepairAnswerLabel('ANSWER:/答案: '+code)).toBe(code);
  expect(heuristicExtractCode('ANSWER:/答案: '+code+'\n\n理由：说明','javascript','f')).toBe(code);
 });
 it.each([
  ['python','fetch_all','import asyncio\nasync def fetch_all(xs):\n    return await asyncio.gather(*xs)'],
  ['go','Atoi','import ("math"; "strconv")\nfunc Atoi(s string)(int,error){return strconv.Atoi(s)}'],
  ['java','Cache','import java.lang.ref.WeakReference;\npublic class Cache { WeakReference<Object> item; }'],
  ['csharp','TryGetKey','using System;\npublic static class HeaderParser { public static bool TryGetKey(){return true;} }'],
  ['typescript','createUser','type DTO={age:number};\nexport function createUser(x:DTO){return x;}'],
  ['c','join','char *join(const char *s) {\n    return 0;\n}'],
 ])('keeps the submitted %s module', (language,name,code)=>expect(heuristicExtractCode(code,language,name)).toBe(code));
 it('recognizes an unfenced mapped type',()=>expect(heuristicExtractCode('答案:\ntype R<T>={[K in keyof T]:T[K]};','typescript','R')).toBe('type R<T>={[K in keyof T]:T[K]};'));
 it('keeps explanation-like text inside a string literal',()=>{
  const js='const text = `first\n\nReason: part of the returned data\n`;\nfunction f(){return text;}';
  expect(heuristicExtractCode(js,'javascript','f')).toBe(js);
  const py='def f():\n    return """first\n\nReason: returned data\n"""';
  expect(heuristicExtractCode(py,'python','f')).toBe(py);
 });
 it('materializes only an explicitly allowed unique alias',()=>{
  const initial='interface U {id:number}\ntype R<T> = any;\ntype Routes=R<U>;',patch='type R<T>={[K in keyof T]:T[K]};';
  expect(materializeTypeRepair(patch,initial,{protocol:'source-or-target-declaration-v1',targetNames:['R']})).toBe(initial.replace('type R<T> = any;',patch));
  expect(materializeTypeRepair(patch,initial,undefined)).toBe(patch);
  expect(materializeTypeRepair(patch,initial,{protocol:'source-or-target-declaration-v1',targetNames:['Other']})).toBe(patch);
 });
 it('moves Go imports ahead of the driver declarations',()=>{
  expect(splitGoSubmission('package main\nimport "math"\nimport ("strconv"; "fmt")\nfunc f(){}')).toEqual({imports:['"math"','"strconv"','"fmt"'],body:'func f(){}'});
 });
});
