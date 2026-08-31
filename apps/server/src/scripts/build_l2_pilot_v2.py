#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
I7 · Level 2 pilot **v2（难度大幅升级）**
=========================================
v1 实测教训（ornith 10 题均分 94.2、3 题满分，天花板效应）：
  1. **failing_output 泄露根因**——v1 里直接写明"client.py 的 LOCAL_RETRY_CAP 与 config 漂移"，
     模型照着改即可，等于送分。v2 只给原始 traceback 现象，根因必须自己读代码定位。
  2. **缺干扰文件**——v1 每题 3~4 个文件且都相关，扫一眼就知道改哪。
     v2 每题 6~8 个文件，其中 2~3 个高度相关但无辜（诱导改错）。
  3. **gold 常只需改 1 个文件**——v1 有 5 题单文件即可修好，违背"多文件修复"初衷。
     v2 强制每题 gold ≥2 个文件。
  4. **缺陷太直白**——常量不一致、解包数量错，属于模式匹配能看出的级别。
     v2 改为：条件分支边界、特定调用顺序才触发的状态污染、跨文件契约在子集路径上失效。

契约提醒（v1 踩过的坑，勿犯）：
  - hiddenTests[].script 必须是 **shell**（`python tests/hidden/test_x.py`），不是 Python 源码
  - 模型输出格式必须能被 parseFileBlocks 解析：`## <path>` 标题 + 代码块
  - status/tier 必须 valid/public_dev，否则 run 选题 0 命中
"""
import json
from pathlib import Path

OUT = Path(r"J:/AI/zxbench-webui/apps/server/src/scripts/l2_pilot_v2_questions.json")

BANK_WEIGHTS = {
    "test_pass": 0.35,
    "api_stability": 0.15,
    "static_signals": 0.30,
    "output_completeness": 0.10,
    "scope_discipline": 0.10,
}

TEST_FILE_TMPL = """import sys
sys.path.insert(0, '.')
{body}
"""

_TEST_SEQ = {"n": 0}
QUESTIONS = []


def t(name, body):
    _TEST_SEQ["n"] += 1
    n = _TEST_SEQ["n"]
    qnum = (n + 1) // 2
    kind = "main" if n % 2 == 1 else "regress"
    idx = f"{qnum:03d}"
    return {
        "description": name,
        "script": f"python tests/hidden/test_{idx}_{kind}.py",
        "_file_path": f"tests/hidden/test_{idx}_{kind}.py",
        "_body": body,
    }


def q(qid, category, difficulty, title, task_hint, files, tests, keywords,
      failing_output, api_files):
    """组装一道 v2 Level 2 题。

    failing_output 只描述**现象**（原始 traceback / 断言输出），绝不写根因。
    """
    file_list = "\n".join(f"- `{f['path']}`" for f in files)
    api_note = "\n".join(f"- `{p}`" for p in api_files)
    prompt = f"""你在一个已有的 Python 项目中工作。项目有一个缺陷，**测试是失败的**。

## 项目文件（{len(files)} 个，其中部分与缺陷无关）
{file_list}

## 失败现象
```
{failing_output}
```

## 你的任务
{task_hint}

## 硬性约束
1. **不得修改这些公开接口的签名**（函数名、参数列表、返回值类型必须保持兼容）：
{api_note}
2. 不得靠"删掉调用方"或"把断言改掉"来让测试通过。
3. 找出**所有**需要修改的文件并逐个输出完整内容——需要的就改，不需要的不要动
   （数量由缺陷本身决定，不要为了凑数去改无关文件）。

## 输出格式（严格遵守，否则无法解析）
对每个需要修改的文件：

## {files[0]['path']}
```python
<该文件的完整内容>
```

## <第二个文件路径>
```python
<该文件的完整内容>
```

