import {type MathCase,type Rational,rational,add,mul,div,neg,fraction,numericEqual,sameSet,exactKeys,exactIntegerArray,equal,result} from './challengeTypes.js';

export function permutations<T>(values:T[]):T[][]{if(!values.length)return [[]];return values.flatMap((v,i)=>permutations(values.filter((_,j)=>i!==j)).map(t=>[v,...t]));}
const route={nodes:['S','A','B','C','D','E','F'],travel:[[0,4,7,3,8,6,9],[5,0,3,7,4,8,6],[6,4,0,5,7,3,8],[4,6,3,0,5,7,4],[7,5,6,4,0,3,5],[6,7,4,8,5,0,3],[8,5,7,3,4,6,0]],windows:[[0,80],[0,24],[5,30],[0,28],[14,42],[12,45],[15,48]],service:[0,2,1,2,1,2,1],precedence:[['A','D'],['B','E']],forbidden:[['C','D']]};
export function simulateRoute(order:unknown){
 if(!Array.isArray(order)||!sameSet(order,route.nodes.slice(1))||route.precedence.some(([a,b])=>order.indexOf(a)>order.indexOf(b)))return null;
 let time=0,previous=0;const arrivals:number[]=[];
 for(const name of order){const next=route.nodes.indexOf(name);if(route.forbidden.some(([a,b])=>a===route.nodes[previous]&&b===name))return null;
   time+=route.travel[previous][next];time=Math.max(time,route.windows[next][0]);if(time>route.windows[next][1])return null;
   arrivals.push(time);time+=route.service[next];previous=next;
 }return {arrivals,finish:time+route.travel[previous][0]};
}
const flow={jobs:[{id:'J1',p:[4,7,3]},{id:'J2',p:[2,5,8]},{id:'J3',p:[6,3,5]},{id:'J4',p:[3,8,2]},{id:'J5',p:[7,2,6]},{id:'J6',p:[5,4,7]},{id:'J7',p:[2,6,4]}],m2Unavailable:[10,16],precedence:['J2','J6']};
export function simulateThreeMachine(order:unknown){
 if(!Array.isArray(order)||!sameSet(order,flow.jobs.map(j=>j.id))||order.indexOf('J2')>order.indexOf('J6'))return null;
 const machine=[0,0,0],completion:number[][]=[];
 for(const id of order){const job=flow.jobs.find(j=>j.id===id)!;const row:number[]=[];
   for(let m=0;m<3;m++){let start=Math.max(machine[m],row[m-1]??0);if(m===1&&start<16&&start+job.p[m]>10)start=16;
     machine[m]=start+job.p[m];row.push(machine[m]);}completion.push(row);
 }return {completion,makespan:machine[2]};
}
const projects={budget:18,staff:12,requiredSkills:['x','y','z'],items:[
 {id:'A',cost:5,staff:3,value:12,skills:['x']},{id:'B',cost:4,staff:3,value:10,skills:['y']},
 {id:'C',cost:6,staff:4,value:15,skills:['z']},{id:'D',cost:3,staff:2,value:8,skills:['x','y']},
 {id:'E',cost:5,staff:3,value:14,skills:['z']},{id:'F',cost:2,staff:2,value:6,skills:['y']},
 {id:'G',cost:4,staff:2,value:11,skills:['x','z']},{id:'H',cost:3,staff:2,value:9,skills:['y','z']},
 ],requires:[['E','A'],['H','B']],exclusive:[['C','G'],['D','F']]};
