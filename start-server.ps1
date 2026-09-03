# ============================================================
# 智秀大模型评测 - Reliable Server Launcher (PowerShell)
# 带健康检查、自动重启、日志轮转
# ============================================================
param(
    [int]$Port = 3001,
    [int]$HealthCheckInterval = 10,
    [int]$MaxRestarts = 20,
    # 0 = never terminate a live server solely because an HTTP health probe timed out.
    # Long-running model evaluations may legitimately occupy the server long enough
    # that /api/health cannot respond, while the Node process is still healthy.
    [int]$HealthFailureRestartThreshold = 0,
    [string]$LogDir = ""
)

$ErrorActionPreference = "Stop"
$RootDir = Split-Path -Parent $MyInvocation.MyCommand.Path
if (-not $LogDir) { $LogDir = Join-Path $RootDir "logs" }
$NODE_BIN = "node"
$SERVER_DIR = Join-Path $RootDir "apps\server"
$SERVER_SCRIPT = "dist\index.js"
$PID_FILE = Join-Path $LogDir "server.pid"

# ===== 单实例守卫：防止多个 watchdog 同时运行 =====
if (Test-Path $PID_FILE) {
    $oldPid = Get-Content $PID_FILE -ErrorAction SilentlyContinue
    if ($oldPid) {
        $oldProc = Get-Process -Id $oldPid -ErrorAction SilentlyContinue
        if ($oldProc) {
            Write-Host "⚠️  检测到已有 watchdog 运行中 (PID: $oldPid)，退出以避免多实例冲突。"
            Write-Host "    如需强制重启，请先运行 stop.bat 或手动终止 PID $oldPid。"
            exit 0
        }
    }
    # PID 文件存在但进程已死，清理过期文件
    Remove-Item $PID_FILE -Force -ErrorAction SilentlyContinue
}
$watchdogPid = $PID
Set-Content -Path $PID_FILE -Value $watchdogPid -Encoding ASCII -Force
Write-Host "Watchdog PID $watchdogPid 已写入 $PID_FILE"
$SERVER_PID_FILE = Join-Path $LogDir "node.pid"

# 退出时清理 PID 文件
$null = Register-EngineEvent -SourceIdentifier PowerShell.Exiting -Action {
    Remove-Item $PID_FILE -Force -ErrorAction SilentlyContinue
} -SupportEvent

# 创建日志目录
if (-not (Test-Path $LogDir)) {
    New-Item -ItemType Directory -Path $LogDir -Force | Out-Null
}

# 日志轮转：保留最近 5 个日志文件
$logFiles = Get-ChildItem -Path $LogDir -Filter "server-*.log" | Sort-Object LastWriteTime -Descending
if ($logFiles.Count -gt 5) {
    $logFiles | Select-Object -Skip 5 | ForEach-Object { Remove-Item -LiteralPath $_.FullName -Force }
    Write-Host "🔄 已清理 $($logFiles.Count - 5) 个旧日志"
}

$timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
$STDOUT_LOG = Join-Path $LogDir "server-$timestamp-out.log"
$STDERR_LOG = Join-Path $LogDir "server-$timestamp-err.log"

Write-Host "============================================================"
Write-Host "  智秀大模型评测 - 可靠启动模式"
$healthRestartLabel = if ($HealthFailureRestartThreshold -gt 0) {
    "连续 $HealthFailureRestartThreshold 次健康检查失败后重启"
} else {
    "仅记录健康检查失败（不终止存活进程）"
}
Write-Host "  端口: $Port | 健康检查: ${HealthCheckInterval}s | 最大重启: $MaxRestarts"
Write-Host "  运行中健康检查策略: $healthRestartLabel"
Write-Host "  日志: $LogDir"
Write-Host "============================================================"

$env:PORT = "$Port"
$env:BUILD_TIME = (Get-Date -Format "yyyy-MM-ddTHH:mm:ss") + "+08:00"
$restartCount = 0
$totalRestarts = 0
$consecutiveHealthFailures = 0

function Write-Log {
    param([string]$Message, [string]$Level = "INFO")
    $time = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    $line = "[$time] [$Level] $Message"
    Write-Host $line
    Add-Content -Path (Join-Path $LogDir "watchdog.log") -Value $line
}

function Start-Server {
    Write-Log "正在启动 智秀大模型评测 Server..."
    
    $proc = Start-Process -FilePath $NODE_BIN `
        -ArgumentList $SERVER_SCRIPT `
        -WorkingDirectory $SERVER_DIR `
        -PassThru `
        -NoNewWindow `
        -RedirectStandardOutput $STDOUT_LOG `
        -RedirectStandardError $STDERR_LOG
    
    # 记录 node 子进程 PID，供 stop.bat 优雅停止使用
    Set-Content -Path $SERVER_PID_FILE -Value $proc.Id -Encoding ASCII -Force
    
    Write-Log "服务器已启动 (PID: $($proc.Id))"
    return $proc
}

