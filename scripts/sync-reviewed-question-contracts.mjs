// Canonical, transactional local sync. Never updates ScenarioResult or EvalRun.
// node scripts/sync-reviewed-question-contracts.mjs /path/to/database [--apply]
import { DatabaseSync, backup } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { hashScenarioShort } from '../packages/core/dist/contracts/canonicalize.js';
const path=process.argv[2];
if(!path)throw Error('Database path required');
const apply=process.argv.includes('--apply');
const executionReview=process.argv.includes('--execution-review');
const bank=JSON.parse(readFileSync(new URL('../data/scenarios/benchmark.json',import.meta.url),'utf8'));
const reviewed=bank.filter(s=>executionReview?['code_repair','instruction_checklist','llm_judge'].includes(s.grader):['reasoning_math','hallucination_resistance','data_extraction'].includes(s.dimension));
if(reviewed.length!==(executionReview?171:168) || reviewed.some(s=>s.scenarioHash!==hashScenarioShort(s)))throw Error('Invalid reviewed bank count/hash');
const db=new DatabaseSync(path,{readOnly:!apply});
const columns=new Set(db.prepare('PRAGMA table_info(ScenarioDefinition)').all().map(c=>c.name));
const serialized=new Set(['requirements','scoring','hiddenTests','publicTests','tags']);
const keep=['id','dimension','category','difficulty','language','locale','status','tier','promptTemplate','grader','graderVersion','scoring','requirements','scenarioVersion','scenarioHash','reviewStatus','goldSource','goldVerifiedAt','outputPolicy','maxAnswerTokens','createdAt','updatedAt'];
const before={results:db.prepare('SELECT count(*) n FROM ScenarioResult').get().n,runs:db.prepare('SELECT count(*) n FROM EvalRun').get().n};
const active=db.prepare("SELECT count(*) n FROM EvalRun WHERE status IN ('running','pending','queued')").get().n;
if(!apply){console.log(JSON.stringify({dryRun:true,count:reviewed.length,before,active,scope:executionReview?'execution-review':'reviewed-dimensions'}));db.close();process.exit(0);}
if(active)throw Error('Refusing definition update while a run is active');
const backupPath=path+'.reviewed-'+Date.now()+'.bak';
await backup(db,backupPath);
db.exec('BEGIN IMMEDIATE');
try{
 for(const s of reviewed){
  const keys=(executionReview?[...keep,'sourceCode','functionName','expectedVerdict','hiddenTests','responseMode','environmentImage','seed','answerFirst','maxReasoningTokens']:keep).filter(k=>columns.has(k));
  const values=keys.map(k=>['createdAt','updatedAt'].includes(k)?Date.now():s[k]==null?null:serialized.has(k)?JSON.stringify(s[k]):k==='goldVerifiedAt'?new Date(s[k]).getTime():typeof s[k]==='boolean'?Number(s[k]):s[k]);
  const update=keys.filter(k=>k!=='id'&&k!=='createdAt').map(k=>`"${k}"=excluded."${k}"`).join(',');
  db.prepare(`INSERT INTO ScenarioDefinition (${keys.map(k=>'"'+k+'"').join(',')}) VALUES (${keys.map(()=>'?').join(',')}) ON CONFLICT(id) DO UPDATE SET ${update}`).run(...values);
 }
 if(!executionReview)db.prepare("UPDATE ScenarioDefinition SET status='retired' WHERE dimension='hallucination_resistance' AND id LIKE 'HAL-%'").run();
 const after={results:db.prepare('SELECT count(*) n FROM ScenarioResult').get().n,runs:db.prepare('SELECT count(*) n FROM EvalRun').get().n};
 if(JSON.stringify(before)!==JSON.stringify(after))throw Error('Historical row counts changed');
 db.exec('COMMIT');console.log(JSON.stringify({applied:reviewed.length,backupPath,before,after}));
}catch(e){db.exec('ROLLBACK');throw e;}finally{db.close();}
