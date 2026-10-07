import ts from 'typescript';

type Input={solution:string;cases:{id:string;kind:'positive'|'negative';code:string}[]};
const PREAMBLE='type Equal<X,Y>=(<T>()=>T extends X?1:2) extends (<T>()=>T extends Y?1:2)?true:false;\n';
const FILE='/solution.ts';
const OPTIONS:ts.CompilerOptions={strict:true,noEmit:true,noResolve:true,target:ts.ScriptTarget.ES2020,module:ts.ModuleKind.ESNext,skipLibCheck:true,types:[]};
function diagnostics(code:string){const text=PREAMBLE+code,sf=ts.createSourceFile(FILE,text,ts.ScriptTarget.ES2020,true);const base=ts.createCompilerHost(OPTIONS);const host:ts.CompilerHost={...base,getSourceFile:(f,l,onErr,nf)=>f===FILE?sf:base.getSourceFile(f,l,onErr,nf),fileExists:f=>f===FILE||base.fileExists(f),readFile:f=>f===FILE?text:base.readFile(f)};return ts.getPreEmitDiagnostics(ts.createProgram([FILE],OPTIONS,host)).filter(d=>d.category===ts.DiagnosticCategory.Error);}
const messages=(ds:readonly ts.Diagnostic[])=>ds.map(d=>ts.flattenDiagnosticMessageText(d.messageText,'\n'));
let raw='';process.stdin.setEncoding('utf8');process.stdin.on('data',c=>raw+=c);process.stdin.on('end',()=>{try{const x=JSON.parse(raw)as Input;const compileErrors=messages(diagnostics(x.solution));const cases=x.cases.map(c=>{const ds=diagnostics(x.solution+'\n'+c.code),offset=PREAMBLE.length+x.solution.length+1;const e=messages(ds);const semanticRejection=ds.some(d=>d.file?.fileName===FILE&&(d.start??-1)>=offset&&d.code>=2000&&![2304,2307,2503,2552,2451,2688].includes(d.code));return{id:c.id,errors:e,passed:compileErrors.length===0&&(c.kind==='positive'?e.length===0:semanticRejection)}});process.stdout.write(JSON.stringify({compileErrors,cases}))}catch(e){process.stderr.write(e instanceof Error?e.message:String(e));process.exitCode=1}});
