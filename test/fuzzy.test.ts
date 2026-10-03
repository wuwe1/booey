// 模糊重定位（self-heal 2.5 级）的纯函数单测：相似度打分、唯一赢家、阈值守卫。

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  diceRatio,
  fingerprintOf,
  fuzzyRelocate,
  type NodeRecord,
  scoreNode,
  tagPathFromXpath,
} from "../daemon/page-model.ts";

/** 造一个 NodeRecord，只填打分关心的字段，其余给合理默认。 */
function node(p: Partial<NodeRecord> & { tag: string; xp: string }): NodeRecord {
  return {
    id: p.id ?? "0-1",
    parent: p.parent ?? null,
    tag: p.tag,
    role: p.role ?? "",
    name: p.name ?? "",
    attrs: p.attrs ?? {},
    rect: p.rect ?? [0, 0, 10, 10],
    vis: p.vis ?? true,
    int: p.int ?? true,
    xp: p.xp,
    elementHash: p.elementHash ?? "deadbeef",
    parentBranchHash: p.parentBranchHash ?? "cafef00d",
  };
}

const addCart = node({
  tag: "button",
  role: "button",
  name: "加入购物车",
  attrs: { id: "add-cart", type: "submit", class: "btn primary" },
  xp: "/html[1]/body[1]/div[1]/button[1]",
});

test("tagPathFromXpath strips sibling indices", () => {
  assert.equal(tagPathFromXpath("/html[1]/body[1]/button[3]"), "/html/body/button");
});

test("diceRatio: identical, disjoint, similar", () => {
  assert.equal(diceRatio("hello", "hello"), 1);
  assert.equal(diceRatio("abc", "xyz"), 0);
  assert.ok(diceRatio("加入购物车", "加入购物车！") > 0.7);
  assert.equal(diceRatio("", "x"), 0);
});

test("scoreNode: identical node scores ~1, unrelated scores low", () => {
  const fp = fingerprintOf(addCart);
  assert.ok(scoreNode(fp, addCart) > 0.99);

  const unrelated = node({
    tag: "a",
    role: "link",
    name: "首页",
    attrs: { href: "/home" },
    xp: "/html[1]/body[1]/nav[1]/a[1]",
  });
  assert.ok(scoreNode(fp, unrelated) < 0.4);
});

test("fuzzyRelocate: finds the element after a redesign (wrapper + class churn)", () => {
  const fp = fingerprintOf(addCart);
  // 改版后：按钮被多包了一层 section、class 变了、兄弟序号变了，但 id/name/role 没变。
  const moved = node({
    tag: "button",
    role: "button",
    name: "加入购物车",
    attrs: { id: "add-cart", type: "submit", class: "Button_root__x7f2 primary" },
    xp: "/html[1]/body[1]/div[1]/section[1]/button[1]",
  });
  const distractors = [
    node({
      tag: "button",
      role: "button",
      name: "立即结算",
      attrs: { id: "checkout", type: "button", class: "btn" },
      xp: "/html[1]/body[1]/div[1]/section[1]/button[2]",
    }),
    node({
      tag: "a",
      role: "link",
      name: "返回",
      attrs: { href: "/" },
      xp: "/html[1]/body[1]/a[1]",
    }),
  ];
  const m = fuzzyRelocate(fp, [distractors[0]!, moved, distractors[1]!]);
  assert.ok(m, "should relocate");
  assert.equal(m!.node.xp, moved.xp);
  assert.ok(m!.score >= 0.72, `score ${m!.score} should clear threshold`);
});

test("fuzzyRelocate: ambiguous twins → null (no clear winner, defer to LLM)", () => {
  const fp = fingerprintOf(addCart);
  const twinA = node({ ...addCart, id: "a", xp: "/html[1]/body[1]/div[1]/button[1]" });
  const twinB = node({ ...addCart, id: "b", xp: "/html[1]/body[1]/div[2]/button[1]" });
  // 两个几乎相同的候选，领先不足 margin → 宁可交给 LLM。
  assert.equal(fuzzyRelocate(fp, [twinA, twinB]), null);
});

test("fuzzyRelocate: nothing similar → null (below threshold)", () => {
  const fp = fingerprintOf(addCart);
  const junk = [
    node({ tag: "a", role: "link", name: "关于", attrs: { href: "/about" }, xp: "/html[1]/a[1]" }),
    node({ tag: "img", name: "logo", attrs: {}, xp: "/html[1]/img[1]" }),
  ];
  assert.equal(fuzzyRelocate(fp, junk), null);
});

test("fuzzyRelocate: skips invisible/non-interactive nodes", () => {
  const fp = fingerprintOf(addCart);
  const hidden = node({ ...addCart, vis: false, int: false, xp: "/html[1]/body[1]/button[9]" });
  assert.equal(fuzzyRelocate(fp, [hidden]), null);
});
