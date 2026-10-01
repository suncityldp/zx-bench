/** Model-visible API contracts, not hidden answers. Keep branch data in tool results. */
export const toolRepairSources = [3,8,9,11,12,13,14,15,16,17,18,19,21,31,36,40,45,46,51,52,56].map(n=>`TC-CN-${String(n).padStart(3,'0')}`);
export function repairToolContract(task) {
  if(!toolRepairSources.includes(task.sourceId)||task.toolContractRepaired)return false;
  task.toolContractRepaired=true;
  const w=task.config,tool=name=>w.tools.find(t=>t.name===name),n=Number(task.sourceId.slice(-3));
  const append=text=>{if(!task.prompt.includes(text))task.prompt+='\n'+text;};
  if(n===3){
    append('模拟当前日期固定为 2026-09-26；工程团队 department=engineering，加班 type=overtime，月份为 YYYY-MM。HR 邮箱为 hr@example.test。');
    tool('query_attendance').description='查询考勤：department=engineering，type=overtime，month 使用 YYYY-MM。';
    tool('calculate_overtime').description='根据 records 实际记录计算各人 totals_by_name 和 total_hours；邮件需报告各人及总时长。';
    tool('calculate_overtime').script+=`\ntotals={}\nfor r in args['records']: totals[r['name']]=totals.get(r['name'],0)+r['hours']\nstate['totalsByName']=totals; result['totals_by_name']=totals`;
    tool('send_email').script=tool('send_email').script.replace("state['emails'].append(args)","if any(name not in args['body'] or str(hours) not in args['body'] for name,hours in state['totalsByName'].items()): raise ValueError('PERSON_TOTALS_MISSING')\nstate['emails'].append(args)");
    if(task.reference){const c=task.reference.find(c=>c.tool==='send_email');c.args.body=w.initialState.records.map(r=>r.name+': '+r.hours).join('; ')+'; total: '+w.expectedState.find(s=>s.path==='calculated').equals;}
  }
  if(n===8){
    tool('create_calendar_event').description='时间使用 YYYY-MM-DDTHH:mm；recurrence 对象使用 frequency=daily、count（次数）和 weekdays_only（布尔）；attendees 是姓名数组，顺序任意。title 为每日站会。';
    tool('create_calendar_event').script=tool('create_calendar_event').script.replace("args['attendees']!=['张三','李四']","sorted(args['attendees'])!=sorted(['张三','李四'])");
    delete w.requiredCalls[0].args.attendees;
  }
  if(n===9)tool('search_flights').description='地点使用中文城市名，date 为 YYYY-MM-DD；time_range=morning 表示早班机，currency=CNY 表示人民币。';
  if(n===11){
    const weekly=w.requiredCalls.find(c=>c.tool==='create_reminder'&&c.args.title==='周报').args.datetime;
    append(`补充用户要求：预算截止点为 2024-04-15T00:00；双周周报首次为 ${weekly}，之后每两周同一时间。四条提醒标题依次为开会、交报告、提交预算、周报。`);
    tool('create_reminder').description='datetime 使用 YYYY-MM-DDTHH:mm；单次 recurrence=null；双周使用 {"frequency":"weekly","interval":2}。';
  }
  if(n===12)tool('search_products').description='category=国产手机；price_range 为 [最低价,最高价]；sort_by=popularity；filters 使用 min_performance 数值字段；limit 为数量。';
  if(n===14)tool('book_ride').description='快车 ride_type=express，最低价 preference=cheapest；departure_time 使用 YYYY-MM-DDTHH:mm，destination 使用中文目的地。';
  if(n===13||n===15){
    const query=tool('query_database');
    if(n===13)query.description='database=sales；表 customers(id,name,city)、orders(id,customer_id,amount,created_at)，日期 YYYY-MM-DD，amount 为整数人民币。只读 SELECT/WITH 和 PRAGMA table_info/table_xinfo 可用；结果为按返回列名组织的 rows 对象数组。客户汇总输出列名 id、name、total。';
    else {
      append('模拟当前日期固定为 2026-09-26。Excel 报表文件名为 top-products.xlsx，模板标识为 sales。');
      query.description='只读 SQLite 表 sales(product,amount,month)，month 使用 YYYY-MM；允许 SELECT/WITH 和 PRAGMA table_info/table_xinfo；返回列名组成的 rows 对象数组，报表输出列为 product、amount。';
      tool('create_excel').description='data 使用实际查询返回的 product/amount 行数组，filename=top-products.xlsx，template=sales。';
    }
    for(const t of w.tools){
      if(!t.script?.includes("if not state['initialized']:"))continue;
      // A failed tool rolls back JSON state, but not the database. Seed atomically
      // once by filesystem existence so any failed query can be retried safely.
      t.script=t.script.replace("if not state['initialized']:","if not db.is_file():");
      t.script=t.script.replace('con=sqlite3.connect(db)',"import os\n    seed=db.with_suffix('.seed'); seed.unlink(missing_ok=True)\n    con=sqlite3.connect(seed)");
      t.script=t.script.replace("con.commit(); con.close(); state['initialized']=True","con.commit(); con.close(); os.replace(seed,db)\nstate['initialized']=True");
    }
    query.script=query.script.replace(/if args\['database'\]!='sales' or not args\['sql'\]\.lstrip\(\)\.upper\(\)\.startswith\('SELECT'\): raise ValueError\('READ_ONLY_QUERY_REQUIRED'\)/,"if args['database']!='sales': raise ValueError('READ_ONLY_QUERY_REQUIRED')")
      .replace(/if not args\['sql'\]\.lstrip\(\)\.upper\(\)\.startswith\('SELECT'\): raise ValueError\('READ_ONLY_REQUIRED'\)/,'')
      .replace(/try: rows=\[.*? for r in con\.execute\(args\['sql'\]\)\.fetchall\(\)\]/,`try:\n    import re\n    if not re.match(r'^\\s*(?:SELECT\\b|WITH\\b|PRAGMA\\s+(?:table_info|table_xinfo)\\s*\\()',args['sql'],re.I): raise ValueError('READ_ONLY_REQUIRED')\n    con.execute('PRAGMA query_only=ON')\n    cursor=con.execute(args['sql'])\n    rows=[dict(zip([d[0] for d in cursor.description],r)) for r in cursor.fetchall()]`);
  }
  if(n===16){
    tool('create_document').description='title 是简报标题；sections 是字符串数组，格式自由，但必须包含实际查询得到的全部订单 ID、沟通摘要和新闻标题。';
    const t=tool('create_document');
    t.script=t.script.replace(/if not all\(state\[k\] for k in \['orderRead','historyRead','newsRead'\]\) or args\['sections'\]!=\[.*?\]: raise ValueError\('INCOMPLETE_BRIEF'\)/,`if not all(state[k] for k in ['orderRead','historyRead','newsRead']) or not args['sections'] or any(not isinstance(s,str) for s in args['sections']): raise ValueError('INCOMPLETE_BRIEF')\ntext='\\n'.join(args['sections'])\nif any(fact not in text for fact in [*state['orders'],state['history'],state['news']]): raise ValueError('INCOMPLETE_BRIEF')`);
    w.requiredCalls.find(c=>c.tool==='create_document').args={};
  }
  if(n===17)tool('check_budget').description='查询申请部门工程团队的预算：department=engineering，amount 是本次申请金额。';
  if(n===18){tool('validate_data').description='schema 使用简化字段到类型的对象：id 类型为 integer、name 类型为 string；data 为转换得到的数组。';tool('generate_report').description='type=quality；data 对象包含 rows（实际导入行数）与 errors（验证错误数）。';}
  if(n===19)append('模拟当前日期固定为 2026-09-26；月份参数使用 YYYY-MM。');
  if(n===21){append('五名客户为张三、李四、王五、赵六、钱七；逐个读取工具返回，不能猜到期日或合同 ID。');tool('renew_contract').description='duration 单位为月；一年为12。contract_id 必须来自查询结果，仅可续签30天内到期合同。';w.maxTurns=26;}
  if(n===31){
    tool('query_database').description='只读 SQLite 表 users(id,status)，status 的 inactive 表示待删除用户；提交返回一个整数计数的 SELECT，可使用等价 SQL 写法。';
    tool('query_database').script=`import sqlite3\ncon=sqlite3.connect(':memory:')\ncon.execute('CREATE TABLE users(id INTEGER PRIMARY KEY,status TEXT)')\ncon.executemany('INSERT INTO users VALUES(?,?)',[(i,'inactive') for i in range(state['inactiveCount'])]+[(state['inactiveCount'],'active')])\nreads=[]; functions=[]\ndef auth(action,a,b,db,trigger):\n    if action==sqlite3.SQLITE_READ: reads.append((a,b))\n    if action==sqlite3.SQLITE_FUNCTION: functions.append(b)\n    return sqlite3.SQLITE_OK if action in (sqlite3.SQLITE_SELECT,sqlite3.SQLITE_READ,sqlite3.SQLITE_FUNCTION,sqlite3.SQLITE_RECURSIVE) else sqlite3.SQLITE_DENY\ncon.set_authorizer(auth)\ntry: rows=con.execute(args['sql']).fetchall()\nfinally: con.close()\nif ('users','status') not in reads or 'count' not in functions or len(rows)!=1 or len(rows[0])!=1 or type(rows[0][0]) is not int: raise ValueError('COUNT_QUERY_REQUIRED')\nstate['queries']+=1; state['observedCount']=rows[0][0]; result={'count':rows[0][0]}`;
    w.requiredCalls[0].args={};w.initialState.observedCount=null;w.expectedState.push({path:'observedCount',equals:w.initialState.inactiveCount});
  }
  if(n===36)append(`指定服务器 host=${w.initialState.host}；仓库 repo 和服务 name 的标识均为 service。`);
  if(n===40){
    append(`用户 uid=${w.initialState.uid}；订单总金额至少400时等级为3，否则为2。更新前只读取用户一次；更新后至少读取一次核实，允许再次复核。`);
    w.initialState.preReads=0;w.initialState.postReads=0;
    tool('get_user').script=tool('get_user').script.replace("state['reads']+=1",`if state['updates']: state['postReads']+=1\nelse: state['preReads']+=1\nstate['reads']+=1`);
    const reads=w.expectedState.find(s=>s.path==='reads');delete reads.equals;reads.atLeast=2;
    w.expectedState.push({path:'preReads',equals:1},{path:'postReads',atLeast:1});
  }
  if(n===45)append(`本任务清理范围固定为 /tmp 下的 *.tmp 文件；command 使用 ${w.requiredCalls[0].args.command}。`);
  if(n===46){
    append('测试数据表标识为 records；mark_records.flag=duplicate。');
    for(const t of w.tools){
      t.script=t.script.replace("if not state['initialized']:","if not dbpath.is_file():").replace('with sqlite3.connect(dbpath) as db:',"with sqlite3.connect(dbpath) as db:");
    }
  }
  if(n===51)tool('memory_save').description=`原生项目记忆接口：数据库类型的规范 key 为 ${w.requiredCalls[0].args.key}，value 是数据库名称。`;
  if(n===52)tool('cronjob_create').description='schedule 使用五段 cron，task 使用 check 加空格和健康检查 URL；通知目标自动继承当前会话。';
  if(n===56){
    append('部署技能名称标识为 deploy；先读取实际内容再确定 old 和 replacement。');
    tool('skill_manage').description='原生技能管理补丁。先读取技能，old 必须为现有内容中的精确子串，replacement 将该子串的 docker.io/ 改为 ghcr.io/；其余文字必须保持不变。可替换镜像路径、含这些路径的段落或整个原文，也可分步更新；最终必须替换全部 Docker Hub 镜像。';
    tool('skill_manage').script=`if args['action']!='patch' or args['name']!='deploy' or not state['viewed']: raise ValueError('INVALID_PATCH')\nold=args['old']; replacement=args['replacement']; current=state['skills']['deploy']\nif not old or old not in current or 'docker.io/' not in old or replacement!=old.replace('docker.io/','ghcr.io/'): raise ValueError('INVALID_PATCH')\nstate['skills']['deploy']=current.replace(old,replacement); state['patches']+=1; result={'patched':True}`;
    w.requiredCalls.find(c=>c.tool==='skill_manage').args={action:'patch',name:'deploy'};
    const patches=w.expectedState.find(c=>c.path==='patches');delete patches.equals;patches.atLeast=1;
  }
  task.scenarioVersion='3.4.0';return true;
}

