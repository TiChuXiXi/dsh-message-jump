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
		// 功能一（v0.3.0 重构）：会话区左侧/右侧的悬浮"指令导航条"，
		// 类似 Codex 的时间线：每条已发送的用户指令是一个丝滑的刻度，
		//   - 深色刻度 = 当前位于视口顶部的指令，随滚动实时刷新定位；
		//   - 鼠标悬停：刻度向四周产生"宽度过渡"涟漪，旁边浮出指令内容；
		//   - 点击刻度：平滑滚动定位到该指令并闪烁高亮；
		//   - 显示在左侧还是右侧可在 设置 → 常规 中配置（"指令导航条位置"）。
		//
		// 功能二（v0.2.0 保留）：消息输入框"↑/↓ 历史消息"穿梭。
		// ============================================================

		// ---------- 共享状态（跨插槽通信） ----------
		const shared = {
			sessions: undefined,
		};

		// 导航条位置偏好：左侧 / 右侧（localStorage 持久化，settings 行可改）
		const railPref = {
			side: "right",
			subs: new Set(),
		};
		function loadRailPref() {
			try {
				const v = window.localStorage.getItem("dsh-msg-jump.rail-side");
				if (v === "left" || v === "right") railPref.side = v;
			} catch (_e) { }
		}
		loadRailPref();
		function emitRail() {
			for (const fn of railPref.subs) fn();
		}
		function setRailSide(side) {
			if (side !== "left" && side !== "right") return;
			if (side !== railPref.side) {
				railPref.side = side;
				try { window.localStorage.setItem("dsh-msg-jump.rail-side", side); } catch (_e) { }
				emitRail();
			}
		}
		function subscribeRail(fn) {
			railPref.subs.add(fn);
			return () => railPref.subs.delete(fn);
		}

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

		// 只收录用户的指令消息：user（普通用户消息）与 steering（turn 中
		// 插入的用户消息）。不收录模型消息（assistant-step），也不收录
		// 系统注入的 context。
		function collectItems(snapshot) {
			const chat = snapshot.chat;
			const order = chat && chat.order ? chat.order : [];
			const store = chat && chat.nodes;
			const items = [];
			for (const key of order) {
				let node;
				try {
					node = store ? store.get(key) : undefined;
				} catch (_e) {
					node = undefined;
				}
				if (!node) continue;
				if (node.visibility === "hidden") continue;
				const kind = node.kind;
				if (kind !== "user" && kind !== "steering") continue;
				const data = node.data;
				items.push({
					key,
					role: "user",
					text: previewOf(blockText(data && data.content)),
					time: data && data.time,
				});
			}
			return items;
		}

		// ---------- 历史消息穿梭：从会话快照提取全部用户消息全文 ----------
		function collectHistory(snapshot) {
			const chat = snapshot && snapshot.chat;
			const order = chat && chat.order ? chat.order : [];
			const store = chat && chat.nodes;
			const out = [];
			for (const key of order) {
				let node;
				try {
					node = store ? store.get(key) : undefined;
				} catch (_e) {
					node = undefined;
				}
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
			for (const el of candidates) {
				if (el.getClientRects().length > 0) return true;
			}
			return false;
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

		// ---------- 指令导航条（shell.overlay） ----------
		// 读取 [data-conversation-scroll] 的位置与尺寸，沿会话区左缘/右缘
		// 渲染一个"集中式"堆叠的刻度条容器：所有指令刻度等距集中排列，
		// 深色刻度 = 当前视口顶部的指令（随滚动实时刷新）。
		const RAIL_PAD = 6; // 与会话滚动区边缘的间距
		const BAR_W = 18; // 默认刻度条宽度（悬停时按距离级联变宽）
		const BAR_MAX_W = 38;
		const BAR_H = 4;
		const BAR_GAP = 7;

		function Rail({ useSessions }) {
			const side = React.useSyncExternalStore(subscribeRail, () => railPref.side);
			const current = useSessions((s) => s.current);
			const [geom, setGeom] = React.useState(null);
			const [items, setItems] = React.useState([]);
			const [activeKey, setActiveKey] = React.useState(null);
			const [hoverIdx, setHoverIdx] = React.useState(null);
			const lockRef = React.useRef(0);
			const disposersRef = React.useRef([]);
			const hoverIdxRef = React.useRef(null);
			hoverIdxRef.current = hoverIdx;

			React.useEffect(() => () => {
				for (const d of disposersRef.current) {
					try { d(); } catch (_e) { }
				}
				disposersRef.current = [];
			}, []);

			// 测量会话滚动容器的位置与尺寸（跟随布局变化）
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

			// 订阅当前会话的 ConversationSnapshot
			const face = React.useMemo(() => {
				if (!shared.sessions || current === undefined) return undefined;
				return shared.sessions.binding(current)?.session;
			}, [current]);

			const snapshot = React.useSyncExternalStore(
				React.useCallback((cb) => (face ? face.subscribe(cb) : () => {}), [face]),
				React.useCallback(() => (face ? face.getSnapshot() : null), [face]),
				() => null,
			);

			React.useEffect(() => {
				setItems(snapshot ? collectItems(snapshot) : []);
			}, [snapshot]);

			// 滚动联动：实时刷新"当前定位"的指令（视口顶部的那一条）
			React.useEffect(() => {
				if (current === undefined) return;
				const sp = document.querySelector("[data-conversation-scroll]");
				if (!sp) return;
				const onScroll = () => {
					if (Date.now() < lockRef.current) return;
					const vp = sp.getBoundingClientRect();
					const keys = new Set(items.map((i) => i.key));
					let best = null;
					let bestTop = Infinity;
					for (const el of sp.querySelectorAll("[data-chat-anchor-key]")) {
						const key = el.dataset.chatAnchorKey;
						if (key === undefined || !keys.has(key)) continue;
						const r = el.getBoundingClientRect();
						if (r.bottom >= vp.top && r.top <= vp.bottom) {
							const top = Math.max(0, r.top - vp.top);
							if (top < bestTop) {
								bestTop = top;
								best = key;
							}
						}
					}
					if (best !== null) setActiveKey(best);
				};
				sp.addEventListener("scroll", onScroll, { passive: true });
				onScroll();
				return () => sp.removeEventListener("scroll", onScroll);
			}, [current, items]);

			const jumpTo = (key) => {
				setActiveKey(key);
				lockRef.current = Date.now() + 800;
				const sp = document.querySelector("[data-conversation-scroll]");
				if (!sp) return;
				let row = null;
				for (const el of sp.querySelectorAll("[data-chat-anchor-key]")) {
					if (el.dataset.chatAnchorKey === key) {
						row = el;
						break;
					}
				}
				if (!row) return;
				const top = row.getBoundingClientRect().top - sp.getBoundingClientRect().top;
				sp.scrollTo({ top: Math.max(0, sp.scrollTop + top - 16), behavior: "smooth" });
				row.classList.remove("dsh-msg-flash");
				void row.offsetWidth;
				row.classList.add("dsh-msg-flash");
				if (pluginCtx) {
					const disposer = pluginCtx.timer.timeout(() => {
						row.classList.remove("dsh-msg-flash");
					}, 1600);
					disposersRef.current.push(disposer);
				}
			};

			// 聚焦式堆叠布局：所有刻度条等距集中在一个小型容器里（"集中"），
			// 深色刻度 = 当前视口顶部的指令（activeIdx 随滚动实时变化）；
			// 自适应对齐：左缘时左对齐、悬停向右变宽；右缘时右对齐、悬停向左变宽。
			const activeIdx = activeKey === null ? -1 : items.findIndex((i) => i.key === activeKey);
			const barWidth = (i) => {
				if (hoverIdx === null) return BAR_W;
				const d = Math.abs(i - hoverIdx);
				return BAR_W + (BAR_MAX_W - BAR_W) * Math.max(0, 1 - d / 3);
			};

			if (current === undefined || geom === null || snapshot === null || items.length === 0) return null;

			const isRight = side === "right";
			const padX = 6;
			const padY = 10;
			const n = items.length;
			const stackH = Math.min(padY * 2 + n * BAR_H + (n - 1) * BAR_GAP, Math.max(40, geom.height - 40));
			const railW = padX + BAR_MAX_W + padX;
			const railTop = geom.top + Math.max(6, (geom.height - stackH) / 2);
			const railLeft = isRight ? geom.right - railW - RAIL_PAD : geom.left + RAIL_PAD;
			const hovered = hoverIdx !== null ? items[hoverIdx] : null;

			return React.createElement(
				"div",
				{
					className: "dsh-rail" + (isRight ? " dsh-rail-right" : " dsh-rail-left"),
					style: { top: railTop, left: railLeft, width: railW, height: stackH },
				},
				React.createElement(
					"div",
					{ className: "dsh-rail-track" },
					items.map((item, i) =>
						React.createElement("button", {
							type: "button",
							key: item.key,
							className:
								"dsh-rail-bar" +
								(i === activeIdx ? " dsh-rail-bar-on" : "") +
								(hoverIdx === i ? " dsh-rail-bar-hover" : ""),
							style: {
								top: padY + i * (BAR_H + BAR_GAP),
								width: Math.round(barWidth(i)),
								height: BAR_H,
								...(isRight ? { right: padX } : { left: padX }),
							},
							title: item.text,
							"aria-label": item.text,
							onMouseEnter: () => setHoverIdx(i),
							onMouseLeave: () => setHoverIdx((cur) => (cur === i ? null : cur)),
							onClick: () => jumpTo(item.key),
						}),
					),
				),
				hovered &&
					React.createElement(
						"div",
						{
							className: "dsh-rail-tip" + (isRight ? " dsh-rail-tip-left" : " dsh-rail-tip-right"),
							style: {
								top: Math.max(geom.top + 8, Math.min(geom.bottom - 96, railTop + padY + hoverIdx * (BAR_H + BAR_GAP))),
							},
							onMouseLeave: () => setHoverIdx(null),
						},
						React.createElement("div", { className: "dsh-rail-tip-text" }, hovered.text || "（空消息）"),
						React.createElement("div", { className: "dsh-rail-tip-time" }, fmtTime(hovered.time)),
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
		// 该组件不依赖任何私有接口：会话快照与输入状态来自 InputZone 标准
		// 提供给 dock 槽位的 owner props（session = ConversationSnapshot、
		// input = InputState），草稿回填走公共的 inputActions.setDraft。
		// 键盘监听挂在 document 捕获阶段，先于产品自身 onKeyDown 介入，
		// 仅在输入框聚焦且无弹出菜单争夺方向键时拦截 ↑/↓。
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

			// 穿梭中手动编辑草稿 → 自动退出穿梭
			React.useEffect(() => {
				if (nav.index === -1) {
					lastAppliedRef.current = null;
					return;
				}
				const draft = inputRef.current ? inputRef.current.draft : "";
				if (draft !== lastAppliedRef.current) {
					nav.index = -1;
					nav.stash = "";
					lastAppliedRef.current = null;
				}
			});

			// 捕获阶段监听：在产品的 onKeyDown 之前决定是否拦截方向键
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
							if (entry.index === -1) {
								entry.stash = t.value;
								entry.index = entry.history.length - 1;
							} else if (entry.index > 0) {
								entry.index -= 1;
							}
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

					// Escape：退出穿梭并恢复进入前的草稿
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

		// ---------- 样式（使用 DSH 主题变量，浅色/深色自动适配） ----------
		const CSS = `
.dsh-rail{position:fixed;box-sizing:border-box;z-index:50;pointer-events:none;animation:dsh-rail-in .22s ease-out}
@keyframes dsh-rail-in{from{opacity:0;transform:translateY(-6px)}to{opacity:1;transform:none}}
.dsh-rail-track{position:absolute;inset:0;pointer-events:none}
.dsh-rail-bar{position:absolute;height:4px;border:none;border-radius:3px;padding:0;cursor:pointer;pointer-events:auto;background:color-mix(in srgb,var(--dsw-alias-label-primary) 24%,transparent);transition:width .18s ease,background-color .15s ease}
.dsh-rail-bar:hover{background:color-mix(in srgb,var(--dsw-alias-label-primary) 55%,transparent)}
.dsh-rail-bar-on{background:var(--dsw-alias-label-primary)}
.dsh-rail-bar-hover{background:var(--dsw-alias-label-primary)}
.dsh-rail-tip{position:absolute;box-sizing:border-box;width:min(260px,38vw);padding:8px 10px;border-radius:8px;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-overlay);border:1px solid var(--dsw-alias-border-l1);box-shadow:0 6px 20px color-mix(in srgb,var(--dsw-alias-label-primary) 14%,transparent);pointer-events:auto;animation:dsh-rail-tip-in .16s ease-out}
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
@media (prefers-reduced-motion:reduce){.dsh-rail{animation:none}.dsh-rail-bar{transition:none}.dsh-rail-tip{animation:none}.dsh-msg-flash{animation:none}.dsh-msg-history-strip{animation:none}}
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

			// v0.3.0：会话区左/右缘的悬浮指令导航条（可配置显示位置）
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