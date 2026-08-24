// actions — L3 动作层的类型 + 纯逻辑（设计文档 §6）。
//
// LLM 只返回 { index, method, args }（ActionDraft）；daemon 查 selectorMap 补齐
// xpath / elementHash / description。动作词表封闭（抄 stagehand 的 11 个元素动作）。
// 三级回退和批量守卫的决策在这里，CDP 执行在 ExtConn（有 sendCdp）。

import type { NodeRecord } from "./page-model.ts";

export const ACTION_METHODS = [
  "click",
  "fill",
  "type",
  "press",
  "scrollTo",
  "selectOption",
  "hover",
  "doubleClick",
  "dragAndDrop",
  "nextChunk",
  "prevChunk",
] as const;

export type ActionMethod = (typeof ACTION_METHODS)[number];

/**
 * 调用方给的动作：要么给 `index`（daemon 查 selectorMap 补齐），要么直接给
 * `xpath` + `elementHash`（完整动作，跳过解析）。
 */
export interface ActionDraft {
  index?: number;
  method: ActionMethod;
  args?: string[];
  description?: string;
  xpath?: string;
  elementHash?: string;
}

/** daemon 补齐后的可执行动作（可序列化、可存盘、可重放）。 */
export interface Action {
  method: ActionMethod;
  xpath: string;
  elementHash: string;
  args: string[];
  description: string;
}

/** 单个动作的执行结果。 */
export interface ActionResult {
  ok: boolean;
  method: ActionMethod;
  /** elementHash 重定位成功（三级回退的第二级，零 LLM）。 */
  healed?: boolean;
  /** 批量守卫中断了剩余动作。 */
  interrupted?: boolean;
  /** 定位失败、需要调用方重新推理（三级回退的第三级）。 */
  needsInference?: boolean;
  error?: string;
}

/**
 * 执行后应丢弃队列剩余的动作（批量守卫第一层，静态）。navigate/goBack/… 不在
 * 11 个元素动作里，但批量执行时遇到它们（或 submit）就该停。
 */
export const TERMINATES_SEQUENCE: ReadonlySet<string> = new Set([
  "navigate",
  "goBack",
  "goForward",
  "switchTab",
  "submit",
]);

/**
 * 把调用方的动作补成完整 Action：给 index 就查 selectorMap；给 xpath+elementHash
 * 就直接用。index 找不到节点 → null（selectorMap 已过期，调用方该重新推理）。
 */
export function resolveDraft(
  draft: ActionDraft,
  selectorMap: Record<number, NodeRecord>,
): Action | null {
  if (draft.xpath && draft.elementHash) {
    return {
      method: draft.method,
      xpath: draft.xpath,
      elementHash: draft.elementHash,
      args: draft.args ?? [],
      description: draft.description ?? `${draft.method}`,
    };
  }
  if (typeof draft.index === "number") {
    const node = selectorMap[draft.index];
    if (!node) return null;
    return {
      method: draft.method,
      xpath: node.xp,
      elementHash: node.elementHash,
      args: draft.args ?? [],
      description: draft.description ?? `${draft.method} ${node.tag}`,
    };
  }
  return null;
}

/** 一批 ActionDraft → 一批 Action；任何一个 index 失效就整体失败（快照已废）。 */
export function resolveDrafts(
  drafts: ActionDraft[],
  selectorMap: Record<number, NodeRecord>,
): Action[] | null {
  const out: Action[] = [];
  for (const d of drafts) {
    const a = resolveDraft(d, selectorMap);
    if (!a) return null;
    out.push(a);
  }
  return out;
}
