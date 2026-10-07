import {describe,expect,it} from 'vitest';
import {analyzeRunQuality} from './quality.js';

describe('reviewed programming task quality',()=>{
 it('separates a defective historical scaffold from a runtime failure',()=>{
  const base={totalScore:0,judgeScore:null,deterministicScore:0,modelOutput:'original submission',environmentError:true};
  const defective={...base,scenarioId:'CP-L4-CS-001',outputMetadata:JSON.stringify({programRevision:{disposition:'excluded_defective_question'}})};
  const runtime={...base,scenarioId:'other',outputMetadata:'{}'};
  const quality=analyzeRunQuality([defective,runtime],2);
  expect(quality.benchmarkDefectCount).toBe(1);
  expect(quality.runtimeEnvironmentErrorCount).toBe(1);
  expect(quality.environmentErrorCount).toBe(2);
  expect(quality.grade).toBe('critical');
 });
});
