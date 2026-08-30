#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
I7 · Level 2 pilot 题库构建（10 题）
====================================
目标：验证「多文件修复 + 测试驱动」类题目能否测出 ornith-1.5-35b 与 qwen3.6-35b-a3b
      在 Level 1（single-shot coding）上测不出的差异。

设计原则（与现有 223 道 Level 1 题的本质区别）：
  1. **单文件修不对**：修复点必然跨越 ≥2 个文件，只改一处测试必挂。
  2. **需要读代码定位**：bug 不是模式匹配能看出的（不是语法错误、不是明显拼写），
     而是「跨文件契约不一致 / 状态漂移 / 隐式依赖」。
  3. **测试驱动**：给出失败测试的输出，要求模型根据失败信息定位（Level 2 核心）。
  4. **梯度可判**：每道题 2 个测试脚本（主路径 + 回归），避免全对/全崩二元。

评分：沿用 projectRepair 的 BANK_WEIGHTS（与库内既有 project_repair 题一致，保证跨题可比）：
  test_pass .35 / api_stability .15 / static_signals .30 / output_completeness .10 / scope_discipline .10

运行：python build_l2_pilot_questions.py   → 产出 l2_pilot_questions.json（供落库脚本消费）
"""
import json
from pathlib import Path

OUT = Path(r"J:/AI/zxbench-webui/apps/server/src/scripts/l2_pilot_questions.json")

BANK_WEIGHTS = {
    "test_pass": 0.35,
    "api_stability": 0.15,
    "static_signals": 0.30,
    "output_completeness": 0.10,
    "scope_discipline": 0.10,
}

# 测试脚本通用骨架：把工作区目录加入 sys.path 后执行断言
PY_RUNNER = """import sys, json
sys.path.insert(0, '.')
{body}
print('OK')
"""


def t(name, body):
    """构造一个 hiddenTest：脚本退出码 0 视为 passed"""
    return {"description": name, "script": PY_RUNNER.format(body=body)}


QUESTIONS = []


def q(qid, category, difficulty, title, brief, files, tests, keywords,
      failing_output, function_name=None, tags=None):
    """组装一道 Level 2 题"""
    prompt = f"""你在一个已有的 Python 项目中工作。项目当前有一个缺陷，**测试是失败的**。

## 项目文件
{chr(10).join('- `' + f['path'] + '`' for f in files)}

## 失败现象（测试输出）
```
{failing_output}
```

## 你的任务
1. 根据失败现象定位缺陷根因（注意：缺陷跨越多个文件，只修改一个文件无法修好）。
2. 修改**所有需要修改的文件**，输出完整的文件内容。
3. 必须保证：既修复缺陷，又不破坏现有接口（函数名、签名、返回值语义保持兼容）。

## 输出格式
对每个需要修改的文件，用如下格式输出**完整文件内容**（不是 diff、不是片段）：

```path: {files[0]['path']}
<该文件的完整内容>
```

{brief}

