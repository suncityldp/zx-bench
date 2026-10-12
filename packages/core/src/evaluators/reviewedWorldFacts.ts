import type { Scenario } from '@zxbench/types';
import type { WorldConfig, WorldTrace } from '../execution/worldLoop.js';
import { hashScenarioShort } from '../contracts/canonicalize.js';

// Compatibility for reviewed frozen revisions. New packs record these facts
// correctly; neither the stored contract nor the execution trace is rewritten.
const repeatReadRevisions = new Set([
  'dc78f52cf9f55e09', '76cf17cb34d1d022', '7a9b96e689d67ba9',
  '5c7f6b5ac3a25e32', '9072895970da9b7a', '3bd3995d1c11f5a3',
]);
const parentDirectoryRevisions = new Set(['247c01fe996aa734', '37ea52018062581a']);
const factReadScript = "state['reads']+=1; result={'fact':state['fact']}";

export function reviewedWorldFacts(scenario: Scenario, config: WorldConfig, trace: WorldTrace) {
  const state = structuredClone(trace.finalState);
  const evidence: Record<string, string> = {};
  const recoveredReadTools = new Set<string>();
  let repeatedReadsVerified = false;
  const revision = scenario.scenarioHash;
  if (!revision || (!repeatReadRevisions.has(revision) && !parentDirectoryRevisions.has(revision))
      || hashScenarioShort(scenario) !== revision) return { state, evidence, repeatedReadsVerified, recoveredReadTools };

  if (repeatReadRevisions.has(revision)) {
    const reads = config.tools.filter(tool => tool.kind === 'script' && tool.script === factReadScript
      && !Object.keys(tool.requiredArgs ?? {}).length && !(config.forbiddenCalls ?? []).includes(tool.name));
    for (const tool of reads) recoveredReadTools.add(tool.name);
    const events = trace.events.filter(event => event.ok && reads.some(tool => tool.name === event.tool));
    repeatedReadsVerified = trace.initialState.reads === 0 && Number.isSafeInteger(state.reads)
      && state.reads === events.length && events.length >= 1
      && events.every(event => !Object.keys(event.args).length
        && (event.result as { fact?: unknown })?.fact === trace.initialState.fact)
      && state.fact === trace.initialState.fact;
    if (repeatedReadsVerified) evidence.reads = `verified read calls=${events.length}; repeated reads permitted by frozen prompt`;
  }

  if (parentDirectoryRevisions.has(revision) && Array.isArray(state.dirs)
      && state.createdDirs && typeof state.createdDirs === 'object') {
    const dirs = [...state.dirs] as unknown[];
    const created = { ...state.createdDirs } as Record<string, unknown>;
    const declared = new Set((config.expectedState ?? []).filter(check => check.path.startsWith('createdDirs/')
      && check.equals === true).map(check => check.path.slice('createdDirs/'.length).replaceAll('.', '/')));
    for (const event of trace.events) {
      if (!event.ok || event.tool !== 'fs.mkdir') continue;
      const path = (event.result as { created?: unknown })?.created;
      // The reviewed script normalizes and bounds this path, then calls
      // Path.mkdir(parents=True, exist_ok=True) before returning success.
      if (typeof path !== 'string' || !declared.has(path) || !dirs.includes(path)
          || created[path.replaceAll('/', '.')] !== true) continue;
      const parts = path.split('/');
      for (let end = 1; end < parts.length; end++) {
        const parent = parts.slice(0, end).join('/');
        if (!declared.has(parent)) continue;
        if (!dirs.includes(parent)) dirs.push(parent);
        created[parent.replaceAll('/', '.')] = true;
        evidence['createdDirs/' + parent.replaceAll('/', '.')] = `parent created by successful mkdir(${path}, parents=True)`;
      }
    }
    if (dirs.length !== state.dirs.length) evidence['dirs/length'] = `including verified mkdir parents: ${dirs.length}`;
    state.dirs = dirs;
    state.createdDirs = created;
  }
  return { state, evidence, repeatedReadsVerified, recoveredReadTools };
}
