#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
v3 rubric 矩阵验证
==================
对每道题验证两件事：
  1. gold 下全部测试点通过（题目可解）
  2. 原码下的通过模式符合设计：L1/L2 挂、L3/L4 过（梯度存在）
     —— 若原码全过 = 废题；若原码全挂 = 无梯度（一票否决式，rubric 失效）

输出每题的通过矩阵 + 原码预期得分，并断言梯度区间。
"""
import json
import re
import subprocess
import sys
import uuid
from pathlib import Path

SRC = Path(r"J:/AI/zxbench-webui/apps/server/src/scripts/l2_pilot_v3_questions.json")
GOLD = Path(r"J:/AI/zxbench-webui/apps/server/src/scripts/l2_pilot_v2_gold.json")
TMP_ROOT = Path(r"J:/AI/zxbench-webui/apps/data/tmp_verify")

# 原码下预期的通过模式：L1/L2 应失败，L3/L4 应通过
EXPECT_FAIL_PREFIX = ("[L1]", "[L2]")
EXPECT_PASS_PREFIX = ("[L3]", "[L4]")


def to_docker_path(p: str) -> str:
    p = p.replace("\\", "/")
    if len(p) > 1 and p[1] == ":":
        drive, rest = p.split(":", 1)
        return "//" + drive.lower() + rest
    return p


def run_in_docker(image, files, command, timeout=120):
    TMP_ROOT.mkdir(parents=True, exist_ok=True)
    root = TMP_ROOT / uuid.uuid4().hex
    root.mkdir(parents=True, exist_ok=True)
    for f in files:
        p = root / f["path"]
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(f["content"], encoding="utf-8")
    try:
        r = subprocess.run(
            ["docker", "run", "--rm",
             "-v", f"{to_docker_path(str(root))}:/workspace", "-w", "/workspace",
             image, "sh", "-c", command],
            capture_output=True, text=True, timeout=timeout,
        )
        out = ((r.stdout or "") + (r.stderr or "")).strip()
        return r.returncode == 0, r.returncode, out
    except subprocess.TimeoutExpired:
        return False, -1, "TIMEOUT"
    except Exception as e:
        return False, -1, f"DOCKER ERR: {e}"


def build_workspace(req, patched):
    files = []
    for f in req["files"]:
        files.append({"path": f["path"], "content": patched.get(f["path"], f["content"])})
    for f in req.get("hiddenTestFiles", []):
        files.append({"path": f["path"], "content": f["content"]})
    return files


def extract_path_from_heading(heading):
    if not heading:
        return None
    for p in (r"([A-Za-z0-9_./\-]+\.(?:py|js|ts|java|go|rs|rb|php|c|cpp|cs|sql|sh|yml|yaml|json|md|toml|txt))",
              r"`([^`]+)`", r"([A-Za-z0-9_./\-]+)"):
        m = re.search(p, heading)
        if m:
            cand = m.group(1).strip()
            if cand and not cand.endswith((".", "/")):
                return cand
    return None


def parse_file_blocks(output):
    result = {}
    if not output:
        return result
    lines = output.split("\n")
    chunks, cur, in_fence = [], None, False
    for line in lines:
        if re.match(r"^\s*```", line):
            in_fence = not in_fence
            if cur:
                cur["body"] += ("\n" if cur["body"] else "") + line
            continue
        if not in_fence:
            hm = re.match(r"^(#{1,6})\s+(.+)$", line)
            if hm:
                if cur:
                    chunks.append(cur)
                cur = {"heading": hm.group(2), "body": ""}
                continue
        if cur:
            cur["body"] += ("\n" if cur["body"] else "") + line
    if cur:
        chunks.append(cur)
    for ch in chunks:
        path = extract_path_from_heading(ch["heading"])
        if not path or path in result:
            continue
        fm = re.search(r"```[\w+\-]*\s*\n([\s\S]*?)```", ch["body"])
        if fm:
            result[path] = re.sub(r"\n$", "", fm.group(1))
    for bm in re.finditer(r"```[\w+\-]*\s*\n([\s\S]*?)```", output):
        arr = bm.group(1).split("\n")
        first = next((l for l in arr if l.strip()), "")
        m = re.match(r"^#\s*([A-Za-z0-9_./\-]+\.[A-Za-z0-9]+)\s*$", first.strip())
        if m and m.group(1) not in result:
            result[m.group(1)] = re.sub(r"\n$", "", bm.group(1))
    return result


def main():
    questions = json.loads(SRC.read_text(encoding="utf-8"))
    gold = json.loads(GOLD.read_text(encoding="utf-8"))
    print(f"rubric 矩阵验证：{len(questions)} 题\n" + "=" * 76)
    all_ok = True

    for q in questions:
        qid = q["id"]
        req = json.loads(q["requirements"])
        image = req.get("image", "python:3.12-alpine")
        tests = req["hiddenTests"]
        names = [t["description"] for t in tests]

        # ---- gold 全过 ----
        gold_out = "\n\n".join(
            f"## {g['path']}\n```python\n{g['content']}\n```" for g in gold.get(qid, []))
        parsed = parse_file_blocks(gold_out)
        gflags = []
        for t in tests:
            ok, _, _ = run_in_docker(image, build_workspace(req, parsed), t["script"])
            gflags.append(ok)
        gold_ok = all(gflags)

        # ---- 原码通过模式 ----
        oflags = []
        for t in tests:
            ok, _, _ = run_in_docker(image, build_workspace(req, {}), t["script"])
            oflags.append(ok)
        orig_score = round(sum(oflags) / len(oflags) * 100)

        # ---- 校验设计红线 ----
        problems = []
        if not gold_ok:
            bad = [n for n, ok in zip(names, gflags) if not ok]
            problems.append(f"gold 未全过: {bad}")
        for n, ok in zip(names, oflags):
            if n.startswith(EXPECT_FAIL_PREFIX) and ok:
                problems.append(f"原码竟然通过（应失败）: {n}")
            if n.startswith(EXPECT_PASS_PREFIX) and not ok:
                problems.append(f"原码竟然失败（应通过）: {n}")
        if orig_score >= 80:
            problems.append(f"原码分 {orig_score} 过高，梯度不足（应 ≤67）")

        status = "OK " if not problems else "BAD"
        print(f"\n[{status}] {qid} ({q['category']})  测试点={len(tests)}  原码分={orig_score}")
        for n, o, g in zip(names, oflags, gflags):
            print(f"    {'P' if o else 'F'}|{'P' if g else 'F'}  {n}")
        if problems:
            all_ok = False
            for p in problems:
                print(f"    ✗ {p}")

    print("\n" + "=" * 76)
    print("结论：", "全部符合 rubric 设计" if all_ok else "存在偏差，需修正")


if __name__ == "__main__":
    main()
