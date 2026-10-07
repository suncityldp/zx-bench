import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {hashScenarioShort} from '../packages/core/dist/contracts/canonicalize.js';

export const PROGRAM_REVISION='program-submission-contracts-20261007-v1';
const submissionIds=['CP-L1-JS-001','CP-L2-TD-GO-001','CP-L3-PY-010','CP-L3-PY-011','CP-L3-JV-005','CP-L3-CS-004','CP-L3-TS-003','CP-L3-TS-007','CP-L2-CC-001','CP-L3-CC-003'];
const sourceContract='提交契约：输出一个带语言标记的代码块，包含可独立编译或导入的候选源码；保留必要的 import/using/include、类型声明和外层类。可以在代码块后简要说明；不要求 ANSWER/答案标签。题面提供的辅助类型若被候选引用，必须随完整源码保留。评分器不得把已提交的依赖或类包装截掉。';
export function reviseProgramScenario(scenario) {
 const s=structuredClone(scenario),before=JSON.stringify(s);
 if(s.requirements?.programRevision===PROGRAM_REVISION)return s;
 if(submissionIds.includes(s.id)) {
  s.requirements={...s.requirements,submissionContract:{protocol:'complete-source-v1'}};
  let contract=sourceContract;
  if(s.id==='CP-L3-TS-003') {
   s.requirements.submissionContract={protocol:'source-or-target-declaration-v1',targetNames:['ExtractResponse']};
   contract='提交契约：输出一个 typescript 代码块，可提交完整源码，也可仅提交名为 ExtractResponse 的类型别名。仅提交该别名时，评分器用它替换原题同名定义，保留原题 User、Post、ApiRoute、Routes 声明；不会补写其他模型代码。可在代码块后简要说明，不要求 ANSWER/答案标签。';
  }
  s.promptTemplate+='\n\n'+contract;
 }
 if(s.id==='CP-L1-PY-004')s.promptTemplate='行为契约：squares(values) 仅返回输入中非负数的平方，保留相对顺序；负数应被过滤。输入是有限实数序列。\n\n'+s.promptTemplate;
 if(s.id==='CP-L3-AW-JS-006')s.promptTemplate='行为契约：args 为可 JSON 序列化的普通 JSON 值；唯一性按 tool 与 JSON.stringify(args) 的结果判断，属性插入顺序属于序列化键的一部分，不要求语义规范化或深排序。\n\n'+s.promptTemplate;
 if(s.id==='CP-L4-CS-001') {
  const req=s.requirements;
  const context=req.files.find(f=>f.path==='src/Shop/Data/AppDbContext.cs');
  context.content=context.content.replace('public class AppDbContext : DbContext\n{','public class AppDbContext : DbContext\n{\n    public AppDbContext() { }\n    public AppDbContext(DbContextOptions<AppDbContext> options) : base(options) { }').replace('=> ob.UseSqlite("Data Source=shop.db");','{ if (!ob.IsConfigured) ob.UseSqlite("Data Source=shop.db"); }').replace('EnableRetryOnFailure 由任务4 决策','SQLite 兼容执行策略由任务4 决策');
  req.files.find(f=>f.path==='src/Shop/Services/OrderService.cs').content='using Shop.Models;\n'+req.files.find(f=>f.path==='src/Shop/Services/OrderService.cs').content;
  req.files.find(f=>f.path==='src/Shop/Program.cs').content=`using Shop.Services;
var builder = WebApplication.CreateBuilder(args);
builder.Services.AddDbContext<AppDbContext>();
builder.Services.AddScoped<OrderService>();
var app = builder.Build();
using (var scope = app.Services.CreateScope())
    scope.ServiceProvider.GetRequiredService<AppDbContext>().Database.EnsureCreated();
app.MapGet("/report", (int customerId, OrderService svc) => svc.ReportAsync(customerId));
app.MapPost("/import", (List<ImportItem> items, OrderService svc) => svc.ImportAsync(items.Select(i => (i.Sku, i.Price))));
app.MapGet("/products", (OrderService svc) => svc.ListProductsAsync());
app.Run();
public record ImportItem(string Sku, decimal Price);
public partial class Program { }
`;
  s.promptTemplate=s.promptTemplate.replace('EnableRetryOnFailure(maxRetryCount:3) + CommandTimeout(30)','SQLite 可用的瞬时故障执行策略（SQLITE_BUSY/LOCKED 最多重试3次）+ CommandTimeout(30)');
  s.promptTemplate+='\n\n脚手架保证：原始工程可编译，入口及三个端点均提供完整实现；不要求填补省略号。AppDbContext 保留无参和 DbContextOptions<AppDbContext> 两个公开构造函数，尊重外部配置的 SQLite 连接与拦截器。SQLite 不支持 SQL Server 的 EnableRetryOnFailure 扩展，必须使用 SQLite 兼容策略。输入路径为 /report?customerId=、/import、/products；保留其参数与响应结构。';
  req.hiddenTestFiles.find(f=>f.path.endsWith('RetryOnFailureTests.cs')).content=`using Microsoft.Data.Sqlite;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Storage;
using Xunit;
namespace Shop.Tests;
public class RetryOnFailureTests {
 [Fact] public void RetryingStrategyAndTimeoutConfigured() {
  var (db, _, _) = H.New();
  Assert.Equal(30, db.Database.GetCommandTimeout());
  var strategy = db.Database.CreateExecutionStrategy();
  int attempts = 0;
  Assert.Equal(7, strategy.Execute(() => { if (++attempts < 3) throw new SqliteException("busy", 5); return 7; }));
  Assert.Equal(3, attempts);
  attempts = 0;
  var failure = Assert.ThrowsAny<Exception>(() => strategy.Execute(() => { attempts++; throw new SqliteException("locked", 6); }));
  var sqlite = failure as SqliteException ?? failure.InnerException as SqliteException;
  Assert.NotNull(sqlite);
  Assert.Equal(6, sqlite.SqliteErrorCode);
  Assert.Equal(4, attempts);
  attempts = 0;
  Assert.Throws<InvalidOperationException>(() => strategy.Execute(() => { attempts++; throw new InvalidOperationException("permanent"); }));
  Assert.Equal(1, attempts);
 }
}
`;
  req.explanationKeywords=req.explanationKeywords.map(k=>k.replace('EnableRetryOnFailure','ExecutionStrategy'));
 }
 if(s.id==='CP-L4-CS-002') {
  const req=s.requirements;
  const context=req.files.find(f=>f.path==='src/Api/Data/AppDbContext.cs');
  context.content=context.content.replace('public class AppDbContext : DbContext\n{','public class AppDbContext : DbContext\n{\n    public AppDbContext() { }\n    public AppDbContext(DbContextOptions<AppDbContext> options) : base(options) { }').replace('=> ob.UseSqlite("Data Source=tele.db");','{ if (!ob.IsConfigured) ob.UseSqlite("Data Source=tele.db"); }');
  const program=req.files.find(f=>f.path==='src/Api/Program.cs');
  program.content=program.content.replace('app.MapGet("/events", ...);      // 只读查询端点','app.MapGet("/events", (AppDbContext db) => db.Events.ToList());\napp.MapGet("/events/count", (AppDbContext db) => new { count = db.Events.Count() });').replace('app.MapPost("/events", ...);     // 写入端点','app.MapPost("/events", (AppDbContext db, TeleEvent ev) => { db.Events.Add(ev); db.SaveChanges(); return Results.Created($"/events/{ev.Id}", ev); });').replace('app.MapGet("/debug/db", ...);    // 任务4 —— 池监控','app.MapGet("/debug/db", () => new { activeConnections = 0, trackerEntries = 0 }); // 任务4：实现真实监控').replace('app.Run();','using (var scope = app.Services.CreateScope()) scope.ServiceProvider.GetRequiredService<AppDbContext>().Database.EnsureCreated();\napp.Run();');
  req.hiddenTestFiles.find(f=>f.path.endsWith('Harness.cs')).content=req.hiddenTestFiles.find(f=>f.path.endsWith('Harness.cs')).content.replace('WebApplicationFactory<Program>','WebApplicationFactory<AppDbContext>');
  s.promptTemplate+='\n\n公开端点契约：GET /events 返回事件数组；POST /events 接收 Source、Payload 并创建事件；GET /events/count 返回 {count}；GET /debug/db 返回 {activeConnections, trackerEntries}。隐藏测试通过公开 AppDbContext 所在程序集定位入口，不要求额外公开顶层 Program。AppDbContext 保留无参和 DbContextOptions<AppDbContext> 两个公开构造函数，并尊重外部配置。原始入口没有省略号，可正常编译和启动。';
 }
 if(s.id==='CP-L4-SH-001') {
  s.requirements.image='zxbench/bash:5-compatible';
  s.environmentImage='zxbench/bash:5-compatible';
  s.promptTemplate+='\n\n运行环境契约：固定 Bash 5 兼容镜像，/bin/bash 与 /usr/bin/env bash 均可用，并提供 flock、timeout、awk。构建离线完成；候选执行仍禁网。';
 }
 if(JSON.stringify(s)===before)return s;
 s.requirements={...s.requirements,programRevision:PROGRAM_REVISION};
 s.scenarioVersion=s.grader==='project_repair'?'1.3.0':'5.1.0';
 s.graderVersion=s.grader==='project_repair'?'1.3.0':'4.15.0';
 s.scenarioHash=hashScenarioShort(s);
 return s;
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
 const root=fileURLToPath(new URL('../',import.meta.url));
 const file=path.join(root,'data/scenarios/benchmark.json');
 const bank=JSON.parse(fs.readFileSync(file,'utf8')),revised=bank.map(reviseProgramScenario);
 const changes=bank.flatMap((s,i)=>s.scenarioHash===revised[i].scenarioHash?[]:[{id:s.id,before:s.scenarioHash,after:revised[i].scenarioHash}]);
 const manifestFile=path.join(root,'data/scenarios/program-revision-manifest.json');
 if(changes.length) {
  if(fs.existsSync(manifestFile))throw Error('Revision manifest already exists; check its policy before replacing evidence');
  fs.writeFileSync(manifestFile,JSON.stringify({schemaVersion:1,policy:PROGRAM_REVISION,historicalAnswersUnchanged:true,historicalScoresUnchanged:true,deliberateTrapsUnchanged:['PR-ELITE-001','PR-ELITE-002','PR-ELITE-004','PR-ELITE-005'],scenarios:changes},null,2)+'\n');
 }
 fs.writeFileSync(file,JSON.stringify(revised,null,2)+'\n');
 const metaFile=path.join(root,'data/scenarios/benchmark-meta.json'),meta=JSON.parse(fs.readFileSync(metaFile,'utf8'));
 meta.programRevision={policy:PROGRAM_REVISION,scenarioIds:revised.filter(s=>s.requirements?.programRevision===PROGRAM_REVISION).map(s=>s.id),historicalAnswersUnchanged:true};
 fs.writeFileSync(metaFile,JSON.stringify(meta,null,2)+'\n');
 const releaseFile=path.join(root,'data/scenarios/benchmark-release.json'),release=JSON.parse(fs.readFileSync(releaseFile,'utf8'));
 release.programRevision=meta.programRevision;
 fs.writeFileSync(releaseFile,JSON.stringify(release,null,2)+'\n');
 console.log(JSON.stringify({policy:PROGRAM_REVISION,count:changes.length,changes}));
}
