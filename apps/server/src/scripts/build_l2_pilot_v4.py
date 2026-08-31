#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
I7 · L2 pilot v4 —— 第三轮难度升级（调用链深度 + 线索削减）
============================================================
v3 现状：rubric 落地（5~6 测试点/题），但 ornith 仍有 8/10 题 test_pass=100。
v4 三个新杠杆（复用 v3 的 rubric 框架与矩阵验证）：

1. 线索削减到底：failing_output 只给「测试名 + 异常类型/最后一行」，
   不给任何数值细节、不给任何"哪个模块可疑"的暗示。v3 还写着
   "Flaky 抛出的是 ConnectionReset"，v4 连这类信息都删掉。
2. 调用链加深：缺陷埋在 2~3 层调用之外——现象在入口（A 调 B 调 C，
   缺陷在 C），模型必须沿链路下钻而不是在入口文件里找。
3. 非功能不变量进 rubric：L2/L4 测试点包含"异常路径资源不泄漏"、
   "比较函数传递性"这类需要推理才能构造反例的点。

契约不变：script 是 shell、输出走 parseFileBlocks、status=valid、
每题 rubric 5~6 点（L1/L2 原码必挂、L3/L4 原码必过）、gold 全过。
"""
import json
from pathlib import Path

OUT = Path(r"J:/AI/zxbench-webui/apps/server/src/scripts/l2_pilot_v4_questions.json")

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


def q(qid, category, difficulty, files, tests, keywords,
      failing_output, api_files):
    file_list = "\n".join(f"- `{f['path']}`" for f in files)
    api_note = "\n".join(f"- `{p}`" for p in api_files)
    prompt = f"""你在一个已有的 Python 项目中工作。项目的某个深层测试失败了。

## 项目文件（{len(files)} 个）
{file_list}

## 失败现象
```
{failing_output}
```

## 你的任务
找到根因并修复所有需要修改的文件——需要的就改，不需要的不要动
（数量由缺陷本身决定，不要为了凑数去改无关文件）。