只输出需要修改的文件的完整内容，不要省略、不要写 "..." 占位、不要额外解释。"""

    QUESTIONS.append({
        "id": qid,
        "dimension": "program",
        "category": category,
        "difficulty": difficulty,
        "language": "python",
        "locale": "zh",
        "status": "active",
        "tier": "pilot",
        "promptTemplate": prompt,
        "sourceCode": json.dumps(files, ensure_ascii=False),
        "functionName": function_name,
        "expectedVerdict": "fix",
        "grader": "project_repair",
        "graderVersion": "1.1.0",
        "scoring": json.dumps({"type": "weighted_axes", "weights": BANK_WEIGHTS}, ensure_ascii=False),
        "hiddenTests": json.dumps(tests, ensure_ascii=False),
        "requirements": json.dumps({
            "files": files,
            "hiddenTestFiles": [],
            "hiddenTests": tests,
            "explanationKeywords": keywords,
            "image": "python:3.12-alpine",
        }, ensure_ascii=False),
        "tags": json.dumps(["L2", "multi_file", "pilot"] + (tags or []), ensure_ascii=False),
        "scenarioVersion": "1.0.0",
        "scenarioHash": f"l2pilot-{qid.lower()}",
        "responseMode": "raw_output",
        "reviewStatus": "pilot",
        "answerFirst": 1,
    })


# ============================================================
# 001 跨文件常量漂移：三处硬编码不一致
# ============================================================
q(
    "L2-PILOT-001", "multi_file_constant_drift", "medium",
    "跨文件常量漂移",
    "提示：同一个业务上限被硬编码在多处，且值不一致。",
    files=[
        {"path": "config.py", "content": '''MAX_RETRIES = 3
TIMEOUT_SEC = 30
BATCH_LIMIT = 100
'''},
        {"path": "client.py", "content": '''from config import TIMEOUT_SEC

# 局部硬编码：与 config.MAX_RETRIES 漂移
LOCAL_RETRY_CAP = 5


def send(payload, attempts=0):
    """返回 (ok, attempts_used)。超过重试上限即放弃。"""
    while attempts < LOCAL_RETRY_CAP:
        attempts += 1
        if payload.get("ok"):
            return True, attempts
    return False, attempts
'''},
        {"path": "pipeline.py", "content": '''from config import BATCH_LIMIT, MAX_RETRIES
from client import send


def run(items):
    """分批发送，每批最多 BATCH_LIMIT 个。

    返回 (sent_count, failed_count)。
    """
    sent = failed = 0
    for i in range(0, len(items), BATCH_LIMIT):
        batch = items[i:i + BATCH_LIMIT]
        for it in batch:
            ok, _ = send(it)
            if ok:
                sent += 1
            else:
                failed += 1
    return sent, failed


def retry_cap():
    """对外暴露全局重试上限，供监控与 client 对齐。"""
    return MAX_RETRIES
'''}],
    tests=[
        t("主路径：重试次数遵循全局配置",
          "from config import MAX_RETRIES\nfrom client import send\nfrom pipeline import retry_cap\n"
          "ok, used = send({'ok': False})\n"
          "assert used == MAX_RETRIES, f'retries {used} != config {MAX_RETRIES}'\n"
          "assert retry_cap() == MAX_RETRIES, 'pipeline 暴露的上限应等于全局配置'\n"
          "assert ok is False"),
        t("回归：分批逻辑不受影响",
          "from pipeline import run\n"
          "sent, failed = run([{'ok': True}] * 7 + [{'ok': False}] * 2)\n"
          "assert sent == 7 and failed == 2, f'got {sent}/{failed}'"),
    ],
    keywords=["MAX_RETRIES", "config", "一致", "LOCAL_RETRY_CAP"],
    failing_output="""FAILED test_retry_boundary
  AssertionError: retries 5 != config 3
  # client.py 里的 LOCAL_RETRY_CAP = 5 与 config.MAX_RETRIES = 3 漂移，
  # 导致重试行为与全局配置不一致（pipeline 暴露的上限与 client 实际行为也对不上）。""",
    tags=["constant_drift", "config"],
)

