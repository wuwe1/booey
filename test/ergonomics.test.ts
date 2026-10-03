// L1/L2 手感助手的纯函数单测：网络事件折叠 + 匹配、快照查询。
// waitFor*/withTab 的端到端在 client.mjs（驱动真 mock）。

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  collectNetRecords,
  findNode,
  interactiveNodes,
  matchFinishedResponses,
  type NodeRecord,
  newNodes,
  nodesByRole,
  nodesByText,
  type RelayEvent,
  type Snapshot,
} from "../clients/ts/index.ts";

function ev(method: string, params: unknown, seq: number): RelayEvent {
  return { seq, method, params, ts: 0 };
}

test("collectNetRecords folds the three Network events per requestId", () => {
  const recs = collectNetRecords([
    ev(
      "Network.requestWillBeSent",
      { requestId: "R1", request: { method: "GET", url: "https://x.com/api/list" } },
      1,
    ),
    ev(
      "Network.responseReceived",
      { requestId: "R1", response: { status: 200, mimeType: "application/json" } },
      2,
    ),
    ev("Network.loadingFinished", { requestId: "R1" }, 3),
    ev(
      "Network.requestWillBeSent",
      { requestId: "R2", request: { method: "POST", url: "https://x.com/other" } },
      4,
    ),
  ]);
  const r1 = recs.get("R1")!;
  assert.equal(r1.url, "https://x.com/api/list");
  assert.equal(r1.method, "GET");
  assert.equal(r1.status, 200);
  assert.equal(r1.mimeType, "application/json");
  assert.equal(r1.finished, true);
  assert.equal(recs.get("R2")!.finished, undefined); // not finished
});

test("collectNetRecords accumulates across batches into the same map", () => {
  const into = collectNetRecords([
    ev("Network.requestWillBeSent", { requestId: "R1", request: { url: "https://x.com/a" } }, 1),
  ]);
  collectNetRecords([ev("Network.loadingFinished", { requestId: "R1" }, 2)], into);
  assert.equal(into.get("R1")!.finished, true);
  assert.equal(into.get("R1")!.url, "https://x.com/a");
});

test("matchFinishedResponses returns only finished records whose url matches", () => {
  const recs = collectNetRecords([
    ev(
      "Network.requestWillBeSent",
      { requestId: "R1", request: { url: "https://x.com/api/list" } },
      1,
    ),
    ev("Network.loadingFinished", { requestId: "R1" }, 2),
    ev(
      "Network.requestWillBeSent",
      { requestId: "R2", request: { url: "https://x.com/api/other" } },
      3,
    ),
    // R2 not finished
  ]);
  assert.deepEqual(
    matchFinishedResponses(recs, /\/api\/list/).map((r) => r.requestId),
    ["R1"],
  );
  assert.deepEqual(matchFinishedResponses(recs, /\/api\/other/), []); // matches url but not finished
  assert.deepEqual(matchFinishedResponses(recs, /nope/), []);
});

function node(p: Partial<NodeRecord> & { tag: string }): NodeRecord {
  return {
    id: p.id ?? "0-1",
    parent: null,
    tag: p.tag,
    role: p.role ?? "",
    name: p.name ?? "",
    attrs: p.attrs ?? {},
    rect: p.rect ?? null,
    vis: p.vis ?? true,
    int: p.int ?? false,
    xp: p.xp ?? "/html[1]/body[1]",
    elementHash: p.elementHash ?? "h",
    parentBranchHash: p.parentBranchHash ?? "p",
  };
}

const button = node({
  id: "0-1",
  tag: "button",
  role: "button",
  name: "加入购物车",
  int: true,
  xp: "/html[1]/body[1]/button[1]",
});
const link = node({
  id: "0-2",
  tag: "a",
  role: "link",
  name: "返回",
  int: true,
  xp: "/html[1]/body[1]/a[1]",
});
const container = node({
  id: "0-3",
  tag: "div",
  role: "",
  name: "",
  int: false,
  xp: "/html[1]/body[1]/div[1]",
});

const snap: Snapshot = {
  revision: 1,
  url: "",
  frames: [],
  nodes: [button, link, container],
  indexedText: "[1]<button>加入购物车</button>\n*[2]<a>返回</a>",
  selectorMap: { 1: button, 2: link },
};

test("nodesByRole / nodesByText / interactiveNodes / findNode", () => {
  assert.deepEqual(
    nodesByRole(snap, "button").map((n) => n.id),
    ["0-1"],
  );
  assert.deepEqual(
    nodesByRole(snap, "button", /购物/).map((n) => n.id),
    ["0-1"],
  );
  assert.deepEqual(nodesByRole(snap, "button", "结算"), []);
  assert.deepEqual(
    nodesByText(snap, "返回").map((n) => n.id),
    ["0-2"],
  );
  assert.deepEqual(
    interactiveNodes(snap).map((n) => n.id),
    ["0-1", "0-2"],
  );
  assert.equal(findNode(snap, (n) => n.tag === "div")!.id, "0-3");
});

test("newNodes reads the * markers in indexedText", () => {
  assert.deepEqual(
    newNodes(snap).map((n) => n.id),
    ["0-2"],
  ); // only *[2]
});