export function evaluateProjects(selected:unknown){
 if(!Array.isArray(selected)||new Set(selected).size!==selected.length||selected.some(id=>!projects.items.some(p=>p.id===id)))return null;
 const entries=projects.items.filter(p=>selected.includes(p.id));const cost=entries.reduce((a,p)=>a+p.cost,0),staff=entries.reduce((a,p)=>a+p.staff,0),value=entries.reduce((a,p)=>a+p.value,0);
 if(cost>projects.budget||staff>projects.staff||projects.requires.some(([a,b])=>selected.includes(a)&&!selected.includes(b))||projects.exclusive.some(([a,b])=>selected.includes(a)&&selected.includes(b))||projects.requiredSkills.some(s=>!entries.some(p=>p.skills.includes(s))))return null;
 return {cost,staff,value};
}
export function countConstrainedWords(){
 const memo=new Map<string,number>();
 function count(z:number,o:number,t:number,last:number,mod:number):number{
   if(z>6||o>4||t>4||t>o)return 0;const pos=z+o+t;if(pos===14)return mod===3?1:0;
   const key=[z,o,t,last,mod].join(',');if(memo.has(key))return memo.get(key)!;
   let n=count(z+1,o,t,0,mod)+count(z,o+1,t,1,(mod+pos+1)%7);
   if(last!==2)n+=count(z,o,t+1,2,(mod+2*(pos+1))%7);memo.set(key,n);return n;
 }
 const first=[count(1,0,0,0,0),count(0,1,0,1,1),0];return {total:first.reduce((a,b)=>a+b,0),by_first:first};
}
export function urnReference(){
 function enumerate(colors:string[]){let event=0,eventThenRed=0;
   for(let a=0;a<10;a++)for(let b=0;b<10;b++)if(b!==a)for(let c=0;c<10;c++)if(c!==a&&c!==b){const drawn=[a,b,c].map(i=>colors[i]);
     if(drawn.filter(x=>x==='G').length!==1||!drawn.includes('R'))continue;event++;
     for(let d=0;d<10;d++)if(d!==a&&d!==b&&d!==c&&colors[d]==='R')eventThenRed++;
   }return {event,eventThenRed};
 }
 const a=enumerate([...('RRRRRBBBGG')]),b=enumerate([...('RRBBBBBGGG')]);const weighted=2*a.event+3*b.event;
 return {event_a:fraction(a.event,720),event_b:fraction(b.event,720),posterior_a:fraction(2*a.event,weighted),next_red:fraction(2*a.eventThenRed+3*b.eventThenRed,7*weighted)};
}
export const transitions:Record<number,number[]>={1:[0,2,3],2:[1,3,4],3:[0,2,4,5],4:[1,3,5]};
function solveLinear(matrix:Rational[][]):Rational[]{const a=matrix.map(row=>row.map(([n,d])=>rational(n,d)));const n=a.length;
 for(let col=0;col<n;col++){const pivot=a.findIndex((row,i)=>i>=col&&row[col][0]!==0n);if(pivot<0)throw new Error('Singular oracle');[a[col],a[pivot]]=[a[pivot],a[col]];
   const p=a[col][col];a[col]=a[col].map(x=>div(x,p));for(let row=0;row<n;row++)if(row!==col){const factor=a[row][col];a[row]=a[row].map((x,j)=>add(x,neg(mul(factor,a[col][j]))));}}
 return a.map(row=>row[n]);
}
export function markovReference(){function solve(time:boolean){return solveLinear([1,2,3,4].map(i=>{const targets=transitions[i],row=Array.from({length:5},()=>rational(0n));row[i-1]=rational(1n);row[4]=time?rational(1n):rational(BigInt(targets.includes(0)?1:0),BigInt(targets.length));
   for(const t of targets)if(t!==0&&t!==5)row[t-1]=add(row[t-1],rational(-1n,BigInt(targets.length)));return row;
 })).map(([n,d])=>fraction(n,d));}return {p:solve(false),e:solve(true)};}
export function congruenceReference(){const roots32=Array.from({length:32},(_,i)=>i).filter(x=>x*x%32===1),roots27=Array.from({length:27},(_,i)=>i).filter(x=>x*x%27===4);
 const solutions=Array.from({length:6048},(_,i)=>i).filter(x=>x*x%32===1&&x*x%27===4&&x%7===5);return {roots32,roots27,solutions};}
export const graph={vertices:Array.from({length:12},(_,i)=>i+1),protected:[1,4],edges:[[1,2],[2,3],[3,1],[4,5],[5,6],[6,4],[7,8],[8,9],[9,7],[10,11],[11,12],[12,10],[2,5],[3,7],[6,10],[8,11],[9,12],[1,8],[4,11]]};
export function bipartition(deleted:unknown){
 if(!Array.isArray(deleted)||new Set(deleted).size!==deleted.length||deleted.some(v=>!graph.vertices.includes(v)||graph.protected.includes(v)))return null;
 const color=new Map<number,number>();for(const start of graph.vertices){if(deleted.includes(start)||color.has(start))continue;color.set(start,0);const queue=[start];
   for(let k=0;k<queue.length;k++){const v=queue[k];for(const [a,b]of graph.edges){const u=a===v?b:b===v?a:null;if(u===null||deleted.includes(u))continue;
     if(color.has(u)){if(color.get(u)===color.get(v))return null;}else{color.set(u,1-color.get(v)!);queue.push(u);}}}}
 return {part_a:[...color].filter(([,c])=>c===0).map(([v])=>v),part_b:[...color].filter(([,c])=>c===1).map(([v])=>v)};
}

