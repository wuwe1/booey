// 编排器纯函数单测：URL 归一化、缓存 key、结果汇总。
// 完整 agent 循环（命中重放/未命中推理）在 client.mjs 的集成套件里驱动真 mock。

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  type ActionResult,
  cacheKey,
  normalizeUrl,
  summarizeActions,
} from "../clients/ts/index.ts";

test("normalizeUrl: 去 hash、去易变 query、排序剩余", () => {
  assert.equal(normalizeUrl("https://a.com/p?b=2&a=1#frag"), "https://a.com/p?a=1&b=2");
  assert.equal(
    normalizeUrl("https://shop.com/item?id=7&token=XYZ&ts=168"),
    "https://shop.com/item?id=7",
  );
  assert.equal(normalizeUrl("not a url"), "not a url"); // 兜底原样返回
});

test("cacheKey: 易变参数不影响 key，instruction 影响 key", () => {
  const k1 = cacheKey("https://shop.com/cart?token=A&id=5", "结算");
  const k2 = cacheKey("https://shop.com/cart?token=B&id=5", "结算");
  assert.equal(k1, k2, "session token 不同应得同一 key");

  const k3 = cacheKey("https://shop.com/cart?id=5", "加购");
  assert.notEqual(k1, k3, "instruction 不同应得不同 key");
});

function r(p: Partial<ActionResult>): ActionResult {
  return { ok: true, method: "click", ...p };
}

test("summarizeActions: 统计 healed / needsInference / interrupted / allOk", () => {
  const s = summarizeActions([
    r({ ok: true }),
    r({ ok: true, healed: true, healMethod: "exact" }),
    r({ ok: true, healed: true, healMethod: "fuzzy", score: 0.9 }),
  ]);
  assert.deepEqual(s, {
    allOk: true,
    ran: 3,
    healed: { exact: 1, fuzzy: 1 },
    needsInference: false,
    interrupted: false,
  });

  const bad = summarizeActions([r({ ok: false, needsInference: true })]);
  assert.equal(bad.allOk, false);
  assert.equal(bad.needsInference, true);

  const cut = summarizeActions([r({ ok: true }), r({ ok: false, interrupted: true })]);
  assert.equal(cut.interrupted, true);
  assert.equal(cut.allOk, false);
});
