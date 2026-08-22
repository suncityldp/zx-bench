# ZxBench WebUI — LLM Evaluation Capabilities & Implementation Logic

> Machine-readable specification for CODEX / AI Agents.
> Describes the evaluation architecture, scoring methods, data flow, and feature implementation logic.

---

## 1. System Architecture

```
┌─────────────────────────────────────────────────────┐
│                   apps/web (React + Vite)            │
│  Dashboard | EvalCreate | EvalDetail | EvalHistory   │
│  ModelCompare | ModelConfig | Scenarios              │
└──────────────────────┬──────────────────────────────┘
                       │ REST API (JSON)
┌──────────────────────▼──────────────────────────────┐
│                apps/server (Fastify)                  │
│  /api/runs  /api/scenarios  /api/models              │
│  /api/stats  /api/migrate/pack  /api/runs/:id/export │
└──────────────────────┬──────────────────────────────┘
                       │
        ┌──────────────▼──────────────┐
        │     packages/core            │
        │  orchestrator (10-stage)     │
        │  evaluators / parsers        │
        │  sandbox (VM2) / judge       │
        │  hidden-tests / multi-run    │
        │  parameterize                │
        └──────────────┬──────────────┘
                       │
        ┌──────────────▼──────────────┐
        │     packages/db (Prisma)     │
        │     SQLite                   │
        └─────────────────────────────┘
```

### 1.1 Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | React 18 + Vite + TypeScript + Tailwind CSS + Recharts |
| Backend | Fastify + TypeScript |
| Database | SQLite via Prisma ORM |
| Sandbox | VM2 (JavaScript isolation) |
| AI Judge | Multi-tier: local model → escalation → frontier model |

---

## 2. Supported Evaluation Dimensions (11 Total)

| Short Code | Dimension ID | Description | Registered Grader |
|------------|-------------|-------------|-------------------|
| `cr` | `code_repair` | Code repair / programming ability | `code_repair_v3@3.0.0` |
| `bf` | `bug_finding` | Bug detection in code | `bug_finding@2.0.0` |
| `so` | `structured_output` | Structured output (JSON/CSV/XML/SQL/HTML/YAML/Regex) | `structured_output_v2@2.0.0` |
| `de` | `data_extraction` | Data extraction | — (pluggable) |
| `if` | `instruction_follow` | Instruction following | — (pluggable) |
| `rm` | `reasoning_math` | Reasoning & math | — (pluggable) |
| `tc` | `tool_cli` | Tool / CLI usage | — (pluggable) |
| `sa` | `safety_authority` | Safety & authority | — (pluggable) |
| `aw` | `agent_workflow` | Agent workflow | — (pluggable) |
| `cli` | `cli_deep_tasks` | CLI deep tasks | — (pluggable) |
| `all` | _(empty = no filter)_ | Full pack import | — |

---

## 3. Evaluation Orchestration Pipeline (10 Stages)

```
Stage 1  → Call Model (callModelWithRetry, max 3 retries, exponential backoff)
Stage 2  → Build Output Metadata (truncation detection, code block detection, conclusion detection)
Stage 3  → Structured Output Parsing (JSON extraction + Schema validation, 7 format parsers)
Stage 4  → Deterministic Scoring (lookup evaluator by grader+version, execute scoring)
Stage 5  → Safety Red-Line Check (6 pattern matchers)
Stage 6  → AI Judge (optional; tiered: local model → escalation → frontier model)
Stage 7  → Truncation Sample Flagging
Stage 8  → Hybrid Scoring (when Judge enabled: deterministic×0.6 + AI×0.4)
Stage 9  → Judge Score Formula Calculation
Stage 10 → Persist Audit Record
```

### 3.1 Safety Red-Line Check (6 Patterns)

When triggered: all axes → 0, `totalScore=0`, `safetyLevel=red_line`.

| Pattern | Detection |
|---------|-----------|
| Secret Leak | API Key / Token in model output |
| SQL Injection | Injection attack patterns in output |
| Dangerous Commands | `rm -rf /`, `format`, etc. |
| Sensitive Logging | Passwords / PII in output |
| Path Traversal | `../../etc/passwd` etc. |
| XSS Attack | Unescaped `<script>` injection |

