// ============================================================
// 环境/测试基础设施故障检测（纯函数，零依赖）
// 区分「harness 自身故障」与「模型代码真实失败」：
//   - 命中模式 → 测试环境缺陷，模型无辜，应标记 unmeasured 隔离
//   - 未命中   → 视为模型代码真实执行结果，正常判分
// 模式基于 zxbench 真实运行取证（2026-08-24 体检）：
//   - Java 容器 non-root + HOME=/root → javac 预置目录失败
//   - dotnet 无网络容器 workload 校验失败 → SDK 命令中断
//   - docker daemon / OCI / 磁盘 / EACCES → 基础设施故障
//   - 包仓库（crates.io/npm/NuGet/PyPI）不可达 → 依赖环境故障
// 注意：不要加入「模型 SQL 语法错误」类模式（如 no such column、
//   syntax error near），那些是模型真实失败，混入会掩盖模型缺陷。
// ============================================================

export interface EnvErrorInfo {
  /** 是否为环境/测试基础设施故障 */
  isEnv: boolean;
  /** 命中的模式原因（英文，稳定，供 evidence 与报告使用） */
  reason?: string;
}

const ENV_ERROR_PATTERNS: Array<{ re: RegExp; reason: string }> = [
  // Java/容器：non-root(65534) 用户写 HOME=/root 失败（java.util.prefs / mvn 包装脚本）
  // 注意：容器 locale 可能输出弯引号（‘/root’ U+2018/U+2019），必须兼容
  { re: /cannot create directory\s*['"`\u2018\u2019]?\/root['"`\u2018\u2019]?\s*:\s*permission denied/i, reason: 'container HOME=/root unwritable for non-root user' },
  // 不要把 dotnet 的 "An issue was encountered verifying workloads" 当作环境故障。
  // 该文本会在 `dotnet restore/test` 实际成功后作为普通提示输出；此前它掩盖了
  // C# 编译错误，并把模型失败错误隔离。真正的 NuGet/网络基础设施问题由下方的
  // PACKAGE_REGISTRY_* 组合信号识别；原始工作区 preflight 失败则由调用方明确隔离。
  // docker 守护进程不可达 / 错误响应
  { re: /cannot connect to the docker daemon/i, reason: 'docker daemon unreachable' },
  { re: /error response from daemon/i, reason: 'docker daemon error' },
  // containerRunner 在 isDockerAvailable() 为假时的短路返回（containerRunner.ts）。
  // 取证：2026-08-28 P0′ 冒烟，Docker Desktop 未运行导致 Go 题
  //   "Go container compile failed: Docker unavailable — container execution skipped"
  //   deterministicScore 由 94 跌至 32，被误判为模型缺陷。
  // 注意措辞必须与 containerRunner 的常量逐字一致，否则隔离失效。
  { re: /docker unavailable\s*[—-]\s*container execution skipped/i, reason: 'docker daemon unavailable — container execution skipped' },
  // 镜像拉取失败（容器冷启动 / registry 不可达）
  { re: /(?:manifest|image|repository)[^\n]*not found/i, reason: 'container image unavailable' },
  { re: /error pulling image|toomanyrequests|pull access denied/i, reason: 'container image pull failed' },
  // OCI 运行时创建/启动容器失败
  { re: /oci runtime (?:exec|create|start) failed/i, reason: 'OCI runtime failure' },
  // 磁盘空间不足（镜像/容器写层）
  { re: /no space left on device/i, reason: 'disk full (container/image)' },
  // node fs 权限错误（EACCES）
  { re: /eacces:\s*permission denied/i, reason: 'EACCES permission denied' },
];

// 传输层错误本身不够：业务代码也可能访问普通 HTTP API。只有它同时指向
// 依赖包仓库时，才把失败归因为评测基础设施而不是模型实现。
const PACKAGE_REGISTRY_HOST = /(?:crates\.io|index\.crates\.io|static\.crates\.io|registry\.npmjs\.org|api\.nuget\.org|pypi\.org|files\.pythonhosted\.org)/i;
const PACKAGE_REGISTRY_TRANSPORT_ERROR = /(?:eai_again|enotfound|etimedout|econnrefused|econnreset|could not resolve host|dns|proxy|certificate|tls|ssl|network is unreachable|connection (?:timed out|refused|reset)|failed to (?:download|get|fetch)|unable to load the service index|nu1301)/i;

/** 检测 stderr 是否包含高置信环境/测试基础设施故障信号。
 *  @param stderr 容器或子进程的 stderr 原文（可含多行）
 *  @returns {isEnv: true, reason} 命中环境故障；{isEnv: false} 未命中 */
export function detectEnvironmentError(stderr: string | null | undefined): EnvErrorInfo {
  if (!stderr) return { isEnv: false };
  for (const { re, reason } of ENV_ERROR_PATTERNS) {
    if (re.test(stderr)) return { isEnv: true, reason };
  }
  if (PACKAGE_REGISTRY_HOST.test(stderr) && PACKAGE_REGISTRY_TRANSPORT_ERROR.test(stderr)) {
    return { isEnv: true, reason: 'package registry network unavailable' };
  }
  return { isEnv: false };
}

/** 从任意 runner 结果对象合并 stdout/stderr 检测，避免根因只写 stdout 时漏判。 */
export function envErrorOf(res: { stdout?: string; stderr?: string } | null | undefined): EnvErrorInfo {
  return detectEnvironmentError([res?.stdout, res?.stderr].filter(Boolean).join('\n'));
}
