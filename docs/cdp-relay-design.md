# cdp-relay —— 设计与路线

> 把一个**已经开着、已经登录**的浏览器，变成一等公民的自动化目标。

参照系：
- `browserbase/stagehand@a21633d`
- `browser-use/browser-use@85ddbfe`

代码：`~/Developer/cdp-relay`（协议 v4）。契约见该仓库 `docs/SPEC.md`。

> **本文里的数字全是实测的**，2026-08-24 在真实 Chrome 上跑的（`learning.oreilly.com` +
> 一个本地 dev app）。上一版文档里的估算有两处错了一个数量级以上，都已按实测改正，
> 并在文中标出。凡是没量过的，明确写「未实测」。

---

## 1. 一句话定位

**一条到已登录浏览器的多路复用通道（transport）+ 一份 agent 级的页面模型（page model）+ 一层可缓存自愈的动作原语（actions），三层都能单独使用。**

跟两个参照系的关系：

| | 它做什么 | 我们跟它的关系 |
|---|---|---|
| `stagehand` | 浏览器内运行时 + act/observe/extract | 抄它的**页面模型**与**自愈结构**；不抄部署形态（它要自己 launch） |
| `browser-use` | 完整自主 agent | 抄它的**序列化格式**与**动作守卫**；不抄 agent loop |

**cdp-relay 不是 agent。** 它是 agent 站的地板。控制流由使用者写。

---

## 2. 分层

```
┌─ L3 actions ──── observe / act / extract ── cache + self-heal + 批量守卫   ← 未开始
├─ L2 page model ─ snapshot → indexed text + selectorMap + 三级身份          ← 未开始
├─ L1 transport ── 多路复用 RPC（per-tab 并发）+ 事件订阅                     ← ✅ v3 + v4
└─ L0 browser ──── extension ── chrome.debugger ── tab                      ← ✅
```

每层都是对外表面，可以只用下面几层：

- 只要 L1 → 你自己发 CDP，它当管道
- 要 L2 → 拿到给 LLM 的页面表示和稳定元素身份，推理你自己做
- 要 L3 → 给一句话，它找元素并执行

### 对外三个表面

| 表面 | 给谁 | 状态 |
|---|---|---|
| **HTTP + `clients/ts`** | lilto 等直接消费者 | ✅ 见 `SPEC.md` |
| **CLI** | 人 / 脚本 | ✅ |
| **标准 CDP endpoint** | Playwright / puppeteer / browser-use | ⏸ 暂缓（SDK + CLI 已覆盖当前消费者，见 §11） |

标准 CDP 门面是采用率的关键：有了它，`browser-use` 传个 `cdp_url` 就能跑在用户已登录的浏览器上——这是我们独有、其它方案给不了的组合。

> **2026-08-24 修订：暂缓（YAGNI）。** 当前消费者（lilto）走 HTTP + `clients/ts`，
> 脚本走 CLI，两条已覆盖全部需要。G 的价值只在「接现成的 browser-use / Playwright
> 做自主 agent」时兑现，而 §11 明确不做自主 agent。等真有这个需求再补——地基
> （sessionId 寻址 + session 池）已在 v5 就位，届时是加一层语义映射，不是重来。

---

## 3. L1 已经做完了：实测数据

### 3.1 并发

v2 每个浏览器只允许一条命令在飞，靠位置配对响应。v3 给每条命令加了 id，`Map<id, waiter>`，按 tab 分 lane。

```
浏览器之间   并行   独立 ExtConn
tab 之间     并行   独立 lane
tab 之内     UNORDERED_CDP_METHODS 里的纯读并发（≤8），其余独占该 tab
```

实测（3 个真实标签页，各取一次 `Accessibility.getFullAXTree`）：

| | 串行 | 并发 | 加速 |
|---|---|---|---|
| **跨 tab** | 426ms | 102ms | **4.19x** |
| 同 tab 内只读 | 247ms | 182ms | 1.36x |

