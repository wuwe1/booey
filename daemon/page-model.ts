// page-model — L2 数据管线的前半段：把 ext 逐 frame 取回的三棵 CDP 树
// （DOM + Accessibility + DOMSnapshot）合并成扁平的 NodeRecord 数组。
//
// 纯函数、无 I/O，可直接单测。这是设计文档 §5.2 + §5.3c 的产物：合并产出
// NodeRecord，并给每个元素算 elementHash / parentBranchHash（D）——剪枝、
// serializer、selectorMap（E）都建在这上面。
//
// 合并键是 backendNodeId（browser-use / stagehand 都用它）：DOM 树是骨架，
// AX 节点按 backendDOMNodeId 挂 role/name，snapshot 按 backendNodeId 挂几何。
// XPath 抄 stagehand 的兄弟序号算法（tag[i]，无属性谓词）——每个元素都带
// [i]，包括根，所以是 "/html[1]/body[1]/div[2]/button[1]" 这种形状。
//
// elementHash 直接照搬 browser-use 的 compute_stable_hash（views.py:830）：
//   sha256(`${rootTag/.../selfTag}|${排序后 k=v 拼接}${|ax_name=...}`)
// 其中 class 先过 filter_dynamic_classes（去掉 20 个动态状态关键词），这样
// 页面加个 `hover`/`focus`/`loading` 类不会改变身份。取 sha256 前 16 个 hex
// 字符（browser-use 转成 int 是因为 Python __hash__ 必须 int；我们拿它当
// Map key / 缓存锚点，string 更精确，避免 JS number 超过 2^53 丢精度）。

import { createHash } from "node:crypto";

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
  /** 稳定身份：跨快照/跨会话认出「同一个元素」。sha256 前 16 hex。 */
  elementHash: string;
  /** 只基于父分支路径（rootTag/.../selfTag）的哈希，用于结构指纹。 */
  parentBranchHash: string;
}

export interface Snapshot {
  revision: number;
  url: string;
  frames: Array<{ frameOrdinal: number; url: string }>;
  nodes: NodeRecord[];
  /** 给 LLM 的带索引文本（设计文档 §5.3a）。 */
  indexedText: string;
  /** index → NodeRecord。LLM 说 index，daemon 查这个拿 xpath/elementHash。 */
  selectorMap: Record<number, NodeRecord>;
}

const NODE_TYPE_ELEMENT = 1;

/**
 * 白名单属性：只有这些进 NodeRecord.attrs，也是 elementHash 的输入。直接抄
 * browser-use 的 STATIC_ATTRIBUTES（views.py:84）——注意它刻意不含 `value`
 * （输入值每次都在变，进了哈希就失去稳定性）。
 */
const STATIC_ATTRIBUTES = new Set([
  "class",
  "id",
  "name",
  "type",
  "placeholder",
  "aria-label",
  "title",
  "role",
  "data-testid",
  "data-test",
  "data-cy",
  "data-selenium",
  "for",
  "required",
  "disabled",
  "readonly",
  "checked",
  "selected",
  "multiple",
  "accept",
  "href",
  "target",
  "rel",
  "aria-describedby",
  "aria-labelledby",
  "aria-controls",
  "aria-owns",
  "aria-live",
  "aria-atomic",
  "aria-busy",
  "aria-disabled",
  "aria-hidden",
  "aria-pressed",
  "aria-autocomplete",
  "aria-checked",
  "aria-selected",
  "list",
  "tabindex",
  "alt",
  "src",
  "lang",
  "itemscope",
  "itemtype",
  "itemprop",
  "pseudo",
  "aria-valuemin",
  "aria-valuemax",
  "aria-valuenow",
  "aria-placeholder",
]);

/**
 * class 里的这些子串表示动态/瞬态 UI 状态，进哈希会让身份随交互抖动。
 * 抄 browser-use 的 DYNAMIC_CLASS_PATTERNS（views.py:139）——substring 匹配，
 * 不是整词。
 */
