// page-model — L2 数据管线的前半段：把 ext 逐 frame 取回的三棵 CDP 树
// （DOM + Accessibility + DOMSnapshot）合并成扁平的 NodeRecord 数组。
//
// 纯函数、无 I/O，可直接单测。这是设计文档 §5.2 的产物；elementHash（D）、
// 剪枝 + serializer + selectorMap（E）都建在这上面。
//
// 合并键是 backendNodeId（browser-use / stagehand 都用它）：DOM 树是骨架，
// AX 节点按 backendDOMNodeId 挂 role/name，snapshot 按 backendNodeId 挂几何。
// XPath 抄 stagehand 的兄弟序号算法（tag[i]，无属性谓词）——每个元素都带
// [i]，包括根，所以是 "/html[1]/body[1]/div[2]/button[1]" 这种形状。

export interface DomNode {
  nodeId?: number;
  parentId?: number;
  backendNodeId: number;
  nodeType: number;
  nodeName: string;
  localName?: string;
  nodeValue?: string;
  children?: DomNode[];
  attributes?: string[];
  documentURL?: string;
  baseURL?: string;
}

export interface AxNode {
  nodeId?: string;
  ignored?: boolean;
  role?: { value?: string };
  name?: { value?: string };
  backendDOMNodeId?: number;
  childIds?: string[];
}

/** 一个 frame 的三棵原始树，ext 原样返回（ext 不做语义）。 */
export interface FrameTrees {
  frameOrdinal: number;
  url: string;
  dom: DomNode;
  ax: { nodes?: AxNode[] };
  snapshot: any;
}

/** 合并后的单个元素节点。`id` 抄 stagehand 的 `${frameOrdinal}-${backendNodeId}`。 */
export interface NodeRecord {
  id: string;
  parent: string | null;
  tag: string;
  role: string;
  name: string;
  attrs: Record<string, string>;
  rect: [number, number, number, number] | null;
  vis: boolean;
  int: boolean;
  xp: string;
}

export interface Snapshot {
  revision: number;
  url: string;
  frames: Array<{ frameOrdinal: number; url: string }>;
  nodes: NodeRecord[];
}

const NODE_TYPE_ELEMENT = 1;
const NODE_TYPE_DOCUMENT = 9;

/**
 * 白名单属性：只有这些进 NodeRecord.attrs。抄 browser-use 的 STATIC_ATTRIBUTES
 * 思路——够 LLM 认元素，又不把整段 style/事件处理器拖进来。
 */
const ATTR_WHITELIST = new Set([
  "id",
  "class",
  "name",
  "type",
  "href",
  "src",
  "placeholder",
  "value",
  "role",
  "title",
  "alt",
  "for",
  "action",
  "method",
  "rel",
  "target",
  "download",
  "checked",
  "selected",
  "disabled",
  "readonly",
  "multiple",
  "maxlength",
  "min",
  "max",
  "step",
  "pattern",
  "autocomplete",
  "contenteditable",
  "aria-label",
  "aria-checked",
  "aria-expanded",
  "aria-selected",
  "aria-disabled",
  "aria-hidden",
  "data-testid",
  "data-test",
  "data-id",
  "data-cy",
  "data-e2e",
]);

/** 可交互的 AX role：有这些 role 的可见节点才标 `int`。 */
const INTERACTIVE_ROLES = new Set([
  "button",
  "link",
  "textbox",
  "searchbox",
  "checkbox",
  "radio",
  "combobox",
  "listbox",
  "option",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "tab",
  "switch",
  "slider",
  "spinbutton",
  "scrollbar",
  "treeitem",
  "gridcell",
  "row",
  "cell",
  "columnheader",
  "rowheader",
]);

/** DOM 的 attributes 数组是 [k1, v1, k2, v2, …]，只保留白名单里的键。 */
function parseAttrs(attributes?: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  if (!attributes) return out;
  for (let i = 0; i + 1 < attributes.length; i += 2) {
    const key = attributes[i]!;
    if (ATTR_WHITELIST.has(key)) out[key] = attributes[i + 1] ?? "";
  }
  return out;
}

/** AX 节点按 backendDOMNodeId 建索引，供 DOM 遍历时 O(1) 取 role/name。 */
function indexAx(ax: { nodes?: AxNode[] }): Map<number, AxNode> {
  const out = new Map<number, AxNode>();
  for (const node of ax.nodes ?? []) {
    if (typeof node.backendDOMNodeId === "number") out.set(node.backendDOMNodeId, node);
  }
  return out;
}

