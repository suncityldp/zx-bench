# 补测试任务单（4 题）

> 按 `docs/fixture-spec.md` 规范补全以下 4 题的 hiddenTests + fixture + referenceSolution。
> 输出格式完全对照已入库的 9 题范例：`data/scenarios/benchmark-hard-phpcsjv.json`（每题含 `requirements.fixture` + `requirements.referenceSolution`）。
> **验收门**：bug 版本（sourceCode）至少 1 个测试 fail；referenceSolution 全部测试 pass。

---

## 1. CP-L2-CS-001（C# · float_money）

**sourceCode（bug）**：
```csharp
public static double Sum(double[] prices) {
    double t = 0;
    foreach (var p in prices) t += p;
    return t;
}
```

- bug：用 double 累加金额，0.1+0.2 等产生浮点误差。
- 修复方向（explanationKeywords）：`decimal`、`0.1m`（改用 decimal 累加）。
- fixture：`{"language":"csharp","wrapInClass":true,"usings":[],"helpers":""}`。
- 测试建议：`Assert.Equal(0.3m, (decimal)Sum(new double[]{0.1, 0.2}))` 类精度断言（≥3 个，含常规/边界/负数）。

---

## 2. CP-L2-JV-002（Java · resource_leak）

**sourceCode（bug）**：
```java
static String readFirstLine(String path) throws IOException {
    BufferedReader r = new BufferedReader(new FileReader(path));
    String line = r.readLine();
    r.close();
    return line;
}
```

- bug：`readLine()` 抛异常时 `r.close()` 不执行 → 资源泄漏。
- 修复方向（explanationKeywords）：`try (BufferedReader`、try-with-resources、AutoCloseable。
- fixture：`{"language":"java","wrapInClass":true,"imports":["import java.io.*;"]}`。
- 测试建议：helpers 提供临时文件路径；测试正常读取 + 用反射/标志验证 close 被调用（≥2 个）。

---

## 3. CP-L3-CONC-JV-001（Java · check_then_act）

**sourceCode（bug）**：
```java
class Cache {
    private Map<String,Integer> m = new HashMap<>();
    int getOrCompute(String k, java.util.function.Supplier<Integer> f) {
        if (m.containsKey(k)) return m.get(k);
        int v = f.get();
        m.put(k, v);
        return v;
    }
}
```

- bug：check-then-act 非原子，并发下 `f` 可能被重复计算、结果不一致。
- 修复方向（explanationKeywords）：`ConcurrentHashMap`、`computeIfAbsent`。
- fixture：`{"language":"java","wrapInClass":false,"imports":["import java.util.*;","import java.util.concurrent.*;"]}`。
- 测试建议：并发调用 count `f.get()` 次数应恰为 1（≥2 个：单线程命中缓存 + 并发去重）。

---

## 4. CP-L2-PHP-001（PHP · loose_comparison）

**sourceCode（bug）**：
```php
function checkToken(string $provided, string $expected): bool {
    return $provided == $expected;
}
```

- bug：`==` 松比较，`"0e123" == "0e456"` 这类科学计数法字符串被误判相等。
- 修复方向（explanationKeywords）：`hash_equals`、`===`、timing（用 `===` 或 `hash_equals` 且常数时间）。
- fixture：`{"language":"php","phpVersion":"8.2","includes":[],"helpers":""}`。
- 测试建议：正常相等 / 正常不等 / `"0e123" vs "0e456"` 必须 false（≥3 个）。

---

## 提交格式

产出一个 JSON 数组（每元素一个完整 scenario，字段对齐 benchmark.json 条目），
包含 `hiddenTests`（数组，元素 `{id, type:'hidden', testCode, description, expectedExitCode:0}`）、
`requirements.fixture`、`requirements.referenceSolution`，并更新 `requirements.hiddenTests`（code 版）。