**`chrome.debugger` 不做内部串行化。** 上一版文档把这个列为待验证的 spike #3，现在有答案了：多 tab 同时在飞是安全的，而且并发耗时 ≈ 最慢那个 tab 单独的耗时，说明三个 renderer 确实在同时干活。

同 tab 内只有 1.36x，符合预期：同一个 renderer 的 CDP 命令还是在它的主线程上按序执行，能省的只有中继往返。

### 3.2 单命令往返：1.0ms

> ⚠️ **上一版估的是 5–10ms，实测 1.0ms（n=20）。差一个数量级。**

这削弱了「tab 内并发能省掉 N 次往返」的分量：20 个 frame 的 AX 树并发，省下的往返只有 ~20ms。真正的收益全在「OOPIF 分属不同 renderer」那一半。

**tab 内并发仍然值得开着（1.36x 白拿），但它不是主要矛盾。设计取舍时按跨 tab 算收益。**

### 3.3 事件订阅

v3 及以前 attach 就无条件 `Network.enable` + `Runtime.enable` + `Page.enable` 并全量转发。v4 改成声明式订阅：attach 带 selector 列表，扩展只 enable 蕴含的域，并在 `onEvent` 第一行按方法过滤——在 stringify / send / store 之前。

实测（同一个页面加载三次，本地 dev app）：

| 订阅 | 过 WS 的事件 | 相对洪水 |
|---|---|---|
| `Network.* + Runtime.* + Page.*`（= v3 行为） | **512** | — |
| `net` preset | **212** | −58.6% |
| `nav`（**v4 默认**） | **3** | **−99.4%** |

洪水那 512 条里最大的一块：

```
140  Network.dataReceived              ← 每个数据块一条，27%，无消费者
 71  Network.requestWillBeSent
 71  Network.responseReceived
 70  Network.loadingFinished
 68  Network.requestWillBeSentExtraInfo
 68  Network.responseReceivedExtraInfo
  6  Runtime.executionContextCreated
```

`net` preset 刻意排除 `dataReceived` 这个决定，现在有数字支撑：**它一条就占洪水的 27%**。

扩展自报计数器：`matched 740 · filtered 303 · dropped 0`。注意这只反映「域已 enable、方法被过滤」那一层；**更大的一块是根本没 enable 的域**——那些事件浏览器压根不生成，计数器看不见。这也是为什么默认 `nav` 能到 3 条。

> 这个数字是**下限**：本地 dev app 没有广告、追踪、第三方脚本。真实电商页会重得多。

### 3.4 其它已落地的

- **offscreen 心跳**：offscreen document 持一条 Port 每秒 postMessage，让 SW 的 idle 计时器根本不启动。`chrome.alarms` 降级为纯复活手段。
  > ⚠️ 上一版说 alarm「24s，压在 30s 阈值下，只有 5 秒余量」——**错的**。Chrome 把 alarm 周期钳在 30s 下限，`periodInMinutes: 0.4` 实际是 0.5。那条兜底线一直压在阈值**上**。
- **超时与 detach 不再错配响应**：id 退休后迟到的响应无处可落。v2 会把它交给下一条命令的 waiter，之后每条响应错开一格。
- **`detached` 立刻取消该 tab 的在途命令**（409），不再各自挂满 30s。
- **`/events` 增量游标**：每条事件带 `seq`，响应带 `nextSeq` / `dropped` / `truncated`。`truncated` 是「丢了事件」和「什么都没发生」的唯一区别。
- **结构化错误码**：14 个封闭值 + `retriable`，`error` 保持人读字符串。
- **`clients/ts`**：跟协议同仓同 commit 的 typed client。
- **`sessionId` 寻址（v5）**：`cdp` 命令和事件都可带 `sessionId`，能寻址 flat auto-attach 出来的 OOPIF 会话。真浏览器验过，见 §8。

---

## 4. 关键决策：语义层放在 daemon，不放在扩展

stagehand 把全部逻辑放进扩展（34k 行）。我们不这么做，理由有三：

