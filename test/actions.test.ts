// actions 的纯逻辑单测：resolveDraft 补齐、三级回退的决策数据、terminatesSequence。
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  type ActionMethod,
  resolveDraft,
  resolveDrafts,
  TERMINATES_SEQUENCE,
} from "../daemon/actions.ts";
import type { NodeRecord } from "../daemon/page-model.ts";

const node: NodeRecord = {
  id: "0-4",
  parent: "0-3",
  tag: "button",
  role: "button",
  name: "加入购物车",
  attrs: { id: "add-cart" },
  rect: null,
  vis: true,
  int: true,
  xp: "/html[1]/body[1]/button[1]",
  elementHash: "abc123def4567890",
  parentBranchHash: "1111222233334444",
};

const selectorMap = { 1: node };

test("resolveDraft 用 index 查 selectorMap 补齐 xpath/elementHash", () => {
  const a = resolveDraft({ index: 1, method: "click" }, selectorMap)!;
  assert.equal(a.xpath, "/html[1]/body[1]/button[1]");
  assert.equal(a.elementHash, "abc123def4567890");
  assert.equal(a.args.length, 0);
  assert.equal(a.description, "click button");
});

test("resolveDraft 的 index 失效返回 null", () => {
  assert.equal(resolveDraft({ index: 99, method: "click" }, selectorMap), null);
});

test("resolveDraft 直接给 xpath+elementHash 则跳过解析", () => {
  const a = resolveDraft({ method: "click", xpath: "/x/y", elementHash: "hash" }, selectorMap)!;
  assert.equal(a.xpath, "/x/y");
  assert.equal(a.elementHash, "hash");
});

test("resolveDrafts 任一失效整体返回 null", () => {
  assert.equal(
    resolveDrafts(
      [
        { index: 1, method: "click" },
        { index: 2, method: "click" },
      ],
      selectorMap,
    ),
    null,
  );
  assert.equal(
    resolveDrafts(
      [
        { index: 1, method: "click" },
        { index: 1, method: "hover" },
      ],
      selectorMap,
    )?.length,
    2,
  );
});

test("TERMINATES_SEQUENCE 含导航/提交类，不含元素动作", () => {
  for (const m of ["navigate", "goBack", "goForward", "switchTab", "submit"]) {
    assert.ok(TERMINATES_SEQUENCE.has(m), m);
  }
  for (const m of ["click", "fill", "type", "hover"] as ActionMethod[]) {
    assert.ok(!TERMINATES_SEQUENCE.has(m), m);
  }
});
