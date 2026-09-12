import type {EvidenceCase} from './challengeTypes.js';

/** Versioned coordinator-only rubric review. Do not infer relevance from model votes.
 * Each entry is [minimal sufficient chain, relevant additional context].
 * Public prompts and value/status gold remain unchanged. Missing an indispensable
 * source still fails; unrelated or invented citations never gain credit.
 */
export const CITATION_REVIEW:Record<string,Record<string,[string[],string[]]>>={
 'HC3-001':{
  r17_tested_repair:[['D1'],['D2']],
  tested_system:[['D4'],['D2','D6']],
  // The question already states the claim. D6 locates the corrected citation,
  // D4 identifies the tested system, and D5 bars transfer to Lumen.
  lumen_result_supported:[['D4','D5','D6'],['D2','D3']],
  lumen_deployed_repair:[['D7'],['D1']],
 },
 'HC3-002':{
  randomized_main_scheme:[['D2'],['D1']],
  reminder_finding:[['D2','D3'],[]], // Design is essential to the randomized-trial claim.
  main_causal_claim:[['D1','D4'],['D2','D3','D6']],
  c_time_replication:[['D5'],['D6']],
 },
 'HC3-003':{
  national_approved:[['D4'],['D1','D2','D3','D6']],
  pilot_approved:[['D4'],['D1','D5']],
  announcement_proves_national:[['D1','D5'],['D4','D6']],
  // Roadmap is conditional; the final decision leaves approval outstanding.
  // A local pilot's announcement is context, not indispensable to this unknown date.
  national_actual_date:[['D2','D4'],['D1','D3','D5','D6']],
 },
 'HC3-004':{
  quote_faithful:[['D1','D2'],[]],
  production_reproduced:[['D4'],['D1','D3']],
  sensor_replaced:[['D5'],['D3']],
  sensor_root_cause:[['D5'],['D1','D3','D4','D6']],
 },
 'HC3-006':{
  certificate_holder:[['D2'],['D1','D3']],
  // D2 states exclusive scope; D5 explicitly excludes transfer to C104.
  x_covers_c104:[['D2','D5'],['D1','D3','D4']],
  prototype_tested:[['D6'],['D1']],
  c104_any_certificate:[['D7'],['D2','D4','D5','D6']],
 },
 'HC3-007':{
  production_mode:[['D1','D2','D3','D5'],[]], // Exclusivity and authority are both material.
  staging_mode:[['D4'],['D1']],
  f_observed_later:[['D2','D3'],['D1']],
  changed_between_dates:[['D2','D3','D5','D6'],['D1']],
 },
 'HC2-005':{
  a_affected:[['D2','D3','D5'],['D1']],
  b_affected:[['D2','D3','D5'],['D1']],
  c_affected:[['D2','D3','D4','D5'],['D1','D6']],
  ui_safe:[['D1'],['D5']],
 },
 'HC2-008':{
  r_publication:[['D1','D5'],[]],
  r_recusals:[['D2','D3'],['D4']],
  r_quorum:[['D2','D3'],['D4']],
  s_eligible:[['D1','D6'],[]],
  s_awarded:[['D7'],['D1','D6']],
 },
};
export function applyCitationReview(c:EvidenceCase):EvidenceCase{
 const rules=CITATION_REVIEW[c.id];if(!rules)throw new Error(`Missing citation review: ${c.id}`);
 if(Object.keys(rules).length!==c.fields.length)throw new Error(`Incomplete review: ${c.id}`);
 c.citationPolicy='sufficiency-relevance-v2';
 for(const f of c.fields){const rule=rules[f.id];if(!rule)throw new Error(`Missing field: ${c.id}.${f.id}`);
  const [required,context]=rule;
  if([...required,...context].some(id=>!Object.hasOwn(c.documents,id)))throw new Error('Unknown rubric source');
  f.expected.sources=[...required];f.allowedSources=[...new Set([...required,...context])];
 }
 return c;
}
