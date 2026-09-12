import {readFileSync} from 'node:fs';
import {describe,it,expect} from 'vitest';
import {HE001_REFERENCE_AUDIT,verifyHE001ReferenceLedger} from './he001ReferenceAudit.js';
const question=readFileSync(new URL('./fixtures/he001-question.md',import.meta.url),'utf8');
describe('HE-001 source-audit provenance (not semantic verification)',()=>{
  it('links all 12 ledger entries to exact original question quotes',()=>{
    expect(verifyHE001ReferenceLedger(question)).toEqual({checkedQuotes:12,allQuotesPresent:true,semanticVerification:false,independentExpertVerified:false,productionEligible:false});
  });
  it('does not promote source-backed author work to expert gold',()=>{
    expect(HE001_REFERENCE_AUDIT).toMatchObject({methodReview:'primary_sources_consulted_by_same_author',semanticReview:'author_rechecked_not_independent',independentExpertVerified:false,judgeCalibrated:false,productionEligible:false});
  });
  it('rejects stale or missing quoted evidence',()=>{
    expect(()=>verifyHE001ReferenceLedger(question.replace(HE001_REFERENCE_AUDIT.ledger[0].quote,''))).toThrow('R01');
  });
});
