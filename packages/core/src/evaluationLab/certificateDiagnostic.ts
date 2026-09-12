import {parseAnswer} from './methodsV2/verify.js';
/** Diagnostic only. Never mutates raw text, picks a highest-scoring object, or repairs syntax. */
export function certificateDiagnostic(raw:string){
  try{parseAnswer(raw);return {state:'whole_answer' as const,certificate:raw,start:0,end:raw.length,extraProse:false};}catch{}
  const fences=[...raw.matchAll(/```json\s*\r?\n([\s\S]*?)```/g)];
  if(fences.length!==1)return {state:'unresolved' as const,certificate:null,reason:'requires_exactly_one_explicit_json_fence'};
  const match=fences[0],text=match[1],start=match.index!+match[0].indexOf(text);
  try{parseAnswer(text);}catch{return {state:'unresolved' as const,certificate:null,reason:'invalid_fenced_json'};}
  return {state:'explicit_single_json_fence' as const,certificate:text,start,end:start+text.length,extraProse:true,
    caveat:'Certificate-only diagnostic; full-answer semantic consistency still requires review. Primary score unchanged.'};
}
