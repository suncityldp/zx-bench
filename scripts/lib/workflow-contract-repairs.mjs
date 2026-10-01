/** Task-visible contract repairs. Hidden target state is never disclosed. */
export const workflowRepairSources = ['HA-CN-004','HA-CN-006','HA-CN-008','HA-CN-011','HA-CN-012','HA-CN-017','HA-CN-020','HA-CN-021','HA-CN-024','HA-CN-027','HA-CN-030','HA-CN-033','HA-CN-042','HA-CN-043'];
export function repairWorkflowContract(task) {
  if (!workflowRepairSources.includes(task.sourceId) || (task.sourceId==='HA-CN-030' && task.variant===1)) return false;
  const w=task.config, tool=name=>w.tools.find(t=>t.name===name);
  const append=text=>{if(!task.prompt.includes(text))task.prompt+='\n'+text;};
  if(task.sourceId==='HA-CN-004') {
    const t=tool('session_search');
    t.script=t.script.replace("if 'network' not in args['query'].lower(): raise ValueError('NO_MATCH')", "query=args['query'].casefold()\nif not any(term in query for term in ('network','网络','網路')): raise ValueError('NO_MATCH')");
    t.description='从历史会话检索 Docker 网络修复补丁；query 接受包含 network、网络或網路的自然语言。';
    if(task.reference)task.reference[0].args.query='上次 Docker 网络修复方法';
  }
  if(task.sourceId==='HA-CN-006') {
    tool('memory.read').description='读取用户语言偏好，key 为 favorite.language。';
    tool('search').description='从本地资源目录搜索学习资料；query 应包含读取到的编程语言名，可附加“教程”等词。';
    tool('search').script=tool('search').script.replace("if args['query']!=state['memory']['favorite.language']", "if state['memory']['favorite.language'].casefold() not in args['query'].casefold()").replace("state['catalog'][args['query']]", "state['catalog'][state['memory']['favorite.language']]");
    tool('search').script=tool('search').script.replace("state['searches'].append(args['query'])", "state['searches'].append(state['memory']['favorite.language'])");
    append('语言偏好的记忆键为 favorite.language；先读取实际值，不能猜测偏好。');
    if(task.reference)task.reference[1].args.query=w.initialState.memory['favorite.language']+' 官方教程';
    w.requiredCalls.find(c=>c.tool==='search').args={};
  }
  if(task.sourceId==='HA-CN-008') {
    append('本题只要求核实断点并回复下一步计划，不授权实际续跑；不得调用 migration.run。');
    tool('memory.list').description='列出迁移相关记忆。prefix 可以是 migration/ 或空字符串（枚举相关键）。';
    tool('memory.list').script=tool('memory.list').script.replace("args['prefix']!='migration/'", "args['prefix'] not in ('migration/','')");
    append('相关记忆前缀为 migration/。进度与输入文件路径须从返回的记忆内容读取。');
    w.requiredCalls.find(c=>c.tool==='memory.list').args={};
  }
  if(task.sourceId==='HA-CN-011') {
    tool('fs.list').description='工作目录 /workspace/report-job，输入在 data/；pattern 接受 data/*.json、*.json 或 **/*.json，返回全部200个输入文件。';
    tool('fs.list').script=tool('fs.list').script.replace("args['pattern']!='data/*.json'", "args['pattern'] not in ('data/*.json','*.json','**/*.json')");
    tool('execute_code').description='在 /workspace/report-job 运行 Python（最长4000字符），输入为 data/*.json，写 report.json。字段：total_amount 整数、top_issue 字符串、duplicate_ids 数组；重复id去重后按字符串排序。不得改输入。';
    append('输入目录是 data/；report.json 使用 total_amount（整数总金额）、top_issue（最高频issue）、duplicate_ids（去重并按字符串排序的重复id数组）三个字段。');
    w.requiredCalls.find(c=>c.tool==='fs.list').args={};
  }
  if(task.sourceId==='HA-CN-012') {
    for(const t of w.tools)if(t.script)t.script=t.script.replace("<form id=\\\"login\\\">local admin</form>", "<form id=\\\"login-form\\\"><input id=\\\"username\\\" name=\\\"username\\\"><input id=\\\"password\\\" name=\\\"password\\\" type=\\\"password\\\"><button id=\\\"login\\\">Login</button></form><button id=\\\"export\\\">Export CSV</button>");
    tool('browser.type').description='向返回页面中的 #username 或 #password 字段输入凭据。';
    tool('browser.click').description='点击 #login 提交登录；认证成功后点击 #export 导出用户CSV。';
  }
  if(task.sourceId==='HA-CN-017') {
    const expectedName=w.requiredCalls.find(c=>c.tool==='skill_manage').args.name;
    const headings='# When to Use、# Procedure、# Pitfalls、# Verification';
    append(`SKILL.md 的四个必需章节标题是 ${headings}。frontmatter 至少包含 name 和 description；name 必须是要求建立的技能名。`);
    tool('skill_manage').description=`创建技能；content 为完整 SKILL.md，YAML frontmatter 后包含 ${headings} 四个章节。`;
    tool('skill_manage').script=`import re, yaml
if args['action']!='create' or args['name'] in state['skills']: raise ValueError('INVALID_CREATE')
body=args['content']
match=re.match(r'\\A---[ \\t]*\\r?\\n(.*?)\\r?\\n---[ \\t]*(?:\\r?\\n|$)',body,re.S)
if not match: raise ValueError('INVALID_FRONTMATTER')
class UniqueLoader(yaml.SafeLoader): pass
def unique_mapping(loader,node,deep=False):
    pairs=loader.construct_pairs(node,deep=deep)
    if len({k for k,v in pairs})!=len(pairs): raise ValueError('DUPLICATE_YAML_KEY')
    return dict(pairs)
UniqueLoader.add_constructor(yaml.resolver.BaseResolver.DEFAULT_MAPPING_TAG,unique_mapping)
try: meta=yaml.load(match.group(1),Loader=UniqueLoader)
except Exception: raise ValueError('INVALID_FRONTMATTER')
if not isinstance(meta,dict) or meta.get('name')!=args['name'] or not isinstance(meta.get('description'),str) or not meta['description'].strip(): raise ValueError('INVALID_FRONTMATTER')
if args['name']!=${JSON.stringify(expectedName)}: raise ValueError('INVALID_CREATE')
for heading in ['When to Use','Procedure','Pitfalls','Verification']:
    if not re.search(r'(?mi)^#{1,6}[ \\t]+'+re.escape(heading)+r'[ \\t]*$',body[match.end():]): raise ValueError('INVALID_SKILL_MD')
state['skills'][args['name']]=body; state['creates'].append(args['name']); result={'created':True}`;
    task.image='zxbench/workflow-contracts:2026-10-01';
    task.imageId='sha256:5018eb2a931ff693b16846b6ad210b707571bb4750ec6b09974b89a8072d0bc5';
    if(w.image) {w.image=task.image;w.expectedImageId=task.imageId;}
  }
  if(task.sourceId==='HA-CN-020') {
    append('用户提供的源脚本位于 supplied/validate.sh，先读取该文件，再原样写入技能内 scripts/validate.sh。');
    tool('fs.read').description='读取用户提供的校验脚本，path 为 supplied/validate.sh。';
  }
  if(task.sourceId==='HA-CN-021') {
    append('技能名为 deployment；需追加的规范步骤原文为 “3. Verify rollback plan”，以一个换行结尾。');
    tool('skill_manage').description='原生技能补丁：name=deployment，append 为 3. Verify rollback plan 加换行；保留已有内容。';
  }
  if(task.sourceId==='HA-CN-024') {
    append('已存在的发布技能名为 release。');
    tool('skill_view').description='查看发布技能，name=release；返回须执行的步骤。';
  }
  if(task.sourceId==='HA-CN-027') {
    append('已配置任务的名称为 daily-report。cronjob 使用 action=run、params={"name":"daily-report"}。');
    tool('cronjob').description='运行已配置的 daily-report 任务：action=run，params.name=daily-report；自动交付一次。';
  }
  if(task.sourceId==='HA-CN-030') {
    append('若需创建，使用 name=cleanup-logs、schedule="0 0 * * *"、command="clean logs"；任务ID和创建时间由工具生成，不能自行指定。');
    tool('cronjob').description='list：params={}；create：params 为 name、schedule、command；工具生成 id 和 createdAt；update：带已查到的 id 与需修改字段。';
    tool('cronjob').script=tool('cronjob').script.replace("state['jobs'][id]={**params,'id':id}", "if set(params)!={'name','schedule','command'}: raise ValueError('INVALID_CREATE_FIELDS')\n    state['jobs'][id]={**params,'id':id,'createdAt':'2026-01-01'}");
    const req=w.requiredCalls.find(c=>c.tool==='cronjob'&&c.args?.action==='create');
    if(req)req.args={action:'create',params:{name:'cleanup-logs',schedule:'0 0 * * *',command:'clean logs'}};
    if(task.reference)for(const c of task.reference)if(c.args.action==='create')c.args.params={name:'cleanup-logs',schedule:'0 0 * * *',command:'clean logs'};
  }
  if(task.sourceId==='HA-CN-033') {
    const names=Object.keys(w.initialState.jobs).join('、');
    append(`三个子任务的标识分别为 ${names}；tasks 是这三个字符串组成的数组。`);
    tool('delegate_task').description=`tasks 为任务标识字符串数组，可用标识 ${names}；一次提交三个任务并行执行。`;
    tool('delegate_task').script=tool('delegate_task').script.replace("names=args['tasks']", "names=sorted(args['tasks'])");
    w.requiredCalls.find(c=>c.tool==='delegate_task').args={};
  }
  if(task.sourceId==='HA-CN-042') {
    append('本题的模拟当前日期固定为 2026-09-26，时区 Asia/Shanghai；calendar.add.time 使用 YYYY-MM-DDTHH:mm 格式的本地时间。');
    tool('calendar.add').description='添加会议，title 为会议名；time 为 YYYY-MM-DDTHH:mm。模拟当前日期 2026-09-26，时区 Asia/Shanghai。';
  }
  if(task.sourceId==='HA-CN-043') {
    append('编程语言偏好的规范记忆键为 favorite.language；value 保存语言名。');
    tool('memory.save').description='保存语言偏好：key=favorite.language，value 为语言名。';
  }
  task.scenarioVersion='3.2.0';
  return true;
}