- 标题以 `## ` 开头、后跟文件路径；其下是完整代码块（完整内容，不是 diff）。
- 不要省略、不要用 "..." 占位；保持简洁，不要长篇分析。"""

    hidden_test_files = [
        {"path": x["_file_path"], "content": TEST_FILE_TMPL.format(body=x["_body"])}
        for x in tests
    ]
    shell_tests = [{"description": x["description"], "script": x["script"]} for x in tests]

    QUESTIONS.append({
        "id": qid,
        "dimension": "program",
        "category": category,
        "difficulty": difficulty,
        "language": "python",
        "locale": "zh",
        # run 选题硬过滤 status='valid'（routes/index.ts:3238）
        "status": "valid",
        "tier": "public_dev",
        "promptTemplate": prompt,
        "sourceCode": json.dumps(files, ensure_ascii=False),
        "expectedVerdict": "fix",
        "grader": "project_repair",
        "graderVersion": "1.1.0",
        "scoring": json.dumps({"type": "weighted_axes", "weights": BANK_WEIGHTS}, ensure_ascii=False),
        "hiddenTests": json.dumps(shell_tests, ensure_ascii=False),
        "requirements": json.dumps({
            "files": files,
            "hiddenTestFiles": hidden_test_files,
            "hiddenTests": shell_tests,
            "explanationKeywords": keywords,
            "image": "python:3.12-alpine",
        }, ensure_ascii=False),
        "tags": json.dumps(["L2", "multi_file", "pilot_v2", "hard"], ensure_ascii=False),
        "scenarioVersion": "2.0.0",
        "scenarioHash": f"l2pilotv2-{qid.lower()}",
        "responseMode": "raw_output",
        "reviewStatus": "pilot",
        "answerFirst": 1,
    })


# ============================================================
# 001 缓存键冲突：不同参数产生同一个 key
# ============================================================
q(
    "L2P2-001", "cache_key_collision", "hard",
    "缓存键冲突",
    "定位缓存键构造中的缺陷并修复，使不同参数的条目互不覆盖。",
    files=[
        {"path": "keys.py", "content": '''SEP = ","


def make_key(namespace, *parts):
    """构造缓存键：namespace 前缀 + 各 part 用 SEP 连接。"""
    return namespace + "|" + SEP.join(str(p) for p in parts)
'''},
        {"path": "cache.py", "content": '''_store = {}
_hits = 0
_misses = 0


def get(key, default=None):
    global _hits, _misses
    if key in _store:
        _hits += 1
        return _store[key]
    _misses += 1
    return default


def put(key, value):
    _store[key] = value
    return value


def stats():
    return {"hits": _hits, "misses": _misses, "size": len(_store)}


def clear():
    _store.clear()
'''},
        {"path": "service.py", "content": '''from cache import get, put
from keys import make_key


def lookup(user_id, tags):
    """按 (user_id, tags) 缓存画像。tags 是字符串列表。"""
    k = make_key("profile", user_id, *tags)
    hit = get(k)
    if hit is not None:
        return hit
    v = {"user": user_id, "tags": list(tags), "score": sum(len(x) for x in tags)}
    put(k, v)
    return v
'''},
        {"path": "metrics.py", "content": '''from cache import stats


def report():
    """对外暴露缓存命中统计（与本次缺陷无关）。"""
    s = stats()
    total = s["hits"] + s["misses"]
    return {"hit_rate": (s["hits"] / total) if total else 0.0, **s}
'''},
        {"path": "logging_util.py", "content": '''def fmt(module, level, message):
    """日志格式化工具（与本次缺陷无关）。"""
    return f"[{level}] {module}: {message}"
'''},
        {"path": "config.py", "content": '''CACHE_TTL = 300
MAX_TAGS = 16


def validate_tags(tags):
    """校验标签数量（与本次缺陷无关）。"""
    return len(tags) <= MAX_TAGS
'''},
    ],
    tests=[
        t("主路径：不同参数组合不得互相覆盖",
          "from service import lookup\nfrom cache import clear\n"
          "clear()\n"
          "a = lookup(1, ['vip','cn'])\n"
          "b = lookup(1, ['vip,cn'])\n"
          "assert a['tags'] == ['vip','cn'], a\n"
          "assert b['tags'] == ['vip,cn'], b\n"
          "assert a is not b"),
        t("回归：相同参数仍命中缓存且统计正确",
          "from service import lookup\nfrom cache import clear\nfrom metrics import report\n"
          "clear()\n"
          "lookup(7, ['x'])\n"
          "lookup(7, ['x'])\n"
          "r = report()\n"
          "assert r['hits'] == 1 and r['misses'] == 1, r\n"
          "assert r['size'] == 1, r"),
    ],
    keywords=["make_key", "转义", "冲突", "collision"],
# 只给现象，不给根因：模型必须自己发现 SEP 未转义
    failing_output="""FAILED test_no_collision
  AssertionError: {'user': 1, 'tags': ['vip', 'cn'], 'score': 5}
  # lookup(1, ['vip','cn']) 与 lookup(1, ['vip,cn']) 本应得到不同条目，
  # 第二次查询本该是缓存未命中，却直接命中了第一次写入的结果。""",
    api_files=["keys.make_key(namespace, *parts)", "cache.get(key, default=None)",
               "cache.put(key, value)", "service.lookup(user_id, tags)"],
)

# ============================================================
# 002 重试只对部分异常生效（异常层级判断反了）
# ============================================================
q(
    "L2P2-002", "retry_exception_hierarchy", "hard",
    "重试策略未覆盖可重试异常",
    "定位为何可重试错误没有被重试，修复后使重试统计正确。",
    files=[
        {"path": "exceptions.py", "content": '''class UpstreamError(Exception):
    """上游错误基类。"""
    retryable = False


class Timeout(UpstreamError):
    retryable = True


class ConnectionReset(UpstreamError):
    retryable = True


class BadRequest(UpstreamError):
    retryable = False


class RateLimited(UpstreamError):
    retryable = True
'''},
        {"path": "retry.py", "content": '''import time
from exceptions import UpstreamError, Timeout


def call_with_retry(fn, attempts=3, backoff=0.0):
    """调用 fn，可重试错误自动重试，返回 (result, used_attempts)。"""
    last = None
    for i in range(1, attempts + 1):
        try:
            return fn(), i
        except UpstreamError as e:
            last = e
            # 只有超时类错误才重试
            if not isinstance(e, Timeout):
                raise
            if i < attempts and backoff:
                time.sleep(backoff)
    raise last
'''},
        {"path": "client.py", "content": '''from exceptions import Timeout, ConnectionReset, RateLimited, BadRequest


class Flaky:
    """模拟会失败若干次的上游。"""

    def __init__(self, failures, exc=Timeout):
        self.failures = failures
        self.exc = exc
        self.calls = 0

    def fetch(self):
        self.calls += 1
        if self.calls <= self.failures:
            raise self.exc("upstream down")
        return "ok"
'''},
        {"path": "gateway.py", "content": '''from retry import call_with_retry
from client import Flaky
from exceptions import Timeout, ConnectionReset


def fetch_profile(failures=2):
    """拉取用户画像：超时/连接重置属于可重试错误。"""
    f = Flaky(failures)
    result, used = call_with_retry(f.fetch, attempts=3)
    return {"result": result, "attempts": used, "calls": f.calls}
'''},
        {"path": "circuit.py", "content": '''class CircuitBreaker:
    """简单的熔断器状态（与本次缺陷无关）。"""

    def __init__(self, threshold=3):
        self.threshold = threshold
        self.failures = 0
        self.open = False

    def record(self, ok):
        if ok:
            self.failures = 0
            self.open = False
        else:
            self.failures += 1
            if self.failures >= self.threshold:
                self.open = True
        return self.open
'''},
        {"path": "telemetry.py", "content": '''import time


class Span:
    """链路追踪 span（与本次缺陷无关）。"""

    def __init__(self, name):
        self.name = name
        self.start = time.time()

    def elapsed(self):
        return time.time() - self.start
'''},
    ],
    tests=[
        t("主路径：可重试错误被重试到成功",
          "from gateway import fetch_profile\nfrom client import Flaky\nfrom retry import call_with_retry\nfrom exceptions import ConnectionReset, RateLimited\n"
          "r = fetch_profile(failures=2)\n"
          "assert r['result'] == 'ok', r\n"
          "assert r['attempts'] == 3, f\"attempts={r['attempts']}, 期望 3\"\n"
          "f = Flaky(1, ConnectionReset)\n"
          "res, used = call_with_retry(f.fetch, attempts=3)\n"
          "assert res == 'ok' and used == 2, (res, used)"),
        t("回归：不可重试错误立即抛出，不消耗重试次数",
          "from client import Flaky\nfrom retry import call_with_retry\nfrom exceptions import BadRequest\n"
          "f = Flaky(5, BadRequest)\n"
          "try:\n"
          "    call_with_retry(f.fetch, attempts=3)\n"
          "except BadRequest:\n"
          "    pass\n"
          "else:\n"
          "    raise AssertionError('BadRequest 应当向上抛出')\n"
          "assert f.calls == 1, f'不应重试，实际调用 {f.calls} 次'"),
    ],
    keywords=["retryable", "isinstance", "子类", "异常层级"],
    failing_output="""FAILED test_retry_on_transient
  exceptions.ConnectionReset: upstream down
    at retry.py:16  raise last
  # Flaky 抛出 ConnectionReset（标记了 retryable=True），期望重试到成功，
  # 实际在第 1 次就把异常抛了上来，一次重试都没发生。""",
    api_files=["retry.call_with_retry(fn, attempts=3, backoff=0.0)",
               "gateway.fetch_profile(failures=2)", "client.Flaky.fetch(self)"],
)

