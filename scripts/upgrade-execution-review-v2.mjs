// Idempotent contract migration; never touches model outputs, scores or running jobs.
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { hashScenarioShort } from '../packages/core/dist/contracts/canonicalize.js';
const bankPath = new URL('../data/scenarios/benchmark.json', import.meta.url);
const bank = JSON.parse(readFileSync(bankPath, 'utf8'));
const constraint = (id, type, description, check) => ({ id, type, description, check });
const updates = {
  'IF-CN-026': [constraint('tree', 'format', '真实父子嵌套：1家公司、3个部门且每部门2个职位；缩进0/2/4空格', {pattern:'^'+[0,2,4,4,2,4,4,2,4,4].map(n=>' '.repeat(n)+'[-*+] [^\\r\\n]+').join('\\r?\\n')+'(?:\\r?\\n)?$'})],
  'IF-CN-023': [constraint('paragraphs', 'paragraph_structure', '春天美好四段；每段3句，每句不超过20字；仅汉字、标点与空白', { starts: ['春','天','美','好'], sentencesPerParagraph: 3, maxSentenceChars: 20 })],
  'IF-CN-024': [constraint('timeline', 'numeric_sequence', '至少5个递增年份节点，首年<1970、末年>2020，每个描述1–30字且无额外行', { linePattern: '^【[0-9]{4}】[^【】\\r\\n]{1,30}$', valuePattern: '^【([0-9]{4})】', order: 'asc', minRows: 5, firstLessThan: 1970, lastGreaterThan: 2020 })],
  'IF-CN-027': [constraint('animals', 'line_structure', '5种指定动物依次排列；奇数条句号，偶数条难道…吗？；每行不超过25字', { linePattern: '^【([^【】]+)】.+[。？]$', exactRows: 5, uniqueGroup: 1, maxChars: 25, oddPattern: '。$', evenPattern: '^【[^【】]+】难道.+吗？$' }), constraint('size-order', 'exact_order', '按题面给定体型顺序', { patterns: ['【蚂蚁】','【蜜蜂】','【麻雀】','【家猫】','【大象】'] })],
  'IF-CN-034': [constraint('sequence', 'format', '逐行核对1–20以及每个数字对应标注，不接受标注总数代替对应关系', { pattern: '^' + Array.from({length:20},(_,i)=>{const n=i+1;return n+(n%15===0?'（十五）':n%3===0?'（三）':n%5===0?'（五）':'');}).join('\\r?\\n') + '\\s*$' })],
  'IF-CN-036': [constraint('sentences', 'sentence_structure', '5句每句12汉字；末句以未来结尾；第2句含第4句首字', {count:5,hanChars:12,lastSuffix:'未来',secondContainsFourthFirst:true}), constraint('no-de','exclusion','不得出现的字',{patterns:['的']}), constraint('intelligence','exact_count','智能恰好3次',{target:'智能',count:3})],
  'IF-CN-039': [constraint('references','section_reference','真实跨部分标题引用、首句复现、每部分2句及B的2行代码块',{}),constraint('forbidden','exclusion','不得出现注意',{patterns:['注意']})],
};
const prGroups = {
  'PR-ELITE-012': {
    F1: [['none','密钥','key','DEBUG'],['绕过','不可信','控制','校验','验证','信任','bypass','untrusted']],
    F2: [['并发','竞态','race','concurrent'],['重复','扣款','原子','atomic','duplicate']],
    F3: [['拼接','插值','interpolat','concatenat'],['注入','injection']],
    F4: [['PAN','CVV','卡号','card'],['日志','明文','记录','log','plaintext']],
    F5: [['风格','转换','String','插值']],
  },
  'PR-ELITE-013': {
    A1: [['双写','dual'],['对账','回填','reconcil','backfill']],
    A2: [['回滚','rollback'],['读','可见','旧库','read','visibility']],
    A3: [['租户','tenant'],['热点','62%','摊平','分散','hotspot']],
    A4: [['灰度','kill-switch','停用','canary'],['全局','部署','开关','global','deploy']],
    A5: [['跨分片','cross-shard'],['事务','抛错','降级','transaction','throw']],
    A6: [['FNV','哈希','hash']],
  },
};
const prContract = '\n\n输出契约：仅返回严格 JSON，不使用代码块：{"findings":[{"file":"diff中的完整文件路径","area":"基准领域（如题面有定义）","severity":"critical|high|medium|low|nit","problem":"明确断言的问题","impact":"失效条件和影响","suggestion":"具体修复步骤","evidence":"该文件一段新增行原文，不含diff前导+，至少8字符"}],"reasonableDecisions":["不应升级为缺陷的合理选择及理由"],"conclusion":"approve|approve_with_comments|request_changes|block"}。area可省略；其余字段不可省略。每条finding只描述一个问题；不要输出基准编号。不得把条件性风险断言为已发生的事故。';
const changed = [];
for (const s of bank) {
  if (s.grader === 'instruction_checklist') {
    s.graderVersion = 'instruction_checklist_v5';
    s.scenarioVersion = '3.0.0';
    if (updates[s.id]) s.requirements.constraints = updates[s.id];
    for (const c of s.requirements.constraints ?? []) if (c.type === 'inclusion') c.check.matchMode = s.id.startsWith('CP-L3-AW-PLAN') ? 'positive' : 'literal';
    if (s.id === 'IF-CN-029') s.requirements.constraints[0].check.requireAll = true;
    if (s.id === 'IF-CN-027') s.promptTemplate = '请为蚂蚁、蜜蜂、麻雀、家猫、大象各写一条描述。本题以这个给定次序代表体型从小到大，只评分指令结构，不评价动物知识真实性。\n要求：恰好5行，依次使用上述5种动物，每行格式为【动物名】内容。奇数行用以。结尾的陈述句；偶数行用“难道…吗？”格式。每行（含标签、标点，不含空白）不超过25字，不加开头结尾。';
    if (s.id === 'IF-CN-039' && !s.promptTemplate.includes('标题格式固定')) s.promptTemplate += '\n\n标题格式固定为独占一行的“A：自拟标题”“B：自拟标题”“C：自拟标题”，不得有前言。每部分的2句话指正文，以。！？结尾；B中的代码块不计入句子数，代码块恰好2行。A须提到C的实际标题文字；C须逐字复现A的第一句（含句末标点），不能写“部分A的第一句话”占位。';
  } else if (s.grader === 'code_repair') {
    s.graderVersion = '3.4.0';
    s.scenarioVersion = '3.0.0';
  } else if (s.grader === 'llm_judge') {
    s.graderVersion = '2.0.0'; s.scenarioVersion = '3.0.0'; s.language = 'pr_review';
    s.requirements.judge_config.require_structured_output = true;
    s.requirements.judge_config.rubric_version = 'pr-evidence-v2';
    for (const g of s.requirements.judge_ground_truth) {
      g.conceptGroups = prGroups[s.id][g.id];
      // Areas were not disclosed to candidates; ground findings by actual diff file instead.
      if (s.id === 'PR-ELITE-013') { g.file = g.id === 'A5' ? 'src/sharding/router.ts' : g.id === 'A6' ? 'src/sharding/hash.ts' : 'docs/rfc/0021-tenant-sharding.md'; delete g.area; }
      if (g.id === 'A1') g.finding = '缺少历史回填与双写差异对账，切读时可能读到缺失或不一致数据；需要校验与修复路径，不能声称必然且不可逆。';
    }
    s.requirements.prompt = s.requirements.prompt.replace('4 文件 PR','5 文件 PR');
    s.promptTemplate = s.promptTemplate.replace('4 文件 PR','5 文件 PR');
    const context = s.id === 'PR-ELITE-012'
      ? '\n评审边界：string.ts的v限定为普通字符串或有限数字；JWT风险须说明PUBLIC_KEY缺失、DEBUG开关或库行为等触发条件，不假定未知依赖版本必然接受无签名。幂等检查包括合并后仍保留的并发风险，不要求把既有缺陷说成本次引入。'
      : '\n评审边界：评估题面明确给出的迁移与路由约束；不能把缺少校验的风险断言为必然且永久不可恢复。';
    if (!s.promptTemplate.includes('输出契约：仅返回严格 JSON')) s.promptTemplate += context + prContract;
    if (!s.requirements.prompt.includes('输出契约：仅返回严格 JSON')) s.requirements.prompt += context + prContract;
    // Remove answer-bearing editorial comments while retaining operational facts.
    for (const key of ['promptTemplate']) s[key] = s[key].replaceAll('   // 无 NX / 无原子性','').replaceAll('// FNV-1a —— 选择合理，无需质疑','// FNV-1a');
    s.requirements.diff = s.requirements.diff.replaceAll('   // 无 NX / 无原子性','').replaceAll('// FNV-1a —— 选择合理，无需质疑','// FNV-1a');
  } else continue;
  // Automated contract audit is not independent human approval.
  s.scenarioHash = hashScenarioShort(s);
  changed.push({id:s.id,grader:s.grader,graderVersion:s.graderVersion,scenarioHash:s.scenarioHash});
}
writeFileSync(bankPath, JSON.stringify(bank,null,1)+'\n');
const metaPath = new URL('../data/scenarios/benchmark-meta.json', import.meta.url);
const meta = JSON.parse(readFileSync(metaPath,'utf8'));
meta.version='1.5.0'; meta.executionReview='code-3.4-instruction-5-pr-2';
writeFileSync(metaPath, JSON.stringify(meta,null,1)+'\n');
const sources = [
  'packages/core/src/evaluators/codeRepair.ts','packages/core/src/evaluators/instructionChecklist.ts','packages/core/src/evaluators/llmJudge.ts',
  'packages/core/src/sandbox/index.ts', ...['completion','containerRunner','phpRunner','bashRunner','cRunner','csharpRunner','goRunner','javaRunner','rustRunner','sqlRunner'].map(f=>'packages/core/src/execution/'+f+'.ts'),
];
const sourceHashes = Object.fromEntries(sources.map(path=>[path,createHash('sha256').update(readFileSync(new URL('../'+path,import.meta.url),'utf8').replaceAll('\r\n','\n')).digest('hex')]));
writeFileSync(new URL('../data/scenarios/execution-review-manifest.json',import.meta.url),JSON.stringify({version:'execution-review-2026-09-12',reviewType:'automated-contract-and-regression-audit',independentHumanReview:false,sourceHashNormalization:'UTF-8, CRLF to LF',sourceHashes,scenarios:changed},null,2)+'\n');
console.log(JSON.stringify({updated:changed.length,counts:changed.reduce((a,s)=>(a[s.grader]=(a[s.grader]??0)+1,a),{})}));