# ============================================================
# 002 接口签名变更未同步调用方
# ============================================================
q(
    "L2-PILOT-002", "cross_file_signature_drift", "medium",
    "接口签名变更未同步",
    "提示：底层函数已改为返回结构，但上层仍按旧结构解包。",
    files=[
        {"path": "store.py", "content": '''_data = {}


def put(key, value):
    """写入并返回 (key, old_value, new_value)。old_value 不存在时为 None。"""
    old = _data.get(key)
    _data[key] = value
    return key, old, value


def get(key):
    return _data.get(key)
'''},
        {"path": "service.py", "content": '''from store import put, get


def upsert(key, value):
    """存在则更新并返回旧值；不存在则插入并返回 None。"""
    if get(key) is None:
        put(key, value)
        return None
    _, old, _ = put(key, value)
    return old
'''},
        {"path": "handlers.py", "content": '''from service import upsert


def handle_set(key, value):
    # 旧契约下 put 返回单个值；现在 put 返回三元组，这里没有同步
    old = upsert(key, value)
    return {"key": key, "previous": old, "current": value}
'''},
        {"path": "audit.py", "content": '''from store import put


def audit_write(key, value):
    # 这里仍按「返回二元组」的旧契约使用
    k, old = put(key, value)
    return {"changed": old != value, "old": old}
'''},
    ],
    tests=[
        t("主路径：更新能拿到旧值",
          "from handlers import handle_set\n"
          "handle_set('a', 1)\n"
          "r = handle_set('a', 2)\n"
          "assert r['previous'] == 1, f\"previous={r['previous']!r}\"\n"
          "assert r['current'] == 2"),
        t("回归：audit 不再因解包失败而抛错",
          "from audit import audit_write\n"
          "r = audit_write('b', 10)\n"
          "assert r['old'] is None and r['changed'] is True, r\n"
          "r2 = audit_write('b', 20)\n"
          "assert r2['old'] == 10, r2"),
    ],
    keywords=["put", "三元组", "解包", "契约"],
    failing_output="""FAILED test_upsert_old_value
  ValueError: too many values to unpack (expected 2)
    at audit.py:5  k, old = put(key, value)
  # store.put 已改为返回 (key, old, new)，但 audit.py 仍按二元组解包。
  # handlers/service 路径也依赖同一契约，需一并核对。""",
    tags=["signature_drift", "api_contract"],
)

# ============================================================
# 003 隐式初始化顺序导致的状态污染
# ============================================================
q(
    "L2-PILOT-003", "implicit_init_order", "hard",
    "模块初始化顺序导致的状态污染",
    "提示：两个模块各自持有同一份状态的副本，导入顺序决定了谁生效。",
    files=[
        {"path": "state.py", "content": '''registry = {}
_defaults = {"mode": "safe", "limit": 10}


def init(**overrides):
    # 缺陷：重新绑定了模块级名字，而非原地更新。
    # 任何在 init 之前就持有 registry 引用的模块，会永远停在旧的空字典上。
    merged = dict(_defaults)
    merged.update(overrides)
    registry = merged
    return registry


def snapshot():
    return dict(registry)
'''},
        {"path": "worker.py", "content": '''from state import registry, snapshot


def describe():
    # 直接引用 registry 对象；若 state.init 用了 clear()+update() 则同一对象被复用，
    # 但若调用方持有旧引用就会看到过期数据
    return {"mode": registry.get("mode"), "limit": registry.get("limit")}


def current_snapshot():
    return snapshot()
'''},
        {"path": "bootstrap.py", "content": '''import state
from worker import describe, current_snapshot

# 这里在 init 之前就 import 了 worker，worker 拿到的 registry 引用是 init 前的空字典对象
_config = state.init(mode="fast", limit=99)


def report():
    return {"describe": describe(), "snapshot": current_snapshot()}
'''},
    ],
    tests=[
        t("主路径：初始化后各视图一致",
          "import bootstrap\n"
          "r = bootstrap.report()\n"
          "assert r['describe']['mode'] == 'fast', r\n"
          "assert r['describe']['limit'] == 99, r\n"
          "assert r['snapshot'] == r['describe'], r"),
        t("回归：重复 init 不会留下脏状态",
          "import state, bootstrap\n"
          "state.init(mode='safe', limit=5)\n"
          "r = bootstrap.report()\n"
          "assert r['describe']['limit'] == 5, r\n"
          "assert set(r['snapshot']) == {'mode', 'limit'}, r"),
    ],
    keywords=["registry", "init", "初始化", "顺序"],
    failing_output="""FAILED test_bootstrap_consistency
  AssertionError: describe={'mode': None, 'limit': None} != snapshot={'mode': 'fast', 'limit': 99}
  # worker 持有的是 init 之前的空 registry 引用；describe() 读到空值，
  # 而 snapshot() 走函数调用拿到新值——同一状态两个视图不一致。""",
    tags=["init_order", "shared_state"],
)