**a. 数据量决定了扩展必须做「减法」，但只做减法。**

实测三棵原始树（`JSON.stringify` 后）：

| 页面 | `DOM.getDocument` | `Accessibility.getFullAXTree` | `DOMSnapshot.captureSnapshot` | 合计 |
|---|---|---|---|---|
| learning.oreilly.com | 648 KB / 45ms | 684 KB / 80ms（1955 节点） | 1395 KB / 119ms | **2.7 MB** |
| 本地 dev app | 1039 KB / 55ms | 735 KB / 85ms（2121 节点） | 621 KB / 82ms | **2.4 MB** |

> ⚠️ **上一版写的是「一个重页面的原始三棵树 5–10MB」，实测 2.4–2.7MB。高估了 2–4 倍。**

结论要比上一版缓和：

- **DOM-first 路线**每次快照过 2.7MB，按实测速率约 **250ms** 的 SW 单线程时间，期间所有 tab 的命令排队
- **AX-first 路线**只要 DOM + AX ≈ 1.3MB，一半
- 剪到 100–300KB 是 ~10–30ms

**所以扩展侧剪枝该做，但不是入场费。** 先出一个不剪枝的版本把流程跑通是可行的，250ms 的偶发卡顿能忍。上一版「扩展必须先剪枝」的绝对说法作废。

剪枝之后剩下的规范化节点记录约 100–300KB（未实测），`stringify` 只要几 ms——**再往后的合并、序列化、哈希、缓存，全放 daemon 更好。**

**b. daemon 代码可以随时更新，扩展代码不能。** 扩展改一次所有用户要重载。序列化格式、提示词、缓存策略是最常改的部分，放扩展里等于给自己上枷锁。

**c. Node 有真线程，MV3 SW 没有。** daemon 里可以 worker_threads；SW 里一个大树遍历就把命令通道堵死。

### 分工

| 在扩展（薄） | 在 daemon（厚） |
|---|---|
| `chrome.debugger` I/O | 跨 frame 合并、XPath 前缀拼接 |
| 逐 frame 取三棵树 | 序列化成带索引文本 |
| **结构剪枝**（可延后，见上） | 三级身份计算与维护 |
| **事件按订阅过滤** ✅ 已做 | 动作缓存 + self-heal |
| **offscreen 心跳** ✅ 已做 | LLM 编排 |

**扩展代码量目标：< 1500 行**，且只有加新 CDP 能力时才需要动。（当前 `background.js` ~560 行。）

---

## 5. L2 页面模型 —— 两家的合成

### 5.1 路线选择：DOM-first，不是 AX-first

**这两家的方案不是同一个东西，是从相反的一端切进去。**

| | stagehand hybrid a11y snapshot | browser-use dom/serializer |
|---|---|---|
| 骨架 | **AX 树**，DOM 只做补充 | **DOM 树**，AX 只做补充 |
| CDP 树 | 2 棵 | 3 棵（多 `DOMSnapshot.captureSnapshot`） |
| 输出行 | `[3-1847] button: 加入购物车 [checked]` | `[12]<button id=add-cart type=submit>加入购物车</button>` |
| 几何 / 遮挡 | 无（另有 `coordinateResolver.ts`） | 有（bounds + paint order） |
| 规模 | ~2.9k 行 | serializer 目录 ~2.6k |

**选 DOM-first（抄 browser-use），三个理由：**

1. **AX 树会漏，而且实测到了。** spike 里第二个 `learning.oreilly.com` 标签页：**AX 只有 43 个节点 / 17KB，而 DOM 有 196KB、DOMSnapshot 有 1011KB**。走 AX-first 的话，那个页面在 LLM 眼里基本是空的。（也可能是后台标签页没渲染完——要坐实得切前台再量，但这个失败模式本身是真的：没有 role 的 div、纯 CSS 交互、canvas 内容，AX 都看不见。）
2. **结构更直白，好照搬**：三棵树 → 打平合并 → 剪枝 → 序列化，四阶段线性。stagehand 的 `capture.ts` 深度耦合 `Page` / `Frame` / `FrameSelectorResolver` 那一整套 understudy，抽出来要连根拔。
3. **输出格式更省 token 且 LLM 更懂**——`[12]<button …>` 本来就是 HTML。

