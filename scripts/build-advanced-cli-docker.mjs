import fs from 'node:fs';
import { advancedCliTasks } from './lib/advanced-cli-tasks.mjs';
import { hashScenarioShort } from '../packages/core/dist/contracts/canonicalize.js';
import { validateScenario } from '../packages/core/dist/contracts/validateScenario.js';
import {addToolCliCheckpoints} from './lib/tool-cli-checkpoints.mjs';
const bank = JSON.parse(fs.readFileSync('data/scenarios/benchmark.json', 'utf8'));
const tasks = advancedCliTasks.map(task => {
  const source = bank.find(s => s.id === task.sourceId);
  if (!source || !(['medium','hard','adversarial'].includes(source.difficulty)
    || (source.id==='TC-CN-024' && source.difficulty==='easy'))) {
    throw Error(`Not an approved original migration: ${task.sourceId}`);
  }
  const scenario = { ...source, id: `${source.id}-DOCKER`, status: 'valid', tier: 'private_dev',
    scenarioVersion: '3.1.0', grader: 'cli_command', graderVersion: 'cli_command_v5',
    responseMode: 'live_execution', reviewStatus: 'unreviewed',
    promptTemplate: `工作区 /workspace，Linux sh 和 Python 3 标准库可用。${task.image && task.image !== 'python:3.12-alpine' ? '也提供 bash；脚本按 sh/bash shebang 选择解释器，无 shebang 使用 sh。' : '使用 Alpine/BusyBox 工具，提交脚本统一以 POSIX sh 执行，未提供 bash 或 GNU 工具。'}${task.prompt}只输出可执行 shell 脚本。`,
    requirements: { migrationSourceId: source.id, developmentShadow: true,
      executionInterpreter: task.image && task.image !== 'python:3.12-alpine' ? 'shebang' : 'sh',
      executionImage: task.image ?? 'python:3.12-alpine',
      executionImageId: task.imageId ?? 'sha256:d09d15e60962ca365d1cd544a48773bac9d33f2fb1b00f2aa0deec78ade7dc31', executionCases: task.cases },
    scoring: { type: 'cli_command', mode: 'executed_state' } };
  if(/^TC-CN-02[2-7]$/.test(source.id)){
    addToolCliCheckpoints(scenario);scenario.graderVersion='cli_command_v6';scenario.scenarioVersion='3.5.0';
  }
  scenario.scenarioHash = hashScenarioShort(scenario);
  const validation = validateScenario(scenario);
  if (validation.errors.length) throw Error(JSON.stringify(validation.errors));
  return scenario;
});
fs.writeFileSync('data/pilots/cli-advanced-docker-v1.json', JSON.stringify(tasks, null, 2) + '\n');
console.log(`Migrated ${tasks.length} existing source tasks; 0 new basic tasks`);