## 硬性约束
1. **不得修改这些公开接口的签名**（函数名、参数列表、返回值类型保持兼容）：
{api_note}
2. 不得靠"删掉调用方"或"把断言改掉"来让测试通过。
3. 修复不得引入新的全局状态。

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
- 不要省略、不要用 "..." 占位；保持简洁。"""

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
        "tags": json.dumps(["L2", "multi_file", "pilot_v4", "deep_call_chain"], ensure_ascii=False),
        "scenarioVersion": "4.0.0",
        "scenarioHash": f"l2pilotv4-{qid.lower()}",
        "responseMode": "raw_output",
        "reviewStatus": "pilot",
        "answerFirst": 1,
    })


# ============================================================
# 001 连接池在异常路径泄漏（现象在池统计，缺陷在包装器的 finally 缺失）
# ============================================================
q(
    "L2P2-011", "pool_leak_exception_path", "adversarial",
    files=[
        {"path": "pool.py", "content": '''import itertools

_lock_ids = itertools.count(1)


class PooledConnection:
    def __init__(self, pool):
        self._pool = pool
        self.cid = next(_lock_ids)
        self.closed = False

    def close(self):
        if not self.closed:
            self.closed = True
            self._pool._release(self)


class ConnectionPool:
    """固定大小连接池。"""

    def __init__(self, size=2):
        self.size = size
        self._in_use = []
        self._idle = [PooledConnection(self) for _ in range(size)]
        self._created = size

    @property
    def in_use_count(self):
        return len(self._in_use)

    @property
    def idle_count(self):
        return len(self._idle)

    def acquire(self):
        if self._idle:
            conn = self._idle.pop()
        elif self._created < self.size + 8:
            self._created += 1
            conn = PooledConnection(self)
        else:
            raise RuntimeError("pool exhausted")
        self._in_use.append(conn)
        return conn

    def _release(self, conn):
        if conn in self._in_use:
            self._in_use.remove(conn)
        self._idle.append(conn)
'''},
        {"path": "executor.py", "content": '''from pool import ConnectionPool

_pool = ConnectionPool(size=2)


def run_task(task_fn):
    """从池里取连接执行任务，无论成败都要归还连接。"""
    conn = _pool.acquire()
    result = task_fn(conn)
    conn.close()
    return result
'''},
        {"path": "tasks.py", "content": '''class TaskError(Exception):
    pass


def ok_task(conn):
    return "done"


def flaky_task(conn):
    raise TaskError("upstream hiccup")
'''},
        {"path": "service.py", "content": '''from executor import run_task
from tasks import ok_task, flaky_task, TaskError


def handle(requests):
    """逐个处理请求；单条失败不影响后续请求。返回 (ok数, fail数)。"""
    ok = fail = 0
    for r in requests:
        try:
            run_task(flaky_task if r == "bad" else ok_task)
            ok += 1
        except TaskError:
            fail += 1
    return ok, fail
'''},
        {"path": "metrics.py", "content": '''from executor import _pool


def pool_snapshot():
    return {"in_use": _pool.in_use_count, "idle": _pool.idle_count}
'''},
        {"path": "backoff.py", "content": '''import time


def retry(fn, attempts=3, base=0.0):
    """通用重试（与本次缺陷无关）。"""
    last = None
    for i in range(attempts):
        try:
            return fn(), i
        except Exception as e:
            last = e
    raise last
'''},
    ],
    tests=[
        t("[L1] 失败任务的连接必须归还（池不泄漏）",
          "from executor import run_task\nfrom tasks import flaky_task, TaskError\n"
          "for _ in range(5):\n"
          "    try:\n"
          "        run_task(flaky_task)\n"
          "    except TaskError:\n"
          "        pass\n"
          "from executor import _pool\n"
          "assert _pool.in_use_count == 0, f'泄漏 { _pool.in_use_count } 个连接'"),
        t("[L1] 连续混合任务后池统计归零",
          "from service import handle\n"
          "ok, fail = handle(['good', 'bad', 'good', 'bad', 'bad'])\n"
          "assert (ok, fail) == (2, 3), (ok, fail)\n"
          "from executor import _pool\n"
          "assert _pool.in_use_count == 0 and _pool.idle_count >= 2, ( _pool.in_use_count, _pool.idle_count)"),
        t("[L2] 复用的连接必须能再次 close 归还（closed 标志要重置）",
          "from executor import _pool\n"
          "c1 = _pool.acquire()\n"
          "c1.close()\n"
          "c2 = _pool.acquire()\n"
          "c2.close()\n"
          "assert _pool.in_use_count == 0, f'复用连接归还失效: in_use={_pool.in_use_count}'"),
        t("[L3] 异常消息不被吞掉（向上传播）",
          "from executor import run_task\nfrom tasks import flaky_task, TaskError\n"
          "try:\n"
          "    run_task(flaky_task)\n"
          "except TaskError as e:\n"
          "    assert 'upstream' in str(e), str(e)\n"
          "else:\n"
          "    raise AssertionError('TaskError 应向上传播')"),
        t("[L3] 成功任务正常返回",
          "from executor import run_task\nfrom tasks import ok_task\n"
          "assert run_task(ok_task) == 'done'"),
        t("[L4] 连接 close 幂等且归还后 idle 恢复",
          "from executor import _pool\n"
          "before = _pool.idle_count\n"
          "conn = _pool.acquire()\n"
          "assert _pool.idle_count == before - 1, (before, _pool.idle_count)\n"
          "conn.close()\n"
          "conn.close()  # 二次 close 不应重复归还\n"
          "assert _pool.idle_count == before, (before, _pool.idle_count)"),
    ],
    keywords=["finally", "归还", "泄漏", "异常路径"],
    failing_output="""FAILED test_pool_no_leak
  RuntimeError: pool exhausted
    at pool.py:44  raise RuntimeError("pool exhausted")
  # 连续提交若干个会失败的任务后，后续任何任务都无法取得连接。""",
    api_files=["pool.ConnectionPool.acquire(self)", "pool.PooledConnection.close(self)",
               "executor.run_task(task_fn)", "service.handle(requests)"],
)

