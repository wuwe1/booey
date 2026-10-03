// Calibrate the 2.5-level fuzzy relocation (daemon/page-model.ts) on realistic
// "page redesign" mutations, so the thresholds (minScore 0.72 / minMargin 0.12)
// and weights rest on measured numbers, not a guess (design doc §6.2).
//
//   node test/calibrate-fuzzy.mjs            # synthetic pages (runs anywhere)
//   node test/calibrate-fuzzy.mjs --sweep    # + a threshold sweep table
//
// Real snapshots: drop `POST /snapshot` dumps (the Snapshot JSON) into
// test/fixtures/snapshots/*.json and they are mutated and measured too — no code
// change. Capture them with `booey snapshot <tab> --full > a.json`.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { fingerprintOf, fuzzyRelocate } from "../daemon/page-model.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SWEEP = process.argv.includes("--sweep");

// ---- a synthetic "before" page: unique products + some ambiguous repeats ----

function node(id, tag, role, name, attrs, xp) {
  return {
    id,
    parent: null,
    tag,
    role,
    name,
    attrs,
    rect: [0, 0, 20, 20],
    vis: true,
    int: role !== "",
    xp,
    elementHash: `h-${id}`,
    parentBranchHash: `p-${id}`,
  };
}

function syntheticPage() {
  const nodes = [];
  // a nav bar — unique link names
  for (const [i, label] of ["首页", "我的订单", "优惠券", "设置"].entries()) {
    nodes.push(
      node(
        `nav-${i}`,
        "a",
        "link",
        label,
        { href: `/${i}`, class: "nav-item" },
        `/html[1]/body[1]/nav[1]/a[${i + 1}]`,
      ),
    );
  }
  // a product grid — unique product names, but every row's buttons repeat (ambiguous)
  for (let r = 0; r < 8; r++) {
    const base = `/html[1]/body[1]/main[1]/div[${r + 1}]`;
    nodes.push(
      node(
        `title-${r}`,
        "a",
        "link",
        `无线蓝牙耳机 Pro ${r + 1} 代`,
        { href: `/p/${r}`, class: "product-title" },
        `${base}/a[1]`,
      ),
    );
    nodes.push(
      node(
        `cart-${r}`,
        "button",
        "button",
        "加入购物车",
        { id: `add-${r}`, type: "button", class: "btn btn-primary" },
        `${base}/button[1]`,
      ),
    );
    nodes.push(
      node(
        `buy-${r}`,
        "button",
        "button",
        "立即购买",
        { id: `buy-${r}`, type: "submit", class: "btn btn-accent" },
        `${base}/button[2]`,
      ),
    );
  }
  // a form — unique field names
  nodes.push(
    node(
      "q",
      "input",
      "textbox",
      "搜索商品",
      { id: "search", type: "search", placeholder: "搜索商品" },
      "/html[1]/body[1]/header[1]/input[1]",
    ),
  );
  nodes.push(
    node(
      "submit",
      "button",
      "button",
      "搜索",
      { id: "do-search", type: "submit", class: "search-btn" },
      "/html[1]/body[1]/header[1]/button[1]",
    ),
  );
  return { nodes };
}

// ---- mutations: four redesign profiles, assigned deterministically ----

const HASH = () => Math.random().toString(36).slice(2, 8); // CSS-module build hash
function churnClass(cls) {
  if (!cls) return cls;
  return cls
    .split(/\s+/)
    .map((c) => `${c.replace(/-/g, "_")}__${HASH()}`)
    .join(" ");
}
function wrapXp(xp) {
  // insert a wrapper <div> just under <body> — the most common redesign shape
  return xp.replace("/body[1]/", "/body[1]/div[1]/");
}
function bumpIndex(xp) {
  // a sibling was inserted before it: the last [n] grows
  return xp.replace(/\[(\d+)\](?!.*\[\d+\])/, (_, n) => `[${Number(n) + 1}]`);
}

const PROFILES = ["light", "light", "medium", "medium", "heavy", "replaced"]; // ~weights

