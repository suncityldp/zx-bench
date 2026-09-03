// ============================================================
// 环境/测试基础设施故障检测器回归测试
// 背景（P1 污染）：容器/环境错误被误计为模型失败分数——
//   mkdir: cannot create directory '/root': Permission denied、
//   SQL container error、An issue was encountered verifying workloads
//   等 harness 自身故障被记低分（Ornith 4 道、Qwen 6 道，得分 19~29）。
//   修复：detectEnvironmentError 命中 → 标记 environmentError 隔离（unmeasured）。
// 关键回归：容器 locale 输出弯引号 ‘/root’（U+2018/U+2019）而非 ASCII 引号，
//   正则必须用字符类 ['"`\u2018\u2019] 兼容，否则回溯漏检。
// ============================================================
import { describe, it, expect } from 'vitest';
import { detectEnvironmentError, envErrorOf } from './harnessErrors.js';

describe('detectEnvironmentError 命中环境故障（正例）', () => {
  it('ASCII 单引号 /root 权限拒绝', () => {
    const r = detectEnvironmentError("mkdir: cannot create directory '/root': Permission denied");
    expect(r.isEnv).toBe(true);
    expect(r.reason).toMatch(/HOME=\/root/);
  });

  it('弯引号 /root（容器 locale 输出，关键回归用例）', () => {
    // U+2018 ‘  U+2019 ’
    const stderr = 'mkdir: cannot create directory \u2018/root\u2019: Permission denied';
    const r = detectEnvironmentError(stderr);
    expect(r.isEnv).toBe(true);
  });

  it('无引号 /root', () => {
    expect(detectEnvironmentError('cannot create directory /root : permission denied').isEnv).toBe(true);
  });

  it('ASCII 双引号 /root', () => {
    expect(detectEnvironmentError('cannot create directory "/root": Permission denied').isEnv).toBe(true);
  });

  it('大小写不敏感', () => {
    expect(detectEnvironmentError('Cannot Create Directory \u2018/ROOT\u2019: PERMISSION DENIED').isEnv).toBe(true);
  });

  it('多行 stderr 中的命中行', () => {
    const stderr = [
      'warning: some prefix noise',
      'mkdir: cannot create directory \u2018/root\u2019: Permission denied',
      'exiting with code 1',
    ].join('\n');
    expect(detectEnvironmentError(stderr).isEnv).toBe(true);
  });

  it('dotnet workload 校验失败（无网络容器）', () => {
    const r = detectEnvironmentError('An issue was encountered verifying workloads. This is likely a temporary issue...');
    expect(r.isEnv).toBe(true);
    expect(r.reason).toMatch(/dotnet workload/);
  });

  it('docker daemon 不可达', () => {
    expect(detectEnvironmentError('Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?').isEnv).toBe(true);
  });

  it('docker daemon 错误响应', () => {
    expect(detectEnvironmentError('Error response from daemon: pull access denied for busybox').isEnv).toBe(true);
  });

  it('OCI runtime exec 失败', () => {
    expect(detectEnvironmentError('OCI runtime exec failed: exec failed: unable to start container process').isEnv).toBe(true);
  });

  it('OCI runtime create 失败', () => {
    expect(detectEnvironmentError('Error: OCI runtime create failed: container_linux.go:345').isEnv).toBe(true);
  });

  it('磁盘空间不足', () => {
    expect(detectEnvironmentError('write /var/lib/docker/tmp: no space left on device').isEnv).toBe(true);
  });

  it('Node fs EACCES 权限拒绝', () => {
    expect(detectEnvironmentError("Error: EACCES: permission denied, mkdir '/tmp/xyz'").isEnv).toBe(true);
  });

  it('crates.io 的 DNS 失败', () => {
    const r = detectEnvironmentError('failed to download from https://index.crates.io/config.json: Could not resolve host');
    expect(r.isEnv).toBe(true);
    expect(r.reason).toMatch(/package registry/);
  });

  it('npm registry 的连接超时', () => {
    expect(detectEnvironmentError('npm ERR! request to https://registry.npmjs.org/typescript failed, reason: connect ETIMEDOUT').isEnv).toBe(true);
  });

  it('NuGet service index 不可达', () => {
    expect(detectEnvironmentError('error NU1301: Unable to load the service index for source https://api.nuget.org/v3/index.json').isEnv).toBe(true);
  });

  it('PyPI 的 TLS 错误', () => {
    expect(detectEnvironmentError('Could not fetch URL https://pypi.org/simple/requests/: There was a problem confirming the ssl certificate').isEnv).toBe(true);
  });
});

describe('detectEnvironmentError 不误报模型真实失败（负例）', () => {
  it('SQL 列缺失是模型真实失败（刻意排除）', () => {
    expect(detectEnvironmentError('SQLite error: no such column: price').isEnv).toBe(false);
  });

  it('SQL 语法错误是模型真实失败（刻意排除）', () => {
    expect(detectEnvironmentError('syntax error near "SELECT"').isEnv).toBe(false);
  });

  it('mkdir 到工作区路径（非 /root）不命中', () => {
    expect(detectEnvironmentError("mkdir: cannot create directory '/workspace/foo': No such file or directory").isEnv).toBe(false);
  });

  it('普通 permission denied（无可执行位，非 /root 上下文）不命中', () => {
    expect(detectEnvironmentError('bash: ./run.sh: Permission denied').isEnv).toBe(false);
  });

  it('编译错误不命中', () => {
    expect(detectEnvironmentError('javac: file not found: Main.java').isEnv).toBe(false);
  });

  it('测试断言失败不命中', () => {
    expect(detectEnvironmentError('AssertionError: expected 1 to equal 2').isEnv).toBe(false);
  });

  it('超时提示不命中', () => {
    expect(detectEnvironmentError('test timed out after 30000ms').isEnv).toBe(false);
  });

  it('普通业务 API 的连接失败不被隔离', () => {
    expect(detectEnvironmentError('request to https://api.example.com failed: connect ETIMEDOUT').isEnv).toBe(false);
  });
});

describe('detectEnvironmentError 边界输入', () => {
  it('null / undefined / 空串均不命中', () => {
    expect(detectEnvironmentError(null).isEnv).toBe(false);
    expect(detectEnvironmentError(undefined).isEnv).toBe(false);
    expect(detectEnvironmentError('').isEnv).toBe(false);
  });

  it('纯空白字符串不命中', () => {
    expect(detectEnvironmentError('   \n\t  ').isEnv).toBe(false);
  });
});

describe('envErrorOf 从 runner 结果对象提取', () => {
  it('带 stderr 的对象命中', () => {
    const res = { exitCode: 1, stdout: '', stderr: 'mkdir: cannot create directory \u2018/root\u2019: Permission denied' };
    const r = envErrorOf(res);
    expect(r.isEnv).toBe(true);
  });

  it('根因只写在 stdout 时仍命中', () => {
    const r = envErrorOf({ stdout: 'npm ERR! request to https://registry.npmjs.org/vitest failed: ENOTFOUND', stderr: '' });
    expect(r.isEnv).toBe(true);
  });

  it('无 stderr 字段的对象不命中', () => {
    expect(envErrorOf({ exitCode: 1 }).isEnv).toBe(false);
  });

  it('null / undefined 对象不命中', () => {
    expect(envErrorOf(null).isEnv).toBe(false);
    expect(envErrorOf(undefined).isEnv).toBe(false);
  });

  it('stderr 为 null 的对象不命中', () => {
    expect(envErrorOf({ stderr: null }).isEnv).toBe(false);
  });
});
