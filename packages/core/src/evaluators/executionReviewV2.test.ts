import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import type { Scenario, OutputMetadata } from '@zxbench/types';
import { instructionChecklistEvaluator as instruction } from './instructionChecklist.js';
import { llmJudgeEvaluator as pr } from './llmJudge.js';
import { hashScenarioShort } from '../contracts/canonicalize.js';
import { callModel } from '../model/caller.js';
vi.mock('../model/caller.js',()=>({callModel:vi.fn()}));
const bank=JSON.parse(readFileSync('data/scenarios/benchmark.json','utf8')) as Scenario[];
const metadata={finishReason:'stop',truncated:false,incomplete:false} as OutputMetadata;
const get=(id:string)=>bank.find(s=>s.id===id)!;
const check=(id:string,text:string)=>instruction.evaluate(get(id),text,metadata);
describe('frozen instruction v5 contracts',()=>{
  it('freezes all 171 contracts and the scoring/execution source fingerprint',()=>{
    const manifest=JSON.parse(readFileSync('data/scenarios/execution-review-manifest.json','utf8'));
    expect(manifest.scenarios).toHaveLength(171);
    for(const row of manifest.scenarios) expect(hashScenarioShort(get(row.id))).toBe(row.scenarioHash);
    for(const [path,hash] of Object.entries(manifest.sourceHashes)) expect(createHash('sha256').update(readFileSync(path,'utf8').replaceAll('\r\n','\n')).digest('hex'),path).toBe(hash);
    expect(manifest.independentHumanReview).toBe(false);
  });
  it('all current configurations are measurable and every updated hash matches',async()=>{
    for(const s of bank.filter(s=>s.grader==='instruction_checklist')){
      const r=await instruction.evaluate(s,'占位文本。',metadata);
      expect(r.environmentError,s.id+': '+r.evidence?.join('\n')).not.toBe(true);
      expect(s.scenarioHash,s.id).toBe(hashScenarioShort(s));
    }
  });
  it('configuration defects are unmeasured, not model failures',async()=>{
    for(const constraints of [[],[null],[{id:'x',type:'format',check:{pattern:'['}}],[{id:'x',type:'inclusion',check:{patterns:[]}}]]){
      const r=await instruction.evaluate({requirements:{constraints}} as unknown as Scenario,'anything',metadata);
      expect(r.environmentError).toBe(true);expect(r.axisCoverage).toBe(0);expect(r.humanReviewRequired).toBe(true);
    }
  });
  it('literal inclusion is independent of assertion/negation',async()=>{
    const s={requirements:{constraints:[{id:'word',type:'inclusion',description:'含花',check:{patterns:['花'],matchMode:'literal'}}]}} as unknown as Scenario;
    expect((await instruction.evaluate(s,'这里没有花。',metadata)).axisScores?.instruction_compliance).toBe(100);
  });
  it('checks all paragraph initials and per-paragraph sentences',async()=>{
    const good=['春风来了。花儿开了。鸟儿唱了。','天气暖了。小草绿了。流水响了。','美景来了。阳光暖了。云朵散了。','好梦醒了。孩子笑了。田野绿了。'].join('\n\n');
    expect((await check('IF-CN-023',good)).totalScore).toBe(100);
    expect((await check('IF-CN-023',good.replace('天气','气天'))).totalScore).toBeLessThan(100);
  });
  it('timeline accepts MORE than five nodes and enforces endpoints/order',async()=>{
    const good=[1969,1980,1990,2000,2010,2021].map(y=>`【${y}】网络发展`).join('\n');
    expect((await check('IF-CN-024',good)).totalScore).toBe(100);
    for(const bad of [good.replace('1969','1971'),good.replace('2021','2020'),good.replace('1990','1979')]) expect((await check('IF-CN-024',bad)).totalScore).toBeLessThan(100);
  });
  it('FizzBuzz validates each annotation, not just total word counts',async()=>{
    const good=Array.from({length:20},(_,i)=>{const n=i+1;return n+(n%15===0?'（十五）':n%3===0?'（三）':n%5===0?'（五）':'')}).join('\n');
    expect((await check('IF-CN-034',good)).totalScore).toBe(100);
    expect((await check('IF-CN-034',good.replace('3（三）','3（五）').replace('5（五）','5（三）'))).totalScore).toBeLessThan(100);
  });
  it('checks actual titles and sentences across sections',async()=>{
    const good='A：总览\n我们介绍收尾部分。这里解释背景。\nB：过程\n先做检查。然后执行。\n```js\nconst x = 1;\nx;\n```\nC：收尾\n我们介绍收尾部分。工作已经完成。';
    expect((await check('IF-CN-039',good)).totalScore).toBe(100);
    expect((await check('IF-CN-039',good.replace('C：收尾','C：结束'))).totalScore).toBeLessThan(100);
    expect((await check('IF-CN-039','部分 C 的标题，部分 A 的第一句话。')).totalScore).toBeLessThan(100);
  });
  it('sentence relations admit a genuine solution and reject a wrong cross-reference/suffix',async()=>{
    const good='智能技术推动产业持续升级。智能工具帮助未来工作提效。智能系统支持城市交通优化。未雨绸缪推动研究稳步向前。人机协同持续创造美好未来。';
    expect((await check('IF-CN-036',good)).totalScore).toBe(100);
    expect((await check('IF-CN-036',good.replace('未雨','雨未'))).totalScore).toBeLessThan(100);
    expect((await check('IF-CN-036',good.replace('美好未来','美好前程'))).totalScore).toBeLessThan(100);
  });
  it('requires two children under EACH department, not just correct aggregate counts',async()=>{
    const good='- 公司\n  - 研发部\n    - 工程师\n    - 测试员\n  - 财务部\n    - 会计\n    - 出纳\n  - 销售部\n    - 销售员\n    - 客服';
    expect((await check('IF-CN-026',good)).totalScore).toBe(100);
    expect((await check('IF-CN-026',good.replace('  - 财务部\n    - 会计','    - 会计\n  - 财务部'))).totalScore).toBeLessThan(100);
  });
  it('checks alternating sentence format and unique animals',async()=>{
    const good='【蚂蚁】蚂蚁会搬运食物。\n【蜜蜂】难道蜜蜂不会采蜜吗？\n【麻雀】麻雀会飞行。\n【家猫】难道家猫不会捕鼠吗？\n【大象】大象有长鼻子。';
    expect((await check('IF-CN-027',good)).totalScore).toBe(100);
    expect((await check('IF-CN-027',good.replace('【蜜蜂】','【蚂蚁】'))).totalScore).toBeLessThan(100);
  });
});
describe('PR v2 evidence-grounded matching',()=>{
  const fixture=()=>({requirements:{diff:'--- a/query.ts\n+++ b/query.ts\n+db.query(`SELECT ${name}`);',judge_config:{require_structured_output:true},judge_ground_truth:[{id:'injection',file:'query.ts',severity:'critical',finding:'SQL injection',keywords:['注入','拼接'],conceptGroups:[['注入'],['拼接']]}]}} as unknown as Scenario);
  const finding={file:'query.ts',severity:'critical',problem:'存在拼接导致的SQL注入风险',impact:'外部输入可改变查询语义',suggestion:'建议改为参数化查询并绑定参数',evidence:'db.query(`SELECT ${name}`);'};
  const output=(findings:unknown[],reasonableDecisions=['另一处风格改动无问题'])=>JSON.stringify({findings,reasonableDecisions,conclusion:'request_changes'});
  it('a harmless decision elsewhere cannot erase a genuine finding',async()=>{
    const r=await pr.evaluate(fixture(),output([finding]),metadata);
    expect(r.axisScores?.critical_findings_recall).toBe(100);expect(r.totalScore).toBe(100);
  });
  it.each([{problem:'query.ts存在问题'},{file:'wrong.ts'},{evidence:'invented evidence'},{problem:'没有注入和拼接问题'}])('rejects filename-only, wrong-file, fabricated-evidence or denied claim',async patch=>{
    const r=await pr.evaluate(fixture(),output([{...finding,...patch}]),metadata);
    expect(r.axisScores?.critical_findings_recall).toBe(0);expect(r.humanReviewRequired).toBe(true);
  });
  it('one submitted finding cannot satisfy duplicate gold findings',async()=>{
    const s=fixture();const req=s.requirements as any;req.judge_ground_truth.push({...req.judge_ground_truth[0],id:'second'});
    const r=await pr.evaluate(s,output([finding]),metadata);expect(r.axisScores?.critical_findings_recall).toBe(50);
  });
  it('invalid or fenced JSON is not silently parsed as a successful review',async()=>{
    for(const text of ['```json\n'+output([finding])+'\n```','{"findings":[]}',output([{...finding,severity:undefined}])]){
      expect((await pr.evaluate(fixture(),text,metadata)).totalScore).toBe(0);
    }
  });
  it('Judge truncation cannot silently become a heuristic verified score',async()=>{
    vi.mocked(callModel).mockResolvedValue({content:'{"score":99',finishReason:'length'} as any);
    const r=await pr.evaluate(fixture(),output([finding]),metadata,undefined,{} as any);
    expect(r.axisEvidence?.actionable_feedback).toBe('unmeasured');expect(r.humanReviewRequired).toBe(true);
  });
  it('area-only legacy fixtures have nonzero coverage when actually detected',async()=>{
    const s={requirements:{judge_ground_truth:[{id:'x',area:'迁移',severity:'high',finding:'缺少回填',keywords:['回填']}]}} as unknown as Scenario;
    const r=await pr.evaluate(s,'high 迁移存在缺少回填风险，建议增加回填。',metadata);
    expect(r.axisScores?.diff_coverage).toBe(100);
  });
});
