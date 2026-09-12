import {snapshotHash} from '../contracts/pack.js';

export const CHALLENGE_VERSION='capability-challenge-2026-09-10-v1.3.0';
export type Value=null|boolean|number|string|string[];
export interface EvidenceAnswer {value:Value;status:'determined'|'insufficient'|'conflict';sources:string[]}
export interface EvidenceField {id:string;question:string;expected:EvidenceAnswer;sourceAlternatives?:string[][];allowedSources?:string[]}
export interface EvidenceCase {id:string;dimension:'hallucination_resistance';family:string;title:string;documents:Record<string,string>;fields:EvidenceField[];citationPolicy?:'sufficiency-relevance-v2'}
export interface MathCase {id:string;dimension:'reasoning_math';family:string;title:string;task:string;data:unknown;reference:Record<string,unknown>}
export type ChallengeCase=EvidenceCase|MathCase;
export interface ChallengeCheck {id:string;pass:boolean}
export interface CitationDiagnostic {field:string;valid:boolean;sufficient:boolean;relevant:boolean;unsupportedSources:string[];missingByAlternative:string[][]}
export interface ChallengeGrade {id:string;formatValid:boolean;checks:ChallengeCheck[];accuracy:number|null;strictPass:boolean;scope:'structured_answers_and_certificates_only';error?:string;citationPolicy?:string;citationDiagnostics?:CitationDiagnostic[];answerPass?:boolean;evidencePass?:boolean}
export function result(id:string,checks:ChallengeCheck[],formatValid=true,error?:string):ChallengeGrade {
  return {id,formatValid,checks,accuracy:formatValid&&checks.length?checks.filter(c=>c.pass).length/checks.length:null,
    strictPass:formatValid&&checks.length>0&&checks.every(c=>c.pass),scope:'structured_answers_and_certificates_only',...(error?{error}:{})};
}
export function object(value:unknown):value is Record<string,unknown>{return value!==null&&typeof value==='object'&&!Array.isArray(value);}
export function exactKeys(value:unknown,keys:string[]):value is Record<string,unknown>{return object(value)&&Object.keys(value).length===keys.length&&keys.every(k=>Object.hasOwn(value,k));}
export const equal=(a:unknown,b:unknown)=>a!==undefined&&b!==undefined&&snapshotHash(a)===snapshotHash(b);
export function sameSet(a:unknown,b:unknown[]):boolean{return Array.isArray(a)&&new Set(a).size===a.length&&a.length===b.length&&a.every(v=>b.includes(v));}

/** Exact rational arithmetic, no float tolerance or evaluating model-supplied code. */
export type Rational=[bigint,bigint];
export function rational(n:bigint,d=1n):Rational {if(d===0n)throw new Error('Zero denominator');if(d<0n){n=-n;d=-d;}let a=n<0n?-n:n,b=d;while(b){[a,b]=[b,a%b];}return [n/a,d/a];}
export const add=(a:Rational,b:Rational)=>rational(a[0]*b[1]+b[0]*a[1],a[1]*b[1]);
export const mul=(a:Rational,b:Rational)=>rational(a[0]*b[0],a[1]*b[1]);
export const div=(a:Rational,b:Rational)=>rational(a[0]*b[1],a[1]*b[0]);
export const neg=(a:Rational):Rational=>[-a[0],a[1]];
export const fraction=(n:number|bigint,d:number|bigint=1)=>{const [a,b]=rational(BigInt(n),BigInt(d));return b===1n?String(a):`${a}/${b}`;};
export function parseRational(value:unknown):Rational|null {
  if(typeof value!=='number'&&typeof value!=='string')return null;
  const s=String(value).trim();if(s.length>100)return null;
  const f=s.match(/^([+-]?\d+)\s*\/\s*([+-]?\d+)$/);
  try{if(f)return rational(BigInt(f[1]),BigInt(f[2]));const d=s.match(/^([+-]?)(\d+(?:\.\d*)?|\.\d+)(?:[eE]([+-]?\d+))?$/);if(!d)return null;
    const [whole,decimal='']=d[2].split('.');const power=Number(d[3]??0)-decimal.length;if(Math.abs(power)>100)return null;
    const n=BigInt(d[1]+(whole||'0')+decimal);return power>=0?rational(n*10n**BigInt(power)):rational(n,10n**BigInt(-power));
  }catch{return null;}
}
export function numericEqual(a:unknown,b:unknown):boolean{const x=parseRational(a),y=parseRational(b);return !!x&&!!y&&x[0]===y[0]&&x[1]===y[1];}
/** Normalize integer certificates without rounding, coercing booleans or losing precision. */
export function exactIntegerArray(value:unknown):number[]|null{
 if(!Array.isArray(value))return null;
 const parsed=value.map(parseRational);
 if(parsed.some(x=>!x||x[1]!==1n||x[0]>BigInt(Number.MAX_SAFE_INTEGER)||x[0]<BigInt(Number.MIN_SAFE_INTEGER)))return null;
 return parsed.map(x=>Number(x![0]));
}