# ============================================================
# 003 状态机 check-then-act 竞态（特定调用顺序触发）
# ============================================================
q(
    "L2P2-003", "state_machine_race", "adversarial",
    "状态机非法回退",
    "定位状态流转在特定调用顺序下被非法回退的原因并修复。",
    files=[
        {"path": "states.py", "content": '''CREATED = "created"
PAID = "paid"
SHIPPED = "shipped"
DONE = "done"

ALLOWED = {
    CREATED: {PAID},
    PAID: {SHIPPED},
    SHIPPED: {DONE},
    DONE: set(),
}

RANK = {CREATED: 0, PAID: 1, SHIPPED: 2, DONE: 3}
'''},
        {"path": "machine.py", "content": '''from states import ALLOWED, RANK


class IllegalTransition(Exception):
    pass


def can_move(cur, nxt):
    # 缺陷：只检查"状态确实变了"，没有校验流转方向，
    # 于是 done -> paid 这类回退也被放行。
    return cur != nxt and nxt in RANK


def move(cur, nxt):
    """校验并推进状态。非法流转抛 IllegalTransition。"""
    if not can_move(cur, nxt):
        raise IllegalTransition(f"{cur} -> {nxt}")
    return nxt
'''},
        {"path": "repository.py", "content": '''class OrderRepository:
    """内存态订单仓储。"""

    def __init__(self):
        self._rows = {}

    def load(self, oid):
        return self._rows.get(oid)

    def save(self, oid, state):
        self._rows[oid] = state
        return state

    def all(self):
        return dict(self._rows)
'''},
        {"path": "orders.py", "content": '''from machine import move, can_move, IllegalTransition
from repository import OrderRepository
from states import CREATED, PAID, SHIPPED, DONE

_repo = OrderRepository()


def create(oid):
    _repo.save(oid, CREATED)
    return _repo.load(oid)


def advance(oid, target):
    """推进订单状态。若当前状态不允许推进到 target，返回当前状态且不改动。"""
    cur = _repo.load(oid)
    if cur is None:
        return None
    # 先判断再写入：两步之间没有约束同一份数据
    if can_move(cur, target):
        return _repo.save(oid, target)
    return cur


def bulk_advance(oid, targets):
    """按序尝试推进多个目标状态，返回最终状态。"""
    state = _repo.load(oid)
    for tg in targets:
        try:
            state = move(state, tg)
            _repo.save(oid, state)
        except IllegalTransition:
            continue
    return state
'''},
        {"path": "events.py", "content": '''class EventBus:
    """极简事件总线（与本次缺陷无关）。"""

    def __init__(self):
        self._subs = {}

    def subscribe(self, topic, fn):
        self._subs.setdefault(topic, []).append(fn)

    def publish(self, topic, payload):
        for fn in self._subs.get(topic, []):
            fn(payload)
        return len(self._subs.get(topic, []))
'''},
        {"path": "audit.py", "content": '''class AuditLog:
    """审计日志（与本次缺陷无关）。"""

    def __init__(self):
        self.entries = []

    def record(self, oid, frm, to):
        self.entries.append((oid, frm, to))
        return len(self.entries)
'''},
    ],
    tests=[
        t("主路径：done 之后不得回退",
          "from orders import create, advance, bulk_advance\nfrom states import CREATED, PAID, SHIPPED, DONE\n"
          "create('o1')\n"
          "bulk_advance('o1', [PAID, SHIPPED, DONE])\n"
          "s = advance('o1', PAID)\n"
          "assert s == DONE, f'状态被非法回退: {s}'\n"
          "s2 = advance('o1', CREATED)\n"
          "assert s2 == DONE, f'状态被非法回退: {s2}'"),
        t("回归：正常推进链路仍可用",
          "from orders import create, advance, bulk_advance\nfrom states import CREATED, PAID, SHIPPED, DONE\n"
          "create('o2')\n"
          "assert advance('o2', PAID) == PAID\n"
          "assert advance('o2', SHIPPED) == SHIPPED\n"
          "assert advance('o2', DONE) == DONE\n"
          "assert bulk_advance('o2', [PAID]) == DONE"),
    ],
    keywords=["RANK", "单调", "回退", "并发"],
    failing_output="""FAILED test_no_regression
  AssertionError: 状态被非法回退: paid
  # 订单 o1 已经走到 done，随后调用 advance('o1', PAID) 竟然回到了 paid。
  # 注意：advance 内部先 can_move 再 save，两次读取之间状态可能被别的路径改写。""",
    api_files=["orders.advance(oid, target)", "orders.bulk_advance(oid, targets)",
               "machine.move(cur, nxt)", "repository.OrderRepository.save(self, oid, state)"],
)

