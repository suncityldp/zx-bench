import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { Scenario, OutputMetadata } from '@zxbench/types';
import { exactAnswerLineEvaluator } from './exactAnswerLine.js';
import { hashScenarioShort } from '../contracts/canonicalize.js';
import { referenceAnswerWarnings } from '../referenceAnswerReview.js';

const bank: Scenario[] = JSON.parse(readFileSync(new URL('../../../../data/scenarios/benchmark.json', import.meta.url), 'utf8'));
const ids = ['RM-CN-013','RM-CN-014','RM-CN-028','RM-CN-031'];
const scenario = (id: number) => bank.find(s => s.id === `RM-CN-${String(id).padStart(3,'0')}`)!;
const meta = {truncated:false,incomplete:false} as OutputMetadata;
const score = async (id:number, answer:string) => (await exactAnswerLineEvaluator.evaluate(scenario(id),`ANSWER: ${answer}`,meta)).axisScores?.answer_accuracy;

describe('restored math independent oracles', () => {
  it('013 calculates every cumulative percentage and category from the actual table', async () => {
    const rows = [...scenario(13).promptTemplate.matchAll(/\|\s*([A-J])\s*\|\s*(\d+)\s*\|/g)]
      .map(m=>({id:m[1],amount:Number(m[2])})).sort((a,b)=>b.amount-a.amount||a.id.localeCompare(b.id));
    expect(rows).toHaveLength(10);
    const total=rows.reduce((sum,r)=>sum+r.amount,0);expect(total).toBe(1250);
    let cumulative=0;
    const groups: string[][]=[[],[],[]];
    const percentages=rows.map(r=>{
      cumulative+=r.amount;
      // Cross-multiplication classifies the exact unrounded ratio.
      groups[cumulative*100<=total*70?0:cumulative*100<=total*90?1:2].push(r.id);
      return `${r.id}:${(cumulative*100/total).toFixed(1)}%`;
    });
    expect(groups).toEqual([['A','B'],['C','D'],['E','F','G','H','I','J']]);
    const answer=`累计占比=${percentages.join(',')}，A类=${groups[0]}，B类=${groups[1]}，C类=${groups[2]}`;
    expect(await score(13,answer)).toBe(100);
    expect(await score(13,answer.replace('C:80.0%','C:79.9%'))).toBe(0);
    expect(await score(13,answer.replace('A类=A,B，B类=C,D','A类=A,B,C，B类=D'))).toBe(0);
    expect(await score(13,'A类=A,B,C，B类=D,E,F，C类=G,H,I,J')).toBe(0);
  });

  it('014 finds conflicts and minute-by-minute free blocks after cancellation and lunch', async () => {
    const minutes=(h:string,m:string)=>Number(h)*60+Number(m);
    const meetings=[...scenario(14).promptTemplate.matchAll(/会议([A-F])：(\d+):(\d+)-(\d+):(\d+)/g)]
      .map(m=>({id:m[1],start:minutes(m[2],m[3]),end:minutes(m[4],m[5])}));
    expect(meetings).toHaveLength(6);
    const overlaps=(a:typeof meetings[number],b:typeof meetings[number])=>a.start<b.end&&b.start<a.end;
    const conflicts=meetings.flatMap((a,i)=>meetings.slice(i+1).filter(b=>overlaps(a,b)).map(b=>`${a.id}和${b.id}`));
    const kept:typeof meetings=[];
    for(const m of meetings)if(!kept.some(k=>overlaps(m,k)))kept.push(m);
    expect(kept.map(m=>m.id)).toEqual(['A','C','D','F']);
    const free:number[][]=[];
    for(let minute=540;minute<1080;minute++) {
      if((minute>=750&&minute<840)||kept.some(m=>minute>=m.start&&minute<m.end))continue;
      const last=free.at(-1);
      if(last&&last[1]===minute)last[1]++;else free.push([minute,minute+1]);
    }
    expect(free).toEqual([[630,690],[930,990],[1050,1080]]);
    const longest=Math.max(...free.map(([a,b])=>b-a));
    expect(longest).toBe(60);expect(free.some(([a,b])=>b-a>=120)).toBe(false);
    const answer=`冲突=${conflicts.join('、')}，最长空闲=${longest}分钟，最早安排=无法安排`;
    expect(await score(14,answer)).toBe(100);
    expect(await score(14,answer.replace('60分钟','60.0分钟'))).toBe(100);
    for(const bad of [answer.replace('60分钟','90分钟'),answer.replace('无法安排','11:30'),answer.replace('、D和E','')]) expect(await score(14,bad)).toBe(0);
  });

  it('028 verifies original premises, independent replacement, and the named converse', async () => {
    // Exhaust all interpretations over two people. P2 itself provides a
    // counterexample to the converse for any domain size.
    const models=Array.from({length:16},(_,mask)=>[0,1].map(i=>({m:!!(mask&(1<<(i*2))),t:!!(mask&(1<<(i*2+1)))})));
    const p1=(people:typeof models[number])=>people.every(x=>!x.m||x.t);
    const p2=(people:typeof models[number])=>people.some(x=>x.t&&!x.m);
    const c=(people:typeof models[number])=>people.some(x=>!x.m&&x.t);
    const converse=(people:typeof models[number])=>people.every(x=>!x.t||x.m);
    const original=models.filter(p=>p1(p)&&p2(p));
    expect(original.length).toBeGreaterThan(0);
    expect(original.every(c)).toBe(true);
    expect(models.some(p=>p.every(x=>!x.t||!x.m)&&p2(p))).toBe(true);
    expect(original.every(p=>!converse(p))).toBe(true);
    expect(scenario(28).promptTemplate).toContain('不是逆否命题');
    const answer='推理有效性=是，改后前提=成立，逆命题=T(x)→M(x)，逆命题成立=否';
    expect(await score(28,answer)).toBe(100);
    for(const bad of [answer.replace('有效性=是','有效性=否'),answer.replace('改后前提=成立','改后前提=不成立'),answer.replace('逆命题成立=否','逆命题成立=是'),answer.replace('T(x)→M(x)','M(x)→T(x)')])expect(await score(28,bad)).toBe(0);
  });

  it('031 prices a 2000-item batch with integer cents and rounds only once', async () => {
    const produced=2000n, shipped=1900n;
    const manufacturing=produced*(5000n+2000n+500n);
    const downstream=shipped*(300n+300n+1250n);
    // Dealer and retailer factor = (5/4)*(7/5)=7/4. Still in cents.
    const numerator=(manufacturing+downstream)*7n, denominator=shipped*4n;
    const rounded=(numerator*2n+denominator)/(2n*denominator);
    expect(rounded).toBe(17053n);
    expect(scenario(31).promptTemplate).toContain('全部在包装前报废');
    expect(scenario(31).promptTemplate).toContain('整批产品恰有5%');
    const price=`${rounded/100n}.${String(rounded%100n).padStart(2,'0')}元`;
    expect(await score(31,price)).toBe(100);
    for(const answer of ['170.530元','0.017053万元'])expect(await score(31,answer)).toBe(100);
    for(const answer of ['168元','164.28元','170.52元','170.54元','170.53000000001元'])expect(await score(31,answer)).toBe(0);
  });

  it('restored source contracts are valid, verified and eligible with matching metadata and hashes', () => {
    for(const s of bank.filter(s=>ids.includes(s.id))) {
      expect(s).toMatchObject({status:'valid',reviewStatus:'verified',scenarioVersion:'3.2.0',graderVersion:'exact_answer_v4'});
      expect(s.scenarioHash).toBe(hashScenarioShort(s));
      expect(referenceAnswerWarnings([{scenarioId:s.id,scenarioVersion:s.scenarioVersion,graderVersion:s.graderVersion}])).toEqual([]);
    }
    const metadata=JSON.parse(readFileSync(new URL('../../../../data/scenarios/benchmark-meta.json',import.meta.url),'utf8'));
    expect(metadata.count).toBe(bank.filter(s=>s.status==='valid').length);
    expect(metadata).toMatchObject({count:574,ambiguousCount:0,reviewCount:0,dimensions:{reasoning_math:34}});
  });

  it('targeted sync previews only the requested four and rejects invalid subsets', () => {
    const script=fileURLToPath(new URL('../../../../scripts/sync-math-reference-contracts.mjs',import.meta.url));
    const preview=JSON.parse(execFileSync(process.execPath,[script,`--ids=${ids.join(',')}`],{encoding:'utf8'}));
    expect(preview).toMatchObject({dryRun:true,count:4});
    expect(preview.scenarios.map((s:{id:string})=>s.id)).toEqual(ids);
    for(const subset of ['', 'RM-CN-999', 'RM-CN-013,RM-CN-013'])expect(()=>execFileSync(process.execPath,[script,`--ids=${subset}`],{stdio:'pipe'})).toThrow();
  });
});
