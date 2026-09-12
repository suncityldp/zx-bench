export interface BoundedJudgeControl {
  scope:string; modelName:string; calls:number; rows:{fullContextVerified:boolean;allMatch:boolean;mappingReviewed:boolean}[];
}
export interface BoundedJudgeRealSignal {
  scope:string; modelName:string; calls:number; reviewedIssues:number; originalAnswerUnchanged:boolean;
  automaticScoreChanged:boolean; entireProofMeasured:boolean;
}
/** Qualifies a model+protocol only for the exact extraction scopes represented here. */
export function judgeRoleEvidence(currentConfiguredModel:string,controls:BoundedJudgeControl[],realSignals:BoundedJudgeRealSignal[]){
  if(!currentConfiguredModel||controls.length<1||realSignals.length<1)throw new Error('Configured model, controls and real signals required');
  const models=new Set([...controls.map(x=>x.modelName),...realSignals.map(x=>x.modelName)]);
  if(models.size!==1)throw new Error('Do not combine evidence from different Judge models');
  for(const set of controls){
    if(!set.scope||set.rows.length<2||set.calls!==set.rows.length||set.rows.some(r=>!r.fullContextVerified||!r.allMatch||!r.mappingReviewed))
      throw new Error('Incomplete or failed bounded control set');
  }
  for(const signal of realSignals){
    if(!signal.scope||signal.calls!==1||signal.reviewedIssues<1||!signal.originalAnswerUnchanged||signal.automaticScoreChanged||signal.entireProofMeasured)
      throw new Error('Real-answer evidence must be reviewed, useful, non-scoring and bounded');
  }
  const modelName=[...models][0],controlScopes=new Set(controls.map(x=>x.scope)),realScopes=new Set(realSignals.map(x=>x.scope));
  if(controlScopes.size!==controls.length||realScopes.size!==realSignals.length||[...realScopes].some(x=>!controlScopes.has(x)))throw new Error('Duplicate or unmatched bounded scope');
  return {version:'bounded-judge-role-evidence-2026-09-12-v1',evidenceModel:modelName,currentConfiguredModel,
    currentConfiguredModelQualified:modelName===currentConfiguredModel,effectiveForEvidenceModelAndExactScopes:true,
    scopes:[...realScopes],controlItems:controls.reduce((n,x)=>n+x.rows.length,0),realAnswersWithReviewedIssues:realSignals.length,
    role:'bounded_claim_extraction_then_deterministic_verification_then_review',automaticScoreAuthority:false,
    generalizedProofJudgeQualified:false,independentGold:false,productionEligible:false,
    note:'Changing the configured model invalidates model-specific qualification; protocol evidence does not transfer by name or provider family.'};
}
