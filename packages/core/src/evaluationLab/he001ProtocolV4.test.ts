import {describe,it,expect} from 'vitest';
import {readFileSync} from 'node:fs';
import {he001SourceBodies,he001VisibleSourceIds,parseHE001V4,validateHE001V4Schema,HE001_V4} from './he001ProtocolV4.js';
import {he001V4Fixtures,he001V4EvidenceControls} from './he001ProtocolV4Fixtures.js';
import {he001ProtocolFixtures} from './he001ProtocolFixtures.js';
const question=readFileSync(new URL('./fixtures/he001-question.md',import.meta.url),'utf8');
const sources=he001SourceBodies(question),fixtures=he001V4Fixtures(sources);
const fixture=(id='supported_complete')=>structuredClone(fixtures.find(x=>x.id===id)!);
const parse=(f=fixture())=>parseHE001V4(f.answer,JSON.stringify(f.review),'stop',sources);

describe('HE-001 v4 opt-in structure and literal-span checks, not semantic calibration',()=>{
 it('extracts six bodies without treating the task or document headings as source evidence',()=>{
  expect(Object.keys(sources)).toEqual(['D1','D2','D3','D4','D5','D6']);
  expect(sources.D3).toContain('25℃');expect(sources.D6).toContain('未附新增测量记录');
  expect(Object.values(sources).join('')).not.toMatch(/##|最后提出一项/);
 });
 it.each(fixtures)('$id is structurally processable but remains uncalibrated',f=>{
  expect(()=>validateHE001V4Schema(f.review)).not.toThrow();
  const p=parse(f);expect(p.profile).toMatchObject({version:HE001_V4,judgeCalibrated:false,independentHumanGold:false,productionEligible:false});
  expect(p.verification).toMatchObject({structureAndQuotedSpansChecked:true,normalizedStatementMeaningChecked:false,evidenceEntailmentChecked:false,judgeReasonFactualityChecked:false,independentGold:false,productionEligible:false});
 });
 it('does not silently migrate saved v3 Judge output',()=>{
  const f=he001ProtocolFixtures()[0];expect(()=>parseHE001V4(f.answer,JSON.stringify(f.review),'stop',sources)).toThrow();
 });
 it('rejects supported + criticalError in both schema and processing',()=>{
  const f=fixture();f.review.claims[0].criticalError=true;
  expect(()=>validateHE001V4Schema(f.review)).toThrow();expect(()=>parse(f)).toThrow();
 });
 it('rejects the old ambiguous critical property',()=>{
  const f=fixture();(f.review.claims[0] as any).critical=false;expect(()=>parse(f)).toThrow(/extra critical/);
 });
 it('requires a contradiction entry for refuted, not just an arbitrary D number',()=>{
  const f=fixture('explicit_controller_contradiction');expect(parse(f).profile.reliability.refuted).toBe(1);
  f.review.claims[1].evidence.forEach(e=>e.relation='context');expect(()=>validateHE001V4Schema(f.review)).toThrow();expect(()=>parse(f)).toThrow();
 });
 it('rejects an evidence excerpt from the wrong source document',()=>{
  const f=fixture();f.review.claims[0].evidence[0].quote=sources.D4;expect(()=>parse(f)).toThrow();
 });
 it('allows normalized negation to differ from its complete literal scope',()=>{
  const f=fixture('shared_negation_separate_statements'),c=f.review.claims.find(c=>c.id==='C5-3')!;
  expect(c.statement).toContain('不能证明永久修复');expect(c.quote).not.toContain('不能证明永久修复');expect(()=>parse(f)).not.toThrow();
  c.quote='不能证明永久修复';expect(()=>parse(f)).toThrow();
 });
 it('tolerates only recoverable line breaks and records the correction',()=>{
  const f=fixture();f.review.verification.quote=f.review.verification.quote!.replace(/[\r\n]/g,'');
  const p=parse(f);expect(p.resolutions).toHaveLength(1);expect(p.resolutions[0].path).toBe('verification.quote');
  f.review.claims[0].quote=f.review.claims[0].quote.replace('S17','S 17');expect(()=>parse(f)).toThrow();
 });
 it('missing citations cannot silently retain quoted evidence or material IDs',()=>{
  const f=fixture();f.review.claims[0].citation.label='missing';expect(()=>parse(f)).toThrow();
 });
 it('adequate/partial citations require actual candidate source IDs',()=>{
  for(const label of ['adequate','partial'] as const){const f=fixture();f.review.claims[0].citation={label,sources:['D3'],quote:'五班次未停机是有效观察',reason:'不能靠Judge自己补引用。'};expect(()=>parse(f)).toThrow(/Citation source absent/);}
 });
 it('recognizes inline and range citations without matching identifier fragments',()=>{
  expect(he001VisibleSourceIds('正文D3未给出；材料D1—D6。')).toEqual(['D1','D2','D3','D4','D5','D6']);
  expect(he001VisibleSourceIds('ID3 D30 D3_ fooD4')).toEqual([]);
 });
 it('corrects the author anchor: stripping parentheses alone is NOT stripping every citation',()=>{
  const f=fixture('parenthetical_citations_removed_inline_D3_kept'),p=parse(f);
  expect(he001VisibleSourceIds(f.answer)).toEqual(['D3']);
  expect(f.review.claims[0].citation).toMatchObject({label:'partial',sources:['D3']});
  expect(p.profile.reliability).toEqual(parse().profile.reliability);
  expect(p.profile.citation.partial).toBe(1);expect(p.profile.citation.missing).toBe(5);
 });
 it('an actually ID-free answer loses citation credit, not factual support or coverage',()=>{
  const f=fixture('no_explicit_material_ids'),p=parse(f),b=parse();expect(he001VisibleSourceIds(f.answer)).toEqual([]);
  expect(p.profile.reliability).toEqual(b.profile.reliability);expect(p.profile.usefulness).toEqual(b.profile.usefulness);
  expect(p.profile.citation.adequacyRate).toBe(0);expect(p.profile.citation.missing).toBe(6);
 });
 it('literal matching cannot prove that a claimed evidence relation or reason is true',()=>{
  const f=fixture();f.review.claims[0].statement='不在候选中的错误主张';f.review.claims[0].reason='S29在82℃高湿下在校准允差内。';
  const p=parse(f);expect(p.verification.normalizedStatementMeaningChecked).toBe(false);expect(p.verification.judgeReasonFactualityChecked).toBe(false);expect(p.verification.productionEligible).toBe(false);
  f.review.claims[0].label='refuted';f.review.claims[0].evidence[0].relation='contradicts';expect(parse(f).verification.evidenceEntailmentChecked).toBe(false);
 });
 it('rejects truncation, fenced JSON, duplicate normalized claims and unknown schema keywords',()=>{
  const f=fixture();expect(()=>parseHE001V4(f.answer,JSON.stringify(f.review),'length',sources)).toThrow();
  expect(()=>parseHE001V4(f.answer,'```json\n'+JSON.stringify(f.review)+'\n```','stop',sources)).toThrow();
  f.review.claims[1].statement=f.review.claims[0].statement;expect(()=>parse(f)).toThrow(/Duplicate/);
  expect(()=>validateHE001V4Schema({}, {unknown:true})).toThrow(/Unsupported/);
 });
 it('evidence-switch controls keep the assertion fixed, not the source, and are not new benchmark items',()=>{
  const controls=he001V4EvidenceControls();expect(new Set(controls.map(x=>x.answer)).size).toBe(1);expect(new Set(controls.map(x=>x.source)).size).toBe(3);
  expect(controls.map(x=>x.expectedLabel)).toEqual(['unsupported','refuted','supported']);
  expect(controls.every(x=>x.origin.includes('not_benchmark_question_or_independent_gold'))).toBe(true);
 });
});
