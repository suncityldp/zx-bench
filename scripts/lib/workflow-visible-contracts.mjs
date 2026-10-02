/** Reviewed workflow contracts: publish API constraints, never hidden outcomes. */
export const workflowVisibleSources = ['HA-CN-001','HA-CN-002','HA-CN-009','HA-CN-011','HA-CN-012','HA-CN-013',
  'HA-CN-014','HA-CN-015','HA-CN-016','HA-CN-019','HA-CN-023','HA-CN-024','HA-CN-025','HA-CN-026','HA-CN-028',
  'HA-CN-029','HA-CN-030','HA-CN-032','HA-CN-034','HA-CN-035','HA-CN-040','HA-CN-041','HA-CN-044'];

export function repairWorkflowVisibility(task) {
  const w=task.config, source=task.sourceId;
  if(!workflowVisibleSources.includes(source)) return false;
  const tool=name=>w.tools.find(t=>t.name===name);
  const append=text=>{if(!task.prompt.includes(text))task.prompt+='\n'+text;};
  const describe=(name,text)=>{const t=tool(name);if(t&&!t.description?.includes(text))t.description=(t.description??'')+' '+text;};
  const relax=(name,keep={})=>{for(const c of w.requiredCalls??[])if(c.tool===name)c.args=keep;};
  // Idempotence is essential: the same module repairs generated and frozen packs.
  const replace=(t,old,next)=>{if(t?.script?.includes(old)&&!t.script.includes(next))t.script=t.script.replace(old,next);};
  const pathPrefix=(key,root)=>`from pathlib import PurePosixPath\nargs=dict(args)\np=PurePosixPath(args[${JSON.stringify(key)}])\nif '..' in p.parts: raise ValueError('PATH_NOT_ALLOWED')\nif p.is_absolute():\n    try: p=p.relative_to(${JSON.stringify(root)})\n    except ValueError: raise ValueError('PATH_NOT_ALLOWED')\nargs[${JSON.stringify(key)}]=str(p)\n`;
  const normalizePath=(name,key,root)=>{const t=tool(name),prefix=pathPrefix(key,root);if(t&&!t.script.startsWith(prefix))t.script=prefix+t.script;};

  if(source==='HA-CN-001') {
    append('本题的冲突消除流程要求：先 memory.read 读取旧键，再 memory.delete 删除旧条目，最后 memory.save 保存规范的新事实。');
  }
  if(source==='HA-CN-002') {
    // The tool returns only keys satisfying the prefix; the actual reads and
    // final state prove relevance, without prescribing one search spelling.
    relax('memory.list');
    describe('memory.list','prefix 可为空或使用能检索到部署条目的前缀，例如 deploy、deploy/；评分不要求固定前缀字符串。');
    const save=w.requiredCalls.find(c=>c.tool==='memory.save');
    append(`压缩记忆保存到规范键 ${save.args.key}，value 使用规范格式 ${JSON.stringify(save.args.value)}。待清理的旧键须从 memory.list 返回值读取，禁止猜测。`);
  }
  if(source==='HA-CN-009') {
    const t=tool('terminal');
    replace(t,"if args['cmd']!='pytest -q': raise ValueError('COMMAND_NOT_ALLOWED')",`import shlex\nparts=shlex.split(args['cmd'])\nif parts[:3] in (['python','-m','pytest'],['python3','-m','pytest']): parts=['pytest']+parts[3:]\nif not parts or parts[0]!='pytest' or any(x not in ('-q','-v','-vv','test_app.py','./test_app.py') for x in parts[1:]): raise ValueError('COMMAND_NOT_ALLOWED')`);
    relax('terminal');
    describe('terminal','cmd 接受 pytest、pytest -q/-v/-vv、python -m pytest、python3 -m pytest，可指定 test_app.py；所有形式都验证完整的本题测试，拒绝其他命令和 shell 运算符。');
    normalizePath('fs.read','path','/workspace/mini');normalizePath('fs.patch','path','/workspace/mini');
    relax('fs.read');relax('fs.patch');
    describe('fs.read','工作目录 /workspace/mini；应用文件 app.py、测试文件 test_app.py；接受对应 ./ 和工作目录内绝对路径。');
    describe('fs.patch','path 指向 app.py；content 为完整替换内容，最长1000字符，保留 def double(x): 接口，禁止修改测试。');
    append('应用和测试分别为 app.py、test_app.py。请先运行完整测试，再读取这两个文件，修复应用后重跑完整测试；本题不是任意命令的通用终端。');
    // Record canonical file reads in trusted state: raw argument spelling can
    // differ, and reading one file twice must not substitute for the other.
    const read=tool('fs.read');
    replace(read,"state['reads'].append(args['path']); result=(root/args['path']).read_text()","state['reads'].append(args['path'])\nstate.setdefault('fileReads',{})[args['path']]=state.get('fileReads',{}).get(args['path'],0)+1\nresult=(root/args['path']).read_text()");
    w.requiredCalls=w.requiredCalls.filter(c=>c.tool!=='fs.read');
    w.requiredCalls.splice(1,0,{tool:'fs.read',args:{}});
    for(const path of ['app.py','test_app.py'])if(!w.expectedState.some(s=>s.path==='fileReads/'+path))w.expectedState.push({path:'fileReads/'+path,atLeast:1});
    const runs=w.expectedState.find(s=>s.path==='runs');runs.allowExtraReadValues=['failed','passed'];
    const patches=w.expectedState.find(s=>s.path==='patches');delete patches.equals;patches.atLeast=1;
    if(task.reference&&!task.reference.some(c=>c.tool==='fs.read'&&c.args.path==='test_app.py')) {
      task.reference.splice(task.reference.findIndex(c=>c.tool==='fs.patch'),0,{tool:'fs.read',args:{path:'test_app.py'}});
    }
  }
  if(source==='HA-CN-011') {
    delete w.finalMessageMustContain;
    append('最终交付以 report.json 的实际内容为准；回复说明报告已生成及保存位置即可，不强制在回复重复金额和最高频问题。');
  }
  if(source==='HA-CN-012') {
    const open=w.requiredCalls.find(c=>c.tool==='browser.open');
    append(`本地登录地址为 ${open.args.url}；先读取 README.md 中的凭据，页面选择器以 browser.open 返回的 HTML 为准。`);
    describe('browser.open','url 为题面给出的本地登录地址；不访问外部网站。');
  }
  if(source==='HA-CN-013') {
    const paths=w.requiredCalls.filter(c=>c.tool==='fs.mkdir').map(c=>c.args.path);
    const project=paths[0];
    // Get the canonical project from initial source calls on the first pass,
    // and from the already-published description on subsequent passes.
    const name=project??w.tools.find(t=>t.name==='fs.write').description.match(/package name=([^；]+)/)?.[1];
    if(!name)throw Error('Missing project contract');
    normalizePath('fs.mkdir','path','/workspace');normalizePath('fs.write','path','/workspace');
    replace(tool('fs.mkdir'),"if args['path'] not in state['dirs']: state['dirs'].append(args['path'])","if args['path'] not in state['dirs']: state['dirs'].append(args['path'])\nstate.setdefault('createdDirs',{})[args['path'].replace('/','.')]=True");
    relax('fs.mkdir');relax('fs.write');
    let mkdirSeen=false;
    w.requiredCalls=w.requiredCalls.filter(c=>c.tool!=='fs.mkdir'||(!mkdirSeen&&(mkdirSeen=true)));
    for(const path of [name,`${name}.src`,`${name}.tests`])if(!w.expectedState.some(s=>s.path==='createdDirs/'+path))w.expectedState.push({path:'createdDirs/'+path,equals:true});
    describe('fs.mkdir','工作目录 /workspace，接受题面目录的相对路径、./ 写法及工作目录内绝对路径；不支持其他目录或 ..。');
    describe('fs.write',`package name=${name}；content 是合法 JSON，name 为项目名，scripts 必须是对象；path 为 ${name}/package.json，可用 ./ 或工作目录内绝对路径。`);
    append(`package.json 必须是合法 JSON，包含 name=${JSON.stringify(name)} 和对象类型 scripts；三个目录都要实际创建，路径允许 ./ 和尾部 /。`);
  }
  if(source==='HA-CN-014') {
    describe('fs.glob','pattern 使用 tmp/**/*.log，包含所有子目录；不支持任意 glob 表达式。');
    describe('fs.mkdir','path 为 backup 或 backup/，可带 ./；仅创建本题备份根目录。');
    describe('fs.delete','path 为 tmp 或 tmp/，可带 ./；仅删除本题已完整备份的临时根目录。');
    normalizePath('fs.mkdir','path','/workspace');normalizePath('fs.delete','path','/workspace');
    relax('fs.mkdir');relax('fs.delete');
    append('fs.glob 使用 pattern="tmp/**/*.log"；备份和清理目录分别是 backup 与 tmp。fs.copy.src 使用返回的相对路径，dst 将 tmp/ 前缀替换为 backup/。');
  }
  if(source==='HA-CN-016') {
    describe('fs.glob','pattern 使用 src/*.js；本题源码文件没有嵌套子目录。');
    describe('terminal','cmd 使用 node test.js；不提供任意 shell 命令。');
    describe('fs.patch','content 为完整替换内容，最长1000字符；每个源码文件修改前须先读取相同 path。');
    append('工具接口使用 src/*.js 列出源码，terminal 使用 cmd="node test.js" 验证；文件路径使用返回的相对路径。');
    const state=w.expectedState.find(s=>s.path==='patches/length');delete state.equals;state.atLeast=2;
    w.expectedState.find(s=>s.path==='runs').allowExtraReadValues=['passed'];
  }
  if(source==='HA-CN-015') {
    describe('terminal','cmd 使用 npm start；本题不支持其他 shell 命令。');
    describe('fs.write','本题安全沙箱仅接受模块实现 module.exports = { start: () => "ready" }; 或 exports.start = () => "ready";，允许空白和单双引号变化；缺失模块的路径从源码读取。');
    append('修复模块需要导出无参数 start 并返回字符串 ready；安全沙箱支持工具说明中的两种最小 CommonJS 实现，不接受任意代码。');
  }
  if(source==='HA-CN-019') {
    describe('skill_view','name=deployment。');
    describe('skill_manage','patch 的 params 包含 old 和 new 字符串；old 是读取到的 Docker Hub 地址或公共前缀，new 是对应 GHCR 替换值，替换全部匹配项。');
    relax('skill_manage',{action:'patch'});
    w.expectedState.find(s=>s.path==='operations').allowExtraReadValues=['patch'];
    append('部署技能名为 deployment；patch 使用 params={"old":"待替换文本","new":"替换文本"}。以读取的原文为准，所有 Docker Hub 地址都改成对应 GHCR 地址，其他内容保留。');
  }
  if(source==='HA-CN-023') {
    const name=w.requiredCalls.find(c=>c.tool==='skill_view').args.name;
    const expected=w.expectedState.find(s=>s.path==='skills/'+name).equals;
    const addition=expected.slice(w.initialState.skills[name].length);
    append(`用户提供的追加内容为以下原文（末尾保留换行）：\n\`\`\`markdown\n${addition}\`\`\`\nskill_manage 的 content 只传上述追加段落，不传整份旧文件，工具负责保留原文。`);
    describe('skill_manage','content 是题面给定的追加段落，包含 ## Pitfalls 与 ## Verification；不是整份文件替换内容。');
  }
  if(source==='HA-CN-024')describe('terminal','cmd 只接受 build、test、publish；按 skill_view 返回顺序逐个执行，不使用 npm 或 shell 拼接形式。');
  if(source==='HA-CN-025') {
    const create=w.requiredCalls.find(c=>c.tool==='cronjob');
    append(`本题 cronjob 使用五字段 cron，schedule=${JSON.stringify(create.args.schedule)}；endpoint 使用题面原地址，当前聊天来源由工具自动保留，不传 destination。`);
  }
  if(source==='HA-CN-026') {
    describe('cronjob','list 使用 params={}；update 使用 params={"id":"查询得到的ID","schedule":"*/30 * * * *","skill":"查询得到的技能名"}，不修改其他字段。');
    append('每30分钟的规范 schedule 为 "*/30 * * * *"；update 的 params 字段为 id、schedule、skill。任务ID从 list 返回值读取。');
    for(const c of w.requiredCalls)if(c.tool==='cronjob'&&c.args.action==='update')c.args={action:'update'};
  }
  if(source==='HA-CN-028')describe('send_message','list 使用 params={}；send 使用 params={"target":"从目录解析的频道ID","message":"题面要求的总结"}。');
  if(source==='HA-CN-029')describe('cronjob','list 使用 params={}；delete 使用 params={"id":"从目录确定的任务ID"}。');
  if(source==='HA-CN-030') {
    describe('cronjob','list 使用 params={}；已有匹配任务时复用，不能为了补全可选字段而再次 update。');
    if(task.variant===1)append('已有相同调度的任务时直接复用原任务，不新增或改写其字段；需要的ID、名称和配置从 list 返回值读取。');
  }
  if(source==='HA-CN-032')describe('schema.validate','data 和 schema 必须原样使用 config.generate 返回的对应对象，不自行猜测字段或替换冻结 schema。');
  if(source==='HA-CN-034') {
    const old="if args['cmd']!='rm -rf build-cache': raise ValueError('COMMAND_NOT_ALLOWED')";
    const check=`import shlex\nparts=shlex.split(args['cmd'])\nif len(parts)!=3 or parts[:2]!=['rm','-rf'] or parts[2] not in ('build-cache','build-cache/','./build-cache','./build-cache/'): raise ValueError('COMMAND_NOT_ALLOWED')`;
    replace(tool('approval.request'),old,check);replace(tool('terminal'),old,check);
    relax('approval.request');relax('terminal');
    describe('approval.request','cmd 接受 rm -rf build-cache，路径也可带 ./ 或尾部 /；不批准其他命令、目录或 shell 拼接。');
    describe('terminal','执行的 cmd 必须与先前获批的 cmd 字符串一致。');
    append('本题删除命令使用 rm -rf build-cache（可用 ./build-cache 或尾部 /）；审批和执行提交相同 cmd，禁止拼接其他 shell 操作。');
  }
  if(source==='HA-CN-035')describe('terminal','cmd 使用 mkdir -p 加 deploy 错误返回的缺失目录路径；不接受其他命令或 shell 拼接。');
  if(source==='HA-CN-040')describe('delegate_task','goal 为用户目标，context 为交给子任务的必要上下文，toolsets 为非空工具名字符串数组；禁止清单中的名称不接受，未列出的可选顶层字段也不接受。');
  if(source==='HA-CN-041') {
    append('回复应包含查询城市以及 weather.query 返回的天气结果，不能自行编造实时数据。');
    const city=w.requiredCalls[0].args.city;
    const status=JSON.parse(tool('weather.query').script.match(/result=\{'status':(.+)\}/)[1]);
    w.finalMessageMustContain=[city,status];
    if(task.reference)task.referenceMessage=`${city}天气：${status}。`;
  }
  if(source==='HA-CN-044')describe('calendar.list','查询本题模拟的今天，date 使用字符串 today；日程内容从返回值读取。');
  return true;
}