let cache:MathCase[]|undefined;
export function buildMathChallenges():MathCase[]{if(cache)return structuredClone(cache);
 const routes=permutations(route.nodes.slice(1)).map(order=>({order,sim:simulateRoute(order)})).filter(r=>r.sim).sort((a,b)=>a.sim!.finish-b.sim!.finish);
 const schedules=permutations(flow.jobs.map(j=>j.id)).map(order=>({order,sim:simulateThreeMachine(order)})).filter(r=>r.sim).sort((a,b)=>a.sim!.makespan-b.sim!.makespan);
 const choices=Array.from({length:256},(_,mask)=>projects.items.filter((_,i)=>mask&(1<<i)).map(p=>p.id)).map(selected=>({selected,sim:evaluateProjects(selected)})).filter(r=>r.sim).sort((a,b)=>b.sim!.value-a.sim!.value);
 const deletions=Array.from({length:4096},(_,mask)=>graph.vertices.filter((_,i)=>mask&(1<<i))).sort((a,b)=>a.length-b.length).map(deleted=>({deleted,parts:bipartition(deleted)})).filter(r=>r.parts);
 if(!routes.length||!schedules.length||!choices.length||!deletions.length)throw new Error('Infeasible challenge design');
 const wrap=(id:string,family:string,title:string,task:string,data:unknown,reference:Record<string,unknown>):MathCase=>({id,dimension:'reasoning_math',family,title,task,data,reference});
 cache=[
 wrap('MC2-001','time-window-asymmetric-routing','有时间窗和先后约束的闭合路线',
 '从 S 在时刻 0 出发，访问 A—F 各一次后返回 S。travel 行列按 nodes 排列，是有向行驶时间；windows 约束服务开始时刻（含边界），早到可等待，service 是服务时长。precedence 中前者须先访问，forbidden 禁止对应有向路段。目标是最早回到 S。输出 order（只含 A—F）、arrivals（按 order 的服务开始时刻）、finish（回到 S 的时刻）。任一全局最优路线均可。',route,{order:routes[0].order,...routes[0].sim!}),
 wrap('MC2-002','three-machine-outage-flowshop','三机器停机与全局最优排程',
 '每个工件依次在 M1、M2、M3 上加工；p 是三段时长。所有工件时刻 0 可用，每台机器同时只能加工一件，不可抢占。三台机器使用同一工件排列；固定排列后每段尽早开始。M2 在 [10,16) 不可使用，加工区间不能与其相交，恰在 10 结束或 16 开始允许；J2 须排在 J6 之前。求全局最短完工时间。输出 order、completion（按 order 每件在三台机器的完成时刻矩阵）、makespan。任一最优排列均可。',flow,{order:schedules[0].order,...schedules[0].sim!}),
 wrap('MC2-003','precedence-budgeted-set-selection','前置依赖与资源约束下的项目组合',
 '每个项目最多选择一次，cost、staff、value 可加；总 cost 不超过 budget，总 staff 不超过 staff；每个 requiredSkills 至少被一个所选项目覆盖。requires=[a,b] 表示选 a 必须选 b，exclusive 中两个项目不能同时选。最大化总 value。输出 selected（ID 数组，顺序不限）、cost、staff、value；任何最优组合均可。',projects,{selected:choices[0].selected,...choices[0].sim!}),
 wrap('MC2-004','prefix-constrained-modular-counting','前缀约束与模条件的精确计数',
 '长度 14 的字符串由 0、1、2 组成，恰有 6 个 0、4 个 1、4 个 2；每个前缀中数字 1 的数量不少于数字 2 的数量；不得出现相邻 22。\n将字符串从左到右依次编号为 1 至 14。把每一位的数字乘以它的位置编号，再把这 14 个乘积相加。所得总和除以 7，余数必须为 3。\n例如，仅演示这种求和方法：短字符串 1021 的总和为 1×1 + 2×0 + 3×2 + 4×1 = 11；11 除以 7 余 4，所以不满足“余数为 3”的条件。这个短例子不属于本题待计数的 14 位字符串。\n求满足上述全部条件的字符串数量。输出 total 与 by_first（首位依次为 0、1、2 的数量数组）；相同字符不可当作有标签的不同对象。',{},countConstrainedWords()),
 wrap('MC2-005','conditional-mixture-without-replacement','隐含来源下的不放回条件概率',
 '先以 2/5 的概率选箱 A、3/5 选箱 B。A 有红 5、蓝 3、绿 2 球，B 有红 2、蓝 5、绿 3 球。同箱内各球等概率，每次不放回。观察前 3 次恰有 1 个绿球且至少 1 个红球，记事件 E。仍从所选箱抽第 4 球。输出 event_a=P(E|A)、event_b=P(E|B)、posterior_a=P(A|E)、next_red=P(第4球红|E)。必须用精确分数或精确等价小数，不得用近似小数。',{},urnReference()),
 wrap('MC2-006','absorbing-chain-exact-linear-certificate','吸收过程的精确概率与等待时间',
 '状态 0 和 5 为吸收态。每一步在当前状态的邻接列表中等概率选一个下一状态；不同步的随机选择独立。输出 p（从 1、2、3、4 出发先到 0 而非 5 的概率）与 e（从 1、2、3、4 出发到任一吸收态所需步数期望）。数组顺序固定，使用精确分数或精确等价小数；这两个完整向量须同时满足各状态递推关系。',transitions,markovReference()),
 wrap('MC2-007','composite-modular-root-completeness','复合模数下的全部整数解',
 '求 0≤x<6048 中全部满足 x²≡1 (mod 32)、x²≡4 (mod 27)、x≡5 (mod 7) 的整数。输出 roots32（0..31 的第一式全部根）、roots27（0..26 的第二式全部根）、solutions（全部 x）。三个数组顺序不限，但不得重复或漏解。',{},congruenceReference()),
 wrap('MC2-008','protected-vertex-bipartization','保护顶点约束下的最小删除构造',
 '给定简单无向图，删除尽量少的顶点使剩余诱导图为二分图；protected 顶点不得删除。输出 deleted（删除顶点）、minimum（最少删除数）、part_a、part_b（剩余顶点的完整不重叠划分）。任一最优删除方案及有效划分均可，所有数组顺序不限。',graph,{deleted:deletions[0].deleted,minimum:deletions[0].deleted.length,...deletions[0].parts!}),
 ];return structuredClone(cache);
}