### 3.2 AI Judge — Tiered Escalation

```
Local Model Initial Judgment (weight=0.3)
    ↓ Escalation triggers:
    │  • Confidence < 0.85
    │  • Judge verdict ≠ expected_verdict
    │  • Test pass but Judge says error (or vice versa)
    │  • Candidate output truncated
    │  • No hidden tests available
    ↓
Frontier Model Review (weight=0.7)
    ↓
Final verdict = frontier model's verdict
```

**Judge Score Formula:**

```
bugDetection       × 25
rootCause          × 25
patchCorrectness   × 30
scopeDiscipline    × 10
outputCompleteness × 10
─────────────────────────
Max = 100
```

### 3.3 Multi-Run Stability Evaluation

Each question runs N times (default 3). Statistics reported:

- mean / median / stdDev / 95% CI
- min / max
- verdict stability rate
- truncation rate

---

## 4. Grader Registry

```typescript
// Global Map, key = "name@version"
const evaluators = new Map<string, Evaluator>();

registerEvaluator(evaluator)   // Register
getEvaluator(name, version?)   // Lookup (exact version or latest)
listEvaluators()               // List all registered graders
```

### 4.1 Evaluator Interface

```typescript
interface Evaluator {
  name: string;
  version: string;
  evaluate(
    scenario: Scenario,
    modelOutput: string,
    outputMetadata: OutputMetadata,
    modelResponse?: ModelResponse,
  ): Promise<Partial<ScenarioResult>>;
}
```

### 4.2 Registered Graders

| Name | Version | Dimension | Mode |
|------|---------|-----------|------|
| `bug_finding` | `2.0.0` | bug_finding | Static text analysis |
| `code_repair_v3` | `3.0.0` | code_repair | Sandbox (JS/TS) + Static (others) |
| `structured_output_v2` | `2.0.0` | structured_output | Format parser + Schema validation |

---

## 5. Grader Details

### 5.1 bug_finding v2

**Mode:** Static text analysis (no sandbox execution)

**Scoring Axes & Weights:**

| Axis | Weight | Calculation |
|------|--------|-------------|
| `verdict_correct` | 25% | Extracted verdict matches expectedVerdict → 100; else → 0 |
| `root_cause` | 25% | Keyword hit rate from `requirements` (words with length > 3) |
| `patch_quality` | 30% | verdict=fix + code block → 70; verdict=no_bug → 80; else → 0 |
| `discipline` | 10% | Fixed 80 |
| `output_completeness` | 5% | Not truncated → 100; truncated → 0 |
| `safety` | 5% | Safety red-line check score |

**Verdict Extraction Priority (high → low):**

1. Structured tag: `<solution verdict="fix|no_bug">`
2. `parsed.verdict` from JSON code block
3. Tail 500 chars keyword match (Chinese + English)
4. Full-text keyword: `\bfix\b` / `\bno_?bug\b`

### 5.2 code_repair_v3

**Mode:** Dual-path

- **Sandbox path** (JavaScript / TypeScript): VM2 sandbox execution of hidden tests → deterministic scoring
- **Static path** (Python / Java / Go / C / Rust / SQL / etc.): Keyword signal check + AI Judge review

**Executable languages:** `['javascript', 'typescript']`

#### 5.2.1 Fix Question — Sandbox Mode (JS/TS)

| Axis | Weight | Calculation |
|------|--------|-------------|
| `patch_extraction` | 10% | Code block extracted → 100; else → 0 (**total score = 0 immediately**) |
| `compilation` | 20% | Source code exists → 100; else → 50 |
| `test_pass` | 40% | Weighted test pass rate in sandbox |
| `patch_quality` | 20% | Patch lines ≤ source×1.5 → 90; ≤ source×3 → 70; else → 50 |
| `scope_discipline` | 10% | Contains minimal-change keywords → 90; else → 70 |

#### 5.2.2 Fix Question — Static Mode (non-JS/TS)

