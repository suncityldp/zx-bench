#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
P0′ Phase A 执行器 — 2 模型 × 60 题 × K=3 = 360 次调用
=====================================================
设计要点（都是踩过的坑换来的）：

1. **严格串行**。绝不并发两个 run。08-24 的 Ornith run 全程与 Qwen B、
   ox-alpha 抢同一个 8081 后端（利用率仅 42.5%），导致数据被污染。
   本脚本一次只让一个 run 存在，启动前还会检查有没有残留的活跃 run。

2. **配置锁定**。与 08-24 三次 run 完全一致，保证可比：
   maxTokens=58192 / runsPerQuestion=1 / judge=true / parallelism=2 /
   parallelMode=global / answerFirst / onLimit=fail / hardTimeLimitMs=600000

3. **题目子集**。两模型共用同一 60 题（配对设计前提），由
   p0prime_sample_subset.py 分层抽出，seed=2930，固化进 config 便于复现。

4. **可断点续跑**。每次 run 落盘到 phaseA_runs.jsonl；重跑脚本会跳过
   已完成的 (model, k, 题量)，不会重复烧调用。启动时即写入 launched 记录，
   因此中途被杀也能恢复到同一个 run 续跑（走服务端 resume，只补未完成的题）。

5. **连接失败会放弃**（2026-08-29 事故后加）。此前轮询遇到异常直接 continue，
   把卡死检测整个跳过了，服务端挂掉后脚本空转 7 小时。现在连续失败
   MAX_CONSEC_FAILURES 次即判定连接中断并退出。

用法：
    python run_p0prime_phaseA.py --smoke        # 2 模型 × 3 题 × 1 次（冒烟）
    python run_p0prime_phaseA.py --dry-run      # 只打印计划
    python run_p0prime_phaseA.py                # 正式跑 360 次调用
    python run_p0prime_phaseA.py --model ornith # 只跑一个模型
