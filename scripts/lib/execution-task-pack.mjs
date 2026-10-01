import { createHash } from 'node:crypto';

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort()
    .filter(key => value[key] !== undefined).map(key => [key, canonical(value[key])]));
  return value;
}
export const digest = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');

// Unknown fields remain in the interaction contract: prefer rerunning to silently
// reusing a trajectory after an unrecognised environment change.
export function taskContract(scenario, runtimeHash, verifierHash) {
  const interaction = structuredClone(scenario);
  const verification = { runtime: verifierHash };
  for (const key of ['scoring', 'grader', 'graderVersion', 'hiddenTests', 'expectedState',
    'requiredInvariants', 'forbiddenActions', 'requiredOrder', 'expectedVerdict']) {
    verification[key] = interaction[key]; delete interaction[key];
  }
  for (const key of ['scenarioHash', 'scenarioVersion', 'status', 'tier', 'reviewStatus',
    'goldSource', 'goldVerifiedAt', 'tags', 'difficulty', 'category']) delete interaction[key];
  const requirements = interaction.requirements ?? {};
  for (const key of ['agentLoopAssert', 'developmentShadow', 'migrationSourceId']) {
    verification[key] = requirements[key]; delete requirements[key];
  }
  if (requirements.executionCases) verification.cases = requirements.executionCases.map(c => {
    const checks = {};
    for (const key of ['expectedFiles', 'absentFiles', 'assertCommands', 'unchangedFiles',
      'expectedStdout', 'expectedStdoutPattern', 'expectedExitCode', 'tokenWhitespaceFiles', 'checkpoints', 'safetyAssertCommands']) {
      checks[key] = c[key]; delete c[key];
    }
    return checks;
  });
  verification.executionCheckpointRubric=requirements.executionCheckpointRubric;delete requirements.executionCheckpointRubric;
  if (requirements.executionShell) {
    verification.shell = {};
    for (const key of ['answer', 'minCommands']) {
      verification.shell[key] = requirements.executionShell[key]; delete requirements.executionShell[key];
    }
  }
  if (requirements.executionWorld) {
    verification.world = {};
    for (const key of ['requiredCalls', 'forbiddenCalls', 'expectedState', 'unchangedState',
      'allowedErrors', 'requireFinalMessage', 'finalMessageMustContain', 'finalMessageMustContainAny', 'finalMessageMustNotContain', 'scoreMode','checkpointRubric']) {
      verification.world[key] = requirements.executionWorld[key]; delete requirements.executionWorld[key];
    }
  }
  return { version: 1, interactionHash: digest({ interaction, runtimeHash }), verifierHash: digest(verification) };
}

export function reuseDecision(previous, next, hasEvidence = true) {
  if (!previous || !hasEvidence || previous.version !== next.version
    || previous.interactionHash !== next.interactionHash) return 'rerun';
  return previous.verifierHash === next.verifierHash ? 'reuse' : 'regrade';
}

export function hasExecutionEvidence(scenario, result) {
  if (!result || result.environmentError) return false;
  const req = scenario.requirements ?? {}, meta = result.outputMetadata ?? {};
  if (req.executionShell) return Boolean(meta.shellExecutionTrace?.events && meta.shellExecutionTrace?.turns);
  if (req.executionWorld) return Boolean(meta.executionWorldTrace?.events && meta.executionWorldTrace?.finalState);
  if (req.agentLoop) return Boolean(meta.agentLoopTrace?.turns && meta.agentLoopTrace?.state);
  return Array.isArray(req.executionCases) && typeof result.modelOutput === 'string' && result.modelOutput.trim().length > 0;
}

export function strictSuccess(result) {
  return result?.totalScore === 100 && !result.environmentError && !result.humanReviewRequired
    && !result.outputMetadata?.truncated
    && (result.criterionResults ?? result.outputMetadata?.evaluationAudit?.criterionResults ?? [])
      .every(c => !c.critical || c.status === 'pass');
}
