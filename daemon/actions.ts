// actions — L3 动作层的类型 + 纯逻辑（设计文档 §6）。
//
// LLM 只返回 { index, method, args }（ActionDraft）；daemon 查 selectorMap 补齐
// xpath / elementHash / description。动作词表封闭（抄 stagehand 的 11 个元素动作）。
// 三级回退和批量守卫的决策在这里，CDP 执行在 ExtConn（有 sendCdp）。

import { type ElementFingerprint, fingerprintOf, type NodeRecord } from "./page-model.ts";

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
  /**
   * 指纹：elementHash 精确命中失败后用来模糊重定位（§6.2 的 2.5 级）。按 index
   * 解析时 daemon 自动从节点填；重放缓存动作想要模糊愈合就带上（调用方从上次结果
   * 的 relocated/快照存下来）。不带也能跑，只是跳过模糊这级直接到 needsInference。
   */
  fingerprint?: ElementFingerprint;
}

/** daemon 补齐后的可执行动作（可序列化、可存盘、可重放）。 */
export interface Action {
  method: ActionMethod;
  xpath: string;
  elementHash: string;
  args: string[];
  description: string;
  fingerprint?: ElementFingerprint;
}

/** 单个动作的执行结果。 */
export interface ActionResult {
  ok: boolean;
  method: ActionMethod;
  /** 定位时发生了重定位（第二/2.5 级，零 LLM）。 */
  healed?: boolean;
  /** 重定位方式：elementHash 精确 或 相似度模糊。 */
  healMethod?: "exact" | "fuzzy";
  /** 模糊重定位的置信分 ∈ [0,1]（仅 healMethod==="fuzzy"）。 */
  score?: number;
  /**
   * 愈合后元素的新身份——调用方据此更新自己缓存的动作（指纹迁移：网站改版后身份
   * 跟着漂，下次直接命中，不再触发愈合）。
   */
  relocated?: { xpath: string; elementHash: string; fingerprint: ElementFingerprint };
  /** 批量守卫中断了剩余动作。 */
  interrupted?: boolean;
  /** 定位失败、需要调用方重新推理（三级回退的最后一级）。 */
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
      ...(draft.fingerprint ? { fingerprint: draft.fingerprint } : {}),
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
      // 从节点自动填指纹，让按 index 的首次执行也能享受模糊愈合。
      fingerprint: draft.fingerprint ?? fingerprintOf(node),
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