"""
import argparse
import json
import sys
import time
import urllib.request
import urllib.error
from datetime import datetime
from pathlib import Path

BASE = "http://localhost:3000"
HERE = Path(__file__).parent
SUBSET_FILE = HERE / "p0prime_subset60_v3.json"
STATE_FILE = HERE / "phaseA_runs_v3.jsonl"

JUDGE_ID = "e32d8a5d-b6ed-45ac-8bb1-a60859ab419e"          # deepseek-v4-pro
MODELS = {
    "ornith": "705fc706-d6a7-4f99-a6ba-0b0d73319630",      # ornith-1.5-35b @1235
    "qwen":   "7cb5ef69-0cc5-4d15-9c90-f7727fa687c1",      # qwen3.6-35b-a3b @1235
    # 双后端并行轨：qwen8081 走 llama.cpp(8081)，与 ornith@1235 各占一个后端。
    # 共享 phaseA_runs_v3.jsonl：守卫的 our_ids 会放行另一轨的计划内活跃 run，
    # done 键 (model,k) 中模型名不同，天然不冲突。
    "qwen8081": "qwen8081-790fbec6",                        # Qwen3.6-35B-A3B-UD-Q4_K_M @8081
}

# 与 08-24 三次 run 逐字段对齐
LOCKED_CONFIG = {
    "maxTokens": 58192,
    "temperature": None,
    "runsPerQuestion": 1,
    "judgeEnabled": True,
    "escalationEnabled": True,
    "escalationThreshold": 0.85,
    "safetyCheckEnabled": True,
    "hiddenTestsEnabled": True,
    "structuredOutputEnabled": False,
    "parallelism": 2,
    "parallelMode": "global",
    "constraints": {
        "answerFirst": True,
        "onLimit": "fail",
        "hardTimeLimitMs": 600000,
    },
}

POLL_SECONDS = 30
STALL_LIMIT_SECONDS = 45 * 60      # 45 分钟无进度视为卡死
MAX_CONSEC_FAILURES = 10           # 连续 10 次轮询失败（约 5 分钟）判定连接中断


def api(method: str, path: str, payload: dict | None = None, timeout: int = 60):
    """调用 API。注意 POST 必须带 JSON 体：部分处理器（如 /runs/:id/resume）
    在没有 body 时会直接 400，因此 POST 一律发 {} 而不是空请求。"""
    url = f"{BASE}{path}"
    if payload is None and method == "POST":
        payload = {}
    data = json.dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request(
        url, data=data, method=method,
        headers={"Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        # 把响应体带出来，否则排障时只能看到一个状态码
        body = ""
        try:
            body = e.read().decode("utf-8", errors="replace")[:300]
        except Exception:
            pass
        raise RuntimeError(f"HTTP {e.code}: {body}") from e


def now() -> str:
    return datetime.now().strftime("%H:%M:%S")


def log(msg: str) -> None:
    print(f"[{now()}] {msg}", flush=True)


def active_runs() -> list[dict]:
    """列出非终态的 run，用于串行守卫。"""
    try:
        d = api("GET", "/api/runs")
    except Exception as e:
        log(f"⚠ 无法查询 /api/runs: {e}")
        return []
    runs = d.get("data") or []
    return [r for r in runs if r.get("status") in ("pending", "running", "paused")]


def load_done(n_expected: int) -> set[tuple[str, int]]:
    """读取已完成项。

    必须按 (model, k, 题量) 三元组匹配：3 题的冒烟 run 与 60 题的正式 run
    共用 (model, k) 键，若不校验题量，一次冒烟就会把正式的 K1 误标为已完成，
    导致续跑时整轮 60 题被静默跳过。
    """
    done = set()
    if STATE_FILE.exists():
        for line in STATE_FILE.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                rec = json.loads(line)
            except json.JSONDecodeError:
                continue
            # 旧记录没有 n 字段时按 n=0 处理，即视为不匹配（保守，宁可重跑）
            if rec.get("status") == "completed" and rec.get("n") == n_expected:
                done.add((rec["model"], rec["k"]))
    return done


def load_launched(n_expected: int) -> dict[tuple[str, int], str]:
    """读取「已启动但未完成」的 runId，用于中途被杀后续跑。

    同一 (model, k, n) 若有多条 launched 记录，取最后一条。
    """
    out: dict[tuple[str, int], str] = {}
    if not STATE_FILE.exists():
        return out
    for line in STATE_FILE.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            rec = json.loads(line)
        except json.JSONDecodeError:
            continue
        if rec.get("status") == "launched" and rec.get("n") == n_expected:
            out[(rec["model"], rec["k"])] = rec["runId"]
    return out


def append_state(rec: dict) -> None:
    with STATE_FILE.open("a", encoding="utf-8") as fh:
        fh.write(json.dumps(rec, ensure_ascii=False) + "\n")


def wait_run(run_id: str, label: str) -> dict:
    """轮询直到 run 进入终态或判定连接中断。"""
    last_done = -1
    last_progress_at = time.time()
    consec_fail = 0
    while True:
        time.sleep(POLL_SECONDS)
        try:
            d = api("GET", f"/api/runs/{run_id}/progress")
            p = (d.get("data") or {})
            consec_fail = 0
        except Exception as e:
            consec_fail += 1
            log(f"  {label} 轮询异常 ({consec_fail}/{MAX_CONSEC_FAILURES}): {e}")
            if consec_fail >= MAX_CONSEC_FAILURES:
                log(f"  ❌ {label} 连续 {MAX_CONSEC_FAILURES} 次无法连接服务端，判定中断")
                return {"status": "conn_lost", "completed": last_done}
            continue
        status = p.get("status") or "unknown"
        done = p.get("completed") or p.get("completedScenarios") or 0
        total = p.get("total") or p.get("totalScenarios") or 0
        if done != last_done:
            log(f"  {label} {status} {done}/{total}")
            last_done = done
            last_progress_at = time.time()
        if status in ("completed", "failed", "cancelled"):
            return {"status": status, "completed": done, "total": total}
        if time.time() - last_progress_at > STALL_LIMIT_SECONDS:
            log(f"  ⚠ {label} 超过 {STALL_LIMIT_SECONDS//60} 分钟无进度，判定卡死")
            return {"status": "stalled", "completed": done, "total": total}


def resume_run(run_id: str, label: str) -> str:
    """让服务端续跑一个中断的 run（会跳过已完成的题）。

    返回 'ok' / 'already_running' / 'failed'。'already_running' 视为可接受：
    说明这个 run 正在跑（比如手工触发过），直接转入等待即可。
    """
    try:
        d = api("POST", f"/api/runs/{run_id}/resume", {})
    except Exception as e:
        msg = str(e)
        # 409：服务端认为该 run 已在运行中（例如手工先行触发过），可直接转入等待
        if "409" in msg or "已在运行中" in msg:
            log(f"  {label} 该 run 已在运行中，转为等待")
            return "already_running"
        log(f"  {label} 续跑请求失败: {msg}")
        return "failed"
    if d.get("success"):
        log(f"  {label} 已发送续跑请求（服务端将跳过已完成的题）")
        return "ok"
    err = str(d.get("error") or "")
    if "已在运行中" in err or "running" in err.lower():
        log(f"  {label} 该 run 已在运行中，转为等待")
        return "already_running"
    log(f"  {label} 续跑被拒绝: {err}")
    return "failed"


def run_one(model: str, k: int, scenario_ids: list[str], smoke: bool,
            existing_run_id: str | None = None) -> dict:
    name = f"P0prime-Av3 {'SMOKE ' if smoke else ''}{model} K{k}"
    payload = {
        "name": name,
        "modelConfigId": MODELS[model],
        "judgeModelConfigId": JUDGE_ID,
        "dimensionIds": ["program"],
        "groupName": "P0prime-A",
        "config": {**LOCKED_CONFIG, "scenarioIds": scenario_ids},
    }

    if existing_run_id:
        log(f"▶ 续跑 {name}  runId={existing_run_id[:8]}  ({len(scenario_ids)} 题)")
        st = resume_run(existing_run_id, f"{model}K{k}")
        run_id = existing_run_id
        if st == "failed":
            append_state({
                "model": model, "k": k, "runId": run_id, "name": name,
                "status": "resume_failed", "n": len(scenario_ids),
                "ts": datetime.now().isoformat(timespec="seconds"),
            })
            return {"model": model, "k": k, "status": "resume_failed"}
    else:
        log(f"▶ 启动 {name}  ({len(scenario_ids)} 题)")
        try:
            d = api("POST", "/api/runs", payload)
        except Exception as e:
            log(f"  ❌ 启动失败: {e}")
            return {"model": model, "k": k, "status": "launch_failed", "error": str(e)}
        if not d.get("success"):
            return {"model": model, "k": k, "status": "launch_failed", "error": str(d)}
        run_id = d["data"]["id"]
        if d.get("data", {}).get("configNotice"):
            log(f"  ⚠ 配置被服务端改写: {d['data']['configNotice']}")
        # 立即落盘，保证中途被杀也能定位到这个 run
        append_state({
            "model": model, "k": k, "runId": run_id, "name": name,
            "status": "launched", "n": len(scenario_ids),
            "ts": datetime.now().isoformat(timespec="seconds"),
        })

    t0 = time.time()
    res = wait_run(run_id, f"{model}K{k}")
    rec = {
        "model": model, "k": k, "runId": run_id, "name": name,
        "status": res["status"], "n": len(scenario_ids),
        "completed": res.get("completed"), "total": res.get("total"),
        "seconds": round(time.time() - t0),
        "ts": datetime.now().isoformat(timespec="seconds"),
    }
    if "error" in res:
        rec["error"] = res["error"]
    append_state(rec)
    log(f"  ✔ {name} -> {res['status']}  {res.get('completed')}/{res.get('total')}  "
        f"耗时 {rec['seconds']//60}m{rec['seconds']%60}s")
    return rec


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--smoke", action="store_true", help="只跑 3 题 × 1 次，验证链路")
    ap.add_argument("--dry-run", action="store_true", help="只打印计划")
    ap.add_argument("--model", choices=list(MODELS), help="只跑指定模型")
    ap.add_argument("--k", type=int, default=3, help="每模型重复次数，默认 3")
    ap.add_argument("--parallelism", type=int, default=None,
                    help="覆盖 run 内并行度（规避 PR 题并发容器死锁，建议 1）")
    args = ap.parse_args()
    if args.parallelism:
        LOCKED_CONFIG["parallelism"] = args.parallelism

    subset = json.loads(SUBSET_FILE.read_text(encoding="utf-8"))["scenarioIds"]
    if args.smoke:
        # 覆盖 easy / hard / adversarial 三档，确保各难度链路都通
        ids = [subset[0], subset[20], subset[45]]
        plan = [(m, 1) for m in MODELS]
        scenario_ids = ids
    else:
        scenario_ids = subset
        plan = [(m, k) for m in MODELS for k in range(1, args.k + 1)]
    if args.model:
        plan = [p for p in plan if p[0] == args.model]

    calls = len(plan) * len(scenario_ids)
    log(f"计划：{len(plan)} 个 run × {len(scenario_ids)} 题 = {calls} 次模型调用"
        f"（另需约 {calls} 次 Judge 调用，走 deepseek-v4-pro）")
    log(f"配置：maxTokens={LOCKED_CONFIG['maxTokens']} "
        f"runsPerQuestion={LOCKED_CONFIG['runsPerQuestion']} "
        f"parallelism={LOCKED_CONFIG['parallelism']}/{LOCKED_CONFIG['parallelMode']} "
        f"judge={LOCKED_CONFIG['judgeEnabled']}")
    if args.dry_run:
        for m, k in plan:
            print(f"   - {m} K{k}  ({len(scenario_ids)} 题)")
        return

    act = active_runs()
    # 双后端并行：放行所有 P0prime 计划的活跃 run（另一轨的 ornith/qwen8081 互不冲突，
    # 各占 1235/8081 一个后端；同轨重复启动由 done/launched 键自然阻止）。
    # 只拦截非 P0prime 的其它评测（P4、手工 run 等），防止后端被第三方抢用。
    our_ids = set(load_launched(len(scenario_ids)).values())
    foreign = [r for r in act
               if r.get("id") not in our_ids
               and not (r.get("name") or "").startswith("P0prime")]
    if foreign:
        log("❌ 存在非 Phase A 的活跃 run，拒绝启动（防后端竞争）：")
        for r in foreign:
            print(f"   - {r.get('id')} {r.get('name')} [{r.get('status')}]")
        log("请先等待其结束或手动取消，再重跑本脚本。")
        sys.exit(1)
    if act:
        log(f"ℹ 检测到 {len(act)} 个本次计划内的活跃 run，将接管并等待（不重复启动）")

    done = load_done(len(scenario_ids))
    launched = load_launched(len(scenario_ids))
    todo = [p for p in plan if p not in done]
    if len(todo) < len(plan):
        log(f"⚠ 跳过已完成的 {len(plan)-len(todo)} 个 run"
            f"（按 model/k/题量={len(scenario_ids)} 匹配）："
            + ", ".join(f"{m}K{k}" for m, k in [p for p in plan if p in done]))
    resumable = [p for p in todo if p in launched]
    if resumable:
        log(f"♻ 检测到 {len(resumable)} 个中断的 run，将续跑而非重跑："
            + ", ".join(f"{m}K{k}" for m, k in resumable))

    t_start = time.time()
    for m, k in todo:
        rec = run_one(m, k, scenario_ids, args.smoke, launched.get((m, k)))
        if rec["status"] not in ("completed",):
            log(f"❌ {m} K{k} 未成功完成（{rec['status']}），停止后续 run 以免连锁污染")
            break
    log(f"全部结束，总耗时 {(time.time()-t_start)/3600:.2f}h")
    log(f"状态文件：{STATE_FILE}")


if __name__ == "__main__":
    main()