# ============================================================
# 002 比较函数不满足传递性（排序结果依赖输入顺序）
# ============================================================
q(
    "L2P2-012", "sort_comparator_transitivity", "adversarial",
    files=[
        {"path": "compare.py", "content": '''def priority_cmp(a, b):
    """按 (紧急度, 权重) 排序：紧急度高者靠前；同紧急度权重小者靠前。

    返回负数表示 a 在前，正数表示 b 在前，0 表示相等。
    """
    if a["urgency"] != b["urgency"]:
        return b["urgency"] - a["urgency"]
    # 缺陷：权重接近时（差值绝对值 < 2）被视作相等，
    # 「接近」不满足传递性，排序结果随输入顺序漂移
    if abs(a["weight"] - b["weight"]) < 2:
        return 0
    return a["weight"] - b["weight"]
'''},
        {"path": "sorter.py", "content": '''from compare import priority_cmp
from functools import cmp_to_key


def order(items):
    """返回按优先级排好序的 id 列表（稳定排序）。"""
    return [it["id"] for it in sorted(items, key=cmp_to_key(priority_cmp))]
'''},
        {"path": "scheduler.py", "content": '''from sorter import order


def plan(jobs):
    """生成执行计划。相同 id 的任务只会出现一次。"""
    ids = order(jobs)
    assert len(ids) == len(set(ids)), "计划中出现重复任务"
    return ids
'''},
        {"path": "models.py", "content": '''def job(jid, urgency, weight):
    return {"id": jid, "urgency": urgency, "weight": weight}


def normalize(jobs):
    """把 job 字典按 id 去重（与本次缺陷无关）。"""
    return {j["id"]: j for j in jobs}
'''},
        {"path": "audit.py", "content": '''def log_plan(plan_ids):
    """记录计划（与本次缺陷无关）。"""
    return {"entries": len(plan_ids), "first": plan_ids[0] if plan_ids else None}
'''},
    ],
    tests=[
        t("[L1] 排序结果与输入顺序无关",
          "from sorter import order\nfrom models import job\n"
          "items = [job('a',1,5), job('b',1,4), job('c',1,3), job('d',1,2), job('e',1,1)]\n"
          "r1 = order(items)\n"
          "r2 = order(list(reversed(items)))\n"
          "assert r1 == r2, f'顺序相关:\\n  {r1}\\n  {r2}'"),
        t("[L1] 比较函数满足反对称与严格序（差 1 不得判等）",
          "from compare import priority_cmp\nfrom models import job\n"
          "x, y = job('x',1,1), job('y',1,2)\n"
          "assert priority_cmp(x, y) < 0, f'weight 差 1 被误判为相等: {priority_cmp(x, y)}'\n"
          "assert priority_cmp(y, x) > 0, '反对称性被破坏'"),
        t("[L3] 同权重不同紧急度仍按紧急度排",
          "from sorter import order\nfrom models import job\n"
          "items = [job('low',1,7), job('high',9,7)]\n"
          "assert order(items) == ['high', 'low'], order(items)"),
        t("[L3] 紧急度优先于权重",
          "from sorter import order\nfrom models import job\n"
          "items = [job('w1',2,1), job('w9',1,9)]\n"
          "assert order(items) == ['w1', 'w9'], order(items)"),
        t("[L4] 空列表与单元素列表安全",
          "from sorter import order\n"
          "assert order([]) == []\n"
          "assert order([{'id':'s','urgency':1,'weight':1}]) == ['s']"),
    ],
    keywords=["传递性", "比较器", "cmp", "排序"],
    failing_output="""FAILED test_plan_deterministic
  AssertionError: 计划中出现重复任务
  # 同一批任务，两次排序生成了顺序不同、内容不一致的计划。""",
    api_files=["compare.priority_cmp(a, b)", "sorter.order(items)", "scheduler.plan(jobs)"],
)

