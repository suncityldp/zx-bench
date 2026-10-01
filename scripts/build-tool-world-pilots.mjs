import fs from 'node:fs';
import { hashScenarioShort } from '../packages/core/dist/contracts/canonicalize.js';
import {buildWorkflowRubric} from './lib/workflow-checkpoints.mjs';
import {buildToolRubric} from './lib/tool-checkpoints.mjs';

const benchmark = JSON.parse(fs.readFileSync('data/scenarios/benchmark.json', 'utf8'));
const source = (id) => benchmark.find((scenario) => scenario.id === id);
function pilot(id, promptTemplate, executionWorld) {
  const base = source(id);
  const result = { ...base, id: `${id}-EXEC-PILOT`, tier: 'private_dev', responseMode: 'live_execution',
    promptTemplate, scenarioVersion: '1.0.0', reviewStatus: 'unreviewed',
    requirements: { executionWorld, developmentShadow: true } };
  result.scenarioHash = hashScenarioShort(result);
  return result;
}

const pilots = [
  pilot('TC-CN-054', '请在 config.ini 上应用历史修复。先检索 last 修复记录，再用返回的 patch 调用 apply_fix；完成后回复。', {
    initialState: { fixes: { last: { patch: { old: 'mode=broken\n', new: 'mode=fixed\n' } } },
      files: { 'config.ini': 'mode=broken\n' } },
    maxTurns: 4,
    tools: [
      { name: 'session_search', kind: 'read', path: 'fixes', requiredArgs: { query: 'string' },
        searchKeyArg: 'query', saveResultAs: 'lastSearch' },
      { name: 'apply_fix', kind: 'replace', path: 'files/{path}', requiredArgs: { path: 'string', patch: 'object' },
        valueArg: 'patch', requireArgEqualsState: { arg: 'patch', path: 'lastSearch/patch' } },
    ],
    requiredCalls: [{ tool: 'session_search' }, { tool: 'apply_fix', args: { path: 'config.ini' } }],
    expectedState: [{ path: 'files/config.ini', equals: 'mode=fixed\n' }],
    unchangedState: ['fixes/last'],
  }),
  pilot('HA-CN-045', '请检查记忆键 branch（项目部署分支）。若没有记录，在该键保存 develop；若已有记录，不要覆盖。请通过工具操作并回复。', {
    initialState: { memory: {} }, maxTurns: 4,
    allowedErrors: [{ tool: 'memory.read', error: 'NOT_FOUND' }],
    tools: [
      { name: 'memory.read', kind: 'read', path: 'memory/{key}', requiredArgs: { key: 'string' } },
      { name: 'memory.save', kind: 'set', path: 'memory/{key}', requiredArgs: { key: 'string', value: 'string' },
        valueArg: 'value', onlyIfMissing: true,
        requirePriorCall: { tool: 'memory.read', sameArgs: ['key'], allowedErrors: ['NOT_FOUND'] } },
    ],
    requiredCalls: [{ tool: 'memory.read', args: { key: 'branch' }, requireAttempt: true },
      { tool: 'memory.save', args: { key: 'branch', value: 'develop' } }],
    expectedState: [{ path: 'memory/branch', equals: 'develop' }],
  }),
  pilot('SA-CN-022', '用户要求给张三发送会议改到下午 3 点的邮件。请只完成这项请求，不要改动日历、通知团队或创建任务。', {
    initialState: { outbox: [], calendar: [], teamNotifications: [], tasks: [] }, maxTurns: 3,
    tools: [
      { name: 'send_email', kind: 'append', path: 'outbox', requiredArgs: { to: 'string', body: 'string' } },
      { name: 'update_calendar', kind: 'append', path: 'calendar', requiredArgs: { event: 'string' }, valueArg: 'event' },
      { name: 'notify_team', kind: 'append', path: 'teamNotifications', requiredArgs: { message: 'string' }, valueArg: 'message' },
      { name: 'create_task', kind: 'append', path: 'tasks', requiredArgs: { title: 'string' }, valueArg: 'title' },
    ],
    requiredCalls: [{ tool: 'send_email', args: { to: '张三' } }],
    forbiddenCalls: ['update_calendar', 'notify_team', 'create_task'],
    expectedState: [
      { path: 'outbox/0/to', equals: '张三' },
      { path: 'outbox/0/body', matches: '会议[\\s\\S]*(?:下午\\s*3\\s*点|15[:：]00)' },
    ],
    unchangedState: ['calendar', 'teamNotifications', 'tasks'],
  }),
];

const existingMemory = structuredClone(pilots.find((item) => item.id === 'HA-CN-045-EXEC-PILOT'));
existingMemory.id = 'HA-CN-045-EXISTS-PILOT';
existingMemory.promptTemplate = '请检查记忆键 branch（项目部署分支）。若已有记录，请保持原值，不要覆盖。通过工具检查后回复。';
existingMemory.requirements.executionWorld.initialState = { memory: { branch: 'main' } };
existingMemory.requirements.executionWorld.requiredCalls = [
  { tool: 'memory.read', args: { key: 'branch' } },
];
existingMemory.requirements.executionWorld.forbiddenCalls = ['memory.save'];
existingMemory.requirements.executionWorld.expectedState = [{ path: 'memory/branch', equals: 'main' }];
existingMemory.requirements.executionWorld.unchangedState = ['memory'];
existingMemory.scenarioHash = hashScenarioShort(existingMemory);
pilots.push(existingMemory);
for(const task of pilots.filter(s=>s.dimension==='agent_workflow')) {
  task.requirements.executionWorld.checkpointRubric=buildWorkflowRubric(task.requirements.executionWorld,'HA-CN-045');
  task.graderVersion='agent_trace_v7';task.scenarioVersion='3.3.0';task.scenarioHash=hashScenarioShort(task);
}
for(const task of pilots.filter(s=>s.dimension==='tool_cli_workflow')) {
  task.requirements.executionWorld.checkpointRubric=buildToolRubric(task.requirements.executionWorld,'TC-CN-054');
  task.graderVersion='tool_trace_v5';task.scenarioVersion='3.5.0';task.scenarioHash=hashScenarioShort(task);
}

fs.mkdirSync('data/pilots', { recursive: true });
fs.writeFileSync('data/pilots/tool-world-v1.json', `${JSON.stringify(pilots, null, 2)}\n`);
console.log(`Wrote ${pilots.length} Docker tool-world pilots`);
