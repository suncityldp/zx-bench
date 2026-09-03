import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hashScenarioShort } from '../contracts/canonicalize.js';
import type { Scenario } from '@zxbench/types';

type ExecutionPolicy = {
  network?: 'required' | 'disabled';
  dependencyPreflight?: { command: string; timeoutMs?: number };
  coldStartTimeoutIsEnvironmentError?: boolean;
};

type ProjectRepairScenario = Scenario & {
  requirements: { executionPolicy?: ExecutionPolicy };
};

const benchmarkPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../data/scenarios/benchmark.json',
);
const scenarios = JSON.parse(readFileSync(benchmarkPath, 'utf8')) as ProjectRepairScenario[];
const projectRepair = scenarios.filter((scenario) => scenario.grader === 'project_repair');

const NETWORK_REQUIRED_IDS = [
  'CP-L4-CS-001',
  'CP-L4-CS-002',
  'CP-L4-PY-001',
  'CP-L4-RS-001',
  'CP-L4-TS-001',
  'CP-L4-TS-002',
  'CP-L4-TS-003',
];

describe('project_repair executionPolicy 题库契约', () => {
  it('20 道工程题均升级 1.2.0，且 hash 与当前配置一致', () => {
    expect(projectRepair).toHaveLength(20);
    for (const scenario of projectRepair) {
      expect(scenario.graderVersion).toBe('1.2.0');
      expect(scenario.scenarioVersion).toBe('1.2.0');
      expect(scenario.scenarioHash).toBe(hashScenarioShort(scenario));
    }
  });

  it('仅明确声明的 7 道题联网，均有原始工作区依赖预检', () => {
    const networkRequired = projectRepair
      .filter((scenario) => scenario.requirements.executionPolicy?.network === 'required')
      .map((scenario) => scenario.id)
      .sort();
    expect(networkRequired).toEqual([...NETWORK_REQUIRED_IDS].sort());

    for (const scenario of projectRepair.filter((s) => networkRequired.includes(s.id))) {
      const policy = scenario.requirements.executionPolicy!;
      expect(policy.dependencyPreflight?.command).toMatch(/\S/);
      expect(policy.dependencyPreflight?.timeoutMs).toBeGreaterThanOrEqual(10_000);
      expect(policy.coldStartTimeoutIsEnvironmentError).toBe(true);
    }
  });

  it('其余工程题没有联网策略，运行器将按默认禁网执行', () => {
    for (const scenario of projectRepair.filter((s) => !NETWORK_REQUIRED_IDS.includes(s.id))) {
      expect(scenario.requirements.executionPolicy?.network).not.toBe('required');
    }
  });
});