# ============================================================
# 004 分页游标在末页重复
# ============================================================
q(
    "L2P2-004", "pagination_cursor_boundary", "hard",
    "分页末页重复",
    "定位末页记录被重复返回的原因并修复。",
    files=[
        {"path": "cursor.py", "content": '''import base64
import json


def encode(value):
    raw = json.dumps({"v": value}).encode()
    return base64.urlsafe_b64encode(raw).decode().rstrip("=")


def decode(token):
    if not token:
        return None
    pad = "=" * (-len(token) % 4)
    raw = base64.urlsafe_b64decode(token + pad)
    return json.loads(raw)["v"]
'''},
        {"path": "paginator.py", "content": '''from cursor import encode, decode


def page(items, size, after=None, key=lambda x: x):
    """返回 (rows, next_cursor)。next_cursor 为 None 表示没有更多数据。"""
    start = 0
    if after is not None:
        for i, it in enumerate(items):
            # 缺陷：用 >= 定位游标，导致游标指向的这条被重复返回
            if key(it) >= after:
                start = i
                break
    rows = items[start:start + size]
    if not rows:
        return [], None
    return rows, encode(key(rows[-1]))
'''},
        {"path": "repository.py", "content": '''class ArticleRepo:
    """文章仓储（内存实现）。"""

    def __init__(self, rows):
        self._rows = list(rows)

    def list_all(self):
        return list(self._rows)

    def count(self):
        return len(self._rows)
'''},
        {"path": "feeds.py", "content": '''from paginator import page
from repository import ArticleRepo
from cursor import decode


def walk(repo, size):
    """翻页遍历全部条目，返回收集到的所有 id（按页顺序）。"""
    seen = []
    token = None
    guard = 0
    while True:
        rows, token = page(repo.list_all(), size, after=decode(token) if token else None,
                           key=lambda a: a["id"])
        if not rows:
            break
        seen.extend(a["id"] for a in rows)
        guard += 1
        if guard > 100:
            break
    return seen
'''},
        {"path": "serializers.py", "content": '''def to_dict(article):
    """序列化（与本次缺陷无关）。"""
    return {"id": article["id"], "title": article.get("title", "")}
'''},
        {"path": "ratelimit.py", "content": '''class TokenBucket:
    """限流桶（与本次缺陷无关）。"""

    def __init__(self, capacity, refill):
        self.capacity = capacity
        self.refill = refill
        self.tokens = capacity

    def take(self, n=1):
        if self.tokens >= n:
            self.tokens -= n
            return True
        return False
'''},
    ],
    tests=[
        t("主路径：全量翻页不重不漏",
          "from repository import ArticleRepo\nfrom feeds import walk\n"
          "rows = [{'id': i} for i in range(1, 8)]\n"
          "got = walk(ArticleRepo(rows), 3)\n"
          "assert got == [1,2,3,4,5,6,7], f'got {got}'\n"
          "assert len(got) == len(set(got)), f'存在重复: {got}'"),
        t("回归：空数据与单页数据正确终止",
          "from repository import ArticleRepo\nfrom feeds import walk\nfrom paginator import page\n"
          "assert walk(ArticleRepo([]), 3) == []\n"
          "assert walk(ArticleRepo([{'id': 1}]), 3) == [1]\n"
          "rows, tok = page([{'id': 1}, {'id': 2}], 5)\n"
          "assert tok is None, '最后一页应返回 None 游标'"),
    ],
    keywords=["next_cursor", "末页", "None", "终止"],
    failing_output="""FAILED test_pagination_no_dup
  AssertionError: got [1, 2, 3, 3, 4, 5, 5, 6, 7, 7, 7, 7, ...]
  # 7 条数据按每页 3 条翻页，游标指向的条目被重复返回，
  # 翻页无法推进到末尾，只能靠调用方的 guard 强行打断。""",
    api_files=["paginator.page(items, size, after=None, key=...)",
               "cursor.encode(value)", "cursor.decode(token)", "feeds.walk(repo, size)"],
)