# ============================================================
# 004 中间层吞异常 + 上层默认值掩盖
# ============================================================
q(
    "L2-PILOT-004", "swallowed_exception", "hard",
    "中间层吞掉异常、上层用默认值掩盖",
    "提示：错误被中途捕获并返回默认值，导致调用方无法区分「真的为空」和「出错了」。",
    files=[
        {"path": "parser.py", "content": '''def parse_int(raw):
    """严格解析整数，非法输入抛 ValueError。"""
    return int(raw)
'''},
        {"path": "loader.py", "content": '''from parser import parse_int


def load_value(raw):
    # 吞掉异常并返回 None，调用方无法区分「空值」和「解析失败」
    try:
        return parse_int(raw)
    except Exception:
        return None
'''},
        {"path": "aggregate.py", "content": '''from loader import load_value


def total(raws):
    """求和；遇到无法解析的项应向上报错，而不是静默按 0 处理。"""
    s = 0
    for r in raws:
        v = load_value(r)
        if v is None:
            continue
        s += v
    return s
'''},
    ],
    tests=[
        t("主路径：非法输入必须向上报错",
          "from aggregate import total\n"
          "try:\n"
          "    total(['1', 'abc', '3'])\n"
          "except ValueError:\n"
          "    pass\n"
          "else:\n"
          "    raise AssertionError('expected ValueError for invalid input')"),
        t("回归：合法输入正常求和",
          "from aggregate import total\n"
          "assert total(['1', '2', '3']) == 6\n"
          "assert total([]) == 0"),
    ],
    keywords=["raise", "ValueError", "异常", "不要吞"],
    failing_output="""FAILED test_invalid_input_raises
  AssertionError: expected ValueError for invalid input
  # total(['1','abc','3']) 返回 4，把 'abc' 静默当 0 处理。
  # 根因：loader.load_value 捕获了 parse_int 的 ValueError 并返回 None，
  # aggregate.total 又把 None 当作「跳过」，错误被完全吞掉。""",
    tags=["error_handling", "exception"],
)

# ============================================================
# 005 缓存键构造不一致（写入与读取用不同 key）
# ============================================================
q(
    "L2-PILOT-005", "cache_key_mismatch", "hard",
    "缓存键构造不一致",
    "提示：写入缓存和读取缓存用了两套键构造逻辑，参数顺序敏感。",
    files=[
        {"path": "keys.py", "content": '''def make_key(namespace, *parts):
    """规范：namespace 在前，其余部分按 '_' 连接。"""
    return namespace + ":" + "_".join(str(p) for p in parts)
'''},
        {"path": "cache.py", "content": '''_store = {}


def set_value(key, value):
    _store[key] = value


def get_value(key, default=None):
    return _store.get(key, default)
'''},
        {"path": "service.py", "content": '''from cache import set_value, get_value


def expensive(user_id, region):
    # 写入时按 (namespace, user_id, region)
    k = "user:" + str(user_id) + "_" + str(region)
    hit = get_value(k)
    if hit is not None:
        return hit
    v = {"user": user_id, "region": region, "score": user_id * 2}
    set_value(k, v)
    return v
'''},
        {"path": "facade.py", "content": '''from cache import get_value
from service import expensive


def lookup(user_id, region):
    # 读取时按 (namespace, region, user_id) —— 参数顺序与写入相反，永远读不到
    k = "user:" + str(region) + "_" + str(user_id)
    cached = get_value(k)
    if cached is not None:
        return dict(cached, hit=True)
    return dict(expensive(user_id, region), hit=False)
'''},
    ],
    tests=[
        t("主路径：第二次查询命中缓存",
          "from facade import lookup\n"
          "r1 = lookup(7, 'cn')\n"
          "r2 = lookup(7, 'cn')\n"
          "assert r1['hit'] is False, r1\n"
          "assert r2['hit'] is True, r2"),
        t("回归：不同参数不串味",
          "from facade import lookup\n"
          "a = lookup(1, 'cn')\n"
          "b = lookup(2, 'us')\n"
          "assert a['user'] == 1 and a['region'] == 'cn', a\n"
          "assert b['user'] == 2 and b['region'] == 'us', b"),
    ],
    keywords=["key", "缓存", "顺序", "一致"],
    failing_output="""FAILED test_cache_hit
  AssertionError: expected cache hit on second lookup, got hit=False
  # service.expensive 用 key="user:{user_id}_{region}" 写入，
  # facade.lookup 用 key="user:{region}_{user_id}" 读取 —— 参数顺序相反，缓存永不命中。
  # keys.make_key 已是规范实现，应统一走它。""",
    tags=["caching", "key_construction"],
)

