// ============================================================
// 集中式工具目录（Tool Catalog，A1-4）
// 为每个工具定义参数 schema（必填项 + 枚举值），供 tool_call_trace 做结构化校验，
// 取代原先的「参数 key/value 子串匹配」——避免模型写成 city="北京" 也能满分。
// catalog 由编排层按需 registerToolCatalog() 注入；未注册时评分器回退到原有 findParam 匹配。
// ============================================================

import { findParam } from './callMatch.js';

export interface ToolParamSpec {
  /** 是否为必填参数；缺失 → 扣分 */
  required?: boolean;
  /** 枚举约束：参数值必须命中其中之一（用于 city/date 这类强约束字段） */
  enum?: string[];
}

export interface ToolSpec {
  params?: Record<string, ToolParamSpec>;
}

export type ToolCatalog = Record<string, ToolSpec>;

let toolCatalog: ToolCatalog = {};

/** 注入工具目录（编排层启动时调用一次；传 null/{} 表示禁用结构校验） */
export function registerToolCatalog(cat: ToolCatalog | null): void {
  toolCatalog = cat ?? {};
}

/** 读取当前工具目录（测试/调试用） */
export function getRegisteredToolCatalog(): ToolCatalog {
  return toolCatalog;
}

export interface ToolCallValidation {
  toolRecognized: boolean;
  /** 参数准确率 0-100 */
  paramScore: number;
  missingRequired: string[];
  invalidEnum: string[];
  matchedParams: string[];
}

/** 仅检测参数 key 是否以「key: value / key=value」形态出现（不比对具体值） */
function paramPresent(output: string, key: string): boolean {
  const k = key.toLowerCase();
  return new RegExp(`["']?${k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["']?\\s*[:=]`).test(output.toLowerCase());
}

/**
 * 依据目录校验一次工具调用（A1-4）。
 * @param output 模型输出
 * @param toolName 期望工具名
 * @param catalog 工具目录
 */
export function validateToolCall(output: string, toolName: string, catalog: ToolCatalog): ToolCallValidation {
  const spec = catalog[toolName];
  const validation: ToolCallValidation = {
    toolRecognized: !!spec,
    paramScore: 100,
    missingRequired: [],
    invalidEnum: [],
    matchedParams: [],
  };
  if (!spec || !spec.params) return validation;

  const entries = Object.entries(spec.params);
  if (entries.length === 0) return validation;

  let matched = 0;
  for (const [key, p] of entries) {
    const present = paramPresent(output, key);
    if (p.enum && p.enum.length > 0) {
      // 枚举约束：输出中出现 key 且命中其一枚举值
      const ok = p.enum.some((v) => output.toLowerCase().includes(String(v).toLowerCase()));
      if (present && ok) {
        matched++;
        validation.matchedParams.push(key);
      } else if (p.required) {
        // 缺失或枚举未命中均记入；若已出现 key 但未命中枚举，归为 invalidEnum
        if (present) validation.invalidEnum.push(key);
        else validation.missingRequired.push(key);
      }
    } else {
      // 普通参数：key 以结构化形态出现即可
      if (present) {
        matched++;
        validation.matchedParams.push(key);
      } else if (p.required) {
        validation.missingRequired.push(key);
      }
    }
  }
  validation.paramScore = Math.round((matched / entries.length) * 100);
  return validation;
}
