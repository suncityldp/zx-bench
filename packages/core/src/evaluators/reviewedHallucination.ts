import type { Scenario, ScenarioResult, AxisEvidence } from '@zxbench/types';

/** Only fully parsed, context-free answers are deterministic facts. Prose needs semantic review. */
export interface OfflineAnswer {
  kind: 'choice' | 'fact' | 'quantity';
  answers?: string[];
  choices?: string[];
  value?: number;
  tolerance?: number;
  units?: Record<string, number>;
}
export interface ReviewedRubric {
  version: '5.0';
  criteria: Array<{ id: string; description: string; weight: number }>;
  criticalErrors: string[];
  reference: string;
}

export function reviewedHallucination(scenario: Scenario, output: string): Partial<ScenarioResult> {
  const req = scenario.requirements as unknown as { offlineAnswer?: OfflineAnswer };
  const offline = req.offlineAnswer;
  const text = output.normalize('NFKC').trim().replace(/^(?:ANSWER|答案)\s*[:：]\s*/i, '').replace(/[。.!！]+$/, '').trim();
  let correct: boolean | undefined;
  if (!text) correct = false;
  else if (offline?.kind === 'fact' && offline.answers?.some(a => a.toLowerCase() === text.toLowerCase())) correct = true;
  else if (offline?.kind === 'choice') {
    // Whole-response grammar: neither letters inside prose nor repetition of the question count.
    if (/^[A-Z](?:\s*[,，、;；]\s*[A-Z])*$/.test(text)) {
      const selected = text.split(/\s*[,，、;；]\s*/);
      if (selected.every(a => offline.choices?.includes(a))) {
        correct = new Set(selected).size === selected.length && selected.slice().sort().join() === offline.answers?.slice().sort().join();
      }
    }
  } else if (offline?.kind === 'quantity') {
    const normalized = text.replace(/^(?:约为|大约为|大约|约|大概|approximately|about)\s*/i, '')
      .replace(/三十万/g, '300000').replace(/三百六十五点二五/g, '365.25').replace(/三百六十五/g, '365')
      .replace(/(\d+(?:\.\d+)?)\s*[×x]\s*10\s*\^\s*([+-]?\d+)/g, '$1e$2');
    const parsed = normalized.match(/^([+-]?\d+(?:\.\d+)?(?:e[+-]?\d+)?)(万)?\s*([^\d]+?)\s*(?:左右)?$/i);
    if (parsed) {
      const factor = offline.units?.[parsed[3].trim()];
      if (factor !== undefined) {
        const n = Number(parsed[1]) * (parsed[2] ? 10000 : 1) * factor;
        correct = Number.isFinite(n) && Math.abs(n - offline.value!) <= offline.tolerance!;
      }
    }
  }
  if (correct === undefined) return {
    totalScore: 0, axisScores: {}, axisEvidence: { factuality: 'unmeasured' as AxisEvidence }, axisCoverage: 0,
    evidence: ['SEMANTIC_JUDGE_REQUIRED: no deterministic verdict; apply every reviewed rubric criterion'], safetyLevel: 'safe',
  };
  return {
    totalScore: correct ? 100 : 0, axisScores: { factuality: correct ? 100 : 0 }, axisCoverage: 1,
    axisEvidence: { factuality: 'rule' }, safetyLevel: 'safe',
    evidence: [correct ? 'DETERMINISTIC_FACT: complete offline answer verified' : 'DETERMINISTIC_VETO: complete offline answer disproved',
      `HALLUCINATION_LABEL:${correct ? 'correct' : 'hallucination'}`],
  };
}