# ============================================================
# 006 并发共享可变状态（跨文件共用的全局）
# ============================================================
q(
    "L2-PILOT-006", "shared_mutable_state", "hard",
    "跨文件共享的可变状态",
    "提示：默认参数/模块级变量被就地修改，污染后续调用。",
    files=[
        {"path": "collector.py", "content": '''_buffer = []


def reset():
    _buffer.clear()


def collect(item):
    _buffer.append(item)
    return len(_buffer)


def drain():
    out = _buffer
    # 注意：这里返回的是内部列表本身，调用方就地修改会污染 collector
    return out
'''},
        {"path": "report.py", "content": '''from collector import collect, drain, reset


def build_report(items):
    reset()
    for it in items:
        collect(it)
    rows = drain()
    rows.append("__footer__")
    return {"count": len(rows) - 1, "rows": rows}
'''},
        {"path": "summary.py", "content": '''from collector import collect, drain, reset


def summarize(items):
    reset()
    for it in items:
        collect(it)
    rows = drain()
    return {"total": len(rows)}
'''}],
    tests=[
        t("主路径：一次流程结束后状态干净",
          "from report import build_report\n"
          "from summary import summarize\n"
          "r = build_report(['a', 'b'])\n"
          "assert r['count'] == 2, r\n"
          "s = summarize(['x', 'y', 'z'])\n"
          "assert s['total'] == 3, s"),
        t("回归：drain 返回副本，调用方修改不污染",
          "from collector import collect, drain, reset\n"
          "reset(); collect('a'); collect('b')\n"
          "a = drain()\n"
          "a.append('polluted')\n"
          "b = drain()\n"
          "assert b == ['a', 'b'], f'collector polluted: {b}'"),
    ],
    keywords=["副本", "list()", "共享", "污染"],
    failing_output="""FAILED test_state_isolation
  AssertionError: summarize returned total=4, expected 3
  # report.build_report 对 drain() 返回的**内部列表**就地 append('__footer__')，
  # 该列表就是 collector._buffer 本身，污染了模块级状态，
  # 后续 summarize 在同一 buffer 上继续累积。""",
    tags=["mutable_state", "aliasing"],
)

# ============================================================
# 007 工具函数里的边界错误（off-by-one）
# ============================================================
q(
    "L2-PILOT-007", "cross_file_off_by_one", "medium",
    "工具函数中的边界错误",
    "提示：主流程逻辑正确，错在被多个调用方共用的工具函数里。",
    files=[
        {"path": "slicing.py", "content": '''def window(seq, start, size):
    """返回 [start, start+size) 的窗口；越界时截断到末尾（短于 size 也正常）。"""
    if start < 0:
        start = 0
    end = start + size
    if end > len(seq):
        # 缺陷：越界时本应在末尾截断、返回不足 size 的短窗口，
        # 这里却左移起点以保证窗口长度恒为 size —— 返回的是「另一段」数据。
        start = max(0, len(seq) - size)
        end = len(seq)
    return seq[start:end]
'''},
        {"path": "stats.py", "content": '''from slicing import window


def moving_average(series, size):
    """计算滑动平均，返回长度 = len(series) - size + 1 的列表。"""
    out = []
    for i in range(len(series) - size + 1):
        w = window(series, i, size)
        out.append(sum(w) / len(w))
    return out
'''},
        {"path": "detect.py", "content": '''from slicing import window


def find_spikes(series, size, threshold):
    """找出滑动窗口均值超过 threshold 的起始下标。"""
    hits = []
    for i in range(len(series) - size + 1):
        w = window(series, i, size)
        avg = sum(w) / len(w) if w else 0
        if avg > threshold:
            hits.append(i)
    return hits
'''},
    ],
    tests=[
        t("主路径：窗口长度严格等于 size",
          "from slicing import window\n"
          "assert window([1,2,3,4,5], 1, 3) == [2,3,4]\n"
          "assert len(window(list(range(10)), 8, 5)) == 2\n"
          "assert window([1,2,3], -5, 2) == [1,2]"),
        t("回归：滑动平均长度正确",
          "from stats import moving_average\n"
          "r = moving_average([1,2,3,4,5], 2)\n"
          "assert len(r) == 4, r\n"
          "assert r[0] == 1.5 and r[-1] == 4.5, r"),
    ],
    keywords=["window", "边界", "size", "截断"],
    failing_output="""FAILED test_window_bounds
  AssertionError: len(window(range(10), start=8, size=5)) == 2, got 5
  # slicing.window 的 end 越界截断失效：end 超过 len(seq) 时未收敛，
  # 导致返回长度大于剩余元素数（实际返回了整段）。
  # stats 与 detect 都依赖该函数，需保证修复后两者都不受影响。""",
    tags=["off_by_one", "bounds"],
)

