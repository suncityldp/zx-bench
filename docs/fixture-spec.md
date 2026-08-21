# 隐藏测试 fixture 补全规范（供补题 / 补测试使用）

> 用途：为 `hiddenTests` 为空、或 `requirements.fixture` 缺失的可执行程序题补测试用例与 fixture，
> 使其能走容器真实编译 + 执行（不再用静态关键词评分）。
> 本文档是「标准」——补题者按此规范补全，验收者按「第 4 节验证门」验收。

## 1. 哪些题需要补

- 主题库 `dimension=program` 且 `language ∈ {go, java, c, rust, php, csharp}`；
- 且 `hiddenTests` 为空（`[]` / `null`），或虽有 hiddenTests 但缺 `requirements.fixture`。

## 2. fixture 字段（写在 `requirements.fixture`）

统一结构：`{ language, ...语言专属字段 }`。

### go
```json
"fixture": {
  "language": "go",
  "imports": ["sync"],
  "importStubs": ["sync.NewCond"],
  "helpers": "func fetch(id string) error { ... }",
  "race": false
}
```
- `imports`：正确解可能用到的全部 import 包名（并集）。
- `importStubs`：与 imports 对齐的 use-stub 表达式（`包名.函数`），防止 bug 版本 unused import 编译失败。
- `helpers`：题面未定义但被 sourceCode 引用的依赖函数/变量（如 fetch 桩）。
- `race`：并发/数据竞争类题设 `true`（启用 `go test -race`）。

### java
```json
"fixture": {
  "language": "java",
  "wrapInClass": true,
  "imports": ["import java.util.*;"],
  "helpers": ""
}
```
- `wrapInClass`：sourceCode 是裸方法（无 class 包裹）时 `true`；是完整 class 时 `false`。
- `imports`：额外 import 语句（`import java.util.*;` 等）。

### c
```json
"fixture": {
  "language": "c",
  "includes": ["<stdint.h>"],
  "helpers": ""
}
```
- `includes`：额外 `#include`（默认已含 stdio/stdlib/string/assert）。

## 3. 测试用例要求（testCode）

每道题至少 2 个测试，覆盖：

1. **正常样例**：常规输入应得预期输出（happy path）。
2. **边界 / 异常样例**：空输入、边界值、非法输入、资源耗尽等，专门暴露该 bug。

断言风格（按语言）：

| 语言 | 断言 | 示例 |
|---|---|---|
| go | `t.Fatal(...)` | `if got != want { t.Fatal(got) }` |
| java | JUnit `assertEquals` | `assertEquals(2.5, average(...), 1e-9)` |
| c | `assert(...)` | `assert(strcmp(r,"abcd")==0)` |
| rust | `assert_eq!(...)` | `assert_eq!(v, vec![1,2,3])` |

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
| go | `golang:1.21` | `go test -run TestHidden -count=1 -v ./...` |
| java | `eclipse-temurin:17-jdk-alpine` | `javac -d /tmp/classes` + `JUnitCore`（jar 在 `data/java-libs/`） |
| c | `gcc:13` | `gcc -fsanitize=address` + 运行 |

## 6. 参考：已完成的题（可直接仿写）

- Go：`CP-L1-GO-001`（goroutine_capture）、`CP-L2-GO-002`（error_wrapping，含 helpers 桩）、`CP-L3-CONC-GO-001`（race=true）。
- Java：`CP-L1-JV-001`（wrapInClass）、`CP-L2-JV-001`（class + imports）。
- C：`CP-L2-CC-001`（buffer overflow，ASan 暴露）。

这些题的 `requirements.fixture` 与 `hiddenTests` 是现成的正确范例，可直接 `git show` 或查 benchmark.json 对照。
