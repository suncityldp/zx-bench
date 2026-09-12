/** Evidence support and evidence refutation are separate bits; neither is real-world truth. */
import type {Stance} from './methodsV2/types.js';
const STATES:Stance[]=['supported','refuted','insufficient','conflict'];
const bits:Record<Stance,[boolean,boolean]>={supported:[true,false],refuted:[false,true],insufficient:[false,false],conflict:[true,true]};
export interface EvidenceObservation {id:string;expected:Stance;observed:Stance|null;outputHash:string|null;reasonUnmeasured?:string}
export function evidenceStateDiagnostics(observations:EvidenceObservation[]){
  if(new Set(observations.map(r=>r.id)).size!==observations.length||observations.some(r=>!r.id||!STATES.includes(r.expected)||r.observed!==null&&!STATES.includes(r.observed)))throw new Error('Duplicate/invalid observation');
  if(observations.some(r=>r.observed!==null&&!r.outputHash||r.observed===null&&!r.reasonUnmeasured))throw new Error('Missing answer provenance or unmeasured reason');
  const confusion=Object.fromEntries(STATES.map(a=>[a,Object.fromEntries(STATES.map(b=>[b,0]))])) as Record<Stance,Record<Stance,number>>;
  const rows=observations.map(r=>{
    if(r.observed===null)return {...r,correct:null,unsupportedSupport:null,unsupportedRefutation:null,missedSupport:null,missedRefutation:null};
    confusion[r.expected][r.observed]++;const expected=bits[r.expected],observed=bits[r.observed];
    return {...r,correct:r.expected===r.observed,unsupportedSupport:observed[0]&&!expected[0],unsupportedRefutation:observed[1]&&!expected[1],
      missedSupport:expected[0]&&!observed[0],missedRefutation:expected[1]&&!observed[1]};
  });
  const measured=rows.filter(r=>r.correct!==null),correct=measured.filter(r=>r.correct).length;
  const counts={unsupportedSupport:measured.filter(r=>r.unsupportedSupport).length,unsupportedRefutation:measured.filter(r=>r.unsupportedRefutation).length,
    unsupportedEither:measured.filter(r=>r.unsupportedSupport||r.unsupportedRefutation).length,missedSupport:measured.filter(r=>r.missedSupport).length,missedRefutation:measured.filter(r=>r.missedRefutation).length,
    falseConflict:measured.filter(r=>r.observed==='conflict'&&r.expected!=='conflict').length,falseInsufficiency:measured.filter(r=>r.observed==='insufficient'&&r.expected!=='insufficient').length};
  return {version:'evidence-polarity-diagnostics-2026-09-12-v1',planned:rows.length,measured:measured.length,unmeasured:rows.length-measured.length,
    coverage:rows.length?measured.length/rows.length:null,correct,observedAccuracy:measured.length?correct/measured.length:null,
    completeAccuracy:rows.length&&measured.length===rows.length?correct/rows.length:null,counts,confusion,rows,
    scope:'closed_evidence_state_not_open_world_truth',note:'False conflict can assert unsupported positive and negative evidence even when no yes/no answer is attempted. Counts overlap; never add them into a primary score.',
    primaryScoreChanged:false};
}