# ============================================================
# 008 跨文件类型退化（精度丢失）
# ============================================================
q(
    "L2-PILOT-008", "type_degradation", "medium",
    "跨文件类型退化导致精度丢失",
    "提示：金额在跨文件传递中被降级为 float，求和出现精度误差。",
    files=[
        {"path": "money.py", "content": '''def to_cents(amount):
    """把金额（元）转为整数分。"""
    # 缺陷：直接用浮点乘 100 后 int() 截断。
    # 0.29 * 100 == 28.999999999999996 → 截断后得到 28 分（少 1 分）。
    return int(float(amount) * 100)
'''},
        {"path": "cart.py", "content": '''from money import to_cents


def line_total(price, qty):
    """单价 × 数量，返回**以元为单位的 float**（历史遗留）。"""
    return float(price) * qty
'''},
        {"path": "invoice.py", "content": '''from decimal import Decimal
from money import to_cents
from cart import line_total


def total_cents(items):
    """items: [(price: Decimal|str, qty: int)]，返回合计（整数分）。"""
    acc = 0
    for price, qty in items:
        # cart.line_total 返回 float，精度在乘法时已经丢失
        acc += to_cents(line_total(price, qty))
    return acc
'''},
    ],
    tests=[
        t("主路径：0.29 类金额不得少算 1 分",
          "from decimal import Decimal\nfrom invoice import total_cents\n"
          "r = total_cents([(Decimal('0.29'), 1)])\n"
          "assert r == 29, f'got {r} (expected 29)'\n"
          "r2 = total_cents([(Decimal('0.10'), 1), (Decimal('0.20'), 1)])\n"
          "assert r2 == 30, f'got {r2}'\n"
          "r3 = total_cents([(Decimal('19.99'), 3)])\n"
          "assert r3 == 5997, f'got {r3}'"),
        t("回归：整数金额计算正常",
          "from decimal import Decimal\nfrom invoice import total_cents\nfrom cart import line_total\n"
          "assert total_cents([(Decimal('2.50'), 4)]) == 1000\n"
          "assert line_total(Decimal('3.00'), 3) == 9.0"),
    ],
    keywords=["Decimal", "精度", "float", "分", "四舍五入"],
    failing_output="""FAILED test_money_precision
  AssertionError: got 28, expected 29
  # to_cents(0.29) 得到 28 分：money.to_cents 用 int(float(amount) * 100)，
  # 而 0.29 * 100 == 28.999999999999996，int() 直接截断 → 少 1 分。
  # cart.line_total 又提前把 Decimal 降级为 float，放大了误差传播。
  # 应保持 Decimal 贯穿全程，或改用 round()/Decimal 量化后再取整。""",
    tags=["precision", "decimal"],
)