**但跨 frame 的 XPath 前缀拼接抄 stagehand 的**（`xpathUtils.ts` 108 行 + `treeFormatUtils.injectSubtrees` 154 行）。这两个文件独立、好抽，而 browser-use 是按 target 各管各的，这块没做好。

### 5.2 扩展 → daemon 的线格式：NodeRecord

逐 frame 取 `DOM.getDocument` + `DOMSnapshot.captureSnapshot` + `Accessibility.getFullAXTree`，就地合并剪枝，输出扁平数组：

```jsonc
{
  "id":     "3-1847",        // frameOrdinal-backendNodeId
  "parent": "3-1840",
  "tag":    "button",
  "role":   "button",        // 来自 AX
  "name":   "加入购物车",     // AX name
  "attrs":  { "id": "add-cart", "class": "btn primary", "type": "submit" },  // 白名单
  "rect":   [120, 480, 96, 36],
  "vis":    1,
  "int":    1,               // 可交互
  "xp":     "/html/body/div[2]/button"   // frame 内相对 XPath
}
```

`id` 的格式直接抄 stagehand：

```ts
// stagehand: packages/extension/types/private/internal.ts
export type EncodedId = `${number}-${number}`;
```

**剪枝规则**：丢弃不可见、无 AX role 且无可交互性、且无可交互后代的子树。保留可滚动容器和 iframe 宿主（跨 frame 拼接需要）。

**取树的并发形状**：browser-use 的 `dom/service.py:388` 对所有 frame `asyncio.gather` 并发发 `Accessibility.getFullAXTree`。这三个方法都已经在 `UNORDERED_CDP_METHODS` 里，所以照搬这个形状就能直接吃到 §3.1 的 4.19x。

### 5.3 daemon 侧产出三样东西

**a. 给 LLM 的带索引文本** —— 抄 browser-use 的格式：

```
[12]<button id=add-cart type=submit>加入购物车</button>
[13]<input type=text placeholder=数量 />
	[14]<a href=/cart>查看购物车</a>
*[15]<div role=dialog>库存不足</div>
```

`*` = 本次快照相对上次**新出现的节点**（browser-use 的 `is_new`），对「点击后有什么变化」极有用。

**b. `selectorMap: Map<index, NodeRecord>`** —— 索引是 LLM 唯一需要说出口的东西。

**c. 三级身份** —— 两家的合成，本设计最重要的一处：

| 层级 | 是什么 | 生命周期 | 用途 | 来源 |
|---|---|---|---|---|
| **index** | `12` | 单次快照 | LLM 输出的唯一形式 | browser-use |
| **encodedId** | `3-1847` | 单次快照 | 内部寻址，查 XPath | stagehand |
| **elementHash** | `sha256(parentBranchPath + 静态属性 + axName)` | **跨快照、跨会话** | 缓存 key、self-heal 锚点 | browser-use |
| **xpath** | `/html/body/...` | 到下次 DOM 变更 | 实际执行 | 两家都有 |

`elementHash` 直接照搬 browser-use，包括**过滤动态 class** 这一手：

```python
# browser_use/dom/views.py — compute_stable_hash()
if k == 'class':
    v = filter_dynamic_classes(v)      # 去掉 focus/hover/animation 这类瞬态类
combined_string = f'{parent_branch_path_string}|{attributes_string}{ax_name}'
```

**为什么必须三级**：LLM 只会说 index（短、无幻觉空间）；执行要 xpath（快）；但 xpath 一次 DOM 变更就失效，跨会话复用必须靠 elementHash。少任何一级都会在某个环节崩。

### 5.4 快照失效：事件驱动，不轮询

daemon 为每个 tab 缓存一份快照，靠 CDP 事件置脏：