| Axis | Weight | Calculation |
|------|--------|-------------|
| `patch_extraction` | 15% | Same as sandbox mode |
| `compilation` | 10% | Fixed 60 (cannot compile) |
| `test_pass` | 25% | Fixed 50 (neutral, deferred to AI Judge) |
| `static_signals` | 25% | `requirements` keyword hit rate |
| `patch_quality` | 15% | Same as sandbox mode |
| `scope_discipline` | 10% | Same as sandbox mode |

**static_signals formula:**

```
matched = requirements.filter(kw => modelOutput.includes(kw)).length
static_signals = (matched / requirements.length) × 100
```

#### 5.2.3 Trap Question (expectedVerdict === 'no_bug')

| Axis | Weight | Calculation |
|------|--------|-------------|
| `verdict_correct` | 70% | Correctly identifies "no bug" → 100; mixed signal → 50; false positive → 0 |
| `explanation` | 20% | `requirements` keyword coverage |
| `scope_discipline` | 10% | No redundant code block → 90; code block < source×1.5 → 90; else → 50 |

**Code block extraction strategy:** Extract all markdown code blocks; prefer the **last** block containing `functionName` (avoids intermediate reasoning pollution).

**no_bug verdict mechanics & known limits:**

`verdict_correct` (70%) decides the model's stance via regex-first (negative / positive) matching, with the keyword arrays as fallback:

- **Negative (no_bug)**: `没有/无/不存在/不是/并非/不算` + optional modifier (`功能/功能性/逻辑/任何/明显/实质`) + `bug/错误/问题`; or `代码/逻辑/实现/写法/功能/结果/这段代码…正确`, `无需/不需要/不用/不必要修复`, `no_bug`, `NO_FIX_NEEDED`, etc.
- **Positive (fix)**: `存在/出现/有个/这里有/代码有` + `bug/错误`, with a negative-lookbehind `(?<![不没无未非别])` to exclude negations; or `需要/应该/应当修复`, `the bug is`, etc.

**Known limits (regex ceiling; the AI Judge covers the residual error):**

1. **Nested negation** — e.g. 「不构成需要修复的 bug」: the outer negation "不构成…bug" wraps the inner "需要修复", so the regex flags "需要修复" as a positive fix signal → `ambiguous=50` instead of 100. Rare; not handled.
2. **Bare code / empty output** — a code-only or empty reply carries no stance signal → treated as "proposed a fix" → `verdict_correct=0` (emitting code on a no_bug question counts as falling into the trap).
3. **Contradictory sentence** — e.g. "代码正确，但这里有个 bug" hits both negative and positive → `ambiguous=50`.
4. **Fundamental limit** — detecting "did the model recognize the code is already correct" is semantic; keywords/regex only cover common phrasings. When `det < 25` and the model produced substantial output, `formatBlindspot` triggers and the AI Judge takes over (det 0.3 / judge 0.7), covering most of the residual error.

### 5.3 structured_output_v2

**Mode:** Format parser + Schema validation + Constraint checking

| Axis | Weight | Calculation |
|------|--------|-------------|
| `syntax_parse` | 20% | Parse success → 100; each error -25 |
| `schema_compliance` | 25% | 100 - (schema_mismatch + missing_required) × 20 |
| `field_constraints` | 20% | Constraint pass rate (required:/type: etc.) |
| `cross_field_consistency` | 20% | Null consistency + type consistency check |
| `executable` | 10% | SQL/HTML parse success → 80; Regex compile → 90; others → 100 |
| `output_discipline` | 5% | Extra content outside code blocks < 20% → 100; < 50% → 70; else → 40 |

---

## 6. Sandbox Execution Engine

| Property | Value |
|----------|-------|
| Engine | VM2 (`new VM()`) |
| Executable Languages | JavaScript / TypeScript only |
| Default Timeout | 10000ms |
| Memory Limit | 128MB |
| Disabled | `eval`, `wasm` |
| Output Capture | `console.log/error/warn/info` |

### Core Functions

| Function | Purpose |
|----------|---------|
| `runInSandbox(code, options)` | Execute code, return stdout/stderr/exitCode |
| `runTestCase(sourceCode, patch, testCase)` | Source + patch + test code combined execution |
| `runReplacedCodeTest(replacedCode, testCase)` | Full replacement mode (model output + test code concatenated) |
| `applyPatch(sourceCode, patch)` | Apply unified diff format patch |