# ============================================================
# 009 循环依赖导致的半初始化
# ============================================================
q(
    "L2-PILOT-009", "circular_import", "hard",
    "循环依赖导致的半初始化",
    "提示：两个模块互相导入，导入期就读取了对方尚未定义的属性。",
    files=[
        {"path": "a_mod.py", "content": '''import b_mod

NAME = "a"
# 导入期就读取 b_mod 的属性；若 b_mod 尚未完成初始化则取不到
PEER = b_mod.NAME


def describe():
    return f"{NAME}<->{PEER}"
'''},
        {"path": "b_mod.py", "content": '''import a_mod

NAME = "b"
# 同样在导入期读取 a_mod 的属性
PEER = a_mod.NAME


def describe():
    return f"{NAME}<->{PEER}"
'''},
        {"path": "app.py", "content": '''import a_mod
import b_mod


def status():
    return {"a": a_mod.describe(), "b": b_mod.describe()}
'''}],
    tests=[
        t("主路径：两个模块都能拿到对方名字",
          "import app\n"
          "s = app.status()\n"
          "assert s['a'] == 'a<->b', s\n"
          "assert s['b'] == 'b<->a', s"),
        t("回归：单独导入任一模块也不报错",
          "import importlib, sys\n"
          "for m in ('a_mod', 'b_mod'):\n"
          "    sys.modules.pop(m, None)\n"
          "    mod = importlib.import_module(m)\n"
          "    assert mod.describe() in ('a<->b', 'b<->a'), mod.describe()"),
    ],
    keywords=["延迟", "导入", "循环", "函数内"],
    failing_output="""FAILED test_circular_import
  AttributeError: partially initialized module 'b_mod' has no attribute 'NAME'
    at a_mod.py:5  PEER = b_mod.NAME
  # a_mod 与 b_mod 互相 import，且在模块导入期就读取对方属性。
  # 无论从哪一侧先导入，另一侧都处于「半初始化」状态，属性尚不存在。""",
    tags=["circular_import", "init"],
)

# ============================================================
# 010 跨文件资源未释放
# ============================================================
q(
    "L2-PILOT-010", "resource_leak_cross_file", "hard",
    "跨文件资源未释放",
    "提示：资源在一个文件里打开、在另一个文件里使用，两处都没有负责关闭。",
    files=[
        {"path": "opener.py", "content": '''_opened = []


def open_many(paths):
    handles = []
    for p in paths:
        h = open(p, "w", encoding="utf-8")
        _opened.append(h)
        handles.append(h)
    return handles


def pending():
    return len([h for h in _opened if not h.closed])
'''},
        {"path": "writer.py", "content": '''from opener import open_many, pending


def write_all(paths, content):
    hs = open_many(paths)
    for h in hs:
        h.write(content)
    # 既没有 flush 也没有 close，调用方也拿不到句柄
    return pending()
'''},
        {"path": "job.py", "content": '''from writer import write_all


def run_job(paths, content):
    leaked = write_all(paths, content)
    return {"written": len(paths), "still_open": leaked}
'''}],
    tests=[
        t("主路径：写完后无句柄泄漏",
          "import tempfile, os\nfrom job import run_job\n"
          "d = tempfile.mkdtemp()\n"
          "ps = [os.path.join(d, f'f{i}.txt') for i in range(3)]\n"
          "r = run_job(ps, 'hello')\n"
          "assert r['still_open'] == 0, r\n"
          "assert all(open(p).read() == 'hello' for p in ps)"),
        t("回归：内容确实落盘",
          "import tempfile, os\nfrom job import run_job\n"
          "d = tempfile.mkdtemp()\n"
          "p = os.path.join(d, 'x.txt')\n"
          "run_job([p], 'data')\n"
          "assert open(p).read() == 'data'"),
    ],
    keywords=["close", "with", "释放", "flush"],
    failing_output="""FAILED test_no_leak
  AssertionError: still_open=3, expected 0
  WARNING ResourceWarning: unclosed file
  # opener.open_many 打开句柄后交给 writer.write_all，writer 只写不关，
  # job.run_job 也拿不到句柄 —— 三方都没有关闭职责，且未 flush 导致内容可能未落盘。""",
    tags=["resource_leak", "lifecycle"],
)


def main():
    OUT.write_text(json.dumps(QUESTIONS, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"已产出 {len(QUESTIONS)} 道 Level 2 pilot 题 → {OUT}")
    for x in QUESTIONS:
        print(f"  {x['id']}  {x['category']}  ({x['difficulty']})")


if __name__ == "__main__":
    main()