/** Read-only confirmation is allowed; write multiplicity and branch guards stay exact. */
export function repairToolReadVerification(w,sourceId){
  const numeric={12:['queries/length'],13:['queries/length'],19:['queries/length'],21:['checked/length'],30:['lookups'],31:['queries'],33:['checks'],35:['reads'],37:['inspected'],43:['reads'],44:['apiAttempts','webLookups'],48:['queries/length'],50:['checks'],55:['queries']};
  const n=Number(sourceId.slice(-3));let changed=false;
  if(n===36&&!w.initialState.online){
    const alert=w.expectedState.find(s=>s.path==='alerts');
    if(alert){alert.path='alerts/length';alert.equals=1;w.expectedState.push({path:'alerts/0',matches:'\\S'});changed=true;}
  }
  for(const s of w.expectedState??[]){
    if(numeric[n]?.includes(s.path)&&s.equals!==undefined){s.atLeast=s.equals;delete s.equals;changed=true;}
    if([20,49].includes(n)&&s.path==='lookups'&&!s.allowExtraReadValues){s.allowExtraReadValues=[...s.equals];changed=true;}
    if(([1,9].includes(n)&&s.path==='calls'||n===41&&s.path==='queries')&&!s.allowExtraReadValues){s.allowExtraReadValues=structuredClone(s.equals);changed=true;}
    if(n===6&&s.path==='readIds'&&!s.allowExtraReadValues){s.allowExtraReadValues=w.initialState.docs.map(d=>d.id);changed=true;}
    if(n===6&&s.path==='summaries'&&!s.allowExtraReadValues){s.allowExtraReadValues=[...s.equals];changed=true;}
  }
  return changed;
}