# ============================================================
# 005 时间窗口跨边界统计
# ============================================================
q(
    "L2P2-005", "time_window_boundary", "adversarial",
    "时间窗口边界归属错误",
    "定位落在窗口边界上的样本被归属到错误窗口的原因并修复。",
    files=[
        {"path": "clock.py", "content": '''from datetime import datetime, timedelta


def floor_hour(ts):
    """把时间戳向下取整到整点。"""
    return ts.replace(minute=0, second=0, microsecond=0)


def hour_range(start, hours):
    """生成从 start 整点开始的连续 hours 个整点。"""
    base = floor_hour(start)
    return [base + timedelta(hours=i) for i in range(hours)]
'''},
        {"path": "window.py", "content": '''from clock import floor_hour


def bucket_of(ts, start):
    """返回 ts 相对 start 落在第几个小时桶（0-based）。"""
    a = floor_hour(start)
    b = floor_hour(ts)
    return int((b - a).total_seconds() // 3600)


def aggregate(events, start, hours, key="value"):
    """按小时聚合事件值，返回长度 hours 的列表。"""
    out = [0] * hours
    for e in events:
        i = bucket_of(e["ts"], start)
        if 0 <= i < hours:
            out[i] += e[key]
    return out
'''},
        {"path": "ingest.py", "content": '''from datetime import datetime, timedelta
from window import aggregate
from clock import hour_range


def summarize(records, base):
    """把 (偏移分钟, 值) 记录按小时聚合。"""
    events = [{"ts": base + timedelta(minutes=m), "value": v} for m, v in records]
    return aggregate(events, base, 3)


def labels(base):
    return [h.strftime("%H:00") for h in hour_range(base, 3)]
'''},
        {"path": "timezone_util.py", "content": '''from datetime import timedelta


def to_utc(ts, offset_hours):
    """朴素时区换算（与本次缺陷无关）。"""
    return ts - timedelta(hours=offset_hours)


def is_dst_boundary(ts):
    return ts.month in (3, 10) and ts.day > 25
'''},
        {"path": "formatters.py", "content": '''def humanize(counts):
    """把聚合结果格式化成字符串（与本次缺陷无关）。"""
    return ", ".join(f"{i}h={c}" for i, c in enumerate(counts))
'''},
    ],
    tests=[
        t("主路径：窗口从起始时刻起算，而非整点",
          "from datetime import datetime\nfrom ingest import summarize\n"
          "base = datetime(2026, 1, 1, 10, 30)\n"
          "# 窗口语义：第 0 桶=[10:30,11:30)，第 1 桶=[11:30,12:30)\n"
          "# 偏移 0/29/30 分钟 → 均在第 0 桶；89 分钟(11:59) → 第 1 桶\n"
          "r = summarize([(0, 1), (29, 2), (30, 4), (89, 8)], base)\n"
          "assert r == [7, 8, 0], f'got {r}, 期望 [7, 8, 0]'"),
        t("回归：起始时刻正好整点时结果一致",
          "from datetime import datetime\nfrom ingest import summarize\n"
          "base = datetime(2026, 1, 1, 10, 0)\n"
          "r = summarize([(5, 1), (65, 2), (125, 3)], base)\n"
          "assert r == [1, 2, 3], r"),
    ],
    keywords=["floor_hour", "窗口起点", "偏移", "半开区间"],
    failing_output="""FAILED test_window_boundary
  AssertionError: got [3, 12, 0], 期望 [7, 8, 0]
  # base=10:30，窗口应覆盖 [10:30, 11:30) 与 [11:30, 12:30)。
  # 偏移 30 分钟（11:00）仍在第 0 个窗口内，却被算进了第 1 个窗口；
  # 偏移 89 分钟（11:59）应在第 1 个窗口，也被算进了第 1 个窗口但值混在了一起。""",
    api_files=["window.bucket_of(ts, start)", "window.aggregate(events, start, hours, key='value')",
               "clock.floor_hour(ts)", "ingest.summarize(records, base)"],
)


# ============================================================
# 006 深度合并：None 语义在部分分支被吞掉
# ============================================================
q(
    "L2P2-006", "deep_merge_none_semantics", "hard",
    "深度合并的 None 语义错误",
    "定位为何部分配置项无法被覆盖（或反向丢失），修复合并语义。",
    files=[
        {"path": "merge.py", "content": '''def deep_merge(base, override):
    """把 override 深合并进 base，返回新 dict。"""
    out = dict(base)
    for k, v in override.items():
        # 缺陷：把 None 当作"调用方没设置"直接跳过，
        # 于是无法通过覆盖层把某项显式置空（默认值会一直留存）。
        if v is None:
            continue
        if isinstance(v, dict) and isinstance(out.get(k), dict):
            out[k] = deep_merge(out[k], v)
        else:
            out[k] = v
    return out


def merge_chain(*layers):
    """从左到右依次合并多层配置。"""
    acc = {}
    for layer in layers:
        acc = deep_merge(acc, layer)
    return acc
'''},
        {"path": "config_loader.py", "content": '''from merge import merge_chain

_DEFAULTS = {
    "server": {"host": "0.0.0.0", "port": 8080, "tls": {"enabled": True, "cert": "/etc/cert.pem"}},
    "logging": {"level": "INFO", "file": None},
}


def load(profile=None, env=None):
    """按 默认值 → profile → env 三层合并。"""
    layers = [_DEFAULTS]
    if profile:
        layers.append(profile)
    if env:
        layers.append(env)
    return merge_chain(*layers)


def effective_port(cfg):
    return cfg["server"]["port"]
'''},
        {"path": "schema.py", "content": '''REQUIRED_KEYS = ["server", "logging"]


def validate(cfg):
    """校验配置结构（与本次缺陷无关）。"""
    missing = [k for k in REQUIRED_KEYS if k not in cfg]
    return {"ok": not missing, "missing": missing}
'''},
        {"path": "envparse.py", "content": '''def parse_env(raw):
    """把 KEY=VALUE 文本解析成 dict（与本次缺陷无关）。"""
    out = {}
    for line in raw.splitlines():
        if "=" in line:
            k, v = line.split("=", 1)
            out[k.strip()] = v.strip()
    return out
'''},
    ],
    tests=[
        t("主路径：显式 None 必须能覆盖默认值",
          "from config_loader import load\n"
          "cfg = load(env={'server': {'tls': {'cert': None}}})\n"
          "assert cfg['server']['tls']['cert'] is None, f\"cert={cfg['server']['tls']['cert']!r}\"\n"
          "assert cfg['server']['tls']['enabled'] is True\n"
          "cfg2 = load(env={'logging': {'file': '/var/log/app.log'}})\n"
          "assert cfg2['logging']['file'] == '/var/log/app.log'"),
        t("回归：深层嵌套合并与默认值保留",
          "from config_loader import load, effective_port\nfrom merge import deep_merge\n"
          "cfg = load()\n"
          "assert cfg['server']['host'] == '0.0.0.0'\n"
          "assert effective_port(cfg) == 8080\n"
          "assert deep_merge({'a': {'b': 1}}, {'a': {'c': 2}}) == {'a': {'b': 1, 'c': 2}}"),
    ],
    keywords=["None", "sentinel", "覆盖", "深合并"],
    failing_output="""FAILED test_none_override
  AssertionError: cert='/etc/cert.pem'
  # 用 env={'server': {'tls': {'cert': None}}} 显式把 cert 置空，
  # 合并后拿到的仍是默认值 '/etc/cert.pem'，该项无法被覆盖。
  # 注意 logging.file 的默认值本身就是 None，两者都走同一条合并路径。""",
    api_files=["merge.deep_merge(base, override)", "merge.merge_chain(*layers)",
               "config_loader.load(profile=None, env=None)"],
)

