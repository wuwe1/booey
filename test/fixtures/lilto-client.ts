/**
 * cdp-relay daemon 的 typed HTTP 客户端。协议契约见 relay/SPEC.md。
 *
 * 三段链路:this ──HTTP──▶ daemon ──WS──▶ extension ──chrome.debugger──▶ tab。
 * 我们只碰第一段;daemon 是本机 127.0.0.1、无鉴权(同机信任)。
 *
 * 关键约束(SPEC):
 * - 单命令 30s 无响应 → daemon 504。长活儿在页面里轮询,别指望单次 eval 撑住。
 * - /send 前必须 attach,否则 409。
 * - 多浏览器:browser 选择器 = browserId 或 label;只连了一个时可省。
 * - chrome.debugger 的业务错误走 200 + ok:false(不是 5xx)。
 */

export interface TabInfo {
	tabId: number;
	url: string;
	title: string;
}

export interface BrowserInfo {
	id: string;
	label: string;
	attached: number[];
	tabCount: number;
}

/** daemon / 传输层失败(HTTP 非 2xx、连不上、debugger 报错) */
export class RelayError extends Error {}
/** 页面里的 JS 抛了异常(exceptionDetails);业务侧错误,和 RelayError 分开接 */
export class PageJsError extends Error {}

export function isRelayConnectionFailure(error: unknown): boolean {
	return (
		error instanceof RelayError ||
		/unreachable|no browser matching|no tab matching|disconnected|断线|掉线|浏览器|daemon|relay|timeout|超时/i.test(
			String((error as Error)?.message ?? error),
		)
	);
}

export interface RelayOptions {
	base?: string;
	/** 多浏览器时指定目标:browserId 或 label。只连一个可省。 */
	browser?: string;
	/** 只给不能长期阻塞 UI 的短查询使用。页面命令默认仍由 daemon 的 30s 超时控制。 */
	timeoutMs?: number;
	/** 每次真正发给 relay 前执行；Dashboard 用它阻止租约失效后的后续浏览器调用。 */
	beforeRequest?: () => void;
}

export class RelayClient {
	private base: string;
	private browser?: string;
	private timeoutMs?: number;
	private beforeRequest?: () => void;

	constructor(opts: RelayOptions = {}) {
		this.base = opts.base ?? process.env.LILTO_RELAY ?? "http://127.0.0.1:9224";
		this.browser = opts.browser ?? process.env.CDP_RELAY_BROWSER ?? undefined;
		this.timeoutMs = opts.timeoutMs;
		this.beforeRequest = opts.beforeRequest;
	}

	/** 当前固定到的 relay 浏览器；店铺写入守卫用它核对人工确认绑定。 */
	selector(): string | undefined {
		return this.browser;
	}

	private async req<T>(method: string, path: string, body?: Record<string, unknown>): Promise<T> {
		this.beforeRequest?.();
		// browser 选择器:GET 走 query,POST 走 body(SPEC「CLI ↔ daemon」)
		let url = this.base + path;
		let payload = body;
		if (this.browser) {
			if (method === "GET") url += `${path.includes("?") ? "&" : "?"}browser=${encodeURIComponent(this.browser)}`;
			else payload = { browser: this.browser, ...body };
		}

		let res: Response;
		try {
			res = await fetch(url, {
				method,
				headers: payload ? { "content-type": "application/json" } : undefined,
				body: payload ? JSON.stringify(payload) : undefined,
				signal: this.timeoutMs ? AbortSignal.timeout(this.timeoutMs) : undefined,
			});
		} catch (e) {
			throw new RelayError(`daemon unreachable at ${this.base} — start it with \`pnpm daemon\` (${(e as Error).message})`);
		}

		const text = await res.text();
		let json: unknown;
		try {
			json = JSON.parse(text);
		} catch {
			throw new RelayError(`daemon ${res.status}: ${text.slice(0, 200)}`);
		}
		if (!res.ok) {
			const msg = (json as { error?: string }).error ?? res.statusText;
			throw new RelayError(`daemon ${res.status}: ${msg}`);
		}
		return json as T;
	}

