import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { recoveryWorldTasks } from './lib/recovery-world-tasks.mjs';

// Execute the actual trusted Python tool scripts in an isolated temporary workspace.
const python = String.raw`
import copy,json,sys,tempfile
from pathlib import Path
tasks=json.load(sys.stdin)
results=[]
for task in tasks:
 for query in ['Docker 网络修复','上次使用的 Docker 网络修复方法','Docker NETWORK repair','Docker 網路修復','Docker volume repair']:
  state=copy.deepcopy(task['config']['initialState'])
  with tempfile.TemporaryDirectory(prefix='zxbench-search-regression-') as directory:
   file=Path(directory)/'compose.yml'
   tools={tool['name']:tool for tool in task['config']['tools']}
   def execute(name,args):
    scope={'state':state,'args':args}
    code=tools[name]['script'].replace('/workspace/compose.yml',file.as_posix())
    exec(compile(code,'trusted-world-tool','exec'),scope)
    return scope['result']
   try:
    patch=execute('session_search',{'query':query})['patch']
    execute('fs.read',{'path':'compose.yml'})
    execute('fs.patch',{'path':'compose.yml','diff':patch})
    results.append({'variant':task['variant'],'query':query,'ok':True,'actual':state['currentFile'],'file':file.read_text(),'expected':task['config']['expectedState'][0]['equals']})
   except ValueError as error:
    results.append({'variant':task['variant'],'query':query,'ok':False,'error':str(error),'lastSearch':state['lastSearch']})
print(json.dumps(results,ensure_ascii=False))
`;
test('HA-CN-004 accepts disclosed Chinese and English searches, applies the real patch, and rejects unrelated queries', () => {
  const tasks=recoveryWorldTasks.filter(task=>task.sourceId==='HA-CN-004');
  assert.equal(tasks.length,2);
  const child=spawnSync('python',['-c',python],{input:JSON.stringify(tasks),encoding:'utf8',env:{...process.env,PYTHONIOENCODING:'utf-8'}});
  assert.equal(child.status,0,child.stderr);
  const results=JSON.parse(child.stdout);
  assert.equal(results.length,10);
  for(const row of results) {
    if(row.query==='Docker volume repair') {
      assert.equal(row.ok,false); assert.equal(row.error,'NO_MATCH'); assert.equal(row.lastSearch,null);
    } else {
      assert.equal(row.ok,true,row.query); assert.equal(row.actual,row.expected); assert.equal(row.file,row.expected);
    }
  }
});
