// ============================================================
// 结构化调用检测
// 只把可执行形态（function call / JSON tool call / tool tag）当成工具调用；
// “不要调用…”，示例和注释里的调用文本都不是 action evidence。
// ============================================================

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export interface StructuredToolCall {
  toolName: string;
  args: string;
  index: number;
  raw: string;
}

/** Extract actual callable forms while discarding negated/example mentions. */
export function getStructuredToolCalls(output: string): StructuredToolCall[] {
  const calls: StructuredToolCall[] = [];

  // Function / SDK call: `call get_weather(location="北京")` or `get_weather(...)`.
  const functionRe = /\b([A-Za-z_][\w.-]*)\s*\(([^()\n]*)\)/g;
  for (const match of output.matchAll(functionRe)) {
    const index = match.index ?? -1;
    if (index >= 0 && !isMentionOnly(output, index)) {
      calls.push({ toolName: match[1], args: match[2], index, raw: match[0] });
    }
  }

  // JSON-style tool call. The bounded object is intentional: nested JSON should use a
  // function form or a registered runner; a loose text scan would reintroduce false calls.
  const jsonRe = /["'](?:tool|tool_name|name)["']\s*:\s*["']([A-Za-z_][\w.-]*)["'](?:\s*,\s*["'](?:args|arguments|parameters)["']\s*:\s*(\{[^{}]*\}))?/g;
  for (const match of output.matchAll(jsonRe)) {
    const index = match.index ?? -1;
    if (index >= 0 && !isMentionOnly(output, index)) {
      calls.push({ toolName: match[1], args: match[2] ?? '', index, raw: match[0] });
    }
  }

  // XML-ish tool envelope used by several agent protocols: <tool name="x">key=value</tool>.
  const tagRe = /<tool(?:_call)?\b[^>]*\bname\s*=\s*["']([A-Za-z_][\w.-]*)["'][^>]*>([\s\S]*?)<\/tool(?:_call)?>/gi;
  for (const match of output.matchAll(tagRe)) {
    const index = match.index ?? -1;
    if (index >= 0 && !isMentionOnly(output, index)) {
      calls.push({ toolName: match[1], args: match[2], index, raw: match[0] });
    }
  }

  return calls.sort((a, b) => a.index - b.index);
}

export function findToolCalls(output: string, toolName: string): StructuredToolCall[] {
  const target = toolName.toLowerCase();
  return getStructuredToolCalls(output).filter((call) => call.toolName.toLowerCase() === target);
}

/** @returns first actionable call position; -1 means no actual call. */
export function findToolCallIndex(output: string, toolName: string): number {
  return findToolCalls(output, toolName)[0]?.index ?? -1;
}

export function findToolCall(output: string, toolName: string): boolean {
  return findToolCallIndex(output, toolName) !== -1;
}

/** Match a key/value inside one parsed tool call, never across prose or other calls. */
export function callHasParam(call: StructuredToolCall, key: string, value?: string): boolean {
  const args = call.args.toLowerCase();
  const k = escapeRe(key.toLowerCase());
  const keyRe = new RegExp(`["']?${k}["']?\\s*[:=]`);
  if (!keyRe.test(args)) return false;
  if (value === undefined || value === '') return true;
  const v = escapeRe(String(value).toLowerCase());
  return new RegExp(`["']?${k}["']?\\s*[:=]\\s*["']?${v}["']?\\s*(?:,|$|}\\s*$|\\]\\s*$)`).test(args);
}

export function findParamInToolCalls(output: string, toolName: string, key: string, value?: string): boolean {
  return findToolCalls(output, toolName).some((call) => callHasParam(call, key, value));
}

/** Backward-compatible generic helper; callers with a known tool must use findParamInToolCalls. */
export function findParam(output: string, key: string, value: string): boolean {
  return getStructuredToolCalls(output).some((call) => callHasParam(call, key, value));
}

export function callContainsPattern(call: StructuredToolCall, pattern: string): boolean {
  return call.args.toLowerCase().includes(pattern.toLowerCase());
}

function isMentionOnly(output: string, index: number): boolean {
  // Scope the check to the current clause. A refusal in a previous sentence must not
  // suppress a later call, while “不要调用 x()” and “示例 x()” are rejected.
  const boundary = Math.max(
    output.lastIndexOf('。', index), output.lastIndexOf('；', index), output.lastIndexOf('\n', index),
  );
  const prefix = output.slice(boundary + 1, index).trim();
  return /(?:不要|禁止|不应|不可|不能|无需|不需要)\s*(?:调用|使用|执行|运行)?\s*$/i.test(prefix)
    || /(?:示例|例如|比如|样例|example)\s*(?:为|：|:)?\s*(?:调用|call|使用)?\s*$/i.test(prefix)
    || /(?:注释|comment)\s*(?:为|：|:)?\s*$/i.test(prefix);
}
