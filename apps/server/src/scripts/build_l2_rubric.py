#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
I7 · L2 pilot v3 —— 多级精细化 rubric
======================================
背景：v2 每题只有 2 个测试点，test_pass 只有 0/50/100 三档；
      实测 8 题 100 分、2 题 50 分 —— 二值化严重，"修复了 95%" 与
      "差一个边界条件" 同分，大量信息丢失（ChatGPT 建议④⑦的缺失部分）。

v3 rubric：每题 5~7 个测试点，按四级能力分层：
  [L1] 核心修复（必须修掉 bug）        —— 原码挂、gold 过
  [L2] 边界与对抗（边界输入不崩）      —— 原码挂（部分）、gold 过
  [L3] 回归保护（现有行为不破坏）      —— 原码过、gold 过
  [L4] 不变量（API 形状/纯函数性）     —— 原码过、gold 过

效果：
  - 原码（有缺陷）预期 test_pass ≈ 33%~67%（L3/L4 白送，L1/L2 拿不到）
  - 完全修复 100%；部分修复（如只修核心但破坏边界）落在中间档
  - 单题分数从 3 档 → 6~8 档，梯度评分真正落地

设计红线（每条测试点都必须满足）：
  - 原码下的通过/失败行为必须与设计一致 —— 用 verify 脚本实测确认，不靠猜
  - gold 下必须全过