const DYNAMIC_CLASS_PATTERNS = [
  "focus",
  "hover",
  "active",
  "selected",
  "disabled",
  "animation",
  "transition",
  "loading",
  "open",
  "closed",
  "expanded",
  "collapsed",
  "visible",
  "hidden",
  "pressed",
  "checked",
  "highlighted",
  "current",
  "entering",
  "leaving",
];

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

/** sha256 → 前 16 个 hex 字符（64 bit）。browser-use 用同样的截断，只是转 int。 */
function hash64(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex").slice(0, 16);
}

/** 去掉动态状态 class，保留语义/识别性的，并排序（哈希要确定性）。 */
function filterDynamicClasses(classStr: string): string {
  if (!classStr) return "";
  const classes = classStr.split(/\s+/).filter(Boolean);
  const stable = classes.filter(
    (c) => !DYNAMIC_CLASS_PATTERNS.some((pattern) => c.toLowerCase().includes(pattern)),
  );
  return stable.sort().join(" ");
}

/**
 * 元素稳定哈希 = sha256(parentBranchPath|attributes|ax_name) 前 16 hex。
 * `branchPath` 是从根到自身的 tag 列表（含自身，browser-use 的
 * `_get_parent_branch_path` 也是这样）。
 */
function computeElementHash(
  branchPath: string[],
  attrs: Record<string, string>,
  axName: string,
): string {
  const entries: Array<[string, string]> = [];
  for (const [k, v] of Object.entries(attrs)) {
    if (!STATIC_ATTRIBUTES.has(k)) continue;
    let val = v;
    if (k === "class") {
      val = filterDynamicClasses(v);
      if (!val) continue; // 过滤后空 class 不参与
    }
    entries.push([k, val]);
  }
  entries.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const attrsString = entries.map(([k, v]) => `${k}=${v}`).join("");
  const axPart = axName ? `|ax_name=${axName}` : "";
  return hash64(`${branchPath.join("/")}|${attrsString}${axPart}`);
}

/** 父分支哈希：只看结构路径，不看属性/名字。 */
function computeParentBranchHash(branchPath: string[]): string {
  return hash64(branchPath.join("/"));
}