# ============================================================
# 007 事件监听重复注册
# ============================================================
q(
    "L2P2-007", "listener_double_registration", "adversarial",
    "事件监听被重复注册",
    "定位回调被重复触发的原因并修复，同时保证幂等注册。",
    files=[
        {"path": "registry.py", "content": '''class Registry:
    """监听器注册表。"""

    def __init__(self):
        self._by_topic = {}

    def add(self, topic, fn):
        self._by_topic.setdefault(topic, []).append(fn)

    def get(self, topic):
        return list(self._by_topic.get(topic, []))

    def topics(self):
        return sorted(self._by_topic)
'''},
        {"path": "events.py", "content": '''from registry import Registry

_bus = Registry()
_dispatch_count = {}


def subscribe(topic, fn):
    """订阅主题。同一 (topic, fn) 重复订阅应当幂等。"""
    _bus.add(topic, fn)
    return len(_bus.get(topic))


def publish(topic, payload):
    for fn in _bus.get(topic):
        fn(payload)
    _dispatch_count[topic] = _dispatch_count.get(topic, 0) + 1
    return len(_bus.get(topic))


def counts():
    return dict(_dispatch_count)
'''},
        {"path": "lifecycle.py", "content": '''from events import subscribe


def on_user_created(fn):
    """装饰 + 注册（内部注册一次）。"""
    subscribe("user.created", fn)
    return fn


def bootstrap(handlers):
    """启动时批量注册处理器。"""
    for h in handlers:
        subscribe("user.created", h)
    return len(handlers)
'''},
        {"path": "plugins.py", "content": '''from lifecycle import on_user_created


@on_user_created
def send_welcome(event):
    send_welcome.calls = getattr(send_welcome, "calls", 0) + 1


@on_user_created
def audit_log(event):
    audit_log.calls = getattr(audit_log, "calls", 0) + 1


def handlers():
    return [send_welcome, audit_log]
'''},
        {"path": "decorators.py", "content": '''def once(fn):
    """让函数只执行一次的装饰器（与本次缺陷无关）。"""

    def wrapper(*a, **kw):
        if getattr(wrapper, "done", False):
            return None
        wrapper.done = True
        return fn(*a, **kw)
    return wrapper
'''},
    ],
    tests=[
        t("主路径：同一处理器重复注册后只触发一次",
          "from events import publish, counts\nfrom plugins import handlers, send_welcome, audit_log\nfrom lifecycle import bootstrap\n"
          "bootstrap(handlers())\n"
          "publish('user.created', {'id': 1})\n"
          "assert send_welcome.calls == 1, f'send_welcome 被触发 {send_welcome.calls} 次'\n"
          "assert audit_log.calls == 1, f'audit_log 被触发 {audit_log.calls} 次'"),
        t("回归：不同处理器各触发一次、计数正确",
          "from events import publish, counts, subscribe\n"
          "calls = []\n"
          "subscribe('x.y', lambda e: calls.append('a'))\n"
          "subscribe('x.y', lambda e: calls.append('b'))\n"
          "publish('x.y', {})\n"
          "assert sorted(calls) == ['a', 'b'], calls\n"
          "assert counts()['x.y'] == 1"),
    ],
    keywords=["幂等", "去重", "重复注册", "idempotent"],
    failing_output="""FAILED test_no_double_dispatch
  AssertionError: send_welcome 被触发 2 次
  # 插件模块用 @on_user_created 装饰器注册了一次，
  # 启动时 bootstrap(handlers()) 又注册了一次，于是发布事件时每个处理器触发了两遍。""",
    api_files=["events.subscribe(topic, fn)", "events.publish(topic, payload)",
               "registry.Registry.add(self, topic, fn)", "lifecycle.bootstrap(handlers)"],
)