# ============================================================
# 003 月末日期计算跨月溢出
# ============================================================
q(
    "L2P2-013", "month_end_overflow", "adversarial",
    files=[
        {"path": "dates.py", "content": '''from datetime import date


def add_months(d, months):
    """把日期 d 增加 months 个月，日号不变；目标月没有该日号时取当月最后一天。"""
    y = d.year + (d.month - 1 + months) // 12
    m = (d.month - 1 + months) % 12 + 1
    # 缺陷：直接沿用原日号，1/31 + 1 个月会溢出报错
    return date(y, m, d.day)


def last_day_of_month(y, m):
    if m == 12:
        return 31
    return (date(y, m + 1, 1) - date(y, m, 1)).days
'''},
        {"path": "billing.py", "content": '''from dates import add_months
from datetime import date


def next_invoice_day(start, n=1):
    """生成第 n 期账单日。"""
    return add_months(start, n)


def schedule(start, n):
    """生成 n 期账单日列表。"""
    return [next_invoice_day(start, i) for i in range(1, n + 1)]
'''},
        {"path": "calendar_util.py", "content": '''def is_weekend(d):
    """周末判断（与本次缺陷无关）。"""
    return d.weekday() >= 5


def business_days_between(a, b):
    """工作日计数（与本次缺陷无关）。"""
    from datetime import timedelta
    days = 0
    cur = a
    while cur < b:
        if not is_weekend(cur):
            days += 1
        cur += timedelta(days=1)
    return days
'''},
        {"path": "formatters.py", "content": '''def iso(d):
    return d.isoformat()


def cn_date(d):
    return f"{d.year}年{d.month}月{d.day}日"
'''},
    ],
    tests=[
        t("[L1] 月末加一个月不溢出且收敛到月末",
          "from dates import add_months\nfrom datetime import date\n"
          "r = add_months(date(2026, 1, 31), 1)\n"
          "assert (r.year, r.month, r.day) == (2026, 2, 28), r"),
        t("[L1] 连续多月账单计划不抛异常",
          "from billing import schedule\nfrom datetime import date\n"
          "days = schedule(date(2026, 1, 31), 4)\n"
          "assert len(days) == 4, days\n"
          "assert [d.month for d in days] == [2, 3, 4, 5], days"),
        t("[L2] 目标月没有该日号时收敛到当月月末",
          "from dates import add_months\nfrom datetime import date\n"
          "r = add_months(date(2026, 3, 31), 1)\n"
          "assert (r.year, r.month, r.day) == (2026, 4, 30), r\n"
          "r2 = add_months(date(2026, 1, 31), 13)\n"
          "assert (r2.year, r2.month, r2.day) == (2027, 2, 28), r2"),
        t("[L3] 普通日期加月不变",
          "from dates import add_months\nfrom datetime import date\n"
          "assert add_months(date(2026, 3, 15), 2) == date(2026, 5, 15)"),
        t("[L4] last_day_of_month 正确",
          "from dates import last_day_of_month\n"
          "assert last_day_of_month(2026, 2) == 28\n"
          "assert last_day_of_month(2028, 2) == 29\n"
          "assert last_day_of_month(2026, 12) == 31"),
    ],
    keywords=["月末", "溢出", "clamp", "日号"],
    failing_output="""FAILED test_month_end_schedule
  ValueError: day is out of range for month
    at dates.py:9  return date(y, m, d.day)
  # 从 1 月 31 日开始生成 4 期月度账单日时直接抛错。""",
    api_files=["dates.add_months(d, months)", "billing.next_invoice_day(start, n=1)",
               "billing.schedule(start, n)", "dates.last_day_of_month(y, m)"],
)