	async browsers(): Promise<BrowserInfo[]> {
		const r = await this.req<{ browsers: BrowserInfo[] }>("GET", "/browsers");
		return r.browsers;
	}

	async tabs(): Promise<TabInfo[]> {
		const r = await this.req<{ tabs: TabInfo[] }>("GET", "/tabs");
		return r.tabs;
	}

	/** 只读扩展已推送到 daemon 的标签页快照；不向扩展发送 list-tabs。 */
	async cachedTabs(): Promise<TabInfo[]> {
		const r = await this.req<{ tabs: TabInfo[] }>("GET", "/tabs?fresh=0");
		return r.tabs;
	}

	/**
	 * 按 URL 正则找 tab。优先读扩展主动推送的快照，避免 list-tabs 排在长 CDP
	 * 命令后面，把本来已经打开的站点误报成 30s Relay timeout。快照没命中时
	 * 才现查一次，兼容刚打开但 tabs-changed 还没到 daemon 的标签页。
	 */
	async findTab(urlRe: RegExp): Promise<TabInfo> {
		const cached = await this.cachedTabs();
		const cachedHit = cached.find((t) => urlRe.test(t.url));
		if (cachedHit) return cachedHit;
		const fresh = await this.tabs();
		const hit = fresh.find((t) => urlRe.test(t.url));
		if (!hit) throw new RelayError(`no tab matching ${urlRe} — open the site and log in first`);
		return hit;
	}

	async attach(tabId: number): Promise<void> {
		await this.req("POST", "/attach", { tabId });
	}

	async detach(tabId: number): Promise<void> {
		await this.req("POST", "/detach", { tabId });
	}

	/**
	 * 在页面 MAIN world 跑 JS,returnByValue 取回结果(须可 JSON 序列化)。
	 * chrome.debugger 的 Runtime.evaluate 绕过页面 CSP —— 这是整套设计存在的理由。
	 * 页面抛错 → PageJsError;30s 未完成 → daemon 504(RelayError)。
	 */
	async eval<T>(tabId: number, expression: string, awaitPromise = false, userGesture = false): Promise<T> {
		const r = await this.req<
			| {
					ok: true;
					result: {
						result?: { value?: unknown };
						exceptionDetails?: { text: string; exception?: { description?: string } };
					};
			  }
			| { ok: false; error: { message: string } }
		>("POST", "/send", {
			tabId,
			method: "Runtime.evaluate",
			params: { expression, returnByValue: true, awaitPromise, userGesture },
		});
		if (!r.ok) throw new RelayError(`debugger: ${r.error.message}`);
		const ex = r.result.exceptionDetails;
		if (ex) throw new PageJsError(ex.exception?.description ?? ex.text);
		return r.result.result?.value as T;
	}

	/**
	 * 把一个本仓库里的 TS 函数搬进页面执行 —— 站点逻辑的唯一出口。
	 *
	 * 原理:node 的原生 type stripping 把类型标注换成等长空白,所以 `fn.toString()`
	 * 拿到的是语义等价的合法 JS。没有打包器 = 没有 esbuild keepNames 的 `__name`
	 * 包装,不需要 listo 里那个 nameSafe 垫片。
	 *
	 * 代价:fn 必须自包含 —— 不能引用模块作用域的 import / 常量 / 闭包变量(搬过去
	 * 就是自由变量,页面里 ReferenceError)。要传东西一律走 args(JSON 序列化)。
	 */
	async evalFn<A extends readonly unknown[], R>(tabId: number, fn: (...args: A) => R, ...args: A): Promise<Awaited<R>> {
		const call = `(${fn.toString()})(${args.map((a) => JSON.stringify(a) ?? "undefined").join(",")})`;
		// 返回 Promise 的函数要 awaitPromise;静态判不出,一律开(同步值不受影响)。
		return this.eval<Awaited<R>>(tabId, call, true);
	}

