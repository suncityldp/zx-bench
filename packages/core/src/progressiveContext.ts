import type { Scenario } from '@zxbench/types';
import { committedItems } from './evaluationLab/examPaper/index.js';
import { buildEvidenceExam } from './evaluationLab/evidenceExam/index.js';
import { buildExamPaper } from './evaluationLab/examExpansion/index.js';
import { differsOnlyByHardTimeLimit } from './evaluationLab/questionHashCompatibility.js';

export interface PriorProgressiveResult {
  modelOutput: string;
  environmentError?: boolean;
}

export interface ProgressiveMessage {
  role: 'user' | 'assistant';
  content: string;
}

/** Build the prior turns of a frozen progressive exam without answer feedback. */
export function buildProgressiveHistory(
  current: Scenario,
  frozenScenarios: readonly Scenario[],
  results: ReadonlyMap<string, PriorProgressiveResult>,
): ProgressiveMessage[] {
  if (current.category !== 'ultra_progressive_exam') return [];
  const requirements = current.requirements as { groupId?: string; partNumber?: number } | undefined;
  const groupId = requirements?.groupId;
  const partNumber = requirements?.partNumber;
  if (!groupId || !Number.isInteger(partNumber) || partNumber! < 1 || partNumber! > 4) {
    throw new Error(`Invalid progressive identity: ${current.id}`);
  }
  if (partNumber === 1) return [];

  const paperParts = [...buildEvidenceExam().parts, ...buildExamPaper().parts];
  const messages: ProgressiveMessage[] = [];
  for (let number = 1; number < partNumber!; number++) {
    const id = `${groupId}-P${number}`;
    const scenario = frozenScenarios.find(item => item.id === id);
    const part = paperParts.find(item => item.id === id);
    const result = results.get(id);
    if (!scenario || !part || !result) throw new Error(`Missing frozen prior part or result: ${current.id} needs ${id}`);
    const recordedHash = (scenario.requirements as { questionHash?: string } | undefined)?.questionHash;
    if (recordedHash && recordedHash !== part.question.questionHash) {
      const currentPrompt = part.question.messages.length === 1 && part.question.messages[0].role === 'user'
        ? part.question.messages[0].content : '';
      const safeLegacyTimeLimit = scenario.id === part.id
        && scenario.dimension === part.question.dimension
        && typeof scenario.promptTemplate === 'string'
        && differsOnlyByHardTimeLimit(scenario.promptTemplate, currentPrompt);
      if (!safeLegacyTimeLimit) throw new Error(`Progressive paper drift: ${id}`);
    }
    const committed = result.environmentError ? new Map<string, unknown>()
      : committedItems(result.modelOutput, part.items.map(item => item.key)).items;
    messages.push({ role: 'user', content: scenario.promptTemplate });
    messages.push({ role: 'assistant', content: committed.size
      ? [...committed].map(([item, answer]) => JSON.stringify({ item, answer })).join('\n')
      : '本问未提交完整答案。' });
  }
  return messages;
}