function numericArray(a:unknown,b:unknown):boolean{return Array.isArray(a)&&Array.isArray(b)&&a.length===b.length&&a.every((x,i)=>Array.isArray(x)?numericArray(x,b[i]):numericEqual(x,b[i]));}
export function gradeMath(c:MathCase,a:unknown){
 if(!exactKeys(a,Object.keys(c.reference)))return result(c.id,[],false,'Response keys do not match the task');
 const checks:{id:string;pass:boolean}[]=[];const check=(id:string,pass:unknown)=>checks.push({id,pass:!!pass});
 if(c.id==='MC2-001'){const sim=simulateRoute(a.order);check('feasible_route',sim);check('arrival_certificate',sim&&numericArray(a.arrivals,sim.arrivals));check('reported_time',sim&&numericEqual(a.finish,sim.finish));check('global_optimum',sim&&sim.finish===c.reference.finish);}
 else if(c.id==='MC2-002'){const sim=simulateThreeMachine(a.order);check('feasible_permutation',sim);check('completion_certificate',sim&&numericArray(a.completion,sim.completion));check('reported_time',sim&&numericEqual(a.makespan,sim.makespan));check('global_optimum',sim&&sim.makespan===c.reference.makespan);}
 else if(c.id==='MC2-003'){const sim=evaluateProjects(a.selected);check('constraints',sim);for(const k of ['cost','staff','value']as const)check(k,sim&&numericEqual(a[k],sim[k]));check('global_optimum',sim&&sim.value===c.reference.value);}
 else if(c.id==='MC2-008'){const normalized=exactIntegerArray(a.deleted),partA=exactIntegerArray(a.part_a),partB=exactIntegerArray(a.part_b);
   const valid=bipartition(normalized);check('valid_deletion',valid);check('global_minimum',valid&&normalized&&normalized.length===c.reference.minimum&&numericEqual(a.minimum,c.reference.minimum));
   const parts=partA&&partB?[...partA,...partB]:null;
   const deleted=normalized??[];
   const remaining=graph.vertices.filter(v=>!deleted.includes(v));
   check('partition_covers_remaining',valid&&sameSet(parts,remaining));
   check('every_edge_crosses',valid&&parts&&sameSet(parts,remaining)&&graph.edges.every(([u,v])=>!remaining.includes(u)||!remaining.includes(v)||partA!.includes(u)!==partA!.includes(v)));}
 else for(const [key,value]of Object.entries(c.reference))check(key,Array.isArray(value)?c.id==='MC2-007'?sameSet(exactIntegerArray(a[key]),value):numericArray(a[key],value):numericEqual(a[key],value));
 return result(c.id,checks);
}
