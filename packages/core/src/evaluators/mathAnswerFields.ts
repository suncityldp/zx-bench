/** Versioned, opt-in field credit. Never scans reasoning for a correct number. */
export interface MathAnswerField { label: string; expected: string; weight: number; aliases?: Record<string,string> }
export function reviewAnswerFields(answer: string, fields: MathAnswerField[], compare: (a:string,b:string)=>number) {
  const clean=(x:string)=>x.normalize('NFKC').replace(/\*\*/g,'').replace(/\s+/g,'').replace(/[\[\]]/g,'').replace(/[，；;]/g,',');
  const text=clean(answer);
  const found=fields.map(f=>{
    const label=clean(f.label), positions:number[]=[];
    if(text.startsWith(label)) positions.push(0);
    let at=text.indexOf(','+label);
    while(at>=0){positions.push(at+1);at=text.indexOf(','+label,at+label.length+1);}
    return {label,positions};
  });
  const starts=found.flatMap(f=>f.positions).sort((a,b)=>a-b);
  const values=found.map(f=>{
    if(f.positions.length!==1)return null;
    const start=f.positions[0],end=starts.find(x=>x>start)??text.length;
    return text.slice(start+f.label.length,end===text.length?end:end-1);
  });
  const checks=fields.map((f,i)=>{
    let value=values[i];
    if(value===null)return {label:f.label,correct:false,weight:f.weight};
    for(const [from,to] of Object.entries(f.aliases??{})) value=value.split(clean(from)).join(clean(to));
    return {label:f.label,correct:compare(f.label+value,f.label+f.expected)===100,weight:f.weight};
  });
  const total=fields.reduce((n,f)=>n+f.weight,0);
  if(!fields.length||!Number.isFinite(total)||total<=0||fields.some(f=>!Number.isFinite(f.weight)||f.weight<=0)) throw Error('Invalid reviewed math fields');
  const validShape=found.every(f=>f.positions.length===1)&&found[0]?.positions[0]===0
    &&found.every((f,i)=>i===0||f.positions[0]>found[i-1].positions[0]);
  return {accuracy:100*checks.reduce((n,f)=>n+(f.correct?f.weight:0),0)/total,fields:checks,validShape,completeFields:found.every(f=>f.positions.length===1)};
}