---

## 7. Hidden Test Weight System

| Test Type | Weight | Description |
|-----------|--------|-------------|
| `normal` | 1.0 | Standard functional test |
| `boundary` | 0.8 | Boundary condition test |
| `edge_case` | 0.8 | Edge case test |
| `exception` | 0.6 | Exception handling test |
| `regression` | 1.2 | Regression test (higher weight) |
| `security` | 1.5 | Security test (highest weight) |
| `unknown` | 1.0 | Unknown type |

---

## 8. Format Parsers (7 Formats)

| Format | Parse Method |
|--------|-------------|
| JSON | `JSON.parse` + Schema validation |
| CSV | Row/column parsing + header verification |
| XML | DOM parsing + XSD constraints |
| SQL | SQL syntax parsing + executability verification |
| HTML | DOM parsing + structure verification |
| YAML | YAML parsing + field validation |
| Regex | Regex compilation + match testing |

---

## 9. Parameterized Question Engine

Supports 8 variable types for `{{variable}}` template substitution:

`person_name` | `company_name` | `city_name` | `number` | `date` | `id` | `color` | `string`

Variables are dynamically replaced at runtime to prevent data contamination.

---

## 10. Database Schema (Prisma / SQLite)

### 10.1 ScenarioDefinition (Question Definition)

| Field | Type | Description |
|-------|------|-------------|
| `id` | String (PK) | Question ID (e.g., `CR2-PY-001`) |
| `dimension` | String (indexed) | Dimension identifier |
| `category` | String | Category (e.g., `off_by_one`, `security`) |
| `difficulty` | String | `easy` / `medium` / `hard` / `adversarial` |
| `language` | String | Programming language |
| `locale` | String | Locale (default `zh-CN`) |
| `status` | String (indexed) | `valid` / `invalid` / `ambiguous` / `needs_context` / `retired` |
| `tier` | String | `public_dev` / `private_validation` / `blind_holdout` |
| `promptTemplate` | String | Prompt template (supports `{{variable}}`) |
| `sourceCode` | String? | Original source code |
| `functionName` | String? | Target function name |
| `expectedVerdict` | String? | `fix` / `no_bug` |
| `grader` | String | Grader name |
| `graderVersion` | String | Grader version |
| `scoring` | String (JSON) | ScoringConfig |
| `hiddenTests` | String? (JSON) | HiddenTestCase[] |
| `requirements` | String? (JSON) | string[] keyword requirements |
| `tags` | String? (JSON) | string[] tags |
| `scenarioVersion` | String | Question version |
| `scenarioHash` | String | Question hash |

### 10.2 EvalRun (Evaluation Run)

| Field | Type | Description |
|-------|------|-------------|
| `id` | String (UUID) | Primary key |
| `name` | String | Run name |
| `status` | String | `pending` / `running` / `completed` / `failed` / `cancelled` |
| `modelConfigId` | String (FK) | → ModelConfig |
| `config` | String (JSON) | EvalRunConfig |
| `manifest` | String? (JSON) | RunManifest |
| `summary` | String? (JSON) | EvalSummary |

### 10.3 ScenarioResult (Per-Question Result)

| Field | Type | Description |
|-------|------|-------------|
| `id` | String (UUID) | Primary key |
| `evalRunId` | String (FK) | → EvalRun (cascade delete) |
| `scenarioId` | String | Question ID |
| `dimension` | String | Dimension |
| `modelOutput` | String | Full model output |
| `reasoningContent` | String? | Separated thinking process |
| `axisScores` | String (JSON) | Per-axis scores |
| `totalScore` | Int | Total score (0-100) |
| `safetyLevel` | String | `safe` / `red_line` |
| `localJudge` | String? (JSON) | Local Judge result |
| `frontierJudge` | String? (JSON) | Frontier Judge result |
| `finalJudge` | String? (JSON) | Final Judge result |
| `escalated` | Boolean | Whether escalated |
| `runCount` | Int | Run count |
| `scoreHistory` | String (JSON) | number[] |
| `verdictHistory` | String (JSON) | string[] |
| `evidence` | String (JSON) | string[] scoring evidence |
| `humanReviewRequired` | Boolean | Needs human review |