/** Mutate the page; return { nodes, truth } where truth maps beforeId → afterId|null. */
function redesign(before) {
  const after = [];
  const truth = new Map();
  let k = 0;
  for (const n of before.nodes) {
    const profile = PROFILES[k++ % PROFILES.length];
    const a = structuredClone(n);
    a.id = `a-${n.id}`;
    a.elementHash = `h2-${n.id}`;
    if (profile === "replaced") {
      // the element is gone / replaced by something unrelated → correct answer is abstain
      a.tag = "div";
      a.role = "";
      a.name = "";
      a.int = false;
      a.attrs = { class: churnClass("placeholder") };
      a.xp = wrapXp(n.xp);
      after.push(a);
      truth.set(n.id, null);
      continue;
    }
    if (n.attrs.class) a.attrs.class = churnClass(n.attrs.class);
    if (profile === "medium" || profile === "heavy") a.xp = bumpIndex(wrapXp(n.xp));
    if (profile === "heavy") {
      delete a.attrs.id; // id dropped
      if (a.name) a.name = `${a.name} `; // a trailing-space tweak
    }
    after.push(a);
    truth.set(n.id, a.id);
  }
  // shuffle so order carries no signal
  for (let i = after.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [after[i], after[j]] = [after[j], after[i]];
  }
  return { nodes: after, truth };
}

// ---- measure ----

function measure(before, afterSnap, opts) {
  const { nodes: afterNodes, truth } = afterSnap;
  let correct = 0; // relocated to the ground-truth node
  let wrong = 0; // relocated to a DIFFERENT node (the dangerous outcome)
  let abstainWithTarget = 0; // a valid target existed but fuzzy gave up (→ LLM)
  let abstainCorrect = 0; // no valid target and fuzzy correctly gave up
  let targets = 0; // cases that had a valid target
  for (const n of before.nodes) {
    if (!n.int) continue; // only action targets
    const want = truth.get(n.id);
    if (want != null) targets++;
    const m = fuzzyRelocate(fingerprintOf(n), afterNodes, opts);
    if (!m) {
      if (want == null) abstainCorrect++;
      else abstainWithTarget++;
      continue;
    }
    if (m.node.id === want) correct++;
    else wrong++;
  }
  const relocated = correct + wrong;
  return {
    targets,
    correct,
    wrong,
    abstainWithTarget,
    abstainCorrect,
    precision: relocated ? correct / relocated : 1, // of what it acted on, how much was right
    recall: targets ? correct / targets : 1, // of findable elements, how many it found
  };
}

function realSnapshots() {
  const dir = resolve(ROOT, "test/fixtures/snapshots");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => {
      const j = JSON.parse(readFileSync(resolve(dir, f), "utf8"));
      return { name: f, nodes: j.nodes ?? j.snapshot?.nodes ?? [] };
    })
    .filter((s) => s.nodes.length > 0);
}

// ---- run ----

const RUNS = 40; // average over many random redesigns
const sources = [{ name: "synthetic", nodes: syntheticPage().nodes }, ...realSnapshots()];

console.log(
  `calibrate-fuzzy — ${RUNS} redesigns per source; default minScore=0.72 minMargin=0.12\n`,
);
for (const src of sources) {
  const agg = { targets: 0, correct: 0, wrong: 0, abstainWithTarget: 0, abstainCorrect: 0 };
  for (let i = 0; i < RUNS; i++) {
    const m = measure({ nodes: src.nodes }, redesign({ nodes: src.nodes }), {});
    for (const k of Object.keys(agg)) agg[k] += m[k];
  }
  const relocated = agg.correct + agg.wrong;
  const precision = relocated ? agg.correct / relocated : 1;
  const recall = agg.targets ? agg.correct / agg.targets : 1;
  console.log(`[${src.name}]  nodes=${src.nodes.length}`);
  console.log(
    `  precision ${(precision * 100).toFixed(1)}%  (acted ${relocated}, wrong ${agg.wrong})`,
  );
  console.log(
    `  recall    ${(recall * 100).toFixed(1)}%  (targets ${agg.targets}, deferred-to-LLM ${agg.abstainWithTarget})`,
  );
  console.log(`  abstained-correctly ${agg.abstainCorrect} (replaced elements)\n`);
}

if (SWEEP) {
  const src = { nodes: syntheticPage().nodes };
  console.log("threshold sweep (synthetic):  minScore  →  precision / recall / wrong");
  for (const minScore of [0.55, 0.6, 0.65, 0.7, 0.72, 0.75, 0.8]) {
    const agg = { targets: 0, correct: 0, wrong: 0 };
    for (let i = 0; i < RUNS; i++) {
      const m = measure(src, redesign(src), { minScore });
      agg.targets += m.targets;
      agg.correct += m.correct;
      agg.wrong += m.wrong;
    }
    const relocated = agg.correct + agg.wrong;
    const p = relocated ? (agg.correct / relocated) * 100 : 100;
    const r = agg.targets ? (agg.correct / agg.targets) * 100 : 100;
    console.log(`  ${minScore.toFixed(2)}      ${p.toFixed(1)}% / ${r.toFixed(1)}% / ${agg.wrong}`);
  }
}