```
DOM.documentUpdated      → 脏
Page.frameNavigated      → 脏
Page.loadEventFired      → 脏
任何 perform 之后         → 脏
```

`Page.frameNavigated` / `loadEventFired` 已经在 v4 的 `nav` preset 里，成本实测 3 条事件。`DOM.documentUpdated` 要加一个 `dom` preset（enable `DOM` 域）。

**比 browser-use 的「动作后比对 URL」更准**——弹出模态框不改 URL，但 selectorMap 已经失效。

---

## 6. L3 动作层

### 6.1 三个原语

| | 输入 | 产出 | 是否执行 |
|---|---|---|---|
| `observe(instruction?)` | 快照 + 指令 | `Action[]` | ❌ |
| `act(instruction \| Action)` | 同上 | 执行结果 | ✅ |
| `extract(schema, instruction?)` | 快照/markdown | 符合 schema 的数据 | ❌ |

`Action` 是可序列化、可存盘、可重放的：

```jsonc
{
  "method": "click",
  "elementHash": "a3f9...",
  "xpath": "/html/body/div[2]/button",
  "args": [],
  "description": "加入购物车按钮"
}
```

**LLM 只返回 `{index, method, args}`**，其余字段由 daemon 查 selectorMap 补齐。动作词表封闭（抄 stagehand 的 11 个）：
`click / fill / type / press / scrollTo / selectOption / hover / doubleClick / dragAndDrop / nextChunk / prevChunk`

### 6.2 三级回退 —— 比 stagehand 多一级

stagehand 是两级：重放 xpath → 失败就整个重新推理。我们中间插一级：

```
1. xpath 命中          → 执行                                零成本
2. xpath 失效
   → 在当前快照里查 elementHash
   → 命中则用新 xpath 执行，并更新缓存                        零 LLM ★
3. elementHash 也没了  → 重新推理（self-heal），更新缓存        一次 LLM
```

★ 这一级是我们独有的。**页面结构挪动但元素本身没变**（最常见的改版形态）时，stagehand 会花一次 LLM，我们不花。

结构沿用 stagehand 的洞见——**缓存重放与 self-heal 是同一条 code path**：

```ts
// stagehand: packages/extension/services/actService.ts
/**
 * Replays cached actions deterministically — no LLM involved. Any failure
 * throws so the cache intercept falls back to the full inference pipeline,
 * which doubles as the self-heal path for stale cached selectors.
 */
```

### 6.3 缓存 —— 留给调用方

> **2026-08-24 修订：缓存不放进 daemon，留给调用方自己做。** 做完 F 之后边界更清楚了。

`key = sha256(归一化URL + instruction + 结构指纹) → value = Action[]` 这个映射的三块
输入里，两块是调用方的业务知识：

- **instruction**（「加购」「改地址」）是自然语言任务，daemon 只认识「一批动作」；
- **归一化 URL** 里「哪些 query 参数易变」（session token、时间戳）是站点相关的；
- 只有**结构指纹**（快照里 `elementHash` 的有序摘要）是 daemon 侧的，而调用方 act 之后也拿得到。

再加上 self-heal 的完整闭环需要 LLM，而 LLM 是调用方的（§11）。所以缓存放哪边都不会让
self-heal 更自治——daemon 重放全失效时照样得回头问调用方重新推理。

**daemon 的职责是「可无状态重放」，不是「缓存」**（§6.1：`Action` 可序列化、可存盘、可重放）：

| 谁 | 该做什么 |
|---|---|
| **daemon** | `Action[]` 重放 + 三级回退（xpath 失效 → elementHash 零 LLM 自愈 → `needsInference`）✅ |
| **调用方** | 存 `key → Action[]`，命中调 `/act` 重放，`needsInference` 时重新推理并写回（几行代码） |

对 lilto：主线站点走 `contracts/` 逆向出来的平台 API，比「快照→LLM→点击」快几个数量级；
缓存是**兜底**——没逆向过的新站点先跑通，跑通后这条指令由调用方缓存，之后重放接近零成本。