"""
import json
from pathlib import Path

SRC = Path(r"J:/AI/zxbench-webui/apps/server/src/scripts/l2_pilot_v2_questions.json")
OUT = Path(r"J:/AI/zxbench-webui/apps/server/src/scripts/l2_pilot_v3_questions.json")

TEST_FILE_TMPL = """import sys
sys.path.insert(0, '.')
{body}
"""

# ============ 每题的分级测试点 ============
# 结构：qid -> [ (name, body), ... ]；顺序即编号顺序（main/regress 命名已废弃，直接顺序编号）
RUBRIC = {
    # ---- 001 缓存键冲突（缺陷：SEP 未转义）----
    "L2P2-001": [
        ("[L1] 不同参数组合不得互相覆盖",
         "from service import lookup\nfrom cache import clear\n"
         "clear()\n"
         "a = lookup(1, ['vip','cn'])\n"
         "b = lookup(1, ['vip,cn'])\n"
         "assert a['tags'] == ['vip','cn'], a\n"
         "assert b['tags'] == ['vip,cn'], b\n"
         "assert a is not b"),
        ("[L1] 数字与字符串参数不得碰撞",
         "from keys import make_key\n"
         "k1 = make_key('ns', 1, 2)\n"
         "k2 = make_key('ns', '1,2')\n"
         "assert k1 != k2, f'键冲突: {k1!r} == {k2!r}'"),
        ("[L2] 含分隔符的参数经转义后不碰撞",
         "from keys import make_key\n"
         "a = make_key('ns', 'a,b')\n"
         "b = make_key('ns', 'a', 'b')\n"
         "assert a != b, f'转义失效: {a!r} == {b!r}'\n"
         "c = make_key('ns', 'a\\\\,b')\n"
         "d = make_key('ns', 'a', ',b')\n"
         "assert c != d, f'二级转义失效: {c!r} == {d!r}'"),
        ("[L3] 相同参数仍命中缓存",
         "from service import lookup\nfrom cache import clear\nfrom metrics import report\n"
         "clear()\n"
         "lookup(7, ['x'])\n"
         "lookup(7, ['x'])\n"
         "r = report()\n"
         "assert r['hits'] == 1 and r['misses'] == 1 and r['size'] == 1, r"),
        ("[L3] 不同 user_id 互不影响",
         "from service import lookup\nfrom cache import clear\n"
         "clear()\n"
         "a = lookup(1, ['x'])\n"
         "b = lookup(2, ['x'])\n"
         "assert a['user'] == 1 and b['user'] == 2, (a, b)"),
        ("[L4] make_key 保持 namespace 前缀形状",
         "from keys import make_key\n"
         "k = make_key('profile', 1, 'vip')\n"
         "assert k.startswith('profile|'), k"),
    ],
    # ---- 002 重试异常层级（缺陷：只 isinstance Timeout）----
    "L2P2-002": [
        ("[L1] ConnectionReset 被重试到成功",
         "from client import Flaky\nfrom retry import call_with_retry\nfrom exceptions import ConnectionReset\n"
         "f = Flaky(2, ConnectionReset)\n"
         "res, used = call_with_retry(f.fetch, attempts=3)\n"
         "assert res == 'ok' and used == 3, (res, used)"),
        ("[L1] RateLimited 被重试到成功",
         "from client import Flaky\nfrom retry import call_with_retry\nfrom exceptions import RateLimited\n"
         "f = Flaky(1, RateLimited)\n"
         "res, used = call_with_retry(f.fetch, attempts=3)\n"
         "assert res == 'ok' and used == 2, (res, used)"),
        ("[L2] 混合瞬态错误序列也能重试成功",
         "from retry import call_with_retry\nfrom exceptions import UpstreamError, Timeout, ConnectionReset\n"
         "class Mixed:\n    def __init__(self):\n        self.calls = 0\n        self.plan = [Timeout('t'), ConnectionReset('c'), 'ok']\n    def fetch(self):\n        r = self.plan[self.calls]; self.calls += 1\n        if isinstance(r, str): return r\n        raise r\n"
         "m = Mixed()\n"
         "res, used = call_with_retry(m.fetch, attempts=4)\n"
         "assert res == 'ok' and used == 3 and m.calls == 3, (res, used, m.calls)"),
        ("[L3] 不可重试错误立即抛出、不消耗重试",
         "from client import Flaky\nfrom retry import call_with_retry\nfrom exceptions import BadRequest\n"
         "f = Flaky(5, BadRequest)\n"
         "try:\n"
         "    call_with_retry(f.fetch, attempts=3)\n"
         "except BadRequest:\n"
         "    pass\n"
         "else:\n"
         "    raise AssertionError('BadRequest 应当向上抛出')\n"
         "assert f.calls == 1, f'不应重试，实际调用 {f.calls} 次'"),
        ("[L3] Timeout 重试行为保持",
         "from gateway import fetch_profile\n"
         "r = fetch_profile(failures=2)\n"
         "assert r['result'] == 'ok' and r['attempts'] == 3, r"),
        ("[L4] 返回值保持 (result, attempts) 二元组",
         "from client import Flaky\nfrom retry import call_with_retry\n"
         "f = Flaky(0)\n"
         "out = call_with_retry(f.fetch, attempts=3)\n"
         "assert isinstance(out, tuple) and len(out) == 2 and out[0] == 'ok' and out[1] == 1, out"),
    ],
    # ---- 003 状态机回退（缺陷：can_move 只查 cur != nxt）----
    "L2P2-003": [
        ("[L1] done 之后不得回退到 paid",
         "from orders import create, advance, bulk_advance\nfrom states import PAID, SHIPPED, DONE\n"
         "create('o1')\n"
         "bulk_advance('o1', [PAID, SHIPPED, DONE])\n"
         "assert advance('o1', PAID) == DONE, '状态被非法回退'"),
        ("[L1] done 之后不得回退到 created",
         "from orders import create, advance, bulk_advance\nfrom states import PAID, SHIPPED, DONE, CREATED\n"
         "create('o1b')\n"
         "bulk_advance('o1b', [PAID, SHIPPED, DONE])\n"
         "assert advance('o1b', CREATED) == DONE, '状态被非法回退'"),
        ("[L2] paid 不得回退到 created",
         "from orders import create, advance\nfrom states import PAID, CREATED\n"
         "create('o2a')\n"
         "advance('o2a', PAID)\n"
         "assert advance('o2a', CREATED) == PAID, '状态被非法回退'"),
        ("[L2] 不得跳级（created 直达 done）",
         "from orders import create, advance\nfrom states import DONE\n"
         "create('o2b')\n"
         "s = advance('o2b', DONE)\n"
         "assert s != DONE, '跳级成功，状态机被绕过'"),
        ("[L3] 正常推进链路可用（不含对终态的再推进）",
         "from orders import create, advance\nfrom states import PAID, SHIPPED, DONE\n"
         "create('o3')\n"
         "assert advance('o3', PAID) == PAID\n"
         "assert advance('o3', SHIPPED) == SHIPPED\n"
         "assert advance('o3', DONE) == DONE"),
        ("[L4] 非法推进返回当前状态且不抛异常",
         "from orders import create, advance\nfrom states import PAID\n"
         "create('o4')\n"
         "s = advance('o4', PAID)\n"
         "assert s == PAID"),
    ],
    # ---- 004 分页游标（缺陷：>= 定位 + 永远返回游标）----
    "L2P2-004": [
        ("[L1] 7 条 3 条/页翻页不重不漏",
         "from repository import ArticleRepo\nfrom feeds import walk\n"
         "got = walk(ArticleRepo([{'id': i} for i in range(1, 8)]), 3)\n"
         "assert got == [1,2,3,4,5,6,7], f'got {got}'"),
        ("[L1] 10 条 4 条/页翻页不重不漏",
         "from repository import ArticleRepo\nfrom feeds import walk\n"
         "got = walk(ArticleRepo([{'id': i} for i in range(1, 11)]), 4)\n"
         "assert got == list(range(1, 11)), f'got {got}'"),
        ("[L2] 末页不足 size 时游标为 None",
         "from paginator import page\n"
         "rows, tok = page([{'id': 1}, {'id': 2}], 5)\n"
         "assert tok is None, f'末页游标应为 None，got {tok}'"),
        ("[L2] size 大于总数时一次取完且游标为 None",
         "from paginator import page\n"
         "rows, tok = page([{'id': 1}, {'id': 2}, {'id': 3}], 10)\n"
         "assert len(rows) == 3 and tok is None, (rows, tok)"),
        ("[L3] 空数据直接结束",
         "from repository import ArticleRepo\nfrom feeds import walk\n"
         "assert walk(ArticleRepo([]), 3) == []"),
        ("[L4] 游标 encode/decode 往返一致",
         "from cursor import encode, decode\n"
         "for v in (1, 99, 'abc'):\n"
         "    assert decode(encode(v)) == v, v"),
    ],
    # ---- 005 时间窗口（缺陷：floor_hour 取整点）----
    "L2P2-005": [
        ("[L1] 窗口从起始时刻起算",
         "from datetime import datetime\nfrom ingest import summarize\n"
         "base = datetime(2026, 1, 1, 10, 30)\n"
         "r = summarize([(0, 1), (29, 2), (30, 4), (89, 8)], base)\n"
         "assert r == [7, 8, 0], f'got {r}'"),
        ("[L1] 非整点 base 的边界样本归属正确",
         "from datetime import datetime\nfrom ingest import summarize\n"
         "base = datetime(2026, 3, 1, 9, 45)\n"
         "# 第 0 桶=[9:45,10:45)：15分=10:00 在桶0；60分=10:45 在桶1；119分=11:44 在桶1\n"
         "r = summarize([(0, 1), (15, 2), (60, 4), (119, 8)], base)\n"
         "assert r == [3, 12, 0], f'got {r}'"),
        ("[L2] 起始时刻之前的样本不计入任何桶",
         "from datetime import datetime, timedelta\nfrom window import aggregate\n"
         "base = datetime(2026, 1, 1, 10, 30)\n"
         "events = [{'ts': base - timedelta(minutes=5), 'value': 9},\n"
         "          {'ts': base, 'value': 1}]\n"
         "r = aggregate(events, base, 2)\n"
         "assert r == [1, 0], f'负偏移被错误计入: {r}'"),
        ("[L3] 整点 base 结果一致",
         "from datetime import datetime\nfrom ingest import summarize\n"
         "base = datetime(2026, 1, 1, 10, 0)\n"
         "r = summarize([(5, 1), (65, 2), (125, 3)], base)\n"
         "assert r == [1, 2, 3], r"),
        ("[L4] aggregate 返回长度恒等于 hours",
         "from datetime import datetime\nfrom window import aggregate\n"
         "base = datetime(2026, 1, 1, 10, 0)\n"
         "assert len(aggregate([], base, 5)) == 5"),
    ],
    # ---- 006 深度合并 None（缺陷：跳过 None）----
    "L2P2-006": [
        ("[L1] 显式 None 覆盖嵌套默认值",
         "from config_loader import load\n"
         "cfg = load(env={'server': {'tls': {'cert': None}}})\n"
         "assert cfg['server']['tls']['cert'] is None, f\"cert={cfg['server']['tls']['cert']!r}\"\n"
         "assert cfg['server']['tls']['enabled'] is True"),
        ("[L1] 显式 None 覆盖已有非 None 值",
         "from merge import deep_merge\n"
         "r = deep_merge({'logging': {'file': '/a'}}, {'logging': {'file': None}})\n"
         "assert r['logging']['file'] is None, r"),
        ("[L3] 链式合并顺序正确（与 None 无关的路径）",
         "from merge import merge_chain\n"
         "r = merge_chain({'a': 1}, {'a': None}, {'a': 2})\n"
         "assert r['a'] == 2, r"),
        ("[L3] 深层 dict 合并且默认值保留",
         "from config_loader import load, effective_port\n"
         "cfg = load()\n"
         "assert cfg['server']['host'] == '0.0.0.0'\n"
         "assert effective_port(cfg) == 8080\n"
         "cfg2 = load(env={'logging': {'file': '/var/log/app.log'}})\n"
         "assert cfg2['logging']['file'] == '/var/log/app.log'"),
        ("[L3] 深合并不整体替换子 dict",
         "from merge import deep_merge\n"
         "assert deep_merge({'a': {'b': 1}}, {'a': {'c': 2}}) == {'a': {'b': 1, 'c': 2}}"),
        ("[L4] deep_merge 是纯函数（不修改入参）",
         "from merge import deep_merge\n"
         "base = {'a': {'b': 1}}\n"
         "deep_merge(base, {'a': {'c': 2}})\n"
         "assert base == {'a': {'b': 1}}, f'入参被修改: {base}'"),
    ],
    # ---- 007 监听重复注册（缺陷：无幂等）----
    "L2P2-007": [
        ("[L1] 装饰器 + bootstrap 双重注册只触发一次",
         "from events import publish\nfrom plugins import handlers, send_welcome, audit_log\nfrom lifecycle import bootstrap\n"
         "bootstrap(handlers())\n"
         "publish('user.created', {'id': 1})\n"
         "assert send_welcome.calls == 1, f'send_welcome 触发 {send_welcome.calls} 次'\n"
         "assert audit_log.calls == 1, f'audit_log 触发 {audit_log.calls} 次'"),
        ("[L1] 同一函数重复 subscribe 三次只注册一次",
         "from events import subscribe\n"
         "def fn(e): pass\n"
         "n1 = subscribe('dup.topic', fn)\n"
         "n2 = subscribe('dup.topic', fn)\n"
         "n3 = subscribe('dup.topic', fn)\n"
         "assert n1 == n2 == n3, (n1, n2, n3)"),
        ("[L2] 幂等后新增不同处理器仍正常",
         "from events import publish, subscribe\n"
         "hits = []\n"
         "def h1(e): hits.append(1)\n"
         "def h2(e): hits.append(2)\n"
         "subscribe('idem.x', h1)\n"
         "subscribe('idem.x', h1)\n"
         "subscribe('idem.x', h2)\n"
         "publish('idem.x', {})\n"
         "assert sorted(hits) == [1, 2], hits"),
        ("[L3] publish 计数与返回值正确",
         "from events import publish, counts, subscribe\n"
         "calls = []\n"
         "subscribe('x.y', lambda e: calls.append('a'))\n"
         "subscribe('x.y', lambda e: calls.append('b'))\n"
         "n = publish('x.y', {})\n"
         "assert n == 2 and sorted(calls) == ['a', 'b']\n"
         "assert counts()['x.y'] == 1"),
        ("[L4] Registry.get 返回副本（修改返回值不影响内部）",
         "from registry import Registry\n"
         "r = Registry()\n"
         "def fn(e): pass\n"
         "r.add('t', fn)\n"
         "snapshot = r.get('t')\n"
         "snapshot.append(print)\n"
         "assert len(r.get('t')) == 1, r.get('t')"),
    ],
    # ---- 008 批量回滚（缺陷：dao 直写 store，rollback 不撤销）----
    "L2P2-008": [
        ("[L1] 中途失败不得留下已写入的行",
         "from batch import bulk_upsert\n"
         "store = {}\n"
         "users = [{'id': 'a'}, {'id': 'b', 'blocked': True}, {'id': 'c'}]\n"
         "ok, fail = bulk_upsert(store, users)\n"
         "assert (ok, fail) == (2, 1), f'(ok,fail)=({ok},{fail})'\n"
         "assert store == {}, f'失败后残留脏数据: {store}'"),
        ("[L1] 末位失败同样不落库",
         "from batch import bulk_upsert\n"
         "store = {}\n"
         "ok, fail = bulk_upsert(store, [{'id': 'a'}, {'id': 'b', 'blocked': True}])\n"
         "assert (ok, fail) == (1, 1), (ok, fail)\n"
         "assert store == {}, store"),
        ("[L2] 失败时被覆盖的旧值必须恢复（update 场景）",
         "from batch import bulk_upsert\n"
         "store = {'a': {'id': 'a', 'v': 1}}\n"
         "users = [{'id': 'a', 'v': 2}, {'id': 'b', 'blocked': True}]\n"
         "ok, fail = bulk_upsert(store, users)\n"
         "assert fail == 1, (ok, fail)\n"
         "assert store['a'] == {'id': 'a', 'v': 1}, f'旧值未被恢复: {store}'"),
        ("[L3] 全部成功时正常落库",
         "from batch import bulk_upsert\n"
         "store = {}\n"
         "ok, fail = bulk_upsert(store, [{'id': 'a'}, {'id': 'b'}])\n"
         "assert (ok, fail) == (2, 0) and set(store) == {'a', 'b'}"),
        ("[L4] 返回值恒为二元组计数",
         "from batch import bulk_upsert\n"
         "out = bulk_upsert({}, [])\n"
         "assert isinstance(out, tuple) and out == (0, 0), out"),
    ],
    # ---- 009 鉴权顺序（缺陷：登记存 path、查询用 handler 名）----
    "L2P2-009": [
        ("[L1] /me 无令牌必须 401",
         "from middleware import App\nfrom handlers import health, me\n"
         "app = App()\n"
         "app.register('/health', health, public=True)\n"
         "app.register('/me', me)\n"
         "assert app.dispatch('/me', {})['status'] == 401, '/me 应受保护'"),
        ("[L1] /admin 无令牌必须 401",
         "from middleware import App\nfrom handlers import health, admin_panel\n"
         "app = App()\n"
         "app.register('/health', health, public=True)\n"
         "app.register('/admin', admin_panel)\n"
         "assert app.dispatch('/admin', {})['status'] == 401, '/admin 应受保护'"),
        ("[L2] 无效令牌必须 401",
         "from middleware import App\nfrom handlers import health, me\n"
         "app = App()\n"
         "app.register('/health', health, public=True)\n"
         "app.register('/me', me)\n"
         "r = app.dispatch('/me', {'Authorization': 'wrong-token'})\n"
         "assert r['status'] == 401, f'无效令牌应 401，got {r}'"),
        ("[L3] 公开路由无需令牌、未知路由 404",
         "from middleware import App\nfrom handlers import health\n"
         "app = App()\n"
         "app.register('/health', health, public=True)\n"
         "assert app.dispatch('/health', {})['status'] == 200\n"
         "assert app.dispatch('/nope', {})['status'] == 404"),
        ("[L4] 路由注册数量与公开标记正确",
         "from middleware import App\nfrom handlers import health, me\n"
         "app = App()\n"
         "app.register('/health', health, public=True)\n"
         "app.register('/me', me)\n"
         "assert app.router.is_public('/health') is True\n"
         "assert app.router.is_public('/me') is False"),
    ],
    # ---- 010 共享节点序列化（缺陷：seen 命中返回 None 被过滤）----
    "L2P2-010": [
        ("[L1] 共享子节点在两个父节点下都要出现",
         "from models import build_tree\nfrom serializer import dumps\n"
         "root, leaf = build_tree()\n"
         "d = dumps(root)\n"
         "a_children = d['children'][0]['children']\n"
         "b_children = d['children'][1]['children']\n"
         "assert len(a_children) == 1 and a_children[0]['id'] == 'leaf', a_children\n"
         "assert len(b_children) == 1 and b_children[0]['id'] == 'leaf', b_children"),
        ("[L1] 共享节点的子结构也要完整（含 children 键）",
         "from models import build_tree\nfrom serializer import dumps\n"
         "root, _ = build_tree()\n"
         "d = dumps(root)\n"
         "for p in d['children']:\n"
         "    ch = p['children']\n"
         "    assert len(ch) == 1 and 'children' in ch[0], ch"),
        ("[L2] 真环折叠为引用且不无限递归",
         "from graph import Node\nfrom serializer import dumps\nfrom visitors import count_nodes\n"
         "x = Node('x')\n"
         "y = Node('y', [x])\n"
         "x.add(y)\n"
         "d = dumps(x)\n"
         "assert d['id'] == 'x'\n"
         "inner = d['children'][0]['children'][0]\n"
         "assert inner.get('ref') is True, f'环应折叠为引用: {inner}'\n"
         "assert count_nodes(d) <= 3, count_nodes(d)"),
        ("[L3] 非共享树正常展开",
         "from graph import Node\nfrom serializer import dumps\n"
         "t = Node('t', [Node('t1'), Node('t2')])\n"
         "d = dumps(t)\n"
         "assert len(d['children']) == 2, d"),
        ("[L4] graph.walk 行为不受影响（重复引用只访问一次）",
         "from models import build_tree\nfrom graph import walk\n"
         "root, _ = build_tree()\n"
         "ids = walk(root)\n"
         "assert ids.count('leaf') == 1, ids\n"
         "assert set(ids) == {'root', 'a', 'b', 'leaf'}, ids"),
    ],
}


def main():
    questions = json.loads(SRC.read_text(encoding="utf-8"))
    out = []
    seq = 0
    for q in questions:
        qid = q["id"]
        rub = RUBRIC.get(qid)
        if not rub:
            out.append(q)
            continue
        req = json.loads(q["requirements"])
        tests, files = [], []
        for i, (name, body) in enumerate(rub, 1):
            fpath = f"tests/hidden/test_{i:02d}.py"
            tests.append({"description": name, "script": f"python {fpath}"})
            files.append({"path": fpath, "content": TEST_FILE_TMPL.format(body=body)})
        req["hiddenTests"] = tests
        req["hiddenTestFiles"] = files
        q = dict(q)
        q["hiddenTests"] = json.dumps(tests, ensure_ascii=False)
        q["requirements"] = json.dumps(req, ensure_ascii=False)
        q["scenarioVersion"] = "3.0.0"
        q["scenarioHash"] = f"l2rubric-{qid.lower()}"
        out.append(q)
        seq += 1
    OUT.write_text(json.dumps(out, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"已产出 {len(out)} 道 v3（多级 rubric）题 → {OUT}")
    for q in out:
        n = len(json.loads(q["requirements"])["hiddenTests"])
        print(f"  {q['id']}: {n} 个测试点")


if __name__ == "__main__":
    main()