# ============================================================
# 004 幂等键在重试时未复用（重复扣款）
# ============================================================
q(
    "L2P2-014", "idempotency_key_reuse", "adversarial",
    files=[
        {"path": "idempotency.py", "content": '''import uuid

_seen = {}


def make_key(operation, payload_id):
    """为一次操作生成幂等键：同 (operation, payload_id) 必须得到同一个键。"""
    k = f"{operation}:{payload_id}:{uuid.uuid4().hex[:8]}"
    _seen[k] = True
    return k
'''},
        {"path": "client.py", "content": '''from idempotency import make_key


class PaymentGateway:
    def __init__(self):
        self.settled = {}
        self.call_count = 0

    def charge(self, order_id, amount_cents, idem_key):
        """以幂等键扣款；同键重复调用只扣一次。"""
        self.call_count += 1
        if idem_key in self.settled:
            return self.settled[idem_key]
        self.settled[idem_key] = {"order": order_id, "amount": amount_cents}
        return self.settled[idem_key]
'''},
        {"path": "checkout.py", "content": '''from client import PaymentGateway
from idempotency import make_key

_gateway = PaymentGateway()


def pay(order_id, amount_cents, retries=0):
    """扣款；失败时重试。同一订单无论重试多少次只应扣一次款。"""
    for attempt in range(retries + 1):
        key = make_key("charge", order_id)
        try:
            return _gateway.charge(order_id, amount_cents, key)
        except Exception:
            if attempt == retries:
                raise
    return None
'''},
        {"path": "ledger.py", "content": '''class Ledger:
    """记账本（与本次缺陷无关）。"""

    def __init__(self):
        self.rows = []

    def add(self, order, amount):
        self.rows.append((order, amount))
        return len(self.rows)

    def total_by_order(self, order):
        return sum(a for o, a in self.rows if o == order)
'''},
        {"path": "notify.py", "content": '''def send_receipt(order_id, amount_cents):
    """发送回执（与本次缺陷无关）。"""
    return {"order": order_id, "amount": amount_cents}
'''},
    ],
    tests=[
        t("[L1] 重试场景同一订单只扣一次款",
          "from checkout import pay\nfrom client import PaymentGateway\n"
          "import checkout\n"
          "gw = PaymentGateway()\n"
          "class FlakyGW(PaymentGateway):\n"
          "    def __init__(self):\n"
          "        super().__init__(); self.n = 0\n"
          "    def charge(self, order_id, amount_cents, idem_key):\n"
          "        self.n += 1\n"
          "        if self.n == 1:\n"
          "            raise RuntimeError('transient')\n"
          "        return super().charge(order_id, amount_cents, idem_key)\n"
          "from idempotency import make_key\n"
          "k1 = make_key('charge', 'o1')\n"
          "k2 = make_key('charge', 'o1')\n"
          "assert k1 == k2, f'幂等键未复用:\\n  {k1}\\n  {k2}'"),
        t("[L1] 幂等键对相同 (操作, 订单) 稳定",
          "from idempotency import make_key\n"
          "keys = {make_key('charge', 'o9') for _ in range(5)}\n"
          "assert len(keys) == 1, f'生成 {len(keys)} 个不同键: {keys}'"),
        t("[L3] 不同订单的键必须不同",
          "from idempotency import make_key\n"
          "a = make_key('charge', 'o1')\n"
          "b = make_key('charge', 'o2')\n"
          "assert a != b, (a, b)"),
        t("[L3] 不同操作的键必须不同",
          "from idempotency import make_key\n"
          "a = make_key('charge', 'o1')\n"
          "b = make_key('refund', 'o1')\n"
          "assert a != b, (a, b)"),
        t("[L3] 正常路径扣款成功",
          "from client import PaymentGateway\n"
          "gw = PaymentGateway()\n"
          "r = gw.charge('oX', 500, 'k-manual-1')\n"
          "assert r['amount'] == 500, r"),
        t("[L4] make_key 含操作与订单标识（可读性不变量）",
          "from idempotency import make_key\n"
          "k = make_key('charge', 'o77')\n"
          "assert 'charge' in k and 'o77' in k, k"),
    ],
    keywords=["幂等键", "复用", "uuid", "稳定"],
    failing_output="""FAILED test_idempotent_retry
  AssertionError: 幂等键未复用
  # 同一订单两次生成扣款幂等键，得到的键不相同，
  # 网关会把重试当作一笔新交易处理（重复扣款）。""",
    api_files=["idempotency.make_key(operation, payload_id)",
               "client.PaymentGateway.charge(self, order_id, amount_cents, idem_key)",
               "checkout.pay(order_id, amount_cents, retries=0)"],
)

