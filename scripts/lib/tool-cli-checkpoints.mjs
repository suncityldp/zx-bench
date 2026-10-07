import {reviewedArchiveAssertion} from './tool-content-delivery-review.mjs';
const python=code=>`python3 -I - <<'PY'\n${code}\nPY`;
const string=value=>JSON.stringify(value);
const linesCheck=(path,start,end,expected)=>python(`from pathlib import Path\nlines=Path(${string(path)}).read_text().splitlines()\nassert lines[${start}:${end??''}]==${string(expected)}`);
const split=(n,count)=>Array.from({length:count},(_,i)=>Math.floor(n/count)+(i<n%count?1:0));
/** Only validators change. Inputs, environment and submitted script are unchanged. */
export function addToolCliCheckpoints(s){
 if(!s.requirements.executionCases)return false;
 const n=Number((s.benchmarkSource?.id??s.requirements.migrationSourceId).slice(-3)),req=s.requirements;
 req.executionCheckpointRubric='cli-checkpoints-v1';
 for(const c of req.executionCases){
  const cp=[];const add=(id,description,assertCommand)=>cp.push({id,description,assertCommand});
  if(n===22){
   c.assertCommands=[reviewedArchiveAssertion(c)];
   add('archive','归档保存全部应处理文件和原始内容',c.assertCommands[0]);
   add('removed','删除全部已归档的过期日志',python(`from pathlib import Path\nassert all(not Path(p).exists() for p in ${string(c.absentFiles)})`));
   // Captured stdout is checked by the original strict verdict. Actual filesystem
   // checkpoints suffice for progress; neither preserved inputs nor exit=0 earn credit.
   c.safetyAssertCommands=[reviewedArchiveAssertion(c,true)];
  }
  if(n===23){const e=c.expectedFiles['tmp/report.txt'].trimEnd().split('\n'),avg=e.findIndex(l=>l.startsWith('AVG_MS'));
   add('top_ips','按日期过滤并正确统计、排序IP',linesCheck('tmp/report.txt',0,avg,e.slice(0,avg)));
   add('average','计算当天响应时间均值',linesCheck('tmp/report.txt',avg,avg+1,[e[avg]]));
   add('errors','原样交付当天5xx日志',linesCheck('tmp/report.txt',avg+1,null,e.slice(avg+1)));
  }
  if(n===24){const head="import subprocess\ndef git(*args): return subprocess.check_output(['git','-c','safe.directory=/workspace',*args],text=True).strip()\n";
   // The visible task requires the last output line, allowing normal Git logs.
   delete c.expectedStdout;
   c.expectedStdoutPattern='(?:^|\\n)merged\\r?\\n?$';
   // sentinel is a protected harness input, and may legitimately remain untracked.
   // All other untracked files and every tracked change still fail cleanliness.
   c.assertCommands=c.assertCommands.map(command=>command.replace("assert not git('status','--porcelain')","assert git('status','--porcelain') in ('', '?? sentinel')").replace("git('log','-1','--format=%s')","git('log','-1','--format=%s','feature/login')"));
   add('commit','feature/login提交指定消息且main保留正确login源码',python(head+`assert git('log','-1','--format=%s','feature/login')=='feat: add login module'\nassert git('show','HEAD:login.js')==${string(c.files.find(f=>f.path==='login.js').content.trim())}`));
   add('branch','建立feature/login且已提交目标源码',python(head+`assert git('branch','--list','feature/login')\nassert git('show','feature/login:login.js')==${string(c.files.find(f=>f.path==='login.js').content.trim())}`));
   add('merge','main包含feature/login且工作区干净（忽略未跟踪的保护输入sentinel）',python(head+"assert git('branch','--show-current')=='main'\nsubprocess.run(['git','-c','safe.directory=/workspace','merge-base','--is-ancestor','feature/login','main'],check=True)\nassert git('status','--porcelain') in ('', '?? sentinel')"));
  }
  if(n===25){const e=c.expectedFiles['diagnostics.txt'].trimEnd().split('\n');
   add('memory','筛选高RSS进程',linesCheck('diagnostics.txt',0,1,[e[0]]));
   add('cpu','排序CPU前五进程',linesCheck('diagnostics.txt',1,2,[e[1]]));
   add('python_system','正确列出Python进程、负载和内存',linesCheck('diagnostics.txt',2,5,e.slice(2,5)));
   add('terminated','确实终止指定测试进程',c.assertCommands[0]);
  }
  if(n===26){const e=c.expectedFiles['network-report.txt'].trimEnd().split('\n'),commands=c.expectedFiles['diag-calls.txt'].trimEnd().split('\n');
   e.forEach((line,i)=>add(commands[i],`实际运行并汇总 ${commands[i]}`,python(`from pathlib import Path\nreport=Path('network-report.txt').read_text().splitlines()\ncalls=Path('diag-calls.txt').read_text().splitlines()\nassert len(report)>${i} and report[${i}]==${string(line)}\nassert len(calls)>${i} and calls[${i}]==${string(commands[i])}`)));
  }
  if(n===27){const e=c.expectedFiles['users.txt'].trimEnd().split('\n');
   add('selected_sorted','按UID和shell筛选并正确排序账户',linesCheck('users.txt',0,-1,e.slice(0,-1)));
   add('count','按实际选出的账户计数',python(`from pathlib import Path\nlines=Path('users.txt').read_text().splitlines()\nassert len(lines)>1 and lines[-1]==${string(e.at(-1))}\nassert lines[-1]=='TOTAL '+str(len(lines)-1)`));
  }
  if(!cp.length)throw Error('CLI rubric missing task '+s.id);
  const weights=split(80,cp.length);c.checkpoints=cp.map((p,i)=>({...p,weight:weights[i]}));
 }
 return true;
}
