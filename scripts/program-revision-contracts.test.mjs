import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {reviseProgramScenario,PROGRAM_REVISION} from './revise-program-contracts.mjs';
const bank=JSON.parse(fs.readFileSync(new URL('../data/scenarios/benchmark.json',import.meta.url),'utf8'));
test('program corrections are explicit, limited and idempotent',()=>{
 const revised=bank.filter(s=>s.requirements?.programRevision===PROGRAM_REVISION);
 assert.equal(revised.length,15);
 assert.ok(revised.every(s=>s.dimension==='program'));
 for(const s of bank)assert.deepEqual(reviseProgramScenario(s),s);
});
test('original C# entrypoints are complete and API harness has no hidden Program visibility demand',()=>{
 for(const id of ['CP-L4-CS-001','CP-L4-CS-002']){
  const s=bank.find(s=>s.id===id),entry=s.requirements.files.find(f=>f.path.endsWith('/Program.cs'));
  assert.ok(!entry.content.includes('...'));
  assert.match(entry.content,/var app = builder.Build/);
  const context=s.requirements.files.find(f=>f.path.endsWith('/AppDbContext.cs'));
  assert.match(context.content,/public AppDbContext\(DbContextOptions<AppDbContext> options\)/);
  assert.match(context.content,/if \(!ob.IsConfigured\)/);
 }
 const api=bank.find(s=>s.id==='CP-L4-CS-002');
 assert.match(api.promptTemplate,/events\/count/);
 assert.ok(!api.requirements.hiddenTestFiles.find(f=>f.path.endsWith('/Harness.cs')).content.includes('WebApplicationFactory<Program>'));
});
test('deliberate false-premise traps retain their original prompts and code',()=>{
 const fingerprints={
  'PR-ELITE-001':['043e66635e54ee1f959d12a39405b74c19722d313f1e197af9eb6928e8c7843b','137f4e0935b12fd20bc1df83c3c8234582518a13356e65ed705e66cb21c22ddd'],
  'PR-ELITE-002':['7e2fe4fe37e868b01215cb0df28b8f2a5a37bc27c77c61947186e171e65f139b','86a3c97de83528ea2782df5414b6d93d0cf02a1d258db9a5e12bb4230cbf306b'],
  'PR-ELITE-004':['0c9e49c8bd1fe1283825a19731e4a69215348b021cd0e506d4620f39e32ef777','b4501b73336278a428606f8b0a3de7a68e8fad08ec2ba42be55d5ae181b3c0a9'],
  'PR-ELITE-005':['4de99341728024df0f51ae3b33cdea4d5ca8f4d4f42d5a73645d8733975e1612','c3b95ff8f73e94a0b3b6430970e803721c4656a7b3fb0a411574a655fd2d3fb0'],
 };
 const hash=text=>createHash('sha256').update(text).digest('hex');
 for(const [id,[prompt,source]] of Object.entries(fingerprints)) {
  const s=bank.find(s=>s.id===id);
  assert.equal(s.expectedVerdict,'no_bug');assert.equal(s.requirements.isCorrectCodeTrap,true);
  assert.equal(hash(s.promptTemplate),prompt);assert.equal(hash(s.sourceCode),source);
  assert.equal(s.requirements.programRevision,undefined);
 }
});
