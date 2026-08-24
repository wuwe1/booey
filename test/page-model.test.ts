// page-model 的纯函数单测：合并三棵树 → NodeRecord，XPath 兄弟序号，白名单。

import assert from "node:assert/strict";
import { test } from "node:test";
import { buildSnapshot, type DomNode, type FrameTrees, mergeFrame } from "../daemon/page-model.ts";

/** 一棵最小的 DOM 树：html > body > (button, div > [a, a])。 */
function sampleDom(): DomNode {
  return {
    nodeType: 9,
    nodeName: "#document",
    backendNodeId: 1,
    children: [
      {
        nodeType: 1,
        nodeName: "html",
        localName: "html",
        backendNodeId: 2,
        children: [
          {
            nodeType: 1,
            nodeName: "body",
            localName: "body",
            backendNodeId: 3,
            children: [
              {
                nodeType: 1,
                nodeName: "button",
                localName: "button",
                backendNodeId: 4,
                attributes: [
                  "id",
                  "add-cart",
                  "class",
                  "btn primary",
                  "type",
                  "submit",
                  "onclick",
                  "do()",
                ],
              },
              {
                nodeType: 1,
                nodeName: "div",
                localName: "div",
                backendNodeId: 5,
                children: [
                  {
                    nodeType: 1,
                    nodeName: "a",
                    localName: "a",
                    backendNodeId: 6,
                    attributes: ["href", "/a"],
                  },
                  {
                    nodeType: 1,
                    nodeName: "a",
                    localName: "a",
                    backendNodeId: 7,
                    attributes: ["href", "/b"],
                  },
                ],
              },
            ],
          },
        ],
      },
    ],
  };
}

function frame(overrides: Partial<FrameTrees> = {}): FrameTrees {
  return {
    frameOrdinal: 0,
    url: "https://example.com/",
    dom: sampleDom(),
    ax: {
      nodes: [
        {
          backendDOMNodeId: 4,
          role: { value: "button" },
          name: { value: "加入购物车" },
          ignored: false,
        },
        { backendDOMNodeId: 6, role: { value: "link" }, name: { value: "A" }, ignored: false },
        { backendDOMNodeId: 7, role: { value: "link" }, name: { value: "B" }, ignored: false },
      ],
    },
    snapshot: {
      documents: [
        {
          nodes: { backendNodeId: [4, 6, 7] },
          layout: {
            nodeIndex: [0, 1, 2],
            bounds: [
              [120, 480, 96, 36],
              [0, 0, 10, 10],
              [0, 10, 10, 10],
            ],
          },
        },
      ],
    },
    ...overrides,
  };
}

test("mergeFrame 合并 DOM + AX：tag/role/name 对齐 backendNodeId", () => {
  const nodes = mergeFrame(frame());
  const byId = new Map(nodes.map((n) => [n.id, n]));

  assert.equal(byId.get("0-4")?.tag, "button");
  assert.equal(byId.get("0-4")?.role, "button");
  assert.equal(byId.get("0-4")?.name, "加入购物车");
  // body 没有 AX 节点，role/name 为空串而不是 undefined。
  assert.equal(byId.get("0-3")?.role, "");
  assert.equal(byId.get("0-3")?.name, "");
});

test("id / parent 用 frameOrdinal-backendNodeId 编码", () => {
  const nodes = mergeFrame(frame());
  const byId = new Map(nodes.map((n) => [n.id, n]));

  assert.equal(byId.get("0-4")?.parent, "0-3");
  assert.equal(byId.get("0-6")?.parent, "0-5");
  // 根元素 html 没有父 record。
  assert.equal(byId.get("0-2")?.parent, null);
});

test("XPath 用兄弟序号：同 tag 兄弟 [1] [2]", () => {
  const nodes = mergeFrame(frame());
  const byId = new Map(nodes.map((n) => [n.id, n]));

  assert.equal(byId.get("0-4")?.xp, "/html[1]/body[1]/button[1]");
  assert.equal(byId.get("0-6")?.xp, "/html[1]/body[1]/div[1]/a[1]");
  assert.equal(byId.get("0-7")?.xp, "/html[1]/body[1]/div[1]/a[2]");
});

test("attrs 只保留白名单，动态属性被丢弃", () => {
  const nodes = mergeFrame(frame());
  const attrs = nodes.find((n) => n.id === "0-4")!.attrs;

  assert.equal(attrs.id, "add-cart");
  assert.equal(attrs.class, "btn primary");
  assert.equal(attrs.type, "submit");
  assert.ok(!("onclick" in attrs));
});

test("rect 来自 snapshot 的 layout.bounds", () => {
  const nodes = mergeFrame(frame());
  assert.deepEqual(nodes.find((n) => n.id === "0-4")!.rect, [120, 480, 96, 36]);
});

test("int 只标可交互 role；vis 由几何或 AX 非 ignored 决定", () => {
  const nodes = mergeFrame(frame());
  const byId = new Map(nodes.map((n) => [n.id, n]));

  assert.equal(byId.get("0-4")!.int, true);
  assert.equal(byId.get("0-6")!.int, true);
  // body 没有 AX、没有几何 → 不标可交互。
  assert.equal(byId.get("0-3")!.int, false);
});

test("buildSnapshot 汇总 frame 并携带 revision/url", () => {
  const snap = buildSnapshot([frame()], 7);
  assert.equal(snap.revision, 7);
  assert.equal(snap.url, "https://example.com/");
  assert.equal(snap.frames.length, 1);
  assert.equal(snap.nodes.length, 6); // html/body/button/div/a/a
});

/** 一个「html>body>button」的最小树，button 的 class 可指定。 */
function buttonTree(classVal: string): DomNode {
  return {
    nodeType: 9,
    nodeName: "#document",
    backendNodeId: 1,
    children: [
      {
        nodeType: 1,
        nodeName: "html",
        localName: "html",
        backendNodeId: 2,
        children: [
          {
            nodeType: 1,
            nodeName: "body",
            localName: "body",
            backendNodeId: 3,
            children: [
              {
                nodeType: 1,
                nodeName: "button",
                localName: "button",
                backendNodeId: 4,
                attributes: ["id", "add-cart", "class", classVal],
              },
            ],
          },
        ],
      },
    ],
  };
}

test("elementHash / parentBranchHash 是 16 hex 字符串", () => {
  const btn = mergeFrame(frame()).find((n) => n.id === "0-4")!;
  assert.match(btn.elementHash, /^[0-9a-f]{16}$/);
  assert.match(btn.parentBranchHash, /^[0-9a-f]{16}$/);
});

test("动态 class 不改变 elementHash（hover/focus/loading 被过滤）", () => {
  const a = mergeFrame({ ...frame(), dom: buttonTree("btn primary") }).find(
    (n) => n.tag === "button",
  )!;
  const b = mergeFrame({ ...frame(), dom: buttonTree("btn primary hover focus loading") }).find(
    (n) => n.tag === "button",
  )!;
  assert.equal(a.elementHash, b.elementHash);
  // 但 attrs.class 展示的是原始 class，动态类还在。
  assert.equal(b.attrs.class, "btn primary hover focus loading");
});

test("parentBranchHash 只看结构路径，不看属性/名字", () => {
  const a = mergeFrame({ ...frame(), dom: buttonTree("btn primary") }).find(
    (n) => n.tag === "button",
  )!;
  const b = mergeFrame({ ...frame(), dom: buttonTree("btn alt") }).find((n) => n.tag === "button")!;
  assert.equal(a.parentBranchHash, b.parentBranchHash);
  // 属性不同 → elementHash 不同。
  assert.notEqual(a.elementHash, b.elementHash);
});