/**
 * DOMSnapshot 是列式存储：`documents[0].layout` 只给「有 box 的节点」，
 * `layout.nodeIndex[i]` 是它在 `nodes.*` 数组里的下标，`layout.bounds[i]` 是
 * [x, y, width, height]。这里只取 rect，别的（paint order 等）后续再加。
 */
function indexRects(snapshot: any): Map<number, [number, number, number, number]> {
  const out = new Map<number, [number, number, number, number]>();
  const doc = snapshot?.documents?.[0];
  const nodes = doc?.nodes;
  const layout = doc?.layout;
  if (!nodes || !layout) return out;
  const nodeIndex: number[] = layout.nodeIndex ?? [];
  const bounds: number[][] = layout.bounds ?? [];
  for (let i = 0; i < nodeIndex.length && i < bounds.length; i++) {
    const backend: number | undefined = nodes.backendNodeId?.[nodeIndex[i]!];
    const b = bounds[i]!;
    if (backend != null && b.length >= 4) out.set(backend, [b[0]!, b[1]!, b[2]!, b[3]!]);
  }
  return out;
}

/**
 * DFS 遍历 DOM 树，产出 NodeRecord。每个元素带兄弟序号 XPath（stagehand 算法）。
 * 非元素节点（document / text / comment）不产 record，但其后代继续走。
 */
function walkDom(
  node: DomNode,
  frameOrdinal: number,
  parentId: string | null,
  parentXp: string,
  counters: Record<string, number>,
  axIndex: Map<number, AxNode>,
  rectIndex: Map<number, [number, number, number, number]>,
  out: NodeRecord[],
): void {
  if (node.nodeType !== NODE_TYPE_ELEMENT) {
    for (const child of node.children ?? []) {
      walkDom(child, frameOrdinal, parentId, parentXp, counters, axIndex, rectIndex, out);
    }
    return;
  }

  const tag = (node.localName || node.nodeName || "").toLowerCase();
  counters[tag] = (counters[tag] ?? 0) + 1;
  const xp = `${parentXp}/${tag}[${counters[tag]}]`;

  const backend = node.backendNodeId;
  const ax = axIndex.get(backend);
  const rect = rectIndex.get(backend) ?? null;
  const role = ax?.role?.value ?? "";
  const name = ax?.name?.value ?? "";
  // 可见性：有几何（snapshot 给了 box）就一定可见；否则退回 AX 的非 ignored。
  const vis = rect != null || (ax != null && ax.ignored === false);
  const int = vis && INTERACTIVE_ROLES.has(role);

  out.push({
    id: `${frameOrdinal}-${backend}`,
    parent: parentId,
    tag,
    role,
    name,
    attrs: parseAttrs(node.attributes),
    rect,
    vis,
    int,
    xp,
  });

  const childCounters: Record<string, number> = {};
  for (const child of node.children ?? []) {
    walkDom(
      child,
      frameOrdinal,
      `${frameOrdinal}-${backend}`,
      xp,
      childCounters,
      axIndex,
      rectIndex,
      out,
    );
  }
}

/** 合并一个 frame 的三棵树 → NodeRecord[]。 */
export function mergeFrame(frame: FrameTrees): NodeRecord[] {
  const axIndex = indexAx(frame.ax);
  const rectIndex = indexRects(frame.snapshot);
  const out: NodeRecord[] = [];
  const root = frame.dom;
  const rootCounters: Record<string, number> = {};
  for (const child of root.children ?? []) {
    walkDom(child, frame.frameOrdinal, null, "", rootCounters, axIndex, rectIndex, out);
  }
  return out;
}

/** 合并所有 frame（C 核心先单 frame；跨 frame 的宿主拼接在后续）→ 快照。 */
export function buildSnapshot(frames: FrameTrees[], revision: number): Snapshot {
  const nodes: NodeRecord[] = [];
  for (const frame of frames) nodes.push(...mergeFrame(frame));
  return {
    revision,
    url: frames[0]?.url ?? "",
    frames: frames.map((f) => ({ frameOrdinal: f.frameOrdinal, url: f.url })),
    nodes,
  };
}
