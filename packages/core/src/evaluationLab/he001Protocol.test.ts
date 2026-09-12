import {describe,it,expect} from 'vitest';
import {summarizeHE001Profile,HE001_PROTOCOL_VERSION} from './he001Protocol.js';
import {he001ProtocolFixtures} from './he001ProtocolFixtures.js';
const fixtures=he001ProtocolFixtures();
const fixture=(id:string)=>fixtures.find(x=>x.id===id)!;
const profile=(id:string)=>{const f=fixture(id);return summarizeHE001Profile(f.answer,f.review);};
describe('HE-001 v3 author-labelled accounting and metamorphic controls',()=>{
 it.each(fixtures)('$id preserves uncalibrated/non-production provenance',f=>{
  expect(summarizeHE001Profile(f.answer,f.review)).toMatchObject({version:HE001_PROTOCOL_VERSION,judgeCalibrated:false,independentHumanGold:false,productionEligible:false});
 });
 it.each(['reordered_same_meaning','paraphrased_same_meaning','additional_relevant_context','quoted_error_rejected','implicit_factor_boundary'])('%s cannot change the labelled content profile',id=>{
  expect(profile(id)).toEqual(profile('supported_complete'));
 });
 it('missing citations change citation quality, not factual correctness or finding coverage',()=>{
  const full=profile('supported_complete'),missing=profile('correct_but_missing_citations');
  expect(missing.reliability).toEqual(full.reliability);expect(missing.usefulness).toEqual(full.usefulness);
  expect(missing.citation.adequacyRate).toBe(0);expect(full.citation.adequacyRate).toBe(1);
 });
 it('an otherwise complete answer cannot hide a critical overclaim behind a weighted sum',()=>{
  const g=profile('endorsed_historical_overclaim');expect(g.reliability.criticalClaims).toEqual(['C3']);
  expect(g.contentAndReasoningSatisfiedUnderSuppliedLabels).toBe(false);expect(g).not.toHaveProperty('weightedScore');
 });
 it('distinguishes missing evidence from explicit contradiction',()=>{
  const missing=profile('fabricated_independent_measurement'),conflict=profile('explicit_controller_contradiction');
  expect(missing.reliability).toMatchObject({unsupported:1,refuted:0,criticalClaims:['C6']});
  expect(conflict.reliability).toMatchObject({unsupported:0,refuted:1,criticalClaims:['C2']});
 });
 it('does not treat an unrecorded dry baseline as source-supported',()=>{
  expect(profile('invented_dry_baseline').reliability.unsupported).toBe(1);
  expect(profile('invented_dry_baseline').contentAndReasoningSatisfiedUnderSuppliedLabels).toBe(false);
 });
 it('blanket abstention has zero coverage and undefined factual precision, not 100%',()=>{
  const g=profile('blanket_abstention');expect(g.usefulness.findingCoverage).toBe(0);expect(g.reliability.supportRate).toBeNull();expect(g.contentAndReasoningSatisfiedUnderSuppliedLabels).toBe(false);
 });
 it('semantic disputes and incomplete extraction cannot produce a final support rate',()=>{
  const f=fixture('supported_complete');for(const mode of ['disputed','incomplete']){const r=structuredClone(f.review);if(mode==='disputed')r.claims[0].label='disputed';else r.claimExtraction='incomplete';const g=summarizeHE001Profile(f.answer,r);expect(g.reliability.supportRate).toBeNull();expect(g.contentAndReasoningSatisfiedUnderSuppliedLabels).toBe(false);}
 });
 it('rejects stale, missing, duplicate, fabricated span and invalid evidence reviews',()=>{
  const f=fixture('supported_complete');for(const mutate of [(r:any)=>r.version='old',(r:any)=>r.findings.pop(),(r:any)=>r.claims.push(r.claims[0]),(r:any)=>r.claims[0].quote='absent quote',(r:any)=>r.claims[0].evidence=['D999'],(r:any)=>r.claims[0].critical=true,(r:any)=>r.boundaries[0].quote=null]){const r=structuredClone(f.review);mutate(r);expect(()=>summarizeHE001Profile(f.answer,r)).toThrow();}
 });
});