# ============================================================
# 008 批量写入部分失败后状态不一致
# ============================================================
q(
    "L2P2-008", "batch_partial_failure", "adversarial",
    "批量写入部分失败后状态不一致",
    "定位批量操作在中途失败后残留脏数据的原因并修复。",
    files=[
        {"path": "transaction.py", "content": '''class Txn:
    """极简事务上下文。"""

    def __init__(self, store):
        self.store = store
        self.staged = {}
        self.committed = False
        self.rolled_back = False

    def stage(self, key, value):
        self.staged[key] = value

    def commit(self):
        for k, v in self.staged.items():
            self.store[k] = v
        self.committed = True
        self.staged = {}
        return True

    def rollback(self):
        self.staged = {}
        self.rolled_back = True
        return True
'''},
        {"path": "dao.py", "content": '''class UserDao:
    def __init__(self, store):
        self.store = store
        self.writes = 0

    def put(self, key, value):
        if value.get("blocked"):
            raise ValueError("blocked user")
        self.store[key] = value
        self.writes += 1
        return key
'''},
        {"path": "batch.py", "content": '''from transaction import Txn
from dao import UserDao


def bulk_upsert(store, users, dao=None):
    """批量写入用户。任一条失败时，本次批量不得留下部分结果。

    返回 (成功条数, 失败条数)。
    """
    dao = dao or UserDao(store)
    txn = Txn(store)
    ok = fail = 0
    for u in users:
        try:
            dao.put(u["id"], u)
            txn.stage(u["id"], u)
            ok += 1
        except ValueError:
            fail += 1
    if fail:
        txn.rollback()
    else:
        txn.commit()
    return ok, fail
'''},
        {"path": "errors.py", "content": '''class BulkError(Exception):
    def __init__(self, ok, fail, failed_ids):
        super().__init__(f"bulk: ok={ok} fail={fail}")
        self.ok = ok
        self.fail = fail
        self.failed_ids = failed_ids
'''},
        {"path": "logging_setup.py", "content": '''import sys


def log(msg, stream=None):
    """日志输出（与本次缺陷无关）。"""
    (stream or sys.stdout).write(msg + "\\n")
    return msg
'''},
    ],
    tests=[
        t("主路径：中途失败时不得留下已写入的行",
          "from batch import bulk_upsert\n"
          "store = {}\n"
          "users = [{'id': 'a'}, {'id': 'b', 'blocked': True}, {'id': 'c'}]\n"
          "ok, fail = bulk_upsert(store, users)\n"
          "assert (ok, fail) == (2, 1), f'(ok,fail)=({ok},{fail})'\n"
          "assert store == {}, f'失败后残留了脏数据: {store}'"),
        t("回归：全部成功时正常落库",
          "from batch import bulk_upsert\n"
          "store = {}\n"
          "ok, fail = bulk_upsert(store, [{'id': 'a'}, {'id': 'b'}])\n"
          "assert (ok, fail) == (2, 0)\n"
          "assert set(store) == {'a', 'b'}, store"),
    ],
    keywords=["回滚", "原子", "脏数据", "rollback"],
    failing_output="""FAILED test_no_partial_write
  AssertionError: 失败后残留了脏数据: {'a': {'id': 'a'}, 'c': {'id': 'c'}}
  # 三条批量写入中第 2 条失败，期望一条都不落库，
  # 实际 a 和 c 都写进了 store（rollback 只清了暂存区，没有回滚已生效的写入）。""",
    api_files=["batch.bulk_upsert(store, users, dao=None)",
               "transaction.Txn.stage/rollback/commit", "dao.UserDao.put(self, key, value)"],
)

# ============================================================
# 009 鉴权中间件在特定路由顺序下失效
# ============================================================
q(
    "L2P2-009", "middleware_order_bypass", "adversarial",
    "鉴权在特定路由上被绕过",
    "定位为何部分受保护路由没有走鉴权，修复执行顺序。",
    files=[
        {"path": "auth.py", "content": '''class Unauthorized(Exception):
    pass


def verify(token):
    """校验令牌，返回用户或抛 Unauthorized。"""
    if token == "secret":
        return {"id": 1, "role": "admin"}
    raise Unauthorized("bad token")


def current_user(headers):
    return verify(headers.get("Authorization", ""))
'''},
        {"path": "router.py", "content": '''class Router:
    def __init__(self):
        self.routes = []
        self.public = set()

    def add(self, path, handler, public=False):
        self.routes.append((path, handler))
        if public:
            self.public.add(path)
        return len(self.routes)

    def match(self, path):
        for p, h in self.routes:
            if p == path:
                return h
        return None

    def is_public(self, path):
        return path in self.public
'''},
        {"path": "middleware.py", "content": '''from auth import current_user, Unauthorized
from router import Router


class App:
    def __init__(self):
        self.router = Router()
        self.guarded = []

    def register(self, path, handler, public=False):
        self.router.add(path, handler, public=public)
        if not public:
            self.guarded.append(path)

    def dispatch(self, path, headers):
        handler = self.router.match(path)
        if handler is None:
            return {"status": 404}
        # 缺陷：登记时存的是路径字符串，这里却拿处理函数的名字去查，
        # 两边类型对不上，于是所有受保护路由都查不中、鉴权被整体跳过。
        if getattr(handler, "__name__", None) in self.guarded:
            try:
                user = current_user(headers)
            except Unauthorized:
                return {"status": 401}
        return {"status": 200, "body": handler(headers), "user": None}
'''},
        {"path": "handlers.py", "content": '''def health(headers):
    return "ok"


def me(headers):
    return {"id": 1}


def admin_panel(headers):
    return {"panel": True}
'''},
        {"path": "decorators.py", "content": '''def route(path):
    """路径装饰器（与本次缺陷无关）。"""

    def deco(fn):
        fn.__route__ = path
        return fn
    return deco
'''},
    ],
    tests=[
        t("主路径：受保护路由在无令牌时必须 401",
          "from middleware import App\nfrom handlers import health, me, admin_panel\n"
          "app = App()\n"
          "app.register('/health', health, public=True)\n"
          "app.register('/me', me)\n"
          "app.register('/admin', admin_panel)\n"
          "assert app.dispatch('/health', {})['status'] == 200\n"
          "assert app.dispatch('/me', {})['status'] == 401, '/me 应受保护'\n"
          "assert app.dispatch('/admin', {})['status'] == 401, '/admin 应受保护'\n"
          "r = app.dispatch('/me', {'Authorization': 'secret'})\n"
          "assert r['status'] == 200, r"),
        t("回归：公开路由始终可访问",
          "from middleware import App\nfrom handlers import health\n"
          "app = App()\n"
          "app.register('/health', health, public=True)\n"
          "assert app.dispatch('/health', {})['status'] == 200\n"
          "assert app.dispatch('/nope', {})['status'] == 404"),
    ],
    keywords=["guarded", "顺序", "绕过", "鉴权"],
    failing_output="""FAILED test_protected_requires_auth
  AssertionError: /me 应受保护
  # 注册顺序为 /health(公开) → /me → /admin，
  # 但无令牌访问 /me 返回了 200，鉴权没有生效。""",
    api_files=["middleware.App.register(self, path, handler, public=False)",
               "middleware.App.dispatch(self, path, headers)",
               "router.Router.add(self, path, handler, public=False)", "auth.verify(token)"],
)