对「能写成流程图」的任务，效果不变：**首次跑用 LLM，之后重放零 token 毫秒级**——只是那个
KV 存在调用方手里，daemon 只管把动作原语做到无状态、可重放。

### 6.4 批量执行的两层守卫

抄 browser-use `multi_act`，并加强第二层：

```
第一层（静态）：动作声明 terminatesSequence
  navigate / goBack / goForward / switchTab / submit → 执行后丢弃队列剩余

第二层（运行时）：每个动作后检查
  url 变了            → 中断      （browser-use 有）
  焦点 target 变了     → 中断      （browser-use 有）
  快照脏标记被置位     → 中断      ★ 我们加的
```

★ 第三个条件靠 §5.4 的事件驱动脏标记，零额外成本，能抓住「模态框弹出 / 列表异步刷新」这类 URL 不变但 selectorMap 已废的情况——browser-use 现在会漏。

失败时**保留已成功的部分结果**（browser-use 的做法），让调用方知道走到哪一步了。

---

## 7. 后台标签页节流

我们 attach 的是用户已启动的浏览器，`--disable-background-timer-throttling` 这类参数加不上（browser-use 靠它们解决）。对策是**设计上不依赖页面内 JS 计时**：

- ❌ 注入 `setTimeout` 轮询等元素
- ✅ 等 CDP 事件（`Page.loadEventFired` / `DOM.documentUpdated` / `Network.responseReceived`）——由浏览器进程发出，不受渲染进程节流

动作用 `Input.dispatchMouseEvent`、状态用 AX 树，**都不经过页面 JS**，天然免疫。

---

## 8. flat session：已验证 ✅

**关键未知数已经有答案了：`chrome.debugger` 能表达 flatten session 语义。**

从 stagehand 读到的线索是：**它的扩展根本不用 `chrome.debugger` 当数据通道**——它开一条裸 WS 到浏览器自己的 CDP endpoint（`understudy/browserWebSocketTransport.ts`），flatten session 多路复用。`chrome.debugger` 在它 34k 行里只出现在一个文件 `understudy/chromeTabs.ts`，只调 `getTargets()` 做 tabId ↔ targetId 映射。

我们做不到同样的事（前提就是没有 `--remote-debugging-port`），但 `chrome.debugger.sendCommand` 的第一个参数从 Chrome 125 起是 `DebuggerSession`，带可选 `sessionId`。

**实测**（`127.0.0.1` 的页面嵌 `https://example.com`，不同 eTLD+1，必然 OOPIF）：

```
1. 不带 sessionId，DOM.getDocument{depth:-1, pierce:true}
     看得见宿主页的 host-button        ✓
     看得见 iframe 里的 Example Domain  ✗      ← 能力缺口，实锤

2. Target.setAutoAttach{autoAttach:true, flatten:true}
     → Target.attachedToTarget  sessionId=14ECF1C2BE72…  type=iframe  url=https://example.com/

3. 带这个 sessionId 再发 DOM.getDocument
     返回 3.5KB，含 example.com 内容 ✓，不含宿主页 host-button ✓   ← 精确寻址到了那个 frame

4. 传一个假 sessionId
     -32001 Session with given id not found.                      ← 字段真被解析，不是忽略
```

**结论：OOPIF 可达，标准 CDP 门面可行。** v5 已经把 `sessionId` 打通到 `/send` 和事件上。

门面本身还没做，且**暂缓**（见 §2 / §11）：当前 SDK + CLI 已覆盖需要。形态照旧记录在此，将来接 browser-use 时照这个做：`/json/version` + `/devtools/browser/<id>` WS，说真 CDP。有了它，`browser-use` 传个 `cdp_url` 就能跑在已登录浏览器上——这是我们独有、其它方案给不了的组合。

---

## 9. 剩下的：session 生命周期管理

传输层通了（v5），但**寻址能力 ≠ 会话管理**。还缺三样：

