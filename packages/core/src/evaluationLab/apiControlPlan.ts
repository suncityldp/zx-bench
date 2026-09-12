import {snapshotHash} from '../contracts/pack.js';
import {buildMethodsPack} from './methodsV2/bank.js';
import {scoreMethods, type Answer} from './methodsV2/score.js';
import {buildAdaptiveProbability, scoreAdaptiveProbability} from './adaptiveProbability.js';

export const API_CONTROL_PROVIDERS = [
  {key: 'deepseek-v4-flash', configId: 'e32d8a5d-b6ed-45ac-8bb1-a60859ab419e', requestedModel: 'deepseek-v4-flash',
    family: 'DeepSeek', endpoint: 'https://api.deepseek.com/chat/completions',
    parameters: {thinking: {type: 'enabled'}, reasoning_effort: 'max', top_p: 0.95},
    aliasNote: 'Official 2026-09-10 notice: requested v4-flash alias routes to V4.1-Flash; preserve returned model identifiers.'},
  {key: 'glm-5.2', configId: '930a2799-d17f-485f-b513-d74b9f458896', requestedModel: 'glm-5.2',
    family: 'GLM', endpoint: 'https://open.bigmodel.cn/api/paas/v4/chat/completions',
    parameters: {thinking: {type: 'enabled'}, reasoning_effort: 'max', temperature: 1.0}, aliasNote: 'Requested GLM-5.2, no substitution to newer models.'},
] as const;

export function buildApiControlPlan() {
  const evidence = buildMethodsPack({seed: 20260912, instances: 1, split: 'development'}), probability = buildAdaptiveProbability(20260912);
  const questions = [...evidence.cases.filter(c => c.kind === 'evidence').map(c => c.question), ...probability.questions];
  if (questions.length !== 14 || new Set(questions.map(q => q.id)).size !== 14) throw new Error('Expected eight evidence and six probability questions');
  const policy = {version: 'cross-family-api-control-2026-09-12-v1', questionsPerModel: 14, maximumRequests: 28,
    maxTokens: 90000, hardSeconds: 1200, concurrency: 1, automaticRetries: 0, judgeCalls: 0, tools: false,
    providers: API_CONTROL_PROVIDERS, sameDecodingAsLocal: false, sameOutputCeilingAsLocal: true,
    reasoningEffortLabelsAreNotEquivalentCompute: true, remoteCancellationGuaranteed: false,
    independentGold: false, productionEligible: false, combinedScore: null,
    scope: 'same frozen questions and exact graders; provider-specific thinking configuration; no strict same-runtime ranking'};
  return {policy, questions, evidence, probability, contractHash: snapshotHash({policy, questions, evidence: evidence.contractHash, probability: probability.contractHash})};
}

export function apiControlBody(provider: typeof API_CONTROL_PROVIDERS[number], question: ReturnType<typeof buildApiControlPlan>['questions'][number]) {
  const expected = API_CONTROL_PROVIDERS.find(p => p.key === provider.key);
  if (!expected || snapshotHash(provider) !== snapshotHash(expected)) throw new Error('Changed registered provider');
  return {model: provider.requestedModel, messages: question.messages, ...provider.parameters, max_tokens: 90000, stream: true};
}

export function allowedReturnedModel(providerKey: string, returnedModels: string[]) {
  if (!returnedModels.length) return false;
  const pattern = providerKey === 'deepseek-v4-flash' ? /^deepseek-(?:v4(?:\.1)?-)?flash(?:-[a-zA-Z0-9._-]+)?$/
    : providerKey === 'glm-5.2' ? /^glm-5\.2(?:-[a-zA-Z0-9._-]+)?$/ : null;
  return !!pattern && returnedModels.every(m => pattern.test(m));
}

export function gradeApiControl(plan: ReturnType<typeof buildApiControlPlan>, providerKey: string, runId: string, answers: Answer[]) {
  if (snapshotHash(plan) !== snapshotHash(buildApiControlPlan())) throw new Error('Modified API control plan');
  const provider = API_CONTROL_PROVIDERS.find(p => p.key === providerKey);
  if (!provider || !runId.trim() || answers.some(a => !plan.questions.some(q => q.id === a.id))) throw new Error('Unknown provider, run or question');
  const base = {runId, modelId: provider.requestedModel, modelFamily: provider.family};
  const evidenceIds = new Set(plan.evidence.cases.filter(c => c.kind === 'evidence').map(c => c.id));
  const evidence = scoreMethods(plan.evidence, {...base, contractHash: plan.evidence.contractHash, answers: answers.filter(a => evidenceIds.has(a.id))});
  const probability = scoreAdaptiveProbability(plan.probability, {...base, contractHash: plan.probability.contractHash, answers: answers.filter(a => !evidenceIds.has(a.id))});
  return {planHash: plan.contractHash, submissionHash: snapshotHash(answers), provider: providerKey, evidence, probability,
    dimensions: [evidence.dimensions.find(d => d.dimension === 'hallucination_resistance')!, probability.dimensions[0]],
    planned: 14, recorded: answers.length, combinedScore: null, historicalScoresChanged: false, productionEligible: false};
}
