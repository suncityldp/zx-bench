#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
I7 · Level 2 pilot 题库验证（复刻真实执行链路）
================================================
⚠️ 教训（2026-08-31）：第一版验证用 `python -c` 直接跑测试体、手工拼 patch，
   与真实执行路径不一致，导致 10 道题全过验证却在实测中全军覆没：
     - hiddenTests.script 真实是 `sh -c` 执行（projectRepair.ts:123），
       写成 Python 源码会 `sh: import: not found`
     - 模型输出真实由 parseFileBlocks 解析（patchParser.ts:59），
       自创的 ```path: xxx 语法解析不到 → "解析到 0 个文件替换"

本版完全复刻真实链路：
  1. 用 docker + `sh -c <script>` 执行测试（镜像取 requirements.image）
  2. 用与 patchParser.parseFileBlocks 完全一致的解析逻辑处理 gold patch 输出
  3. 验证三项：
     A. 原始代码跑测试必须失败（缺陷真实存在）
     B. gold patch 输出经 parseFileBlocks 解析后必须命中所有待改文件
     C. 应用 gold patch 后跑测试必须全过（题目可解）
"""
import json
import re
import subprocess
import sys
import uuid
from pathlib import Path

SRC = Path(r"J:/AI/zxbench-webui/apps/server/src/scripts/l2_pilot_questions.json")
GOLD = Path(r"J:/AI/zxbench-webui/apps/server/src/scripts/l2_pilot_gold.json")


# ---------- 复刻 patchParser.parseFileBlocks ----------
def extract_path_from_heading(heading: str):
    if not heading:
        return None
    patterns = [
        r"([A-Za-z0-9_./\-]+\.(?:py|js|ts|tsx|jsx|java|go|rs|rb|php|c|h|cpp|cs|sql|sh|yml|yaml|json|md|toml|txt))",
        r"`([^`]+)`",
        r"([A-Za-z0-9_./\-]+)",
    ]
    for p in patterns:
        m = re.search(p, heading)
        if m:
            cand = m.group(1).strip()
            if cand and not cand.endswith((".", "/")):
                return cand
    return None


def parse_file_blocks(output: str):
    """与 packages/core/src/evaluators/patchParser.ts:59 等价的 Python 实现"""
    result = {}
    if not output:
        return result
    lines = output.split("\n")
    chunks = []
    cur = None
    in_fence = False
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

    # 次级提取：代码块首行 `# <path.ext>`
    for bm in re.finditer(r"```[\w+\-]*\s*\n([\s\S]*?)```", output):
        content = bm.group(1)
        arr = content.split("\n")
        first = next((l for l in arr if l.strip()), "")
        m = re.match(r"^#\s*([A-Za-z0-9_./\-]+\.[A-Za-z0-9]+)\s*$", first.strip())
        if m:
            path = m.group(1)
            if path not in result:
                result[path] = re.sub(r"\n$", "", content)
    return result


# ---------- 复刻 projectRepair 的 docker 执行 ----------
# 临时目录必须放在可被 docker 挂载的盘上，并转成 docker 可识别格式。
# tempfile 默认给 C:\Users\...\Temp，docker -v 无法直接挂载（会静默挂起），
# 故固定放在工作区 data 下，并把 `J:/x` 转成 `//j/x`。
TMP_ROOT = Path(r"J:/AI/zxbench-webui/apps/data/tmp_verify")


def to_docker_path(p: str) -> str:
    p = p.replace("\\", "/")
    if len(p) > 1 and p[1] == ":":
        drive, rest = p.split(":", 1)
        return "//" + drive.lower() + rest
    return p


def run_in_docker(image, files, command, timeout=120):
    """在容器里 sh -c 执行，返回 (passed, exit_code, output)。

    注意：不用 tempfile.TemporaryDirectory —— 它的 cleanup 走 shutil.rmtree，
    会被 WorkBuddy 沙箱的 safe-delete 劫持抛 OSError（ignore_cleanup_errors 也拦不住）。
    改为手动建目录、用后不清理（脚本末尾统一提示清理路径）。
    """
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


def build_workspace(req, patched: dict):
    files = []
    for f in req["files"]:
        files.append({"path": f["path"], "content": patched.get(f["path"], f["content"])})
    for f in req.get("hiddenTestFiles", []):
        files.append({"path": f["path"], "content": f["content"]})
    return files


def main():
    questions = json.loads(SRC.read_text(encoding="utf-8"))
    gold = json.loads(GOLD.read_text(encoding="utf-8")) if GOLD.exists() else {}

    print(f"验证 {len(questions)} 道题（docker 真实链路）\n" + "=" * 72)
    all_ok = True

    for q in questions:
        qid = q["id"]
        req = json.loads(q["requirements"])
        image = req.get("image", "python:3.12-alpine")
        tests = req["hiddenTests"]
        print(f"\n### {qid} ({q['category']})")

        # A. 原始代码必须失败
        ws = build_workspace(req, {})
        passed_flags = []
        for t in tests:
            ok, code, out = run_in_docker(image, ws, t["script"])
            passed_flags.append(ok)
            if ok:
                print(f"   [!] 测试竟然通过: {t['description']}")
        n_pass = sum(passed_flags)
        if n_pass == len(tests):
            print(f"   [FAIL-A] 原始代码全过 {n_pass}/{len(tests)} → 废题！")
            all_ok = False
        else:
            print(f"   [OK-A] 缺陷存在：{len(tests) - n_pass}/{len(tests)} 个测试失败")
            # 打印第一个失败的诊断
            for t, ok in zip(tests, passed_flags):
                if not ok:
                    _, code, out = run_in_docker(image, ws, t["script"])
                    print(f"        {t['description'][:28]}: exit={code} {out.splitlines()[-1][:90] if out else ''}")
                    break

        # B + C. gold patch 解析与执行
        if qid not in gold:
            print("   [SKIP-B/C] 无参考解")
            continue
        gold_out = "\n\n".join(
            f"## {g['path']}\n```python\n{g['content']}\n```" for g in gold[qid]
        )
        parsed = parse_file_blocks(gold_out)
        expected = {g["path"] for g in gold[qid]}
        if not expected.issubset(set(parsed)):
            missing = expected - set(parsed)
            print(f"   [FAIL-B] parseFileBlocks 未解析出: {missing}")
            all_ok = False
        else:
            print(f"   [OK-B] 输出格式可解析：命中 {len(parsed)} 个文件 {sorted(expected)}")

        ws2 = build_workspace(req, parsed)
        gflags = []
        for t in tests:
            ok, code, out = run_in_docker(image, ws2, t["script"])
            gflags.append(ok)
            if not ok:
                print(f"        FAIL {t['description'][:28]}: exit={code} {out.splitlines()[-1][:120] if out else ''}")
        if all(gflags):
            print(f"   [OK-C] 参考解全过：{sum(gflags)}/{len(gflags)}")
        else:
            print(f"   [FAIL-C] 参考解未全过：{sum(gflags)}/{len(gflags)} → 题目可能无解")
            all_ok = False

    print("\n" + "=" * 72)
    print("结论：", "全部通过验证" if all_ok else "存在问题，需修正")


if __name__ == "__main__":
    main()
