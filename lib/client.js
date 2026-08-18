window.__ModuleLoader__.load({
	id: "dsh-message-jump",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		const React = require("react");

		// ============================================================
		// dsh-message-jump 浏览器端（client）半边
		//
		// A. 指令导航条（v0.4.0）：会话区左/右缘的集中式悬浮刻度条。
		//    - 刻度覆盖本地会话**完整历史**的用户指令（含未加载的"更早"
		//      → 通过宿主 RPC msgjump.fullHistory 获取，不依赖已加载窗口）；
		//    - 深色刻度 = 当前视口顶部的指令，随滚动实时刷新（点"回到底部"
		//      时也跟随激活最新指令）；
		//    - 点击已加载刻度：平滑滚动定位 + 闪烁；点击尚未加载的刻度：
		//      自动"加载更早"直到该历史指令进入窗口再定位（刻度以虚线幽灵态
		//      表示未加载、点击触发的刻度有脉冲动画）；
		//    - 悬停：自绘悬浮卡片（垂直居中锚定刻度），不依赖原生 title；
		//    - 左侧左对齐向右变宽 / 右侧右对齐向左变宽，无背景；
		//    - 位置可配置（设置 → 常规 → 指令导航条位置）。
		//
		// B. 输入框 ↑/↓ 历史消息穿梭（v0.2.0 保留）。
		// ============================================================

		// ---------- 共享状态 ----------
		const shared = { sessions: undefined };

		// 导航条位置偏好：左侧 / 右侧（localStorage 持久化）
		const railPref = { side: "right", subs: new Set() };
		function loadRailPref() {
			try {
				const v = window.localStorage.getItem("dsh-msg-jump.rail-side");
				if (v === "left" || v === "right") railPref.side = v;
			} catch (_e) { }
		}
		loadRailPref();
		function emitRail() { for (const fn of railPref.subs) fn(); }
		function setRailSide(side) {
			if (side !== "left" && side !== "right") return;
			if (side !== railPref.side) {
				railPref.side = side;
				try { window.localStorage.setItem("dsh-msg-jump.rail-side", side); } catch (_e) { }
				emitRail();
			}
		}
		function subscribeRail(fn) { railPref.subs.add(fn); return () => railPref.subs.delete(fn); }

		// ---------- 文本提取与格式化 ----------
		function blockText(blocks) {
			let out = "";
			for (const b of blocks || []) {
				if (!b || typeof b !== "object") continue;
				if (b.type === "text" || b.type === "reasoning") {
					if (typeof b.text === "string" && b.text) out += b.text;
				} else if (b.type === "image") {
					out += (out && !/\s$/.test(out) ? " " : "") + "[图片]";
				} else if (b.type === "tool-call") {
					out += (out && !/\s$/.test(out) ? " " : "") + "[工具调用]";
				}
			}
			return out;
		}

		function previewOf(text) {
			const flat = String(text || "").replace(/\s+/g, " ").trim();
			return flat.length > 96 ? flat.slice(0, 96) + "…" : flat;
		}

		function fmtTime(t) {
			if (!t) return "";
			const d = new Date(t);
			const now = new Date();
			const pad = (n) => String(n).padStart(2, "0");
			const hm = pad(d.getHours()) + ":" + pad(d.getMinutes());
			if (
				d.getFullYear() === now.getFullYear() &&
				d.getMonth() === now.getMonth() &&
				d.getDate() === now.getDate()
			) {
				return hm;
			}
			return d.getMonth() + 1 + "/" + d.getDate() + " " + hm;
		}

		// 从会话快照取出**已加载窗口**里的用户指令：map seq → {key,text,time}
		function collectLoaded(snapshot) {
			const map = new Map();
			const chat = snapshot && snapshot.chat;
			const order = chat && chat.order ? chat.order : [];
			const nodes = chat && chat.nodes;
			for (const key of order) {
				let node;
				try { node = nodes ? nodes.get(key) : undefined; } catch (_e) { node = undefined; }
				if (!node) continue;
				const kind = node.kind;
				if (kind !== "user" && kind !== "steering") continue;
				if (node.visibility === "hidden") continue;
				const seq = node.anchorSeq;
				if (typeof seq !== "number") continue;
				const data = node.data;
				map.set(seq, { key, text: previewOf(blockText(data && data.content)), time: data && data.time });
			}
			return map;
		}

		// ---------- 历史消息穿梭：从会话快照提取全部用户消息全文 ----------
		function collectHistory(snapshot) {
			const chat = snapshot && snapshot.chat;
			const order = chat && chat.order ? chat.order : [];
			const store = chat && chat.nodes;
			const out = [];
			for (const key of order) {
				let node;
				try { node = store ? store.get(key) : undefined; } catch (_e) { node = undefined; }
				if (!node) continue;
				if (node.visibility === "hidden") continue;
				const kind = node.kind;
				if (kind !== "user" && kind !== "steering") continue;
				const text = blockText(node.data && node.data.content).replace(/\s+$/, "").trim();
				if (!text) continue;
				if (out.length > 0 && out[out.length - 1] === text) continue;
				out.push(text);
			}
			return out;
		}

		// 文档中是否有"打开"的下拉菜单（如 / 命令候选菜单）
		function hasOpenMenu() {
			const candidates = document.querySelectorAll('[role="listbox"], [role="menu"]');
			for (const el of candidates) { if (el.getClientRects().length > 0) return true; }
			return false;
		}

		function delay(ms) {
			return new Promise((r) => window.setTimeout(r, ms));
		}

		// 每个会话一份穿梭状态
		const historyNavMap = new Map(); // sessionId -> { history, index, stash }
		function navFor(sessionId) {
			let entry = historyNavMap.get(sessionId);
			if (!entry) {
				entry = { history: [], index: -1, stash: "" };
				historyNavMap.set(sessionId, entry);
			}
			return entry;
		}

		// ---------- 插件上下文（apply 时注入，供组件使用 timer 服务） ----------
		let pluginCtx = null;

		// 公开的 Package-private host 桥：仅动态 Cordis 插件具备 `host` 内建；
		// npm 模块加载器只传 require、不注入 host。这里安全探测，缺失不抛错。
		let hostBridge = undefined;
		try { if (typeof host !== "undefined") hostBridge = host; } catch (_e) { }

		// 枚举当前会话**完整**用户指令：host 桥可用走 RPC（`msgjump.fullHistory`）；
		// 否则退化为用会话自身的 loadOlder() 逐页扫描到顶，从快照枚举全部用户指令
		//（npm 模块插件没有 host 内建，走这一条；结果同样覆盖未加载的更早历史）。
		async function loadFullHistory(sessionId) {
			if (hostBridge) {
				try {
					const res = await hostBridge.call("msgjump.fullHistory", { sessionId });
					if (res && Array.isArray(res.items) && res.items.length) return res.items;
				} catch (_e) { }
			}
			const sess = shared.sessions && shared.sessions.binding(sessionId)?.session;
			if (!sess) return null;
			const read = () => { try { return sess.getSnapshot ? sess.getSnapshot() : null; } catch (_e) { return null; } };
			let guard = 0;
			while (guard++ < 60) {
				const snap = read();
				if (!(snap && snap.hasMore)) break;
				try { await Promise.race([Promise.resolve(sess.loadOlder ? sess.loadOlder() : null), delay(6000)]); } catch (_e) { break; }
			}
			const items = [];
			for (const [seq, v] of collectLoaded(read())) items.push({ seq, text: v.text, time: v.time });
			return items.length ? items : null;
		}

		// ---------- 指令导航条（shell.overlay） ----------
		const RAIL_PAD = 6;
		const BAR_W = 18;
		const BAR_MAX_W = 38;
		const BAR_H = 4;
		const BAR_GAP = 7;

		function Rail({ useSessions }) {
			const side = React.useSyncExternalStore(subscribeRail, () => railPref.side);
			const current = useSessions((s) => s.current);
			const [geom, setGeom] = React.useState(null);
			const [activeKey, setActiveKey] = React.useState(null);
			const [hoverIdx, setHoverIdx] = React.useState(null);
			const [full, setFull] = React.useState(null); // 宿主返回的完整历史
			const [busySeq, setBusySeq] = React.useState(null); // 正在加载更早的刻度
			const lockRef = React.useRef(0);
			const disposersRef = React.useRef([]);

			React.useEffect(() => () => {
				for (const d of disposersRef.current) { try { d(); } catch (_e) { } }
				disposersRef.current = [];
			}, []);

			// 测量会话滚动容器位置/尺寸
			React.useEffect(() => {
				if (current === undefined) return;
				const sp = document.querySelector("[data-conversation-scroll]");
				if (!sp) return;
				const measure = () => setGeom(sp.getBoundingClientRect());
				measure();
				if (typeof ResizeObserver === "undefined") return;
				const ro = new ResizeObserver(measure);
				ro.observe(sp);
				return () => ro.disconnect();
			}, [current]);

			// 订阅当前会话快照（含 chat window 分页字段）
			const face = React.useMemo(() => {
				if (!shared.sessions || current === undefined) return undefined;
				return shared.sessions.binding(current)?.session;
			}, [current]);

			const snapshot = React.useSyncExternalStore(
				React.useCallback((cb) => (face ? face.subscribe(cb) : () => {}), [face]),
				React.useCallback(() => (face ? face.getSnapshot() : null), [face]),
				() => null,
			);

			// 已加载窗口：seq → {key,text,time}
			const loaded = React.useMemo(() => collectLoaded(snapshot), [snapshot]);

			// 全量历史：优先宿主 RPC；宿主不提供（npm 模块 client 无 host 内建）时
			// 用 loadOlder() 扫描到顶枚举完整历史，保证刻度覆盖全部用户指令。
			React.useEffect(() => {
				if (current === undefined) { setFull(null); return; }
				let alive = true;
				setFull(null);
				loadFullHistory(current)
					.then((items) => { if (alive && Array.isArray(items)) setFull(items); })
					.catch(() => { /* 保持已加载窗口 */ });
				return () => { alive = false; };
			}, [current]);

			// 导航条行：优先全量历史，否则回退已加载
			const rows = React.useMemo(() => {
				if (full && full.length) {
					return full.map((f) => {
						const l = loaded.get(f.seq);
						return { seq: f.seq, text: f.text, time: f.time || (l && l.time), key: l ? l.key : null };
					});
				}
				return Array.from(loaded.entries()).map(([seq, v]) => ({ seq, text: v.text, time: v.time, key: v.key }));
			}, [full, loaded]);

			// 当前激活刻度：视口顶部指令 → anchorSeq → 全量行下标
			const activeSeq = React.useMemo(() => {
				if (!activeKey || !snapshot) return null;
				const nodes = snapshot.chat && snapshot.chat.nodes;
				const node = nodes && activeKey ? nodes.get(activeKey) : undefined;
				return node && typeof node.anchorSeq === "number" ? node.anchorSeq : null;
			}, [activeKey, snapshot]);
			const activeIdx = activeSeq === null ? -1 : rows.findIndex((r) => r.seq === activeSeq);

			// 滚动联动 + 回到底部跟随
			React.useEffect(() => {
				if (current === undefined) return;
				const sp = document.querySelector("[data-conversation-scroll]");
				if (!sp) return;
				const keySet = new Set();
				for (const r of rows) if (r.key) keySet.add(r.key);
				const onScroll = () => {
					if (Date.now() < lockRef.current) return;
					const vp = sp.getBoundingClientRect();
					let best = null, bestTop = Infinity;
					let lastAboveKey = null, lastAboveBottom = -Infinity;
					for (const el of sp.querySelectorAll("[data-chat-anchor-key]")) {
						const key = el.dataset.chatAnchorKey;
						if (key === undefined || !keySet.has(key)) continue;
						const r = el.getBoundingClientRect();
						if (r.bottom >= vp.top && r.top <= vp.bottom) {
							const top = Math.max(0, r.top - vp.top);
							if (top < bestTop) { bestTop = top; best = key; }
						} else if (r.bottom < vp.top) {
							if (r.bottom > lastAboveBottom) { lastAboveBottom = r.bottom; lastAboveKey = key; }
						}
					}
					// 视口内无指令（如已滚到底）→ 激活最近滚出的那条
					if (best === null) best = lastAboveKey;
					if (best !== null) setActiveKey(best);
				};
				sp.addEventListener("scroll", onScroll, { passive: true });
				onScroll();
				return () => sp.removeEventListener("scroll", onScroll);
			}, [current, rows]);

			// 定位到已加载节点
			const jumpToKey = (key) => {
				setActiveKey(key);
				lockRef.current = Date.now() + 800;
				const sp = document.querySelector("[data-conversation-scroll]");
				if (!sp) return;
				let row = null;
				for (const el of sp.querySelectorAll("[data-chat-anchor-key]")) {
					if (el.dataset.chatAnchorKey === key) { row = el; break; }
				}
				if (!row) return;
				const top = row.getBoundingClientRect().top - sp.getBoundingClientRect().top;
				sp.scrollTo({ top: Math.max(0, sp.scrollTop + top - 16), behavior: "smooth" });
				row.classList.remove("dsh-msg-flash");
				void row.offsetWidth;
				row.classList.add("dsh-msg-flash");
				if (pluginCtx && pluginCtx.timer) {
					const disposer = pluginCtx.timer.timeout(() => { row.classList.remove("dsh-msg-flash"); }, 1600);
					disposersRef.current.push(disposer);
				}
			};

			// 点刻度：已加载 → 直接定位；未加载 → 逐页"加载更早"直到进入窗口
			const jumpToSeq = async (seq) => {
				setBusySeq(seq);
				try {
					const l0 = loaded.get(seq);
					if (l0) { jumpToKey(l0.key); return; }
					const sess = face;
					if (!sess) return;
					const read = () => { try { return sess.getSnapshot ? sess.getSnapshot() : null; } catch (_e) { return null; } };
					let guard = 0;
					while (guard++ < 80) {
						const snap = read();
						const hit = collectLoaded(snap).get(seq);
						if (hit) { jumpToKey(hit.key); return; }
						if (!(snap && snap.hasMore)) break;
						try { await Promise.race([Promise.resolve(sess.loadOlder ? sess.loadOlder() : null), delay(7000)]); } catch (_e) { break; }
					}
					const hit = collectLoaded(read()).get(seq);
					if (hit) jumpToKey(hit.key);
				} finally { setBusySeq(null); }
			};

			const barWidth = (i) => {
				if (hoverIdx === null) return BAR_W;
				const d = Math.abs(i - hoverIdx);
				return BAR_W + (BAR_MAX_W - BAR_W) * Math.max(0, 1 - d / 3);
			};

			if (current === undefined || geom === null || snapshot === null || rows.length === 0) return null;

			const isRight = side === "right";
			const padX = 6;
			const padY = 10;
			const n = rows.length;
			const slotH = BAR_H + BAR_GAP;
			const stackH = Math.min(padY * 2 + n * slotH, Math.max(40, geom.height - 40));
			const railW = padX + BAR_MAX_W + padX;
			const railTop = geom.top + Math.max(6, (geom.height - stackH) / 2);
			const railLeft = isRight ? geom.right - railW - RAIL_PAD : geom.left + RAIL_PAD;
			const hovered = hoverIdx !== null ? rows[hoverIdx] : null;
			const tipTopAbs = railTop + padY + hoverIdx * slotH + slotH / 2 - 45;
			const tipTop = Math.max(geom.top + 8, Math.min(geom.bottom - 98, tipTopAbs)) - railTop;

			return React.createElement(
				"div",
				{
					className: "dsh-rail" + (isRight ? " dsh-rail-right" : " dsh-rail-left"),
					style: { top: railTop, left: railLeft, width: railW, height: stackH },
				},
				React.createElement(
					"div",
					{ className: "dsh-rail-track" },
					rows.map((row, i) =>
						React.createElement(
							"button",
							{
								type: "button",
								key: row.seq,
								className:
									"dsh-rail-bar" +
									(i === activeIdx ? " dsh-rail-bar-on" : "") +
									(hoverIdx === i ? " dsh-rail-bar-hover" : "") +
									(row.key ? "" : " dsh-rail-bar-more") +
									(busySeq === row.seq ? " dsh-rail-bar-busy" : ""),
								style: {
									top: padY + i * slotH,
									width: Math.round(barWidth(i)),
									height: slotH,
									...(isRight ? { right: padX } : { left: padX }),
								},
								"aria-label": row.text,
								onMouseEnter: () => setHoverIdx(i),
								onMouseLeave: () => setHoverIdx((cur) => (cur === i ? null : cur)),
								onClick: () => jumpToSeq(row.seq),
							},
							React.createElement("span", { className: "dsh-rail-bar-core", "aria-hidden": true }),
						),
					),
				),
				hovered &&
					React.createElement(
						"div",
						{
							className: "dsh-rail-tip" + (isRight ? " dsh-rail-tip-left" : " dsh-rail-tip-right"),
							style: { top: tipTop },
							onMouseLeave: () => setHoverIdx(null),
						},
						React.createElement("div", { className: "dsh-rail-tip-text" }, hovered.text || "（空消息）"),
						React.createElement(
							"div",
							{ className: "dsh-rail-tip-time" },
							(hovered.key ? "" : "未加载 · ") + fmtTime(hovered.time),
						),
					),
			);
		}

		// ---------- 设置项：导航条位置（settings.general.item） ----------
		function RailSettingRow() {
			const side = React.useSyncExternalStore(subscribeRail, () => railPref.side);
			const seg = (value, label) =>
				React.createElement(
					"button",
					{
						type: "button",
						key: value,
						className: "dsh-rail-setting-opt" + (side === value ? " dsh-rail-setting-opt-on" : ""),
						"aria-pressed": side === value,
						onClick: () => setRailSide(value),
					},
					label,
				);
			return React.createElement(
				"div",
				{ className: "dsh-rail-setting" },
				React.createElement("span", { className: "dsh-rail-setting-label" }, "指令导航条位置"),
				React.createElement(
					"div",
					{ className: "dsh-rail-setting-seg", role: "group", "aria-label": "指令导航条位置" },
					seg("left", "左侧"),
					seg("right", "右侧"),
				),
			);
		}

		// ---------- 输入框"↑/↓ 历史消息"穿梭（conversation.input.dock） ----------
		function HistoryNav({ sessionId, session, input, inputActions }) {
			const inputRef = React.useRef(input);
			inputRef.current = input;
			const sessionRef = React.useRef(session);
			sessionRef.current = session;
			const lastAppliedRef = React.useRef(null);

			const nav = React.useMemo(() => {
				const entry = navFor(sessionId);
				const items = collectHistory(sessionRef.current);
				entry.history = items;
				if (entry.index > items.length - 1) entry.index = items.length - 1;
				return entry;
				// eslint-disable-next-line react-hooks/exhaustive-deps
			}, [sessionId, session]);

			React.useEffect(() => {
				if (nav.index === -1) { lastAppliedRef.current = null; return; }
				const draft = inputRef.current ? inputRef.current.draft : "";
				if (draft !== lastAppliedRef.current) {
					nav.index = -1;
					nav.stash = "";
					lastAppliedRef.current = null;
				}
			});

			React.useEffect(() => {
				const onKeyDown = (e) => {
					if (e.key !== "ArrowUp" && e.key !== "ArrowDown" && e.key !== "Escape") return;
					const t = e.target;
					if (!(t instanceof HTMLElement)) return;
					if (t.tagName !== "TEXTAREA") return;
					if (!t.closest("[data-input-scroll]")) return;
					if (t.readOnly || t.disabled) return;
					if (e.isComposing || e.keyCode === 229) return;
					if (e.ctrlKey || e.metaKey || e.altKey) return;
					if (hasOpenMenu()) return;

					const entry = navFor(sessionId);
					if (e.key === "ArrowUp" || e.key === "ArrowDown") {
						if (e.shiftKey) return;
						if (entry.history.length === 0) return;
						if (e.key === "ArrowDown" && entry.index === -1) return;
						e.preventDefault();
						e.stopImmediatePropagation();

						const goingUp = e.key === "ArrowUp";
						if (goingUp) {
							if (entry.index === -1) { entry.stash = t.value; entry.index = entry.history.length - 1; }
							else if (entry.index > 0) { entry.index -= 1; }
						} else {
							if (entry.index >= entry.history.length - 1) {
								const stash = entry.stash;
								entry.index = -1;
								entry.stash = "";
								lastAppliedRef.current = stash;
								inputActions.setDraft(stash);
								return;
							}
							entry.index += 1;
						}
						if (entry.index >= 0) {
							const text = entry.history[entry.index];
							lastAppliedRef.current = text;
							inputActions.setDraft(text);
						}
						return;
					}

					if (entry.index !== -1) {
						e.preventDefault();
						e.stopImmediatePropagation();
						const stash = entry.stash;
						entry.index = -1;
						entry.stash = "";
						lastAppliedRef.current = stash;
						inputActions.setDraft(stash);
					}
				};
				document.addEventListener("keydown", onKeyDown, true);
				return () => document.removeEventListener("keydown", onKeyDown, true);
			}, [sessionId, inputActions]);

			if (nav.index < 0) return null;
			return React.createElement(
				"div",
				{ className: "dsh-msg-history-strip", "aria-hidden": true },
				React.createElement("span", { className: "dsh-msg-history-badge" }, "历史消息"),
				React.createElement(
					"span",
					{ className: "dsh-msg-history-hint" },
					"↑↓ " + (nav.index + 1) + "/" + nav.history.length + " · Esc 退出",
				),
			);
		}

		// ---------- 样式（使用 DSH 主题变量） ----------
		const CSS = `
.dsh-rail{position:fixed;box-sizing:border-box;z-index:50;pointer-events:none;animation:dsh-rail-in .22s ease-out}
@keyframes dsh-rail-in{from{opacity:0;transform:translateY(-6px)}to{opacity:1;transform:none}}
.dsh-rail-track{position:absolute;inset:0;pointer-events:none}
.dsh-rail-bar{position:absolute;padding:0;border:none;cursor:pointer;pointer-events:auto;background:transparent;transition:width .18s ease}
.dsh-rail-bar-core{position:absolute;top:0;left:0;right:0;height:4px;border-radius:3px;background:color-mix(in srgb,var(--dsw-alias-label-primary) 24%,transparent);transition:background-color .15s ease}
.dsh-rail-bar:hover .dsh-rail-bar-core{background:color-mix(in srgb,var(--dsw-alias-label-primary) 55%,transparent)}
.dsh-rail-bar-on .dsh-rail-bar-core{background:var(--dsw-alias-label-primary)}
.dsh-rail-bar-hover .dsh-rail-bar-core{background:var(--dsw-alias-label-primary)}
.dsh-rail-bar-more .dsh-rail-bar-core{background:color-mix(in srgb,var(--dsw-alias-label-primary) 10%,transparent);height:3px}
.dsh-rail-bar-busy .dsh-rail-bar-core{animation:dsh-rail-busy .8s ease-in-out infinite}
@keyframes dsh-rail-busy{0%,100%{opacity:.35}50%{opacity:1}}
.dsh-rail-tip{position:absolute;box-sizing:border-box;width:min(260px,38vw);padding:8px 10px;border-radius:8px;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-overlay);border:1px solid var(--dsw-alias-border-l1);pointer-events:auto;animation:dsh-rail-tip-in .16s ease-out}
.dsh-rail-tip-left{right:calc(100% + 6px)}
.dsh-rail-tip-right{left:calc(100% + 6px)}
.dsh-rail-tip-text{overflow:hidden;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;word-break:break-word}
.dsh-rail-tip-time{margin-top:4px;font-size:11px;color:var(--dsw-alias-label-secondary)}
@keyframes dsh-rail-tip-in{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:none}}
.dsh-rail-setting{display:flex;align-items:center;justify-content:space-between;gap:16px;width:100%}
.dsh-rail-setting-label{font-size:13px;color:var(--dsw-alias-label-primary)}
.dsh-rail-setting-seg{display:inline-flex;gap:2px;padding:2px;border-radius:8px;background:var(--dsw-alias-bg-layer-2)}
.dsh-rail-setting-opt{border:none;border-radius:6px;padding:3px 12px;font-size:12px;line-height:20px;cursor:pointer;color:var(--dsw-alias-label-secondary);background:transparent;transition:background-color .15s ease,color .15s ease}
.dsh-rail-setting-opt:hover{color:var(--dsw-alias-label-primary)}
.dsh-rail-setting-opt-on{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-overlay);box-shadow:0 1px 3px color-mix(in srgb,var(--dsw-alias-label-primary) 12%,transparent)}
@keyframes dsh-msg-flash-kf{0%{background-color:color-mix(in srgb,var(--dsw-alias-brand-primary) 30%,transparent)}100%{background-color:transparent}}
.dsh-msg-flash{animation:dsh-msg-flash-kf 1.6s ease-out}
.dsh-msg-history-strip{display:flex;align-items:center;gap:8px;justify-content:flex-end;padding:2px 4px 4px;font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary);user-select:none;animation:dsh-msg-strip-in .15s ease-out}
@keyframes dsh-msg-strip-in{from{opacity:0;transform:translateY(-4px)}to{opacity:1;transform:none}}
.dsh-msg-history-badge{color:var(--dsw-alias-brand-primary);background:color-mix(in srgb,var(--dsw-alias-brand-primary) 10%,transparent);border-radius:6px;padding:0 6px}
.dsh-msg-history-hint{opacity:.85;font-variant-numeric:tabular-nums}
@media (prefers-reduced-motion:reduce){.dsh-rail{animation:none}.dsh-rail-bar{transition:none}.dsh-rail-bar-busy .dsh-rail-bar-core{animation:none}.dsh-rail-tip{animation:none}.dsh-msg-flash{animation:none}.dsh-msg-history-strip{animation:none}}
`;

		const inject = ["timer"];

		function apply(ctx) {
			pluginCtx = ctx;

			// 注入样式；插件卸载时自动移除
			const styleEl = document.createElement("style");
			styleEl.setAttribute("data-dsh-message-jump", "");
			styleEl.textContent = CSS;
			document.head.appendChild(styleEl);
			ctx.on("dispose", () => {
				try { styleEl.remove(); } catch (_e) { }
			});

			const slots = ctx.get("slots");
			if (slots === undefined) return;
			const sessions = ctx.get("sessions");
			if (sessions !== undefined) shared.sessions = sessions;

			// v0.4.0：会话区左/右缘悬浮指令导航条（全量历史 + 点击加载未加载）
			slots.inject("shell.overlay", () =>
				slots.register(
					{ name: "shell.overlay", id: "msg-jump-rail", order: 100, label: "指令导航条" },
					(props) => React.createElement(Rail, { useSessions: props.useSessions }),
				),
			);

			// v0.3.0：设置 → 常规 → 导航条位置（左侧/右侧）
			slots.inject("settings.general.item", () =>
				slots.register(
					{ name: "settings.general.item", id: "msg-jump-rail-side", order: 25, label: "指令导航条位置" },
					() => React.createElement(RailSettingRow, null),
				),
			);

			// v0.2.0：输入框 ↑/↓ 历史消息穿梭
			slots.inject("conversation.input.dock", () =>
				slots.register(
					{ name: "conversation.input.dock", id: "msg-jump-history", order: 30, label: "历史消息" },
					(props) =>
						React.createElement(HistoryNav, {
							sessionId: props.sessionId,
							session: props.session,
							input: props.input,
							inputActions: props.inputActions,
						}),
				),
			);
		}

		exports.inject = inject;
		exports.apply = apply;
		return module.exports;
	}
});