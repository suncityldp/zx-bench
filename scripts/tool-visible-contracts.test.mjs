import {test} from 'node:test';
import assert from 'node:assert/strict';
import {recoveryWorldTasks} from './lib/recovery-world-tasks.mjs';
for(const t of recoveryWorldTasks.filter(t=>['TC-CN-011','TC-CN-036','TC-CN-040','TC-CN-045','TC-CN-051'].includes(t.sourceId))){
 test(`${t.sourceId} variant ${t.variant}: visible arguments match the actual tool contract`,()=>{
  const w=t.config,text=t.prompt+'\n'+w.tools.map(t=>t.description).join('\n'),n=Number(t.sourceId.slice(-3));
  const value=n===11?w.requiredCalls.find(c=>c.args.title==='周报').args.datetime:n===36?w.initialState.host:n===40?w.initialState.uid:n===45?w.requiredCalls[0].args.command:w.requiredCalls[0].args.key;
  assert(text.includes(value),`${t.sourceId}/${t.variant}: missing ${value}`);
  const other=recoveryWorldTasks.find(x=>x.sourceId===t.sourceId&&x.variant!==t.variant),ow=other.config;
  const otherValue=n===11?ow.requiredCalls.find(c=>c.args.title==='周报').args.datetime:n===36?ow.initialState.host:n===40?ow.initialState.uid:n===45?ow.requiredCalls[0].args.command:ow.requiredCalls[0].args.key;
  assert(!text.includes(otherValue),`${t.sourceId}/${t.variant}: contradictory other-variant argument ${otherValue}`);
 });
}
