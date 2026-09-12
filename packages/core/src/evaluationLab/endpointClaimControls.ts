import {snapshotHash} from '../contracts/pack.js';
import {checkEndpointClaims, endpointPublicInput, type EndpointAuditInput} from './endpointClaimAudit.js';
type Claim = {target: string; predicate: 'all_first'|'all_last'; symbol: string; stance: string};
export interface EndpointControl {id: string; family: string; input: EndpointAuditInput; expected: Claim[]; expectedIssues: number; requiredContext: string[]}
const targets = {P1: ['a', 'ab', 'abb'], P2: ['b', 'ab', 'aab']};
const claim = (target: string, predicate: Claim['predicate'], symbol: string, stance: string): Claim => ({target, predicate, symbol, stance});
export function endpointClaimControls(): EndpointControl[] {
  const specs: Omit<EndpointControl, 'id'>[] = [
    {family: 'true_paraphrase', input: {targets, candidate: 'P1中的这些片段无一例外都由字符a起头。'}, expected: [claim('P1', 'all_first', 'a', 'asserted')], expectedIssues: 0, requiredContext: []},
    {family: 'false_assertion', input: {targets, candidate: '我的证明采用如下事实：P1的全部片段最后一个字符均为a。'}, expected: [claim('P1', 'all_last', 'a', 'asserted')], expectedIssues: 1, requiredContext: []},
    {family: 'correct_denial', input: {targets, candidate: '我明确否定这个命题：“P1的所有片段末字符都是a”。'}, expected: [claim('P1', 'all_last', 'a', 'denied')], expectedIssues: 0, requiredContext: []},
    {family: 'incorrect_denial', input: {targets, candidate: '我的结论是：说P2的片段全都以b结尾是不对的。'}, expected: [claim('P2', 'all_last', 'b', 'denied')], expectedIssues: 1, requiredContext: []},
    {family: 'unendorsed_quotation', input: {targets, candidate: '以下是引文：“P2的所有片段均以b开头”。我仅原样记录这句话，不采纳也不否定它。'}, expected: [claim('P2', 'all_first', 'b', 'quoted')], expectedIssues: 0, requiredContext: ['C1', 'C2']},
    {family: 'unestablished_condition', input: {targets, candidate: '仅作条件讨论：如果P1的所有片段均以a结尾，那么可以继续检查拼接性质。这里没有确立这个假设，也不据此作无条件推断。'}, expected: [claim('P1', 'all_last', 'a', 'conditional')], expectedIssues: 0, requiredContext: ['C1', 'C2']},
    {family: 'later_retraction', input: {targets, candidate: 'P1的所有片段都以a结尾。这是我前面的错误陈述，现在明确撤回并否定该命题。'}, expected: [claim('P1', 'all_last', 'a', 'denied')], expectedIssues: 0, requiredContext: ['C1', 'C2']},
    {family: 'target_binding', input: {targets, candidate: 'P1的片段全部以a开头。P2的片段全部以b开头。以上两条均是我的最终主张。'}, expected: [claim('P1', 'all_first', 'a', 'asserted'), claim('P2', 'all_first', 'b', 'asserted')], expectedIssues: 1, requiredContext: []},
  ];
  return specs.map(s => ({...s, id: 'EC-' + snapshotHash(s.input).slice(0, 14)}));
}
export function assessEndpointControl(control: EndpointControl, result: ReturnType<typeof checkEndpointClaims>) {
  if (result.bindingHash !== snapshotHash(control.input)) throw new Error('Result bound to different answer');
  const key = (c: Claim) => JSON.stringify([c.target, c.predicate, c.symbol, c.stance]);
  const observed = [...new Set(result.findings.map(f => key(f as Claim)))].sort(), expected = [...new Set(control.expected.map(key))].sort();
  const issues = new Set(result.findings.filter(f => f.disposition === 'potential_proof_issue_requires_mapping_review').map(f => key(f as Claim))).size;
  // Retractions may be annotated on both the original and later segment. They are one proposition.
  const contextPreserved = control.expected.every(c => {
    const ids = new Set(result.findings.filter(f => key(f as Claim) === key(c)).flatMap(f => f.context.map(s => s.id)));
    return control.requiredContext.every(id => ids.has(id));
  });
  const claimsMatch = JSON.stringify(observed) === JSON.stringify(expected), issueCountMatches = issues === control.expectedIssues;
  return {id: control.id, claimsMatch, issueCountMatches, contextPreserved, uncertainSegments: result.uncertainSegments,
    allMatch: claimsMatch && issueCountMatches && contextPreserved && result.uncertainSegments.length === 0,
    uniqueExpectedClaims: expected.length, uniqueObservedClaims: observed.length, expectedIssues: control.expectedIssues, observedIssues: issues,
    semanticMappingIndependentlyReviewed: false, deploymentEligible: false};
}
/** Oracle-shaped extraction for tests only; never included in a Judge request. */
export function endpointControlOracle(control: EndpointControl) {
  const segments = endpointPublicInput(control.input).candidateSegments;
  return segments.map((s, i) => ({segment: s.id, coverage: i === 0 ? 'claims' : 'none', claims: i === 0 ? control.expected.map(c => ({...c, context: [...new Set([s.id, ...control.requiredContext])]})) : []}));
}
