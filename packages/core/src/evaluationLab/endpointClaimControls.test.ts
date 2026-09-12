import {describe, expect, it} from 'vitest';
import {checkEndpointClaims, endpointPublicInput} from './endpointClaimAudit.js';
import {endpointClaimControls, endpointControlOracle, assessEndpointControl} from './endpointClaimControls.js';
describe('frozen semantic controls detect claim omissions and false endorsements', () => {
  it('checks mathematical truth and expected issue counts for all eight controls', () => {
    const controls = endpointClaimControls(); expect(controls).toHaveLength(8);
    for (const control of controls) {
      const checked = checkEndpointClaims(control.input, JSON.stringify(endpointControlOracle(control)), 'stop', true);
      expect(assessEndpointControl(control, checked).allMatch, control.family).toBe(true);
    }
  });
  it('rejects all-none extraction even when every segment is accounted for', () => {
    for (const control of endpointClaimControls()) {
      const rows = endpointPublicInput(control.input).candidateSegments.map(s => ({segment: s.id, coverage: 'none', claims: []}));
      expect(assessEndpointControl(control, checkEndpointClaims(control.input, JSON.stringify(rows), 'stop', true)).allMatch).toBe(false);
    }
  });
  it('requires the later negation context rather than an isolated mistaken sentence', () => {
    const control = endpointClaimControls().find(c => c.family === 'later_retraction')!, rows = endpointControlOracle(control);
    rows[0].claims[0].context = ['C1'];
    expect(assessEndpointControl(control, checkEndpointClaims(control.input, JSON.stringify(rows), 'stop', true)).contextPreserved).toBe(false);
  });
  it('rejects falsely asserting a quotation, even if proposition truth is known exactly', () => {
    const control = endpointClaimControls().find(c => c.family === 'unendorsed_quotation')!, rows = endpointControlOracle(control);
    rows[0].claims[0].stance = 'asserted';
    const a = assessEndpointControl(control, checkEndpointClaims(control.input, JSON.stringify(rows), 'stop', true));
    expect(a.claimsMatch).toBe(false); expect(a.observedIssues).toBe(1);
  });
});
