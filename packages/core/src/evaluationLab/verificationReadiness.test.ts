import {describe,it,expect} from 'vitest';
import {buildVerificationReadiness,humanReviewCalibrationEligibility} from './verificationReadiness.js';
import {readFileSync} from 'node:fs';
describe('verification-first development routing',()=>{
 it('keeps programmable math, authored rules, regression variants and open questions distinct',()=>{
  const r=buildVerificationReadiness();expect(r.items).toHaveLength(34);
  const count=(t:string)=>r.items.filter(i=>i.track===t).length;
  expect(count('executable_development_pilot')).toBe(12);expect(count('authored_evidence_rule_development')).toBe(8);expect(count('basic_regression_only')).toBe(12);expect(count('experimental_unverified')).toBe(1);
  expect(count('executable_evidence_experimental')).toBe(1);
  expect(new Set(r.items.filter(i=>i.track==='basic_regression_only').map(i=>i.family)).size).toBe(4);
  expect(r.items.every(i=>!i.productionEligible&&!i.independentExpertVerified)).toBe(true);
 });
 it('never silently promotes authored checks or collected human scores to gold',()=>{
  expect(humanReviewCalibrationEligibility({status:'single_item_review_complete'},'HR-001').eligible).toBe(false);
  expect(humanReviewCalibrationEligibility({status:'paused_reviewer_suitability',excludedCalibrationItems:['HR-001']},'HR-001')).toEqual({eligible:false,reason:'reviewer_suitability_exclusion'});
  expect(humanReviewCalibrationEligibility({status:'paused_reviewer_suitability'},'HR-002')).toEqual({eligible:false,reason:'review_paused'});
 });
 it('preserves HR-001 raw ratings but excludes them and stops further severity prompts',()=>{
  const read=(p:string)=>JSON.parse(readFileSync(new URL(`./fixtures/${p}`,import.meta.url),'utf8'));
  const review=read('human-hr001-review.json'),progress=read('human-review-progress.json');
  expect(review.levels).toEqual([1,2,2,0,2,2,2,2,2]);expect(review.weightedScore).toBe(77.5);expect(review.criticalSeverity).toBeNull();
  expect(progress.requestFurtherProfessionalRatings).toBe(false);expect(progress.pendingSeverityItems).toEqual([]);expect(progress.eligibleCalibrationItems).toBe(0);expect(progress.completedItems).toBe(0);
  expect(humanReviewCalibrationEligibility(progress,'HR-001').eligible).toBe(false);
 });
});