# ============================================================
# 010 序列化共享节点导致的数据丢失
# ============================================================
q(
    "L2P2-010", "serialize_shared_node", "adversarial",
    "共享节点序列化时被吞掉",
    "定位嵌套结构中共享节点在序列化时丢失的原因并修复。",
    files=[
        {"path": "graph.py", "content": '''class Node:
    def __init__(self, nid, children=None):
        self.nid = nid
        self.children = list(children or [])

    def add(self, child):
        self.children.append(child)
        return self


def walk(node, seen=None):
    """按深度优先遍历，返回节点 id 列表（重复引用只访问一次）。"""
    seen = set() if seen is None else seen
    if node.nid in seen:
        return []
    seen.add(node.nid)
    out = [node.nid]
    for c in node.children:
        out.extend(walk(c, seen))
    return out
'''},
        {"path": "serializer.py", "content": '''from graph import Node


def to_dict(node, seen=None):
    """把节点树序列化成 dict。"""
    seen = set() if seen is None else seen
    if node.nid in seen:
        # 缺陷：遇到已访问过的节点直接丢弃，连引用标记都不留，
        # 于是被多个父节点共享的子节点，除第一次外全部消失。
        return None
    seen.add(node.nid)
    children = [to_dict(c, seen) for c in node.children]
    return {"id": node.nid, "children": [c for c in children if c is not None]}


def dumps(node):
    return to_dict(node)
'''},
        {"path": "models.py", "content": '''from graph import Node


def build_tree():
    """构造一棵含共享子节点的树：root -> [a, b]，a 和 b 共享同一个 leaf。"""
    leaf = Node("leaf")
    a = Node("a", [leaf])
    b = Node("b", [leaf])
    root = Node("root", [a, b])
    return root, leaf
'''},
        {"path": "visitors.py", "content": '''def count_nodes(data):
    """统计序列化结果中的节点数（与本次缺陷无关）。"""
    if not isinstance(data, dict):
        return 0
    return 1 + sum(count_nodes(c) for c in data.get("children", []))
'''},
        {"path": "cache.py", "content": '''class MemoCache:
    """记忆化缓存（与本次缺陷无关）。"""

    def __init__(self):
        self._m = {}

    def get(self, k, fn):
        if k not in self._m:
            self._m[k] = fn()
        return self._m[k]
'''},
    ],
    tests=[
        t("主路径：共享子节点在两个父节点下都要出现",
          "from models import build_tree\nfrom serializer import dumps\n"
          "root, leaf = build_tree()\n"
          "d = dumps(root)\n"
          "a_children = d['children'][0]['children']\n"
          "b_children = d['children'][1]['children']\n"
          "assert len(a_children) == 1, f'a 下应有 1 个子节点，实际 {len(a_children)}'\n"
          "assert a_children[0]['id'] == 'leaf', a_children\n"
          "assert len(b_children) == 1, f'b 下应有 1 个子节点，实际 {len(b_children)}'\n"
          "assert b_children[0]['id'] == 'leaf', b_children"),
        t("回归：真正的环要被标记为引用而不是无限递归",
          "from graph import Node\nfrom serializer import dumps\nfrom visitors import count_nodes\n"
          "x = Node('x')\n"
          "y = Node('y', [x])\n"
          "x.add(y)\n"
          "d = dumps(x)\n"
          "assert d['id'] == 'x'\n"
          "assert count_nodes(d) <= 3, f'环应当收敛，实际节点数 {count_nodes(d)}'"),
    ],
    keywords=["seen", "共享", "副本", "深度优先"],
    failing_output="""FAILED test_shared_child_present
  AssertionError: b 下应有 1 个子节点，实际 0
  # root -> [a, b]，a 和 b 共享同一个 leaf 节点。
  # 序列化结果里 a 下面是 leaf，但 b 下面是空的——leaf 被当成"已访问过"吞掉了。""",
    api_files=["serializer.to_dict(node, seen=None)", "serializer.dumps(node)",
               "graph.walk(node, seen=None)", "models.build_tree()"],
)


def main():
    OUT.write_text(json.dumps(QUESTIONS, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"已产出 {len(QUESTIONS)} 道 v2 题 → {OUT}")
    for x in QUESTIONS:
        print(f"  {x['id']}  {x['category']}  ({x['difficulty']})")


if __name__ == "__main__":
    main()