# ============================================================
# 005 functools.wraps 缺失导致注册表元数据丢失
# ============================================================
q(
    "L2P2-015", "decorator_metadata_loss", "adversarial",
    files=[
        {"path": "decorators.py", "content": '''import time


def timed(fn):
    """记录耗时的装饰器。"""

    def wrapper(*args, **kwargs):
        t0 = time.time()
        try:
            return fn(*args, **kwargs)
        finally:
            elapsed = time.time() - t0
            wrapper.last_elapsed = elapsed
    return wrapper
'''},
        {"path": "registry.py", "content": '''class HandlerRegistry:
    """按函数名注册处理器。"""

    def __init__(self):
        self._by_name = {}

    def register(self, fn):
        self._by_name[fn.__name__] = fn
        return fn

    def get(self, name):
        return self._by_name.get(name)

    def names(self):
        return sorted(self._by_name)
'''},
        {"path": "handlers.py", "content": '''from decorators import timed
from registry import HandlerRegistry

registry = HandlerRegistry()


@registry.register
@timed
def sync_user(payload):
    """同步用户。"""
    return {"op": "sync", "payload": payload}


@registry.register
@timed
def purge_cache(payload):
    """清缓存。"""
    return {"op": "purge", "payload": payload}
'''},
        {"path": "dispatcher.py", "content": '''from handlers import registry
from decorators import timed


def dispatch(op, payload):
    """按操作名分发。未知操作返回 None。"""
    fn = registry.get(op)
    if fn is None:
        return None
    return fn(payload)


def available_ops():
    return registry.names()
'''},
        {"path": "docs_gen.py", "content": '''import inspect


def describe(fn):
    """生成函数签名描述（用于文档，与本次缺陷相关的元数据来源）。"""
    sig = str(inspect.signature(fn))
    return {"name": fn.__name__, "signature": sig, "doc": (fn.__doc__ or "").strip()}
'''},
    ],
    tests=[
        t("[L1] 注册表用原函数名注册（装饰后名字不丢）",
          "from handlers import registry\n"
          "assert 'sync_user' in registry.names(), f'注册名: {registry.names()}'\n"
          "assert 'purge_cache' in registry.names(), f'注册名: {registry.names()}'"),
        t("[L1] 分发按业务操作名工作",
          "from dispatcher import dispatch\n"
          "r = dispatch('sync_user', {'id': 1})\n"
          "assert r is not None and r['op'] == 'sync', r"),
        t("[L2] 装饰后 __doc__ 与 __name__ 保留",
          "from dispatcher import dispatch\nfrom handlers import registry\n"
          "fn = registry.get('sync_user')\n"
          "assert fn.__name__ == 'sync_user', fn.__name__\n"
          "assert fn.__doc__ and '同步' in fn.__doc__, fn.__doc__"),
        t("[L3] 未知操作返回 None",
          "from dispatcher import dispatch\n"
          "assert dispatch('nope', {}) is None"),
        t("[L4] timed 记录耗时的副作用保留",
          "from dispatcher import dispatch, available_ops\n"
          "op = available_ops()[0]\n"
          "dispatch(op, {'id': 1})\n"
          "from handlers import registry\n"
          "fn = registry.get(op)\n"
          "assert getattr(fn, 'last_elapsed', None) is not None, 'timed 的计时副作用丢失'"),
    ],
    keywords=["wraps", "__name__", "元数据", "装饰器"],
    failing_output="""FAILED test_dispatch_by_name
  AssertionError: 注册名: ['wrapper', 'wrapper']
  # 两个不同的处理器注册到了同一个名字上，按业务操作名分发全部失败。""",
    api_files=["decorators.timed(fn)", "registry.HandlerRegistry.register(self, fn)",
               "dispatcher.dispatch(op, payload)", "dispatcher.available_ops()"],
)


def main():
    OUT.write_text(json.dumps(QUESTIONS, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"已产出 {len(QUESTIONS)} 道 v4 题 → {OUT}")
    for x in QUESTIONS:
        n = len(json.loads(x["requirements"])["hiddenTests"])
        print(f"  {x['id']}  {x['category']}  ({x['difficulty']})  测试点={n}")


if __name__ == "__main__":
    main()
