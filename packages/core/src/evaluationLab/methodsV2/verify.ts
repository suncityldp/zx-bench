import {add,div,equal,exactIntegerArray,exactKeys,mul,neg,numericEqual,parseRational,rational,sameSet,type Rational} from '../challengeTypes.js';
import type {AllocationData,Case,CountingData,LinearData} from './types.js';

export interface Verification {formatValid:boolean;pass:boolean;checks:Record<string,boolean>;status?:string;error?:string}
const checked=(checks:Record<string,boolean>,formatValid=true):Verification=>({formatValid,pass:formatValid&&Object.values(checks).every(Boolean),checks});
const zero=()=>rational(0n),isZero=(x:Rational)=>x[0]===0n;
const render=(x:Rational)=>x[1]===1n?String(x[0]):`${x[0]}/${x[1]}`;
export function parseAnswer(text:string):unknown {
  if(text.length>20000)throw new Error('Answer exceeds 20,000 characters');
  const trimmed=text.trim(),fence=trimmed.match(/^```(?:json)?\s*\n([\s\S]*?)\n```$/i),source=fence?fence[1]:trimmed;
  const value=JSON.parse(source),stack:{object:boolean;keys:Set<string>;key:boolean}[]=[];
  for(const match of source.matchAll(/"(?:\\.|[^"\\])*"|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|[{}\[\],]/g)) {
    const t=match[0],top=stack.at(-1);
    if(/^-?\d/.test(t)){if(!numericEqual(t,Number(t)))throw new Error('JSON number loses precision; use a numeric string');}
    else if(t==='{'||t==='['){if(stack.length>=12)throw new Error('Excess nesting');stack.push({object:t==='{',keys:new Set(),key:true});}
    else if(t==='}'||t===']')stack.pop();
    else if(t===','){if(top)top.key=true;}
    else if(top?.object&&top.key){const k=JSON.parse(t);if(top.keys.has(k))throw new Error('Duplicate key');top.keys.add(k);top.key=false;}
  }
  return value;
}
export function feasible(d:AllocationData,selected:number[]):boolean {
  if(new Set(selected).size!==selected.length||selected.some(i=>!Number.isInteger(i)||i<0||i>=d.items.length))return false;
  const set=new Set(selected),sum=(k:'cost'|'risk')=>selected.reduce((s,i)=>s+d.items[i][k],0);
  return selected.length>=d.minCount&&sum('cost')<=d.budget&&sum('risk')<=d.riskLimit&&
    d.requires.every(([a,b])=>!set.has(a)||set.has(b))&&d.excludes.every(([a,b])=>!set.has(a)||!set.has(b));
}
export function solveAllocation(d:AllocationData):{selected:number[];gain:number} {
  if(d.items.length>18)throw new Error('Allocation oracle bounded at 18 items');
  let best={selected:[] as number[],gain:-Infinity};
  for(let mask=0;mask<2**d.items.length;mask++) {
    const selected=d.items.flatMap((_,i)=>mask&(1<<i)?[i]:[]);
    if(feasible(d,selected)){const gain=selected.reduce((s,i)=>s+d.items[i].gain,0);if(gain>best.gain)best={selected,gain};}
  }
  if(!Number.isFinite(best.gain))throw new Error('Generated allocation has no feasible solution');
  return best;
}
export function countWords(d:CountingData):bigint {
  if(d.counts.reduce((a,b)=>a+b,0)>30||d.modulus>19||d.counts.some(x=>!Number.isInteger(x)||x<0)||d.modulus<1)throw new Error('Counting oracle bounds');
  const memo=new Map<string,bigint>();
  const visit=(a:number,b:number,c:number,previousTwo:boolean,residue:number):bigint=>{
    if(a===d.counts[0]&&b===d.counts[1]&&c===d.counts[2])return residue===d.residue?1n:0n;
    const key=[a,b,c,+previousTwo,residue].join(',');if(memo.has(key))return memo.get(key)!;
    const pos=a+b+c+1;let total=0n;
    if(a<d.counts[0])total+=visit(a+1,b,c,false,residue);
    if(b<d.counts[1])total+=visit(a,b+1,c,false,(residue+pos)%d.modulus);
    if(c<d.counts[2]&&c<b&&!previousTwo)total+=visit(a,b,c+1,true,(residue+2*pos)%d.modulus);
    memo.set(key,total);return total;
  };return visit(0,0,0,false,0);
}
/** Exact RREF, tracking row operations to generate an inconsistency certificate. */
export function solveLinear(d:LinearData):Record<string,unknown> {
  const n=d.a[0]?.length,m=d.a.length;
  if(!n||n>8||m>8||d.b.length!==m||d.a.some(r=>r.length!==n))throw new Error('Linear oracle bounds');
  const a=d.a.map((row,i)=>[...row,d.b[i]].map(v=>rational(BigInt(v))));
  const transform=Array.from({length:m},(_,i)=>Array.from({length:m},(_,j)=>rational(i===j?1n:0n)));
  const pivots:number[]=[];let rank=0;
  for(let col=0;col<n&&rank<m;col++) {
    const found=a.findIndex((row,i)=>i>=rank&&!isZero(row[col]));if(found<0)continue;
    [a[rank],a[found]]=[a[found],a[rank]];[transform[rank],transform[found]]=[transform[found],transform[rank]];
    const pivot=a[rank][col];a[rank]=a[rank].map(v=>div(v,pivot));transform[rank]=transform[rank].map(v=>div(v,pivot));
    for(let i=0;i<m;i++)if(i!==rank){const f=a[i][col];a[i]=a[i].map((v,j)=>add(v,neg(mul(f,a[rank][j]))));transform[i]=transform[i].map((v,j)=>add(v,neg(mul(f,transform[rank][j]))));}
    pivots.push(col);rank++;
  }
  const contradiction=a.findIndex(row=>row.slice(0,n).every(isZero)&&!isZero(row[n]));
  if(contradiction>=0)return {kind:'inconsistent',witness:transform[contradiction].map(render)};
  const x=Array.from({length:n},zero);pivots.forEach((p,i)=>x[p]=a[i][n]);
  if(rank===n)return {kind:'unique',x:x.map(render)};
  const free=Array.from({length:n},(_,i)=>i).find(i=>!pivots.includes(i))!,direction=Array.from({length:n},zero);
  direction[free]=rational(1n);pivots.forEach((p,i)=>direction[p]=neg(a[i][free]));
  return {kind:'multiple',x:x.map(render),direction:direction.map(render)};
}
function vector(value:unknown,n:number):Rational[]|null {
  if(!Array.isArray(value)||value.length!==n)return null;
  const v=value.map(parseRational);return v.every(x=>x!==null)?v as Rational[]:null;
}
function dot(a:number[],b:Rational[]):Rational{return a.reduce((s,v,i)=>add(s,mul(rational(BigInt(v)),b[i])),zero());}
export function oracle(c:Case):Record<string,unknown> {
  if(c.kind==='evidence')return structuredClone(c.gold);
  if(c.kind==='allocation')return solveAllocation(c.data as AllocationData);
  if(c.kind==='counting')return {count:String(countWords(c.data as CountingData))};
  return solveLinear(c.data as LinearData);
}
// Oracles only accept bounded frozen generated data; never execute candidate expressions or code.
export function verify(c:Case,output:string,reference=oracle(c)):Verification {
  let value:unknown;try{value=parseAnswer(output);}catch(error){return {...checked({},false),error:String(error)};}
  if(c.kind==='evidence') {
    if(!exactKeys(value,['status','sources'])||!['supported','refuted','insufficient','conflict'].includes(String(value.status))||!Array.isArray(value.sources)||value.sources.some(s=>typeof s!=='string'))return checked({},false);
    return {...checked({stance:value.status===c.gold.status,citations:sameSet(value.sources,c.gold.sources)}),status:String(value.status)};
  }
  if(c.kind==='allocation') {
    if(!exactKeys(value,['selected','gain']))return checked({},false);
    const d=c.data as AllocationData,selected=exactIntegerArray(value.selected);
    if(!selected||!parseRational(value.gain))return checked({},false);
    const valid=feasible(d,selected),gain=valid?selected.reduce((s,i)=>s+d.items[i].gain,0):null;
    return checked({feasible:valid,reportedGain:gain!==null&&numericEqual(value.gain,gain),optimal:gain!==null&&numericEqual(gain,reference.gain)});
  }
  if(c.kind==='counting') {
    if(!exactKeys(value,['count'])||!parseRational(value.count))return checked({},false);
    return checked({exactCount:numericEqual(value.count,reference.count)});
  }
  const d=c.data as LinearData,n=d.a[0].length;
  if(exactKeys(value,['kind','witness'])&&value.kind==='inconsistent') {
    const y=vector(value.witness,d.a.length);if(!y)return checked({},false);
    return checked({classification:reference.kind==='inconsistent',leftNullspace:d.a[0].every((_,j)=>isZero(dot(d.a.map(row=>row[j]),y))),contradiction:!isZero(dot(d.b,y))});
  }
  if(!(exactKeys(value,['kind','x'])&&value.kind==='unique'||exactKeys(value,['kind','x','direction'])&&value.kind==='multiple'))return checked({},false);
  const x=vector(value.x,n);if(!x)return checked({},false);
  const checks:Record<string,boolean>={classification:equal(value.kind,reference.kind),solution:d.a.every((row,i)=>numericEqual(render(dot(row,x)),d.b[i]))};
  if(value.kind==='multiple'){const v=vector(value.direction,n);if(!v)return checked({},false);checks.nonzero=v.some(x=>!isZero(x));checks.nullspace=d.a.every(row=>isZero(dot(row,v)));}
  return checked(checks);
}
