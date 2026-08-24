# Program 维度区分度深回归 —— 最终报告（迭代完成版）

## 覆盖
- 深回归实测 **128/150**（code_repair 127 + sandbox 1）。
- **no_bug 20 道**：verdict 轴全部 100/0 正常分层（早期「weak」是验证法假警报）。
- 普通 fix 108 道：89 干净 ok + **19 真塌陷（已全部处置）**。

## 19 个塌陷 → 处置结果（17 全修 + 2 残余固有）

### 系统性修复（4 处，src + 重建 + 重启 + 复验）
1. **javaRunner** @Test 补 throws Exception —— 修 JV-005(0→92)/JV-006(能编译) + 未来所有 Java 受检异常
2. **cRunner** 移除 -fsanitize=address —— 修受限容器 DEADLYSIGNAL/死循环
3. **csharpRunner** Assert.False 补 (bool,string) 重载 —— 修 CS-004 CS1501
4. **codeRepair 评分器** 零改动→patch_quality/scope_discipline 判 0 —— 去除 buggy 基线 ~30 分软轴头

### 隐藏测试重写（13 道，3 子代理并行 + 复验）
| 档 | 题 | 修复前 test | 修复后 test(b/c/ch) |
|---|---|---|---|
| B死题 | PY-012 | 恒0(C扩展) | 整题重写 67/100/67 |
| C静默 | PY-004 | 恒0/100? | 67/100/33 |
| C静默 | PERF-JS-001 | 100/100/100 | 33/100/33 |
| C静默 | TS-001 | 100/100/100 | 50/100/50 |
| C静默 | PY-011 | 100/100/100 | 50/100/50 |
| C静默 | CONC-JS-001 | 100/100/100 | 0/100/0 |
| C静默 | JS-003 | 100/100/100 | 0/100/33 |
| C静默 | PY-009 | 100/100/100 | 67/100/67 |
| C静默 | PHP-003 | 100/100/100 | 40/100/80 |
| C静默 | PY-013 | 100/100/100 | 50/100/75 |
| D漏拦 | SEC-JS-001 | 60/100/100 | 20/100/60 |
| D漏拦 | CONC-JV-001 | 67/100/100 | 67/100/67 |
| D漏拦 | PERF-PY-001 | 100/100/100 | 80/100/60 |
| D漏拦 | SEM-JV-001 | 43/100/80 | 43/100/57 |
| A diff轴 | CS-004 | 73/86 | 46/86/70 |
| A diff轴 | JS-010 | 67/82 | 40/82/66 |

（test 列为 test_pass 轴；A 档两题为 total 分数）

### 2 个残余（固有，已注明不展开）
- **JV-006** volatile 双重检查锁：JMM 重排序本质非确定，运行时并发测试只能到 50/75；要确定性需反射检查 volatile（会误伤 Holder 类等价解）。
- **TD-PY-003** 罗马数字：正确解是 8 行重写、作弊解是 1 行局部修，「最小改动」启发式给作弊 +1 分(83 vs 82)；根治需软轴仅在 test_pass 相等时才起作用。


---

## project_repair（多文件工程修复，CP-L4）深回归 —— 20 题

### 结果：20/20 全部分层（correct test_pass=100 > buggy）
- 9 题原样 ok（PY-001/002/003/004、JS-001/002、SQL-001、RS-002、SH-001）
- 11 题经修复后 ok（CS×2、GO×2、TS×3、JV×2、RS-001、CC-001）

### 本轮修复
1. harness 3 处（projectRepair.ts）：
   - 容器注入 HOME=/tmp：非 root(65534) 下 dotnet/go/npm 缓存目录可写（原 /nonexistent 会 EACCES）
   - go 镜像 golang:1.21 → golang:1.22-alpine（go.mod go1.22 版本匹配）
   - java 镜像 eclipse-temurin:17-jdk-alpine → maven:3.9-eclipse-temurin-17-alpine（原镜像无 mvn，mvn test exit=127）
2. 场景修复 11 题（子代理 + update-project.mjs 落库）：
   - C#：dotnet test 补项目路径（MSB1003）、csproj ImplicitUsings/字段改属性
   - Go：脚本 module-root 路径 + CRLF 转义
   - TS：npx jest → tsc + node --test、补 package.json、sh 兼容脚本
   - Java：补完整 pom.xml / 测试占位、mvn 加 -Duser.home / -Dmaven.repo.local、预构建 zxbench/java-spring:3.2.5
   - Rust：shutdown_deadline.sh 改 sh 兼容（/dev/tcp → nc）
   - C++：fuzz 缓冲区 16→4096（消 ASan stack-buffer-overflow）
3. 新工具：verify-project.mjs（多文件验证器）、update-project.mjs（合并式改 requirements）、dbg-project.mjs（stderr 证据诊断）

### 完整 Program 维度覆盖
- code_repair 127 + sandbox 1 + project_repair 20 = 148 题已实测
- 未覆盖：llm_judge 2（PR-ELITE-012/013，需 LLM key）