1. **attach 时自动 `setAutoAttach`**，而不是让调用方自己记得发
2. **per-tab 的 session 池**，跟着 `Target.attachedToTarget` / `detachedFromTarget` 事件维护
3. **事件按 session 归属**——扩展已经在推 `sessionId` 了，daemon 侧还没建索引

注意一个坑：**同站子域不是 OOPIF**。站点隔离按 site（scheme + eTLD+1）算，所以 `a.claude.ai` 嵌在 `claude.ai` 里是同进程，`accounts.youtube.com` 嵌在 `youtube.com` 里也是。实测扫了 13 个真实标签页，「跨源」的三个全是同站子域，一个真 OOPIF 都没有——**得跨 eTLD+1 才会分进程**。这既说明缺口没想象中那么普遍，也说明测的时候不能随便找个 iframe 就当 OOPIF。

**lane 粒度仍然是 tab。** OOPIF 的 session 跟宿主 tab 共享焦点、对话框、导航，所以排序必须在 tab 粒度决定——session 是地址，不是并发域。

**长期状态要以 `targetId` 为键，不是 `sessionId`**：后者 detach/reattach 后会变。browser-use 的 `SessionManager` 是这块的参考实现，它踩过的一个坑值得记：

```python
# browser_use/browser/session_manager.py:48
# cdp-use's event registry is single-slot per CDP method, so per-session handler
# registrations would replace each other and leave every tab but the most
# recently attached one without lifecycle events.
```

browser-use 的 `SessionManager` 是这块的参考实现（单一真源，靠 `Target.attachedToTarget` / `detachedFromTarget` 事件维护 session 池）。有一条它踩过的坑值得记：

```python
# browser_use/browser/session_manager.py:48
# cdp-use's event registry is single-slot per CDP method, so per-session handler
# registrations would replace each other and leave every tab but the most
# recently attached one without lifecycle events.
```

我们现在的结构（一个 `onEvent` → 按 tabId 进 ring）碰巧是对的。但加 sessionId 后，事件归属键要统一到 **targetId**，不是 `(tabId, sessionId)`——sessionId 在 detach/reattach 后会变，targetId 不会。

---

## 10. 路线

排期按**真实依赖**，不按愿望。

> 上一版这里写着「`elementHash` 和 `multi_act` 守卫不依赖快照，现在就能做」。
> **读完 browser-use 的实现，对 `elementHash` 是错的。** 它的三个输入（parent
> branch path、静态属性、`ax_name`）需要一棵合并好的 DOM + AX 树，那正是 L2
> 数据管线的前半截。它不需要的只是后半截：剪枝、序列化成 LLM 文本、index。

```
                    ┌─ 事件驱动脏标记 ──→ multi_act 第三层守卫
                    │                     快照失效
   零依赖 ──────────┘

   session 生命周期 ─────────┐   前置：否则下面拿到的树漏掉所有跨站 iframe
                             ▼
                  取三棵树 + 跨 frame 合并（NodeRecord）
                        ├──→ elementHash / parentBranchHash ──→ 动作缓存 + 三级回退
                        └──→ 剪枝 + 序列化 + index (selectorMap) ──→ observe / act / extract

   flat session 传输 ✅ v5 已通
```

| | 内容 | 依赖 |
|---|---|---|
| ✅ | L0 + L1：多浏览器、per-tab 并发、事件订阅、`sessionId` 寻址、HTTP 接口 | — |
| **A** | **事件驱动脏标记** | 无。v4 已经在推 `Page.frameNavigated` / `loadEventFired`，加个 `DOM.documentUpdated` 订阅和一个标志位 |
| **B** | **session 生命周期**（自动 `setAutoAttach` + per-tab session 池 + 事件按 target 归属） | v5 |
| C | 取三棵树 + 跨 frame 合并 → NodeRecord | B |
| D | `elementHash` / `parentBranchHash` | C |
| E | 剪枝 + serializer（DOM-first）+ selectorMap | C |
| F | L3：动作层 + 三级回退 + 两层半守卫（缓存留给调用方，见 §6.3） | A + D + E |
| G | 标准 CDP 门面（⏸ 暂缓，YAGNI，见 §2 / §11） | B |

