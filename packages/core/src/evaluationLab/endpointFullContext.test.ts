import {describe, expect, it} from 'vitest';
import {endpointClaimControls, endpointControlOracle} from './endpointClaimControls.js';
import {endpointFullContext, assessEndpointFullContext} from './endpointFullContext.js';
describe('host context adapter removes model-dependent excerpt completeness', () => {
  it('preserves an omitted qualification without rewriting the historical failed gate', () => {
    const c = endpointClaimControls().find(c => c.family === 'unendorsed_quotation')!, rows = endpointControlOracle(c);
    rows[0].claims[0].context = ['C1'];
    const checked = endpointFullContext(c.input, JSON.stringify(rows), 'stop', true), assessment = assessEndpointFullContext(c, checked);
    expect(checked.fullOriginalContext.text).toContain('不采纳也不否定');
    expect(assessment.legacyStrictAnchorAssessment.allMatch).toBe(false);
    expect(assessment.allSemanticControlsMatch).toBe(true);
    expect(assessment.deploymentEligible).toBe(false);
  });
  it('does not excuse wrong stance, missing claims or altered context', () => {
    const c = endpointClaimControls().find(c => c.family === 'later_retraction')!, rows = endpointControlOracle(c);
    rows[0].claims[0].stance = 'asserted';
    const checked = endpointFullContext(c.input, JSON.stringify(rows), 'stop', true);
    expect(assessEndpointFullContext(c, checked).allSemanticControlsMatch).toBe(false);
    const correct = endpointFullContext(c.input, JSON.stringify(endpointControlOracle(c)), 'stop', true);
    expect(assessEndpointFullContext(c, {...correct, fullOriginalContext: {...correct.fullOriginalContext, text: 'clipped'}}).allSemanticControlsMatch).toBe(false);
    const missing = endpointControlOracle(c).map(r => ({...r, coverage: 'none', claims: []}));
    expect(assessEndpointFullContext(c, endpointFullContext(c.input, JSON.stringify(missing), 'stop', true)).allSemanticControlsMatch).toBe(false);
  });
});
