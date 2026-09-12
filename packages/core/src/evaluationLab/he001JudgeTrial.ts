import {summarizeHE001Profile,type HE001ProfileReview} from './he001Protocol.js';

/** Restricted validator for the frozen HE-001 schema; fail closed on new keywords. */
export function checkHE001Schema(value:unknown,schema:any,path='$'):void {
  const known=['type','enum','properties','required','additionalProperties','minLength','items','minItems','maxItems','uniqueItems'];
  if(Object.keys(schema).some(k=>!known.includes(k)))throw new Error('Unsupported frozen-schema keyword');
  const types=Array.isArray(schema.type)?schema.type:[schema.type];
  const matches=(t:string)=>t==='null'?value===null:t==='array'?Array.isArray(value):t==='object'?value!==null&&typeof value==='object'&&!Array.isArray(value):t==='integer'?Number.isInteger(value):typeof value===t;
  if(!types.some(matches))throw new Error(`${path}: type`);
  if(schema.enum&&!schema.enum.some((x:unknown)=>JSON.stringify(x)===JSON.stringify(value)))throw new Error(`${path}: enum`);
  if(typeof value==='string'&&schema.minLength!==undefined&&Array.from(value).length<schema.minLength)throw new Error(`${path}: minLength`);
  if(Array.isArray(value)){
    if(value.length<(schema.minItems??0)||value.length>(schema.maxItems??Infinity))throw new Error(`${path}: array length`);
    if(schema.uniqueItems&&new Set(value.map(x=>JSON.stringify(x))).size!==value.length)throw new Error(`${path}: duplicate`);
    if(schema.items)value.forEach((v,i)=>checkHE001Schema(v,schema.items,`${path}[${i}]`));
  }else if(value!==null&&typeof value==='object'){
    const obj=value as Record<string,unknown>;
    for(const k of schema.required??[])if(!Object.hasOwn(obj,k))throw new Error(`${path}.${k}: required`);
    for(const k of Object.keys(obj)){
      if(!Object.hasOwn(schema.properties??{},k)){if(schema.additionalProperties===false)throw new Error(`${path}.${k}: extra`);}
      else checkHE001Schema(obj[k],schema.properties[k],`${path}.${k}`);
    }
  }
}

export function parseHE001Judgment(answer:string,content:string,finishReason:string,schema:unknown){
  if(finishReason!=='stop')throw new Error(finishReason==='length'?'judge_truncated':'judge_non_stop_finish');
  const parsed=JSON.parse(content);
  checkHE001Schema(parsed,schema);
  const review=parsed as HE001ProfileReview;
  return {review,profile:summarizeHE001Profile(answer,review)};
}

/** Only CR/LF may differ. Recover one unique contiguous ORIGINAL span; never
 * edit semantic labels or discard spaces, punctuation, words, or numbers. */
export function resolveHE001LineBreakSpan(answer:string,quote:string){
  if(answer.includes(quote))return {quote,start:answer.indexOf(quote),end:answer.indexOf(quote)+quote.length,changed:false};
  const positions:number[]=[];let flat='';
  for(let i=0;i<answer.length;i++)if(answer[i]!=='\r'&&answer[i]!=='\n'){flat+=answer[i];positions.push(i);}
  const needle=quote.replace(/[\r\n]/g,'');
  if(!needle)throw new Error('Empty normalized quote');
  const at=flat.indexOf(needle);
  if(at<0||flat.indexOf(needle,at+1)>=0)throw new Error('Absent or ambiguous newline-only span');
  const start=positions[at],end=positions[at+needle.length-1]+1;
  return {quote:answer.slice(start,end),start,end,changed:true};
}

export function parseHE001JudgmentWithLineBreaks(answer:string,content:string,finishReason:string,schema:unknown){
  let strictValidationPassed=false;
  try{parseHE001Judgment(answer,content,finishReason,schema);strictValidationPassed=true;}catch{}
  if(finishReason!=='stop')throw new Error(finishReason==='length'?'judge_truncated':'judge_non_stop_finish');
  const original=JSON.parse(content);checkHE001Schema(original,schema);
  const review=structuredClone(original) as HE001ProfileReview;
  const lineBreakResolutions:{path:string;originalQuote:string;resolvedQuote:string;start:number;end:number}[]=[];
  const resolveQuote=(row:{quote:string|null},path:string)=>{
    if(row.quote===null)return;
    const resolved=resolveHE001LineBreakSpan(answer,row.quote);
    if(resolved.changed){lineBreakResolutions.push({path,originalQuote:row.quote,resolvedQuote:resolved.quote,start:resolved.start,end:resolved.end});row.quote=resolved.quote;}
  };
  for(const name of ['claims','findings','boundaries'] as const)review[name].forEach((row,i)=>resolveQuote(row,`${name}[${i}].quote`));
  resolveQuote(review.verification,'verification.quote');
  return {review,profile:summarizeHE001Profile(answer,review),quotePolicy:'unique_original_span_CR_LF_only_v1',strictValidationPassed,lineBreakResolutions};
}

/** Exactly one HTTP POST. No compatibility retry, redirect, SDK or model fallback. */
export async function postHE001Once(url:string,key:string,body:unknown,signal:AbortSignal,request:typeof fetch=fetch){
  signal.throwIfAborted();
  return request(url,{method:'POST',redirect:'error',headers:{'Content-Type':'application/json',Authorization:`Bearer ${key}`,Connection:'close'},body:JSON.stringify(body),signal});
}
