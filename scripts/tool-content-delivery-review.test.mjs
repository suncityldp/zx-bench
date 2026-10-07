import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {recoveryWorldTasks} from './lib/recovery-world-tasks.mjs';
import {reviewToolContentDelivery,reviewedArchiveAssertion} from './lib/tool-content-delivery-review.mjs';

test('content/delivery revision is scoped and idempotent',()=>{
  for(const task of recoveryWorldTasks.filter(t=>t.sourceId.startsWith('TC-CN-'))){
    const before=JSON.stringify(task);
    assert.equal(reviewToolContentDelivery(task),false);
    assert.equal(JSON.stringify(task),before);
    assert.equal(task.config.checkpointRubric.version,
      ['TC-CN-031','TC-CN-038'].includes(task.sourceId)?'workflow-checkpoints-v2':'workflow-checkpoints-v1');
  }
});
test('artifact delivery does not require duplicating its contents in chat',()=>{
  for(const task of recoveryWorldTasks.filter(t=>['TC-CN-006','TC-CN-015'].includes(t.sourceId))){
    assert.deepEqual(task.config.finalMessageMustContain,[]);
    assert(task.config.checkpointRubric.checkpoints.every(c=>c.all.every(id=>!/^world_final_\d+$/.test(id))));
    assert(task.config.expectedState.some(s=>s.path==='emails'||s.path.startsWith('emails/')));
  }
});
test('scaling explicitly takes a delta and preserves the successful reference',()=>{
  for(const task of recoveryWorldTasks.filter(t=>t.sourceId==='TC-CN-050')){
    const tool=task.config.tools.find(t=>t.name==='scale_up_cluster');
    assert.deepEqual(tool.requiredArgs,{host:'string',delta_replicas:'number'});
    for(const call of task.reference.filter(c=>c.tool==='scale_up_cluster')){
      assert.equal(call.args.delta_replicas,1);
      assert(!Object.hasOwn(call.args,'n'));
    }
  }
});
test('reminder accepts equivalent labels but rejects different times or cancellation',()=>{
  const task=recoveryWorldTasks.find(t=>t.sourceId==='TC-CN-005');
  const result=spawnSync('python',['-c',`import json
script=${JSON.stringify(task.config.tools[0].script)}
for label,time,valid in [('参加9点团队会议','07:00',True),('提醒我参加九点团队会议','07:00',True),('参加9点团队会议','08:00',False),('取消9点团队会议','07:00',False)]:
    context={'args':{'label':label,'date':'2024-03-16','time':time},'state':{'calls':[]}}
    try:
        exec(script,context)
        assert valid and len(context['state']['calls'])==1
    except ValueError:
        assert not valid
`],{encoding:'utf8',windowsHide:true});
  assert.equal(result.status,0,result.stderr);
});
test('archive roots are equivalent; lost bytes, collisions, links and traversal are rejected',()=>{
  const c={files:[{path:'data/logs/old.log',content:'exact saved bytes\n'}],absentFiles:['data/logs/old.log']};
  const body=command=>command.split("<<'PY'\n")[1].replace(/\nPY$/,'');
  const directory=mkdtempSync(join(tmpdir(),'zxbench-archive-review-'));
  try{
    const result=spawnSync('python',['-c',`import io,tarfile
checks=[${JSON.stringify(body(reviewedArchiveAssertion(c)))},${JSON.stringify(body(reviewedArchiveAssertion(c,true)))}]
def archive(names,content=b'exact saved bytes\\n',link=False):
    with tarfile.open('archive.tar.gz','w:gz') as tar:
        for name in names:
            item=tarfile.TarInfo(name); item.size=len(content)
            if link: item.type=tarfile.SYMTYPE; item.linkname='old.log'; tar.addfile(item)
            else: tar.addfile(item,io.BytesIO(content))
for names,content,link,valid in [(['data/logs/old.log'],b'exact saved bytes\\n',False,True),(['old.log'],b'exact saved bytes\\n',False,True),(['old.log','data/logs/old.log'],b'exact saved bytes\\n',False,False),(['../old.log'],b'exact saved bytes\\n',False,False),(['old.log'],b'wrong',False,False),(['old.log'],b'exact saved bytes\\n',True,False),([],b'',False,False)]:
    archive(names,content,link)
    for check in checks:
        passed=True
        try: exec(check,{})
        except (AssertionError,KeyError): passed=False
        assert passed==valid,(names,valid)
`],{cwd:directory,encoding:'utf8',windowsHide:true});
    assert.equal(result.status,0,result.stderr);
  }finally{rmSync(directory,{recursive:true,force:true});}
});
