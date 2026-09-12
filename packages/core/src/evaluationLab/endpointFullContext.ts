import {snapshotHash} from '../contracts/pack.js';
import {checkEndpointClaims, type EndpointAuditInput} from './endpointClaimAudit.js';
import {assessEndpointControl, type EndpointControl} from './endpointClaimControls.js';

/** Context preservation belongs to the host, not to the model's choice of highlights. */
export function endpointFullContext(input: EndpointAuditInput, content: string, finishReason: string, streamDone: boolean) {
  const checked = checkEndpointClaims(input, content, finishReason, streamDone);
  return {...checked, fullOriginalContext: {text: input.candidate, outputHash: snapshotHash(input.candidate)},
    highlightsAreNotCompleteEvidence: true,
    presentationRule: 'Always show the full original answer together with highlights. Never render a highlight as a standalone endorsed claim.',
    overallProofVerdict: 'unmeasured' as const, deploymentEligible: false};
}

/** New presentation-policy diagnostic, never overwrites the historical strict-anchor result. */
export function assessEndpointFullContext(control: EndpointControl, checked: ReturnType<typeof endpointFullContext>) {
  const strict = assessEndpointControl(control, checked);
  const fullContextVerified = checked.fullOriginalContext.text === control.input.candidate && checked.fullOriginalContext.outputHash === snapshotHash(control.input.candidate);
  return {policyVersion: 'host-full-original-context-v1', legacyStrictAnchorAssessment: strict,
    fullContextVerified, claimsMatch: strict.claimsMatch, issueCountMatches: strict.issueCountMatches,
    allSemanticControlsMatch: fullContextVerified && strict.claimsMatch && strict.issueCountMatches && strict.uncertainSegments.length === 0,
    contextGateChangedAfterObservedOmission: true, historicalOutcomeChanged: false,
    semanticMappingIndependentlyReviewed: false, deploymentEligible: false};
}
