#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
I7 · Level 2 pilot 题库验证
============================
对每道题做两项验证，证明题目「不是废题」：
  A. 缺陷真实存在：用原始 files 跑 hiddenTests → 必须失败（否则题目没缺陷）
  B. 存在可行解：用 gold patch 跑 hiddenTests → 必须全部通过（否则题目无解/评分器有问题）

本地直接跑 Python 子进程（不需要 docker），与容器内 python:3.12 语义一致。
"""
import json
import subprocess
import sys
import tempfile
from pathlib import Path

SRC = Path(r"J:/AI/zxbench-webui/apps/server/src/scripts/l2_pilot_questions.json")
GOLD = Path(r"J:/AI/zxbench-webui/apps/server/src/scripts/l2_pilot_gold.json")


def run_tests(files, tests, workdir):
    """把 files 落到 workdir，依次跑 tests；返回 (passed_list, outputs)"""
    for f in files:
        p = workdir / f["path"]
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(f["content"], encoding="utf-8")
    passed, outputs = [], []
    for t in tests:
        r = subprocess.run(
            [sys.executable, "-c", t["script"]],
            cwd=workdir, capture_output=True, text=True, timeout=120,
        )
        ok = r.returncode == 0
        passed.append(ok)
        outputs.append((t["description"], ok, (r.stdout + r.stderr).strip()[-400:]))
    return passed, outputs


def main():
    questions = json.loads(SRC.read_text(encoding="utf-8"))
    gold = json.loads(GOLD.read_text(encoding="utf-8")) if GOLD.exists() else {}

    print(f"验证 {len(questions)} 道题\n" + "=" * 70)
    all_ok = True

    for q in questions:
        qid = q["id"]
        req = json.loads(q["requirements"])
        tests = req["hiddenTests"]
        print(f"\n### {qid}  ({q['category']})")

        # A. 原始代码必须失败
        with tempfile.TemporaryDirectory() as d:
            passed, outs = run_tests(req["files"], tests, Path(d))
        n_pass = sum(passed)
        if n_pass == len(tests):
            print(f"   [FAIL-A] 原始代码竟然全过（{n_pass}/{len(tests)}）→ 题目无缺陷，废题！")
            all_ok = False
        else:
            print(f"   [OK-A] 缺陷存在：原始代码 {n_pass}/{len(tests)} 通过")
            for desc, ok, out in outs:
                if not ok:
                    print(f"        - {desc}: {out.splitlines()[-1][:110] if out else '(no output)'}")

        # B. gold patch 必须全过
        if qid in gold:
            gfiles = []
            gmap = {f["path"]: f["content"] for f in gold[qid]}
            for f in req["files"]:
                gfiles.append({"path": f["path"], "content": gmap.get(f["path"], f["content"])})
            with tempfile.TemporaryDirectory() as d:
                gpassed, gouts = run_tests(gfiles, tests, Path(d))
            if all(gpassed):
                print(f"   [OK-B] 参考解全过：{sum(gpassed)}/{len(gpassed)}")
            else:
                print(f"   [FAIL-B] 参考解未全过：{sum(gpassed)}/{len(gpassed)}")
                all_ok = False
                for desc, ok, out in gouts:
                    if not ok:
                        print(f"        - {desc}: {out.splitlines()[-1][:150] if out else '(no output)'}")
        else:
            print("   [SKIP-B] 无参考解（待补）")

    print("\n" + "=" * 70)
    print("结论：", "全部通过验证" if all_ok else "存在问题，需修正")


if __name__ == "__main__":
    main()
