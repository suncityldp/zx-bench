/** Exact regular-language partition certificate checker.
 * Proves prefix/suffix recurrence decompositions by exhausting reachable product
 * automaton states, not by extrapolating a few small numerical examples.
 * No model code, regex execution or LLM-generated gold is executed here.
 */
export interface PartitionProblem {alphabet:string[];forbidden:string[];minLength:number}
export interface PartitionCertificate {side:'prefix'|'suffix';pieces:string[]}
export interface PartitionWitness {kind:'missing'|'overlap'|'invalid';word:string;matchingPieces:number[]}
interface Nfa {start:number;accept:Set<number>;edges:Map<string,number[]>;epsilon:Map<number,number[]>}
function validate(p:PartitionProblem,c:PartitionCertificate) {
  if(p.alphabet.length<1||p.alphabet.length>3||new Set(p.alphabet).size!==p.alphabet.length||p.alphabet.some(a=>a.length!==1))throw new Error('Alphabet must contain 1..3 unique single-code-unit symbols');
  const validWord=(w:unknown):w is string=>typeof w==='string'&&w.length<=8&&[...w].every(x=>p.alphabet.includes(x));
  if(p.forbidden.length>8||p.forbidden.some(w=>!validWord(w)||!w.length)||new Set(p.forbidden).size!==p.forbidden.length)throw new Error('Invalid forbidden patterns');
  if(!Number.isInteger(p.minLength)||p.minLength<0||p.minLength>8||!['prefix','suffix'].includes(c.side)||c.pieces.length<1||c.pieces.length>8||c.pieces.some(w=>!validWord(w)||!w.length))throw new Error('Invalid partition certificate');
}
export function verifyRegularPartition(problem:PartitionProblem,certificate:PartitionCertificate,stateLimit=10000) {
  validate(problem,certificate);
  if(!Number.isInteger(stateLimit)||stateLimit<1||stateLimit>10000)throw new Error('Invalid state bound');
  // DFA remembers the longest suffix which is a proper prefix of a forbidden word.
  const prefixes=[...new Set(['',...problem.forbidden.flatMap(w=>Array.from({length:w.length},(_,i)=>w.slice(0,i)))])];
  const step=(state:number,symbol:string)=>{
    if(state<0)return -1;const text=prefixes[state]+symbol;
    if(problem.forbidden.some(w=>text.endsWith(w)))return -1;
    let best=0;prefixes.forEach((p,i)=>{if(p.length>prefixes[best].length&&text.endsWith(p))best=i;});return best;
  };
  const branches=certificate.pieces.map(piece=>{
    const nfa:Nfa={start:0,accept:new Set(),edges:new Map(),epsilon:new Map()};
    const edge=(from:number,symbol:string,to:number)=>{const key=from+':'+symbol;nfa.edges.set(key,[...(nfa.edges.get(key)??[]),to]);};
    if(certificate.side==='suffix') {
      // L · piece; choose the boundary through epsilon transitions from any accepting L state.
      const chain=prefixes.length;
      prefixes.forEach((_,i)=>{for(const a of problem.alphabet){const next=step(i,a);if(next>=0)edge(i,a,next);}nfa.epsilon.set(i,[chain]);});
      [...piece].forEach((a,i)=>edge(chain+i,a,chain+i+1));nfa.accept.add(chain+piece.length);
    }else {
      // piece · L. The fixed prefix is followed by a fresh L automaton.
      [...piece].forEach((a,i)=>edge(i,a,i+1));const offset=piece.length+1;nfa.epsilon.set(piece.length,[offset]);
      prefixes.forEach((_,i)=>{nfa.accept.add(offset+i);for(const a of problem.alphabet){const next=step(i,a);if(next>=0)edge(offset+i,a,offset+next);}});
    }
    return nfa;
  });
  const closure=(nfa:Nfa,states:number[])=>{const found=new Set(states),queue=[...states];for(let i=0;i<queue.length;i++)for(const n of nfa.epsilon.get(queue[i])??[])if(!found.has(n)){found.add(n);queue.push(n);}return [...found].sort((a,b)=>a-b);};
  type State={target:number;branches:number[][];lengthBucket:number;parent:number;symbol:string};
  const initial:State={target:0,branches:branches.map(nfa=>closure(nfa,[nfa.start])),lengthBucket:0,parent:-1,symbol:''};
  const queue:State[]=[initial],key=(s:State)=>JSON.stringify([s.target,s.branches,s.lengthBucket]),seen=new Set([key(initial)]);
  const witnesses:PartitionWitness[]=[],kinds=new Set<string>();
  const wordAt=(i:number)=>{let result='';while(queue[i].parent>=0){result=queue[i].symbol+result;i=queue[i].parent;}return result;};
  for(let i=0;i<queue.length;i++) {
    const s=queue[i];
    if(s.lengthBucket>=problem.minLength){
      const matches=s.branches.flatMap((states,j)=>states.some(n=>branches[j].accept.has(n))?[j]:[]),targetAccept=s.target>=0;
      const kind=targetAccept&&matches.length===0?'missing':!targetAccept&&matches.length>0?'invalid':matches.length>1?'overlap':null;
      if(kind&&!kinds.has(kind)){witnesses.push({kind,word:wordAt(i),matchingPieces:matches});kinds.add(kind);}
    }
    for(const symbol of problem.alphabet) {
      const next:State={target:step(s.target,symbol),branches:s.branches.map((states,j)=>closure(branches[j],states.flatMap(n=>branches[j].edges.get(n+':'+symbol)??[]))),
        lengthBucket:Math.min(problem.minLength,s.lengthBucket+1),parent:i,symbol};
      const encoded=key(next);if(seen.has(encoded))continue;
      if(queue.length>=stateLimit)throw new Error('Product-state limit reached; result is unmeasured, not a proof');
      seen.add(encoded);queue.push(next);
    }
  }
  return {pass:witnesses.length===0,proof:'exhaustive_reachable_product_automaton' as const,reachableStates:queue.length,witnesses,
    scope:'All words over the fixed alphabet with length >= minLength; pieces concatenate an arbitrary word of the SAME forbidden-pattern language.',
    problem,certificate};
}