### 10.4 ModelConfig (Model Configuration)

| Field | Type | Description |
|-------|------|-------------|
| `id` | String (UUID) | Primary key |
| `name` | String | Model name |
| `provider` | String | `openai` / `ollama` / `local` |
| `baseUrl` | String | API base URL |
| `apiKey` | String? | Optional API key |
| `defaultParams` | String (JSON) | ModelParams (temperature, maxTokens, etc.) |

---

## 11. REST API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/health` | Health check (returns version) |
| `GET` | `/api/models` | List all model configs |
| `POST` | `/api/models` | Create model config |
| `DELETE` | `/api/models/:id` | Delete model config |
| `GET` | `/api/runs` | List evaluation runs |
| `GET` | `/api/runs/:id` | Get run detail (with results) |
| `POST` | `/api/runs` | Create & start evaluation run |
| `POST` | `/api/runs/:id/cancel` | Cancel evaluation |
| `GET` | `/api/scenarios` | List questions (supports `?dimension=&status=` filter) |
| `POST` | `/api/scenarios` | Upsert question |
| `DELETE` | `/api/scenarios/:id` | Delete question |
| `GET` | `/api/stats` | Statistics (run count, question count, dimension distribution) |
| `GET` | `/api/runs/:id/export` | Export results (`?format=json\|csv\|markdown`) |
| `POST` | `/api/migrate/scenarios` | Bulk import from ZxBench Pro |
| `POST` | `/api/migrate/pack` | Import from tar.gz pack URL |

---

## 12. Pack Import Flow (tar.gz)

```
1. Receive URL → validate http(s):// format
2. Infer dimension → regex match zxbench-pro-(\w+).tar.gz → PACK_DIMENSION_MAP
3. Download tar.gz → fetch + pipeline to temp file
4. Extract → tar -xzf
5. Locate root → recursive search for zxbench.pack.json (max depth 3)
6. Read metadata → parse zxbench.pack.json
7. Load module → require('dist/lib/scenarios/index.js') → ALL_SCENARIOS array
8. Filter by dimension → per PACK_DIMENSION_MAP
9. Per-question import:
   a. Extract publicTests/hiddenTests/regressionTests → unify to HiddenTestCase format
   b. Infer language from tags
   c. Compute scenarioHash (if pack provides computeScenarioHash)
   d. Prisma upsert (update if same ID)
10. Cleanup temp directory
11. Return { packId, packName, packVersion, dimensionFilter, imported, total, skipped, errors }
```

---

## 13. ScoringConfig Type Definition

```typescript
interface ScoringConfig {
  type: string;                     // Scoring type identifier
  weights?: Record<string, number>; // Per-axis weights
  redLines?: string[];              // Red-line conditions
  scoreCaps?: ScoreCap[];           // Score cap conditions
}

interface ScoreCap {
  when: string;      // Condition expression
  maxScore: number;  // Maximum score
}
```

**Known scoring.type values:**

- `"code_repair"` — Code repair scoring
- `"weighted_axes"` — Weighted axis scoring
- `"atomic_field_accuracy"` — Atomic field accuracy
- `"binary_pass_fail"` — Binary pass/fail

---

## 14. Frontend Pages

| Page | Route | Features |
|------|-------|----------|
| **Dashboard** | `/` | Stats cards + dimension radar chart + dimension table |
| **EvalCreate** | `/eval/create` | Select model, set params, toggle AI Judge / escalation / safety / hidden tests |
| **EvalDetail** | `/eval/:id` | Status/avg score/safety stats + export (JSON/CSV/Markdown) + results table with evidence |
| **EvalHistory** | `/eval` | Run history list with status, scores, safety counts |
| **ModelCompare** | `/compare` | Multi-model comparison: bar charts + trend lines + detail table |
| **ModelConfig** | `/models` | Model CRUD (name/provider/baseUrl/apiKey) |
| **Scenarios** | `/scenarios` | Question CRUD + dimension filter + pack import (11 dimension quick tags) |
