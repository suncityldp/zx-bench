# 隐藏测试 fixture 补全规范（供补题 / 补测试使用）

> 用途：为 `hiddenTests` 为空、或 `requirements.fixture` 缺失的可执行程序题补测试用例与 fixture，
> 使其能走容器真实编译 + 执行（不再用静态关键词评分）。
> 本文档是「标准」——补题者按此规范补全，验收者按「第 4 节验证门」验收。

## 1. 哪些题需要补

- `dimension=program` 且 `language ∈ {go, java, c, rust, php, csharp, bash, sql, typescript}`；
- 且 `hiddenTests` 为空（`[]` / `null`），或虽有 hiddenTests 但缺 `requirements.fixture`。

## 2. fixture 字段（写在 `requirements.fixture`）

统一结构：`{ language, ...语言专属字段 }`。

### go
```json
"fixture": { "language": "go", "imports": ["sync"], "importStubs": ["sync.NewCond"], "helpers": "...", "race": false }
```
- `imports`：正确解可能用到的全部 import 包名（并集）。
- `importStubs`：与 imports 对齐的 use-stub（`包名.函数`），防止 bug 版本 unused import 编译失败。
- `helpers`：题面未定义但被 sourceCode 引用的依赖函数/变量。
- `race`：并发/数据竞争类题设 `true`。
- 完整 main 程序题（package main）用 `programMode: true` + `expectedOutput: ["行1","行2"]`（输出行排序后比对）。

### java
```json
"fixture": { "language": "java", "wrapInClass": true, "imports": ["import java.util.*;"], "helpers": "" }
```
- `wrapInClass`：sourceCode 是裸方法时 `true`；是完整 class 时 `false`（public class 会被自动去 public）。
- `helpers`：必须是**完整顶层类**（如 `class FdUtil {...}`），测试里以 `FdUtil.xxx()` 调用。

### c / cpp
```json
"fixture": { "language": "c", "includes": ["<stdint.h>"], "helpers": "" }
```
- `includes`：额外 `#include`（默认已含 stdio/stdlib/string/assert）。

### rust
```json
"fixture": { "language": "rust", "uses": ["use std::collections::HashSet;"], "helpers": "" }
```

### php
```json
"fixture": { "language": "php", "phpVersion": "8.2", "includes": [], "helpers": "" }
```
- 镜像 `php:8.2-cli` 内置 mbstring，assert 默认抛 AssertionError。

### csharp
```json
"fixture": { "language": "csharp", "wrapInClass": true, "usings": [], "helpers": "" }
```
- 断言是 xUnit 风格（`Assert.Equal`/`Assert.True`），由 runner 映射为自定义 Assert 类 throw。

### bash
```json
"fixture": { "language": "bash", "image": "bash:5", "setOptions": [], "helpers": "" }
```
- `image`：默认 `bash:5`。
- `setOptions`：如 `["-euo", "pipefail"]`（可选）。
- 断言风格：`[[ "$(fn ...)" == "expected" ]]`，以退出码判定（每条测试独立 bash 进程执行）。

### sql
```json
"fixture": { "language": "sql", "dialect": "sqlite", "schema": "CREATE TABLE ...", "seed": "INSERT ...", "expectedResult": [{"col": 1}], "forbidPlanPattern": "CORRELATED SCALAR SUBQUERY" }
```
- `schema`/`seed`：建表 + 插数 SQL。
- `expectedResult`：fix 查询应返回的结果集（JSON 规范化后深度比较）。
- `forbidPlanPattern`（可选）：EXPLAIN 计划禁用正则（n_plus_one 等性能题，如 `CORRELATED SCALAR SUBQUERY`）。

## 3. 测试用例要求（testCode）

每道题至少 2 个测试，覆盖：

1. **正常样例**：常规输入应得预期输出（happy path）。
2. **边界 / 异常样例**：空输入、边界值、非法输入等，专门暴露该 bug。

断言风格（按语言）：

| 语言 | 断言 | 示例 |
|---|---|---|
| go | `t.Fatal(...)` | `if got != want { t.Fatal(got) }` |
| java | JUnit `assertEquals` | `assertEquals(2.5, average(...), 1e-9)`（受检异常需在语句内 try-catch） |
| c | `assert(...)` | `assert(strcmp(r,"abcd")==0)` |
| rust | `assert_eq!(...)` | `assert_eq!(v, vec![1,2,3])` |
| php | `assert(...)` | `assert(fn('x') === true)` |
| csharp | `Assert.Equal/True` | `Assert.Equal(3.14m, Round(3.14159m))` |
| bash | `[[ ... ]]` | `[[ "$(fn 3)" == "4" ]]` |
| sql | 结果集比对 | （见 fixture.expectedResult） |

**铁律**：测试必须能区分 bug 与 fix——bug 版本至少 fail 一个测试，fix 版本全部通过。

## 4. 验证门（补题后必过，否则不收）

对每道补好的题，用两段代码自检：

1. **reference solution（正确修复代码）**：全部测试通过（`test_pass=100`）。
2. **bug 版本（原始 sourceCode）**：对应 bug 的测试必须失败（`test_pass<100`）。

若 bug 版本「意外全过」，说明该 bug 在目标镜像的语义下已不存在（如 Go 1.22 循环变量、
Rust NLL borrow），必须改题（把 sourceCode 改成目标版本下真实存在的 bug），或标 `invalid`。

## 5. 环境 / 镜像（执行后端统一）

| 语言 | 镜像 | 编译 / 运行 |
|---|---|---|
| go | `golang:1.21` | `go test`（function 模式）/ `go run`（program 模式） |
| java | `eclipse-temurin:17-jdk-alpine` | `javac -d /tmp/classes` + `JUnitCore`（jar 在 `data/java-libs/`） |
| c | `gcc:13` | `gcc -fsanitize=address` + 运行 |
| rust | `rust:1.75` | `rustc` + 运行 |
| php | `php:8.2-cli` | `php main.php` |
| csharp | `mono:6.12` | `mcs` + `mono`（MCR 不可达，用 mono 替代 dotnet） |
| bash | `bash:5` | `bash main.sh` |
| sql | `node:22-alpine` | node:sqlite 内存库 + 查询 |

## 6. 参考：已完成的题（可直接仿写）

- Go：`CP-L1-GO-001`、`CP-L2-GO-002`（helpers 桩）、`CP-L3-CONC-GO-001`（race）、`CR2-GO-001`（programMode）。
- Java：`CP-L1-JV-001`（wrapInClass）、`CR2-JV-002`（helpers 顶层类 FdUtil）。
- C：`CP-L2-CC-001`（buffer overflow ASan）、`CR2-CC-003`（use-after-return）。
- PHP：`CP-L2-PHP-001`（loose_comparison）、`PH-001`（strpos falsy）。
- C#：`CP-L3-SEM-CS-001`（1000 次累加）、`CS-001`（HashSet 去重）。
- Bash：`SH-001`（08/09/010 八进制三层杀伤）。
- SQL：`CP-L2-SQL-001`（结果集）、`CP-L3-PERF-SQL-001`（forbidPlanPattern）。

这些题的 `requirements.fixture` 与 `hiddenTests` 是现成的正确范例，可直接 `git show` 或查 benchmark.json 对照。
