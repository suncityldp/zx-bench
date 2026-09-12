/** Exact primal/dual, Farkas and recession-ray certificates for max c.x,
 * subject to A.x <= b and x >= 0. No candidate-supplied code is evaluated. */
import {add,mul,neg,rational,parseRational,exactKeys,type Rational} from './challengeTypes.js';
export interface LinearOptimization {a:number[][];b:number[];c:number[]}
const zero=()=>rational(0n),less=(x:Rational,y:Rational)=>x[0]*y[1]<y[0]*x[1];
const eq=(x:Rational,y:Rational)=>x[0]===y[0]&&x[1]===y[1];
const nonnegative=(v:Rational)=>v[0]>=0n;
const numeric=(v:number)=>rational(BigInt(v));
const vector=(v:unknown,n:number):Rational[]|null=>{if(!Array.isArray(v)||v.length!==n)return null;const parsed=v.map(parseRational);return parsed.every(x=>x!==null)?parsed as Rational[]:null;};
const dot=(a:number[],b:Rational[])=>a.reduce((s,x,i)=>add(s,mul(numeric(x),b[i])),zero());
export const showRational=(x:Rational)=>x[1]===1n?String(x[0]):`${x[0]}/${x[1]}`;
function validate(p:LinearOptimization){
  const n=p.c.length,m=p.b.length;
  if(n<1||n>5||m<1||m>8||p.a.length!==m||p.a.some(r=>r.length!==n)||[...p.a.flat(),...p.b,...p.c].some(x=>!Number.isSafeInteger(x)||Math.abs(x)>10000))throw new Error('Invalid bounded LP input');
}
export function verifyLinearOptimization(p:LinearOptimization,value:unknown) {
  validate(p);const n=p.c.length,m=p.b.length;
  const invalid=()=>({formatValid:false,pass:false,checks:{} as Record<string,boolean>});
  const finish=(checks:Record<string,boolean>)=>({formatValid:true,pass:Object.values(checks).every(Boolean),checks});
  const primal=(x:Rational[])=>x.every(nonnegative)&&p.a.every((a,i)=>!less(numeric(p.b[i]),dot(a,x)));
  const transpose=(y:Rational[])=>p.c.map((_,j)=>dot(p.a.map(a=>a[j]),y));
  if(exactKeys(value,['status','x','y','value'])&&value.status==='optimal'){
    const x=vector(value.x,n),y=vector(value.y,m),v=parseRational(value.value);if(!x||!y||!v)return invalid();
    const dual=y.every(nonnegative)&&transpose(y).every((a,j)=>!less(a,numeric(p.c[j])));
    return finish({primalFeasible:primal(x),dualFeasible:dual,primalValue:eq(dot(p.c,x),v),dualValue:eq(dot(p.b,y),v)});
  }
  if(exactKeys(value,['status','y'])&&value.status==='infeasible'){
    const y=vector(value.y,m);if(!y)return invalid();
    return finish({nonnegativeMultipliers:y.every(nonnegative),nonnegativeLeftSide:transpose(y).every(nonnegative),negativeRightSide:less(dot(p.b,y),zero())});
  }
  if(exactKeys(value,['status','x','ray'])&&value.status==='unbounded'){
    const x=vector(value.x,n),ray=vector(value.ray,n);if(!x||!ray)return invalid();
    return finish({primalFeasible:primal(x),nonnegativeRay:ray.every(nonnegative),recessionDirection:p.a.every(a=>!less(zero(),dot(a,ray))),positiveGain:less(zero(),dot(p.c,ray))});
  }
  return invalid();
}