function Test-ServerHealth {
    param([int]$TimeoutMs = 5000)
    
    try {
        $response = Invoke-WebRequest -Uri "http://127.0.0.1:$Port/api/health" `
            -UseBasicParsing `
            -TimeoutSec ($TimeoutMs / 1000) `
            -ErrorAction Stop
        return $true
    } catch {
        return $false
    }
}

function Stop-Server {
    param($Process)
    
    if ($Process -and -not $Process.HasExited) {
        Write-Log "正在停止进程 PID: $($Process.Id)" "WARN"
        try {
            $Process.Kill()
            $Process.WaitForExit(5000) | Out-Null
        } catch {
            # 强制杀掉端口占用
            $conn = Get-NetTCPConnection -LocalPort $Port -ErrorAction SilentlyContinue
            if ($conn) {
                $conn.OwningProcess | Sort-Object -Unique | ForEach-Object {
                    Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue
                }
            }
        }
        Start-Sleep 2
    }
}

# ===== 主循环 =====
# 注意：全程不使用 WMI（Get-CimInstance/Get-WmiObject），避免本机 WMI 异常导致蓝屏
# 端口清理改用 Get-NetTCPConnection（TCP/IP 协议栈查询，安全）
while ($true) {
    # 清理旧进程：仅通过端口检测（不使用 WMI）
    $existingConn = Get-NetTCPConnection -LocalPort $Port -ErrorAction SilentlyContinue
    if ($existingConn) {
        Write-Log "端口 $Port 仍被占用，正在清理..." "WARN"
        $existingConn.OwningProcess | Sort-Object -Unique | ForEach-Object {
            Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue
        }
        Start-Sleep 3
    }
    
    # 启动服务器
    $serverProc = Start-Server
    
    # 等待服务器就绪
    $ready = $false
    $serverVersion = $null
    for ($i = 0; $i -lt 15; $i++) {
        Start-Sleep -Seconds 1
        if (Test-ServerHealth) {
            $ready = $true
            $restartCount = 0
            $consecutiveHealthFailures = 0
            try {
                $vResp = Invoke-WebRequest -Uri "http://127.0.0.1:$Port/api/version" -UseBasicParsing -TimeoutSec 3
                $vData = $vResp.Content | ConvertFrom-Json
                $serverVersion = $vData.version
                Write-Log "✅ 服务器就绪 (v${serverVersion}, features: $($vData.features | ConvertTo-Json -Compress))"
            } catch {
                Write-Log "✅ 服务器就绪 (http://127.0.0.1:$Port)"
            }
            break
        }
    }
    
    if (-not $ready) {
        Write-Log "❌ 服务器启动超时 (15s)，可能有问题" "ERROR"
        # 输出最近的错误日志
        if (Test-Path $STDERR_LOG) {
            $errs = Get-Content $STDERR_LOG -Tail 10
            foreach ($e in $errs) { Write-Log "STDERR: $e" "ERROR" }
        }
        Stop-Server $serverProc
        $restartCount++
        $totalRestarts++
        
        if ($restartCount -ge 3) {
            Write-Log "🛑 连续 3 次启动失败，放弃重启" "FATAL"
            break
        }
        if ($totalRestarts -ge $MaxRestarts) {
            Write-Log "🛑 达到最大重启次数 ($MaxRestarts)，放弃" "FATAL"
            break
        }
        
        Write-Log "🔄 ${restartCount}/3 次连续失败，${totalRestarts}/${MaxRestarts} 总重启，等待 10s 后重试..."
        Start-Sleep -Seconds 10
        continue
    }
    
    # 运行中：定期健康检查
    while ($true) {
        Start-Sleep -Seconds $HealthCheckInterval
        
        if ($serverProc.HasExited) {
            $exitCode = $serverProc.ExitCode
            Write-Log "⚠️ 服务器进程意外退出 (ExitCode: $exitCode)" "WARN"
            
            # 检查 stderr 最后几行错误
            if (Test-Path $STDERR_LOG) {
                $errs = Get-Content $STDERR_LOG -Tail 5
                foreach ($e in $errs) { Write-Log "STDERR: $e" "ERROR" }
            }
            
            $restartCount++
            $totalRestarts++
            break
        }
        
        if (-not (Test-ServerHealth -TimeoutMs 3000)) {
            $consecutiveHealthFailures++

            # A single request timeout cannot distinguish an unresponsive process
            # from a server that is currently waiting on a long model invocation.
            # Preserve the live process by default so a valid evaluation is never
            # interrupted and its in-memory controller state is not lost.
            if ($HealthFailureRestartThreshold -gt 0 -and
                $consecutiveHealthFailures -ge $HealthFailureRestartThreshold) {
                Write-Log "⚠️ 健康检查已连续失败 $consecutiveHealthFailures 次，按配置重启服务器" "WARN"
                Stop-Server $serverProc
                $restartCount++
                $totalRestarts++
                break
            }

            Write-Log "⚠️ 健康检查第 $consecutiveHealthFailures 次未响应；Node 进程仍存活，保留进程以避免中断长时评测" "WARN"
            continue
        }

        if ($consecutiveHealthFailures -gt 0) {
            Write-Log "✅ 健康检查已恢复（此前连续失败 $consecutiveHealthFailures 次）"
            $consecutiveHealthFailures = 0
        }
        
        # 周期性心跳日志
        $memMB = [Math]::Round($serverProc.WorkingSet64 / 1MB, 1)
        $cpuTime = $serverProc.TotalProcessorTime
        Write-Log "❤️ 心跳正常 | 内存: ${memMB}MB | CPU时间: $cpuTime" "DEBUG"
    }
    
    if ($restartCount -ge 3) {
        Write-Log "🛑 连续 3 次启动/健康检查失败，放弃" "FATAL"
        break
    }
    if ($totalRestarts -ge $MaxRestarts) {
        Write-Log "🛑 达到最大重启次数 ($MaxRestarts)" "FATAL"
        break
    }
    
    Write-Log "🔄 准备重启... (${totalRestarts}/${MaxRestarts})"
    Start-Sleep -Seconds 3
}

Write-Log "智秀大模型评测 守护进程已退出" "INFO"

# 清理 PID 文件
Remove-Item $PID_FILE -Force -ErrorAction SilentlyContinue
Remove-Item $SERVER_PID_FILE -Force -ErrorAction SilentlyContinue

Write-Host ""
Write-Host "按任意键关闭此窗口..."
$null = $Host.UI.RawUI.ReadKey("NoEcho,IncludeKeyDown")
