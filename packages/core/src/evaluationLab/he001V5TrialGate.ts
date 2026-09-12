/** Operational review receipts are not independent semantic gold. */
export function nextHE001V5Call(plan:string[],calls:{id:string;status:string;contentHash:string}[],attemptedIds:string[],reviews:Record<string,{decision:string;contentHash:string;notes:string[]}>){
 if(plan.length!==6||new Set(plan).size!==6)throw new Error('Exactly six bounded stage slots required');
 if(calls.length>=plan.length)throw new Error('Call budget exhausted');
 if(attemptedIds.length!==calls.length||new Set(attemptedIds).size!==attemptedIds.length||calls.some((c,i)=>c.id!==plan[i]||attemptedIds[i]!==plan[i]))throw new Error('Incomplete or repeated attempt blocks dispatch');
 for(const call of calls){
  if(call.status!=='structurally_valid')throw new Error('Prior stage failure blocks dispatch');
  const review=reviews[call.id];
  if(!review||review.decision!=='continue'||review.contentHash!==call.contentHash||!review.notes?.some(n=>n.trim()))throw new Error('Matching operational review required before next call');
 }
 return plan[calls.length];
}