/** DOM 的 attributes 数组是 [k1, v1, k2, v2, …]，只保留白名单里的键。 */
function parseAttrs(attributes?: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  if (!attributes) return out;
  for (let i = 0; i + 1 < attributes.length; i += 2) {
    const key = attributes[i]!;
    if (STATIC_ATTRIBUTES.has(key)) out[key] = attributes[i + 1] ?? "";
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
 * DFS 遍历 DOM 树，产出 NodeRecord。每个元素带兄弟序号 XPath（stagehand 算法）
 * 和 elementHash / parentBranchHash。非元素节点（document / text / comment）
 * 不产 record，但其后代继续走。
 */
function walkDom(
  node: DomNode,
  frameOrdinal: number,
  parentId: string | null,
  parentXp: string,
  counters: Record<string, number>,
  axIndex: Map<number, AxNode>,
  rectIndex: Map<number, [number, number, number, number]>,
  branchPath: string[],
  out: NodeRecord[],
): void {
  if (node.nodeType !== NODE_TYPE_ELEMENT) {
    for (const child of node.children ?? []) {
      walkDom(
        child,
        frameOrdinal,
        parentId,
        parentXp,
        counters,
        axIndex,
        rectIndex,
        branchPath,
        out,
      );
    }
    return;
  }

  const tag = (node.localName || node.nodeName || "").toLowerCase();
  counters[tag] = (counters[tag] ?? 0) + 1;
  const xp = `${parentXp}/${tag}[${counters[tag]}]`;
  const myBranch = [...branchPath, tag];

  const backend = node.backendNodeId;
  const ax = axIndex.get(backend);
  const rect = rectIndex.get(backend) ?? null;
  const role = ax?.role?.value ?? "";
  const name = ax?.name?.value ?? "";
  // 可见性：有几何（snapshot 给了 box）就一定可见；否则退回 AX 的非 ignored。
  const vis = rect != null || (ax != null && ax.ignored === false);
  const int = vis && INTERACTIVE_ROLES.has(role);
  const attrs = parseAttrs(node.attributes);

  out.push({
    id: `${frameOrdinal}-${backend}`,
    parent: parentId,
    tag,
    role,
    name,
    attrs,
    rect,
    vis,
    int,
    xp,
    elementHash: computeElementHash(myBranch, attrs, name),
    parentBranchHash: computeParentBranchHash(myBranch),
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
      myBranch,
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
    walkDom(child, frame.frameOrdinal, null, "", rootCounters, axIndex, rectIndex, [], out);
  }
  return out;
}

// ---- serializer（设计文档 §5.3a/b，E 的后半）----
//
// 把扁平 NodeRecord[] 变回树（按 parent 分组），只给「可见且有语义」的节点
// （int 或 role 或 name）分配连续 index 并输出一行；纯结构容器（div/span 之类
// 没有 role/name 也不可交互的）不占行，只透传子节点，所以缩进仍然表达层级。
// 不可见且没有可见语义后代的子树自然什么都不输出——这就是 §5.2 剪枝的简化版。
// （「先出不剪枝」的分量：真剪枝要加 scrollable/iframe 宿主保留，接在跨 frame 后。）

export interface SerializedPage {
  indexedText: string;
  selectorMap: Record<number, NodeRecord>;
}

/** 属性 → `key=value`。含空格的值加引号（class="btn primary"），空值 key=''。 */
function formatAttr(key: string, value: string): string {
  const val = value.length > 100 ? value.slice(0, 100) : value;
  if (val === "") return `${key}=''`;
  return /\s/.test(val) ? `${key}="${val}"` : `${key}=${val}`;
}

function formatLine(node: NodeRecord, index: number, depth: number, isNew: boolean): string {
  const indent = "\t".repeat(depth);
  const star = isNew ? "*" : "";
  const attrs = Object.entries(node.attrs)
    .map(([k, v]) => formatAttr(k, v))
    .join(" ");
  const attrStr = attrs ? ` ${attrs}` : "";
  // 有 accessible name 就把它当元素内容（更接近 HTML，省 token）；没有就自闭合。
  const body = node.name ? `>${node.name}</${node.tag}>` : " />";
  return `${indent}${star}[${index}]<${node.tag}${attrStr}${body}`;
}

/**
 * 序列化成 `[12]<button id=add-cart>加入购物车</button>` 这种文本（§5.3a），
 * 并产出 selectorMap。`previousIds` 是上次快照的节点 id 集合，用来打 `*`
 * （本次新出现的节点，browser-use 的 is_new——对「点击后有什么变化」极有用）。
 */
export function serialize(nodes: NodeRecord[], previousIds?: Set<string>): SerializedPage {
  const byParent = new Map<string | null, NodeRecord[]>();
  for (const n of nodes) {
    const list = byParent.get(n.parent);
    if (list) list.push(n);
    else byParent.set(n.parent, [n]);
  }

  const isSemantic = (n: NodeRecord): boolean => n.vis && (n.int || n.role !== "" || n.name !== "");

  // 自底向上：subtree 里有没有「可见且有语义」的节点。整棵没有就剪掉（§5.2 的
  // 简化剪枝：只留可见+有 role/name/可交互的，及其祖先链）。
  const hasMeaningful = new Map<string, boolean>();
  const compute = (node: NodeRecord): boolean => {
    const children = byParent.get(node.id) ?? [];
    // 显式遍历：children.some(compute) 会短路，导致后面的 child 不被标记。
    let childHas = false;
    for (const child of children) if (compute(child)) childHas = true;
    const val = isSemantic(node) || childHas;
    hasMeaningful.set(node.id, val);
    return val;
  };
  for (const root of byParent.get(null) ?? []) compute(root);

  const selectorMap: Record<number, NodeRecord> = {};
  const lines: string[] = [];
  let counter = 0;

  const walk = (node: NodeRecord, depth: number): void => {
    const children = byParent.get(node.id) ?? [];
    if (isSemantic(node)) {
      const index = ++counter;
      selectorMap[index] = node;
      lines.push(formatLine(node, index, depth, previousIds ? !previousIds.has(node.id) : false));
      for (const child of children) walk(child, depth + 1);
    } else if (hasMeaningful.get(node.id)) {
      // 纯结构容器但有语义后代：不占行，只贡献一层缩进。html/body 是文档骨架，不占。
      const next = node.tag === "html" || node.tag === "body" ? depth : depth + 1;
      for (const child of children) walk(child, next);
    }
    // 无语义且无语义后代 → 整棵丢弃。
  };

  for (const root of byParent.get(null) ?? []) walk(root, 0);
  return { indexedText: lines.join("\n"), selectorMap };
}

// ---- 跨 frame 拼接（C 的跨 frame 一半）----

/** stagehand 的 prefixXPath：把子 frame 的相对 XPath 拼到宿主 iframe 的绝对 XPath 后。 */
function prefixXPath(parentAbs: string, child: string): string {
  const p = parentAbs === "/" ? "" : parentAbs.replace(/\/$/, "");
  if (!child || child === "/") return p || "/";
  if (child.startsWith("//")) return p ? `${p}//${child.slice(2)}` : `//${child.slice(2)}`;
  const c = child.replace(/^\//, "");
  return p ? `${p}/${c}` : `/${c}`;
}

/**
 * 把每个 OOPIF frame 的根挂到父 frame 里的 iframe 宿主下，并把子 frame 的 XPath
 * 加上宿主前缀。宿主匹配靠 iframe 的 `src == 子 frame 的 url`——url 匹配是启发式
 * （同 url 的多个 iframe 会歧义，真实页面少见，mock 可精确控制）。elementHash /
 * parentBranchHash 不重算：browser-use 也是按 frame 独立算（DOM 树不跨 frame），
 * 所以子 frame 元素身份不受父 frame 结构变动影响。
 */
function stitchFrames(perFrame: Array<{ url: string; nodes: NodeRecord[] }>): NodeRecord[] {
  const main = perFrame[0];
  const children = perFrame.slice(1);
  if (!main) return [];
  const result = [...main.nodes];
  if (children.length === 0) return result;

  const byUrl = new Map<string, NodeRecord[]>();
  for (const child of children) byUrl.set(child.url, child.nodes);

  const used = new Set<string>();
  for (const node of main.nodes) {
    if (node.tag !== "iframe" && node.tag !== "frame") continue;
    const src = node.attrs.src;
    if (!src) continue;
    const childNodes = byUrl.get(src);
    if (!childNodes) continue;
    used.add(src);
    for (const child of childNodes) {
      if (child.parent === null) child.parent = node.id;
      child.xp = prefixXPath(node.xp, child.xp);
    }
    result.push(...childNodes);
  }

  // 没匹配到宿主的子 frame（url 对不上）：扁平保留，避免内容凭空消失。
  for (const child of children) {
    if (!used.has(child.url)) result.push(...child.nodes);
  }
  return result;
}

/** 合并所有 frame 并跨 frame 拼接 → 快照。 */
export function buildSnapshot(
  frames: FrameTrees[],
  revision: number,
  previousIds?: Set<string>,
): Snapshot {
  const perFrame = frames.map((f) => ({ url: f.url, nodes: mergeFrame(f) }));
  const nodes = stitchFrames(perFrame);
  const { indexedText, selectorMap } = serialize(nodes, previousIds);
  return {
    revision,
    url: frames[0]?.url ?? "",
    frames: frames.map((f) => ({ frameOrdinal: f.frameOrdinal, url: f.url })),
    nodes,
    indexedText,
    selectorMap,
  };
}
