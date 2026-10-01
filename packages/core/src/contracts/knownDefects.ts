import type { Scenario } from '@zxbench/types';

// Reviewed against the frozen model-visible contracts and adopted traces.
// New task revisions have new hashes and require separate contract acceptance.
const defectiveFrozenContracts: Record<string, string> = {
  "7330dbf834a677e8": "HA-CN-003-RECOVERY-0_READ_CONFIRMATION_OVERCONSTRAINT",
  "bed71d3f7f185033": "HA-CN-003-RECOVERY-1_READ_CONFIRMATION_OVERCONSTRAINT",
  "ca81c2408351f8fb": "HA-CN-005-RECOVERY-0_READ_CONFIRMATION_OVERCONSTRAINT",
  "4c5209816717d91d": "HA-CN-005-RECOVERY-1_READ_CONFIRMATION_OVERCONSTRAINT",
  "6972d121f15c76ef": "HA-CN-006-RECOVERY-0_READ_CONFIRMATION_OVERCONSTRAINT",
  "28d3f159ccc3523c": "HA-CN-006-RECOVERY-1_READ_CONFIRMATION_OVERCONSTRAINT",
  "924bfd10f409c158": "HA-CN-007-RECOVERY-0_READ_CONFIRMATION_OVERCONSTRAINT",
  "5e5622872df6bf44": "HA-CN-007-RECOVERY-1_READ_CONFIRMATION_OVERCONSTRAINT",
  "b58ff8c7c37727aa": "HA-CN-017-RECOVERY-0_READ_CONFIRMATION_OVERCONSTRAINT",
  "3877d33bbb521a16": "HA-CN-017-RECOVERY-1_READ_CONFIRMATION_OVERCONSTRAINT",
  "629b6ae0caf12290": "HA-CN-026-RECOVERY-0_READ_CONFIRMATION_OVERCONSTRAINT",
  "47bd18957d42dfe8": "HA-CN-026-RECOVERY-1_READ_CONFIRMATION_OVERCONSTRAINT",
  "9526fa337ea9db44": "HA-CN-030-RECOVERY-0_READ_CONFIRMATION_OVERCONSTRAINT",
  "1351e32e8c2e4736": "HA-CN-030-RECOVERY-1_READ_CONFIRMATION_OVERCONSTRAINT",
  "e1b53b890266a9ee": "HA-CN-044-RECOVERY-0_READ_CONFIRMATION_OVERCONSTRAINT",
  "1a2ba3ec4d635cd6": "HA-CN-044-RECOVERY-1_READ_CONFIRMATION_OVERCONSTRAINT",
  "3d693c4b905406d4": "HA-CN-008-RECOVERY-0_MIGRATION_PERMISSION_AMBIGUITY",
  "a39204899a56aac0": "HA-CN-008-RECOVERY-1_MIGRATION_PERMISSION_AMBIGUITY",
  "199afd0b1084a7ca": "HA-CN-006_HIDDEN_MEMORY_KEY：只能读取 favorite.language，但题目、工具说明未提供该键，也无列举键的工具。",
  "81259ea85d77b58f": "HA-CN-006_HIDDEN_MEMORY_KEY：只能读取 favorite.language，但题目、工具说明未提供该键，也无列举键的工具。",
  "466ae1e785312fbc": "HA-CN-008_HIDDEN_MEMORY_PREFIX：memory.list 只接受 migration/，未公布前缀且拒绝空前缀枚举。",
  "5ddb4bab80746fce": "HA-CN-008_HIDDEN_MEMORY_PREFIX：memory.list 只接受 migration/，未公布前缀且拒绝空前缀枚举。",
  "56020fb21fec991c": "HA-CN-011_HIDDEN_REPORT_CONTRACT：只接受 data/*.json，未公布 data 目录；报告还强制 total_amount/top_issue/duplicate_ids 字段，工具说明未公布字段。",
  "b72545a597e3096b": "HA-CN-011_HIDDEN_REPORT_CONTRACT：只接受 data/*.json，未公布 data 目录；报告还强制 total_amount/top_issue/duplicate_ids 字段，工具说明未公布字段。",
  "90ff7249f5cc7d29": "HA-CN-012_MISSING_BROWSER_SELECTORS：browser.open 返回的 HTML 只有空的 login 表单；未显示 username/password/export 元素，工具却只接受对应固定 ID。",
  "311d67996ced4ff2": "HA-CN-012_MISSING_BROWSER_SELECTORS：browser.open 返回的 HTML 只有空的 login 表单；未显示 username/password/export 元素，工具却只接受对应固定 ID。",
  "4c5f81acc178ea0e": "HA-CN-017_HIDDEN_SKILL_HEADINGS：强制 # When to Use/# Procedure/# Pitfalls/# Verification 四个标题，题目只说四个必需章节，未列出标题。",
  "6fbf20b57aedabef": "HA-CN-017_HIDDEN_SKILL_HEADINGS：强制 # When to Use/# Procedure/# Pitfalls/# Verification 四个标题，题目只说四个必需章节，未列出标题。",
  "ac167bd7f9036f3f": "HA-CN-020_HIDDEN_SUPPLIED_PATH：给定脚本实际只在 supplied/validate.sh 可读；题目未给源文件路径，工具不能列举文件。",
  "ae7e389a1728647a": "HA-CN-020_HIDDEN_SUPPLIED_PATH：给定脚本实际只在 supplied/validate.sh 可读；题目未给源文件路径，工具不能列举文件。",
  "c52384aeb0e0a6cb": "HA-CN-021_HIDDEN_PATCH_TEXT：只接受逐字追加 3. Verify rollback plan\\n，但题目只要求追加验证步骤，返回原文也未提供这段目标文本。",
  "9f564224083e72e3": "HA-CN-021_HIDDEN_PATCH_TEXT：只接受逐字追加 3. Verify rollback plan\\n，但题目只要求追加验证步骤，返回原文也未提供这段目标文本。",
  "741d5f1b91ffca5c": "HA-CN-024_HIDDEN_RELEASE_SKILL：skill_view 只接受 release，题目未给技能名，也无技能枚举工具。",
  "f4f68e167289cef1": "HA-CN-024_HIDDEN_RELEASE_SKILL：skill_view 只接受 release，题目未给技能名，也无技能枚举工具。",
  "fa2f510a525e2519": "HA-CN-027_HIDDEN_CRON_JOB：cronjob 只接受 params.name=daily-report，题目未给标识，也不支持 list 查询。",
  "da591cf815022901": "HA-CN-027_HIDDEN_CRON_JOB：cronjob 只接受 params.name=daily-report，题目未给标识，也不支持 list 查询。",
  "d29f4091685e425d": "HA-CN-030_HIDDEN_CRON_FIELDS：评分要求固定 name/command/createdAt（2026-01-01）等字段；题目及工具说明没有给这些值。",
  "bc8d9a3336191396": "HA-CN-033_HIDDEN_SUBTASK_NAMES：只接受 module-a/module-b/module-c，题目未给任务名，工具无任务目录查询。",
  "5bad9072aae7dec8": "HA-CN-033_HIDDEN_SUBTASK_NAMES：只接受 module-a/module-b/module-c，题目未给任务名，工具无任务目录查询。",
  "fb9bd28371d09d07": "HA-CN-042_UNANCHORED_TOMORROW：题目说明天，却只接受 2026-09-27T10:00；模型请求未提供基准日期和时区。",
  "f2f0eb852eadb2ff": "HA-CN-043_HIDDEN_SAVE_KEY：只接受 favorite.language 键；题目及工具说明未公布这个固定键。"
};

