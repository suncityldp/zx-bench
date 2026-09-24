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
  const parsedJsonSpans: Array<[number, number]> = [];

  // Agent traces may use a JSON action envelope instead of a `tool` field.
  // Parse only complete JSON (including fenced JSON), never a quoted example in prose.
  const jsonCandidates = [{ text: output.trim(), index: output.search(/\S/) }];
  for (const fenced of output.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)) {
    jsonCandidates.push({ text: fenced[1].trim(), index: (fenced.index ?? 0) + fenced[0].indexOf(fenced[1]) });
  }
  for (const candidate of jsonCandidates) {
    try {
      const root: unknown = JSON.parse(candidate.text);
      parsedJsonSpans.push([candidate.index, candidate.index + candidate.text.length]);
      const actions = Array.isArray(root) ? root :
        root && typeof root === 'object' && Array.isArray((root as { actions?: unknown }).actions)
          ? (root as { actions: unknown[] }).actions : [root];
      for (const action of actions) {
        if (!action || typeof action !== 'object') continue;
        const record = action as Record<string, unknown>;
        const toolName = record.action ?? record.tool ?? record.tool_name ?? record.name;
        if (typeof toolName !== 'string' || !/^[A-Za-z_][\w.-]*$/.test(toolName)) continue;
        const params = record.params ?? record.args ?? record.arguments ?? record.parameters;
        calls.push({ toolName, args: params == null ? '' : JSON.stringify(params), index: candidate.index, raw: candidate.text });
      }
    } catch { /* prose or incomplete JSON is not a tool call */ }
  }

  // Function / SDK call: `call get_weather(location="北京")` or `get_weather(...)`.
  const functionRe = /\b([A-Za-z_][\w.-]*)\s*\(([^()\n]*)\)/g;
  for (const match of output.matchAll(functionRe)) {
    const index = match.index ?? -1;
    if (index >= 0 && !parsedJsonSpans.some(([start, end]) => index >= start && index < end) && !isMentionOnly(output, index)) {
      calls.push({ toolName: match[1], args: match[2], index, raw: match[0] });
    }
  }

  // JSON-style tool call. The bounded object is intentional: nested JSON should use a
  // function form or a registered runner; a loose text scan would reintroduce false calls.
  const jsonRe = /["'](?:tool|tool_name|name)["']\s*:\s*["']([A-Za-z_][\w.-]*)["'](?:\s*,\s*["'](?:args|arguments|parameters)["']\s*:\s*(\{[^{}]*\}))?/g;
  for (const match of output.matchAll(jsonRe)) {
    const index = match.index ?? -1;
    if (index >= 0 && !parsedJsonSpans.some(([start, end]) => index >= start && index < end) && !isMentionOnly(output, index)) {
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
  const line = output.slice(output.lastIndexOf('\n', index) + 1, index).trim();
  if (/^(?:#|\/\/|--)\s*/.test(line)) return true;
  if (/(?:不执行(?:任何)?|不会执行|未执行|不调用(?:任何)?|未调用|不能调用|不要(?:再|手动)?调用|不要做|禁止(?:调用|用)|拒绝调用|不使用)\s*[`'"\s]*$/i.test(prefix)) return true;
  const fenceStart = output.lastIndexOf('```', index);
  if (fenceStart >= 0 && (output.slice(0, fenceStart).match(/```/g)?.length ?? 0) % 2 === 0) {
    const beforeFence = output.slice(0, fenceStart).trimEnd();
    const precedingLine = beforeFence.slice(beforeFence.lastIndexOf('\n') + 1).trim();
    if (/(?:不调用|不要(?:再)?调用|不要做|禁止调用|示例)[：:]?\s*$/.test(precedingLine)) return true;
  }
  return /(?:不要|禁止|不应|不可|不能|无需|不需要)\s*(?:调用|使用|执行|运行)?\s*$/i.test(prefix)
    || /(?:示例|例如|比如|样例|example)\s*(?:为|：|:)?\s*(?:调用|call|使用)?\s*$/i.test(prefix)
    || /(?:注释|comment)\s*(?:为|：|:)?\s*$/i.test(prefix);
}
