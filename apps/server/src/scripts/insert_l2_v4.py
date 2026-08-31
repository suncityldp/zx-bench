#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
I7 · Level 2 pilot v2 落库（10 题）
与 insert_l2_pilot.py 同源，仅换输入文件与安全校验的题集前缀。
默认 DRY-RUN，--apply 才写入；写入前自动备份；绝不 DELETE。
"""
import argparse
import json
import shutil
import sqlite3
import sys
from datetime import datetime, timezone
from pathlib import Path

DB = Path(r"J:/AI/zxbench-webui/apps/data/zxbench_experiment.db")
SRC = Path(r"J:/AI/zxbench-webui/apps/server/src/scripts/l2_pilot_v4_questions.json")
BACKUP_DIR = Path(r"J:/AI/zxbench-webui/apps/data/backups")

ALL_COLS = [
    "id", "dimension", "category", "difficulty", "language", "locale", "status", "tier",
    "promptTemplate", "sourceCode", "functionName", "expectedVerdict", "grader", "graderVersion",
    "scoring", "hiddenTests", "requirements", "tags", "scenarioVersion", "scenarioHash",
    "responseMode", "outputPolicy", "toolSchema", "expectedState", "requiredInvariants",
    "allowedActions", "forbiddenActions", "requiredOrder", "environmentImage", "seed",
    "goldSource", "goldVerifiedAt", "reviewStatus", "createdAt", "updatedAt",
    "answerFirst", "maxAnswerTokens", "maxReasoningTokens",
]
REQUIRED = [
    "id", "dimension", "category", "difficulty", "language", "promptTemplate",
    "grader", "graderVersion", "scoring", "scenarioVersion", "scenarioHash",
]
STRICT_JSON_COLS = ["scoring", "hiddenTests", "requirements", "tags"]
BANK_WEIGHTS = {
    "test_pass": 0.35,
    "api_stability": 0.15,
    "static_signals": 0.30,
    "output_completeness": 0.10,
    "scope_discipline": 0.10,
}


def validate(records, known_ids):
    errs, conflicts = [], []
    seen = set()
    for q in records:
        qid = q.get("id", "<no id>")
        if qid in seen:
            errs.append(f"{qid}: 输入内 id 重复")
        seen.add(qid)
        for col in REQUIRED:
            if q.get(col) in (None, ""):
                errs.append(f"{qid}: 缺必填列 {col}")
        for col in STRICT_JSON_COLS:
            v = q.get(col)
            if v in (None, ""):
                errs.append(f"{qid}: 必填 JSON 列 {col} 为空")
                continue
            try:
                json.loads(v)
            except json.JSONDecodeError as e:
                errs.append(f"{qid}: {col} 非合法 JSON — {e}")
        # run 选题硬过滤 status='valid'（routes/index.ts:3238）
        if q.get("status") != "valid":
            errs.append(f"{qid}: status 必须为 valid，否则 run 选不到题")
        req = json.loads(q.get("requirements") or "{}")
        for key in ("files", "hiddenTests", "hiddenTestFiles"):
            if not req.get(key):
                errs.append(f"{qid}: requirements 缺 {key}")
        if len(req.get("files", [])) < 4:
            errs.append(f"{qid}: v4 题应含 ≥4 个文件（含干扰文件），实际 {len(req.get('files', []))}")
        for ht in req.get("hiddenTests", []):
            if not ht.get("script"):
                errs.append(f"{qid}: hiddenTests 元素缺 script")
                break
        unknown = set(q) - set(ALL_COLS)
        if unknown:
            errs.append(f"{qid}: 未知列 {sorted(unknown)}")
        if qid in known_ids:
            conflicts.append(qid)
    return errs, conflicts


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true")
    ap.add_argument("--force", action="store_true")
    args = ap.parse_args()

    records = json.loads(SRC.read_text(encoding="utf-8"))
    print(f"输入记录数: {len(records)}")
    conn = sqlite3.connect(str(DB), timeout=30)
    conn.execute("PRAGMA busy_timeout = 30000")
    known = {r[0] for r in conn.execute("select id from ScenarioDefinition")}
    print(f"库中既有题目数: {len(known)}")

    errs, conflicts = validate(records, known)
    print("\n=== 校验 ===")
    if conflicts:
        print(f"  ⚠ id 冲突 {len(conflicts)} 个（{'覆盖' if args.force else '将跳过'}）")
    if errs:
        print(f"  ✗ 校验失败 {len(errs)} 项：")
        for e in errs[:30]:
            print(f"     - {e}")
        sys.exit(1)
    print("  ✓ 校验通过")
    if not args.apply:
        print("\n[DRY-RUN] 未写入。加 --apply 落库。")
        return

    BACKUP_DIR.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
    bak = BACKUP_DIR / f"zxbench_experiment.bak_l2v2_{stamp}.db"
    shutil.copy2(DB, bak)
    print(f"\n已备份 → {bak}")

    now = datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
    inserted = updated = skipped = 0
    for q in records:
        q = dict(q)
        q["scoring"] = json.dumps({"type": "project_repair", "weights": dict(BANK_WEIGHTS)},
                                  ensure_ascii=False)
        q.setdefault("createdAt", now)
        q["updatedAt"] = now
        qid = q["id"]
        if qid in known and not args.force:
            skipped += 1
            continue
        cols = [c for c in ALL_COLS if c in q]
        if qid in known:
            sets = ",".join(f"{c}=?" for c in cols if c != "id")
            conn.execute(f"update ScenarioDefinition set {sets} where id=?",
                         [q[c] for c in cols if c != "id"] + [qid])
            updated += 1
        else:
            conn.execute(
                f"insert into ScenarioDefinition ({','.join(cols)}) values ({','.join('?' * len(cols))})",
                [q[c] for c in cols])
            inserted += 1
    conn.commit()
    total = conn.execute("select count(*) from ScenarioDefinition").fetchone()[0]
    print(f"\n完成：新增 {inserted}，更新 {updated}，跳过 {skipped}")
    print(f"库中题目总数：{total}")


if __name__ == "__main__":
    main()