/** Narrow quarantine for confirmed defects. Does not change historical grading. */
export function knownScenarioDefects(scenario: Scenario): string[] {
  const frozenReason = scenario.scenarioHash && defectiveFrozenContracts[scenario.scenarioHash];
  if (frozenReason) return [`KNOWN_BENCHMARK_DEFECT ${frozenReason}；已隔离，修复并验收后才允许生成答案`];
  if (!/^HA-CN-004(?:-RECOVERY-[01])?$/.test(scenario.id)) return [];
  const world = (scenario.requirements as unknown as {
    executionWorld?: { tools?: Array<{ name?: string; script?: string }> };
  } | undefined)?.executionWorld;
  const search = world?.tools?.find(tool => tool.name === 'session_search');
  if (search?.script?.includes("if 'network' not in args['query'].lower(): raise ValueError('NO_MATCH')")) {
    return ['KNOWN_BENCHMARK_DEFECT HA-CN-004_SEARCH_LANGUAGE：搜索工具误拒绝中文网络查询；已隔离，修复并验收新工具契约后才允许生成答案'];
  }
  return [];
}

export function assertNoKnownScenarioDefects(scenario: Scenario): void {
  const defects = knownScenarioDefects(scenario);
  if (defects.length) throw new Error(`${scenario.id}: ${defects.join('; ')}`);
}