**A 是唯一真·零依赖的**，而且它同时是两个下游的地基（第三层守卫、快照失效）。先做它。

**B 现在是瓶颈**，不是因为难，是因为 C/E/G 全压在上面。而 C 之前做 E 没意义——树是漏的。

**关于 D 和 E 的先后**：两者都只依赖 C，可以并行。但如果只能做一个，先做 **D**——理由见下。

### 为什么 L2/L3 对 lilto 不是主线

lilto 有 `contracts/` 和 `recon/`——手工逆向出来的平台端点契约，走 `evalFn` 直接调站点自己的 API。对**已知站点**，那比「快照 → LLM 推理 → 点击」快好几个数量级，也准得多、便宜得多：一次 fetch，对比一次 50KB prompt + 一次 LLM 往返 + 一次点击 + 等页面。

所以 E/F 对 lilto 是**兜底**，不是主路：

- 没逆向过的新站点，先用页面模型跑通，再逆向成 contract
- 逆向不出来、必须在页面上填的流程
- 站点改版导致 contract 失效时的自愈

而 **D（`elementHash`）跟 contract 路线是叠加的**：它解决「同一个元素在页面重绘后还认不认得出来」，走 contract 也一样会踩——手写的 `.sku` 选择器一样会在改版时碎。这是把 D 排在 E 前面的理由。

### 关于剪枝的时机

实测三棵原始树是 **2.4–2.7MB**（上一版估 5–10MB，高估 2–4 倍）。按实测速率约 250ms 的 SW 单线程时间，期间所有 tab 的命令排队。

**所以剪枝该做，但不是入场费。** E 可以先出一个不剪枝的版本把流程跑通，250ms 的偶发卡顿能忍。上一版「扩展必须先剪枝」的绝对说法作废。

## 11. 明确不做

- **不做 agent loop**。没有自主决策、没有记忆压缩、没有 planning。要自主 agent 就把 browser-use 接到标准 CDP 门面上。
- **暂缓标准 CDP 门面（G）**。它是「接现成 browser-use / Playwright」的入口，而那是自主 agent 场景才需要的；当前 lilto 走 HTTP + `clients/ts`、脚本走 CLI，已覆盖全部需要。地基（sessionId 寻址 + session 池）在 v5 已就位，将来要接时是加一层语义映射。
- **不 launch 浏览器**。launch 是别人已经做好的事，且一旦 launch 就失去存在的理由（已登录的真实浏览器）。
- **不做云端**。缓存、LLM 调用全部本地或由调用方提供。
- **不重实现 Playwright 语义层**。stagehand 的 `understudy` 是 34k 行的巨大投入，我们通过标准 CDP 门面直接复用现成的 Playwright。

---

## 12. 未实测清单

按重要性排：

1. **剪枝后的实际体积**（§4a）——假设 100–300KB，没量过。原始 2.4–2.7MB 已实测。决定 E 要不要在扩展里做减法。
2. **那个 43 节点的 AX 树**（§5.1）——是后台标签页没渲染完，还是 AX 本身就漏。切前台再量一次。这条是 DOM-first 选型的主要证据，值得坐实。
3. **真实电商页的事件量**（§3.3）——58.6% / 99.4% 是在本地 dev app 上量的，是下限。
4. **一个 tab 上几十个 OOPIF 时的 session 管理开销**（§9）——`setAutoAttach` 在广告位密集的页面上会一次冒出很多 session，没量过。

### 已结案

- ~~`chrome.debugger` 的 `sessionId` 支持~~ → §8，2026-08-24 实测通过，v5 已落地
- ~~`chrome.debugger` 并发发命令的稳定性~~ → §3.1，跨 tab 4.19x，不串行化
- ~~原始三棵树的体积~~ → §4a，2.4–2.7MB（原估 5–10MB）
