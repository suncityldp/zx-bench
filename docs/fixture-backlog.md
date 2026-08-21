# 补测试任务单（CR2 剩余 7 题）

> 按 `docs/fixture-spec.md` 规范补全以下 7 题的 hiddenTests + fixture + referenceSolution。
> 输出格式对照已入库范例（查 benchmark.json 或 cr2-*.json 里已带 fixture 的题）。
> **验收门**：bug 版本（sourceCode）至少 1 个测试 fail；referenceSolution 全部测试 pass。

---

## TypeScript 4 题（host 沙箱执行，fixture 可不写，只需 hiddenTests + referenceSolution）

### CR2-TS-001（type_safety）
```typescript
function first<T>(items: T[]): T {
  return items[0];
}
```
- bug：空数组返回 undefined，但签名是 T（类型不诚实）。
- 修复方向：返回 `T | undefined` 或空数组 throw。keywords：`T | undefined`、`throw`、`undefined`。
- 测试建议：空数组 + 非空数组（≥2 个）。

### CR2-TS-002（null_handling）
```typescript
interface User { name: string; address?: { city: string }; }
function getCity(user: User): string {
  return user.address.city;
}
```
- bug：address 可选，`user.address.city` 在 address 缺失时抛 TypeError。
- 修复方向：可选链 + 空值合并 `user.address?.city ?? 'Unknown'`。keywords：`?.`、`??`。
- 测试建议：address 存在 / address 缺失 / user 为 null（≥3 个）。

### CR2-TS-003（implementation，实现题）
```typescript
type Result<T, E> = { ok: true; value: T } | { ok: false; error: E };
function safeParseInt(s: string): Result<number, string> {
  // TODO
}
```
- 这是**实现题**（无 bug 代码，模型要实现 safeParseInt）。
- 修复方向：`Number.isInteger` 校验、`trim` 空白、非法返回 `{ ok: false, error }`。
- 测试建议：合法整数 / 带空白 / 非数字 / 小数（≥4 个）。

### CR2-TS-005（security）
```typescript
function merge(target: Record<string, unknown>, source: Record<string, unknown>) {
  for (const key in source) {
    target[key] = source[key];
  }
  return target;
}
```
- bug：`__proto__`/`constructor` 键可污染原型链。
- 修复方向：`hasOwnProperty` 检查 / `Object.keys` 白名单。keywords：`__proto__`、`hasOwnProperty`。
- 测试建议：普通合并 + 恶意 `__proto__` 键不得污染原型（≥2 个）。

---

## PHP 1 题

### CR2-PH-001（security，SQL 注入）
```php
function login($pdo, $username, $password) {
    $sql = "SELECT * FROM users WHERE username = '$username' AND password = '$password'";
    $stmt = $pdo->query($sql);
    return $stmt->fetch() !== false;
}
```
- bug：字符串拼接 SQL，可注入（`' OR '1'='1`）。
- 修复方向：`prepare` + `bindParam` + `password_verify`。keywords：`prepare`、`bindParam`、`password_verify`。
- fixture：`{"language":"php","phpVersion":"8.2","includes":[],"helpers":""}`（helpers 提供内存 PDO 桩）。
- 测试建议：正常登录 + 注入 payload 不得绕过（≥2 个）。

---

## C# 1 题

### CR2-CS-001（float_money）
```csharp
public static class Ledger {
    public static double SumTransactions(IEnumerable<double> amounts) {
        double total = 0;
        foreach (var a in amounts) total += a;
        return total;
    }
}
```
- bug：double 累加精度误差（可参照 CP-L3-SEM-CS-001 用 1000 次 0.1 累加）。
- 修复方向：`decimal`。keywords：`decimal`。
- fixture：`{"language":"csharp","wrapInClass":false,"usings":[],"helpers":""}`。
- 测试建议：常规合计 + 1000 次 0.1 累加暴露误差 + 空集（≥3 个）。

---

## Bash 1 题

### CR2-SH-001（quoting）
```bash
backup_file() {
    local src=$1
    local dest=$2
    cp $src $dest
    chmod 644 $dest
}
```
- bug：`$src`/`$dest` 未加引号，含空格/特殊字符路径会分词错误（cp 参数错乱）。
- 修复方向：`"$src"`、`"$dest"`，可加 `set -e`。keywords：`"$src"`、`set -e`。
- fixture：`{"language":"bash","image":"bash:5","setOptions":[],"helpers":""}`。
- 断言风格：`[[ "$(backup_file ...)" == "..." ]]`（或检查副作用）。
- 测试建议：无空格路径 + 含空格路径（bug 必挂）（≥2 个）。

---

## 提交格式

产出一个 JSON 数组（每元素一个完整 scenario，字段对齐 cr2-*.json 条目），包含：
- `hiddenTests`：数组，元素 `{id, type:'hidden', testCode, description, expectedExitCode:0}`。
- `requirements.fixture` + `requirements.referenceSolution`。
- 同步更新 `requirements.hiddenTests`（code 版）。