	/**
	 * 通过 CDP 导航，不在旧页面 MAIN world 执行 location.href。1688 商铺页曾让
	 * Runtime.evaluate 卡满 30s；Page.navigate 不依赖页面主线程。不等 load，页面
	 * 就绪仍由站点抽取器轮询。
	 */
	async navigate(tabId: number, url: string): Promise<void> {
		const response = await this.req<{ ok: true; result: { errorText?: string } } | { ok: false; error: { message: string } }>(
			"POST",
			"/send",
			{ tabId, method: "Page.navigate", params: { url } },
		);
		if (!response.ok) throw new RelayError(`debugger: ${response.error.message}`);
		if (response.result.errorText) throw new RelayError(`Page.navigate: ${response.result.errorText}`);
	}

	/**
	 * 开一个新标签页,后台开,不抢焦点。
	 *
	 * 走扩展的 chrome.tabs.create({ active: false })。CDP 那边确实没有开标签页这个
	 * 操作(扩展是 per-tab 附着的,拿不到 browser 级的 Target.createTarget),但
	 * chrome.tabs.create 是扩展 API,不需要 debugger 附着 —— 这条路一直都在。
	 *
	 * 新标签页继承同一个 profile 的 cookie —— 这就是「不用重新登录」还成立的原因。
	 * 但如果这个 profile 从没登录过那个站,开出来的就是登录页,blockProbe 会认出来。
	 */
	async openTab(url: string, opts: { timeoutMs?: number } = {}): Promise<TabInfo> {
		let tab: TabInfo;
		try {
			const r = await this.req<{ ok?: boolean; result?: { tab: TabInfo } }>("POST", "/open-tab", { url });
			if (!r.result?.tab) throw new RelayError(`开标签页失败:${url}`);
			tab = r.result.tab;
		} catch (e) {
			// 装着旧扩展 / 旧 daemon 的浏览器没有这条路。降级到借页面 window.open ——
			// 它会把窗口提到前台,所以只当兜底,不当主路。
			if (!(e instanceof RelayError) || !/404|open-tab|unknown/i.test(e.message)) throw e;
			return this.openTabByWindowOpen(url, opts);
		}

		// chrome.tabs.create 立刻返回,那一刻 url 常常还是空的或 about:blank。
		// 等扩展把导航后的地址报上来,拿不到就退回创建时那份。
		const deadline = Date.now() + (opts.timeoutMs ?? 15_000);
		while (Date.now() < deadline) {
			const hit = (await this.tabs()).find((t) => t.tabId === tab.tabId);
			if (hit?.url && hit.url !== "about:blank") return hit;
			if (!hit) throw new RelayError(`标签页开出来又没了:${url}`);
			await sleep(300);
		}
		return tab;
	}

	/** 老路:借一个页面执行 window.open。会激活新页并把窗口提到前台。 */
	private async openTabByWindowOpen(url: string, opts: { timeoutMs?: number } = {}): Promise<TabInfo> {
		const tabs = await this.tabs();
		const opener = tabs.find((t) => /^https?:/.test(t.url));
		if (!opener) throw new RelayError("没有可借用的普通网页标签页 —— 随便开一个 http(s) 页面再试");

		const before = new Set(tabs.map((t) => t.tabId));
		await this.attach(opener.tabId);
		// userGesture: true 让 Chrome 不当成弹窗拦掉
		await this.eval(opener.tabId, `window.open(${JSON.stringify(url)}, "_blank"); "opened"`, false, true);

		// 等扩展把新标签页报上来。开页面比 attach 慢,轮询而不是睡一个固定值。
		const deadline = Date.now() + (opts.timeoutMs ?? 15_000);
		for (;;) {
			await sleep(400);
			const fresh = (await this.tabs()).filter((t) => !before.has(t.tabId));
			// about:blank 是刚开还没导航过去的中间态,跳过
			const hit = fresh.find((t) => t.url && t.url !== "about:blank");
			if (hit) return hit;
			if (Date.now() > deadline) {
				throw new RelayError(`开标签页超时:${url} —— 多半被浏览器拦了弹窗,手动开一个再试`);
			}
		}
	}

	/** 找一个匹配的标签页;没有就开一个。capture 这类活儿的入口。 */
	async findOrOpenTab(urlRe: RegExp, openUrl: string): Promise<TabInfo> {
		try {
			return await this.findTab(urlRe);
		} catch {
			return this.openTab(openUrl);
		}
	}
}

export function sleep(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}
