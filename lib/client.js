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
		// 功能一：会话页头部右侧提供"指令列表"开关按钮，点击后从会话区
		// 右侧滑出浮动面板，只收录用户的指令消息（user / steering）：
		//   - 点击任一条目：会话区平滑滚动定位到该指令并闪烁高亮；
		//   - 手动滚动聊天：列表实时高亮当前位于视口顶部的指令；
		//   - 关闭方式：点击面板外部任意位置、Esc、右上角 ×、再点头部开关。
		//
		// 功能二：消息输入框"↑/↓ 历史消息"穿梭（v0.2.0 新增）：
		//   在输入框聚焦时按 ↑ / ↓ 快速回填当前会话已发送过的历史内容，
		//   类似终端命令历史记录交互：
		//   - ↑：逐条回退到更早的消息；↓：逐条前进到更新的消息；
		//   - 开始穿梭前输入框里未发送的草稿会被暂存，↓ 到底或按 Esc 后恢复；
		//   - 穿梭中手动编辑草稿会自动退出穿梭（不再覆盖你的输入）；
		//   - 输入框上方显示"历史消息 n/m · Esc 退出"的轻量提示条。
		// ============================================================

		// ---------- 共享状态（开关按钮与面板跨插槽通信） ----------
		const shared = {
			open: false,
			subs: new Set(),
			sessions: undefined,
		};

		function emitOpen() {
			for (const fn of shared.subs) fn();
		}
		function setOpen(value) {
			if (shared.open !== value) {
				shared.open = value;
				emitOpen();
			}
		}
		function subscribeOpen(fn) {
			shared.subs.add(fn);
			return () => shared.subs.delete(fn);
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
			return flat.length > 64 ? flat.slice(0, 64) + "…" : flat;
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
		// 与 collectItems 同源（user / steering、跳过 hidden），但保留完整
		// 文本（不截断）、按时间旧→新排列、去空与去连续重复，供输入框回填。
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
				if (out.length > 0 && out[out.length - 1] === text) continue; // 连续重复只记一次
				out.push(text);
			}
			return out;
		}

		// 文档中是否有"打开"的下拉菜单（如 / 命令候选菜单）。菜单开启时
		// ↑/↓ 是菜单导航键，历史穿梭必须让位，避免互相抢键。
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

		// ---------- 图标（内联 SVG） ----------
		function UserIcon() {
			return React.createElement(
				"svg",
				{ width: 14, height: 14, viewBox: "0 0 16 16", fill: "currentColor", "aria-hidden": true },
				React.createElement("path", {
					d: "M8 8a3.2 3.2 0 1 0 0-6.4A3.2 3.2 0 0 0 8 8Zm0 1.6c-2.67 0-8 1.34-8 4v1.2h16v-1.2c0-2.66-5.33-4-8-4Z",
				}),
			);
		}

		function AiIcon() {
			return React.createElement(
				"svg",
				{ width: 14, height: 14, viewBox: "0 0 16 16", fill: "currentColor", "aria-hidden": true },
				React.createElement("path", {
					d: "M8 1.5l1.2 3.3L12.5 6 9.2 7.2 8 10.5 6.8 7.2 3.5 6l3.3-1.2L8 1.5Zm4.5 6l.75 2.25L15.5 10.5l-2.25.75L12.5 13.5l-.75-2.25L9.5 10.5l2.25-.75L12.5 7.5Z",
				}),
			);
		}

		function CloseIcon() {
			return React.createElement(
				"svg",
				{ width: 14, height: 14, viewBox: "0 0 16 16", fill: "none", "aria-hidden": true },
				React.createElement("path", {
					d: "M4 4l8 8M12 4l-8 8",
					stroke: "currentColor",
					"stroke-width": 1.6,
					"stroke-linecap": "round",
				}),
			);
		}

		function ListIcon() {
			return React.createElement(
				"svg",
				{ width: 16, height: 16, viewBox: "0 0 16 16", fill: "none", "aria-hidden": true },
				React.createElement("path", {
					d: "M2.5 4h.01M2.5 8h.01M2.5 12h.01M6 4.5h8M6 8.5h8M6 12.5h8",
					stroke: "currentColor",
					"stroke-width": 1.5,
					"stroke-linecap": "round",
				}),
			);
		}

		// ---------- 插件上下文（apply 时注入，供组件使用 timer 服务） ----------
		let pluginCtx = null;

		// ---------- 头部开关按钮（conversation.session.header.utilities） ----------
		function ToggleButton() {
			const open = React.useSyncExternalStore(subscribeOpen, () => shared.open);
			const label = open ? "关闭指令列表" : "指令列表";
			return React.createElement(
				"button",
				{
					type: "button",
					className: "dsh-msg-toggle" + (open ? " dsh-msg-toggle-on" : ""),
					title: label,
					"aria-label": label,
					"aria-pressed": open,
					onClick: () => setOpen(!open),
				},
				React.createElement(ListIcon, null),
			);
		}

		// ---------- 右侧浮动面板（shell.overlay） ----------
		function Panel({ useSessions }) {
			const open = React.useSyncExternalStore(subscribeOpen, () => shared.open);
			const current = useSessions((s) => s.current);
			const [activeKey, setActiveKey] = React.useState(null);
			const [geom, setGeom] = React.useState(null);
			const listRef = React.useRef(null);
			const lockRef = React.useRef(0);
			const disposersRef = React.useRef([]);

			React.useEffect(() => () => {
				for (const d of disposersRef.current) {
					try { d(); } catch (_e) { }
				}
				disposersRef.current = [];
			}, []);

			// 测量会话滚动容器（[data-conversation-scroll]）的位置与尺寸，
			// 让面板贴齐会话区右缘并跟随布局变化。
			React.useEffect(() => {
				if (!open || current === undefined) return;
				const sp = document.querySelector("[data-conversation-scroll]");
				if (!sp) return;
				const measure = () => setGeom(sp.getBoundingClientRect());
				measure();
				if (typeof ResizeObserver === "undefined") return;
				const ro = new ResizeObserver(measure);
				ro.observe(sp);
				return () => ro.disconnect();
			}, [open, current]);

			// 订阅当前会话的 ConversationSnapshot（sessions.binding().session）
			const face = React.useMemo(() => {
				if (!shared.sessions || current === undefined) return undefined;
				return shared.sessions.binding(current)?.session;
			}, [current]);

			const snapshot = React.useSyncExternalStore(
				React.useCallback((cb) => (face ? face.subscribe(cb) : () => {}), [face]),
				React.useCallback(() => (face ? face.getSnapshot() : null), [face]),
				() => null,
			);

			const items = React.useMemo(() => (snapshot ? collectItems(snapshot) : []), [snapshot]);
			const itemKeysRef = React.useRef(new Set());
			itemKeysRef.current = React.useMemo(() => new Set(items.map((i) => i.key)), [items]);

			// 滚动联动：只在列表收录（用户指令）的节点里选当前高亮
			React.useEffect(() => {
				if (!open || current === undefined) return;
				const sp = document.querySelector("[data-conversation-scroll]");
				if (!sp) return;
				const onScroll = () => {
					if (Date.now() < lockRef.current) return;
					const vp = sp.getBoundingClientRect();
					const keys = itemKeysRef.current;
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
			}, [open, current]);

			// Esc 关闭
			React.useEffect(() => {
				if (!open) return;
				const onKey = (e) => {
					if (e.key === "Escape") setOpen(false);
				};
				document.addEventListener("keydown", onKey);
				return () => document.removeEventListener("keydown", onKey);
			}, [open]);

			// 点击面板外部任意位置关闭；点击面板内部或头部开关按钮不关闭。
			// 监听冒泡阶段的 click，不阻止默认行为，因此底层聊天区交互不受影响。
			React.useEffect(() => {
				if (!open) return;
				const onDocClick = (e) => {
					const t = e.target;
					if (!(t instanceof Element)) return;
					if (t.closest(".dsh-msg-panel") || t.closest(".dsh-msg-toggle")) return;
					setOpen(false);
				};
				document.addEventListener("click", onDocClick);
				return () => document.removeEventListener("click", onDocClick);
			}, [open]);

			// 保持激活条目在面板内可见
			React.useEffect(() => {
				const list = listRef.current;
				if (!list || !activeKey) return;
				let el = null;
				for (const child of list.querySelectorAll("[data-msg-key]")) {
					if (child.dataset.msgKey === activeKey) {
						el = child;
						break;
					}
				}
				if (el) el.scrollIntoView({ block: "nearest" });
			}, [activeKey]);

			const jumpTo = (key) => {
				setActiveKey(key);
				lockRef.current = Date.now() + 800;
				const sp = document.querySelector("[data-conversation-scroll]");
				if (sp) {
					let row = null;
					for (const el of sp.querySelectorAll("[data-chat-anchor-key]")) {
						if (el.dataset.chatAnchorKey === key) {
							row = el;
							break;
						}
					}
					if (row) {
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
					}
				}
			};

			if (!open || current === undefined || snapshot === null || geom === null) return null;

			return React.createElement(
				"div",
				{
					className: "dsh-msg-panel",
					style: { top: geom.top + 12, left: geom.right - 328, width: 316, height: geom.height - 24 },
				},
				React.createElement(
					"div",
					{ className: "dsh-msg-panel-head" },
					React.createElement("span", { className: "dsh-msg-panel-title" }, "指令列表"),
					items.length > 0 &&
						React.createElement("span", { className: "dsh-msg-panel-count" }, String(items.length)),
					React.createElement(
						"button",
						{
							type: "button",
							className: "dsh-msg-panel-close",
							"aria-label": "关闭指令列表",
							onClick: () => setOpen(false),
						},
						React.createElement(CloseIcon, null),
					),
				),
				items.length === 0
					? React.createElement("div", { className: "dsh-msg-panel-empty" }, "暂无指令消息")
					: React.createElement(
							"div",
							{ className: "dsh-msg-panel-list", ref: listRef },
							items.map((item) =>
								React.createElement(
									"button",
									{
										type: "button",
										key: item.key,
										className: "dsh-msg-item" + (item.key === activeKey ? " dsh-msg-item-on" : ""),
										"data-msg-key": item.key,
										onClick: () => jumpTo(item.key),
									},
									React.createElement(
										"span",
										{ className: "dsh-msg-item-avatar dsh-msg-avatar-user", "aria-hidden": true },
										React.createElement(UserIcon, null),
									),
									React.createElement(
										"span",
										{ className: "dsh-msg-item-body" },
										React.createElement(
											"span",
											{ className: "dsh-msg-item-text" },
											item.text || "（空消息）",
										),
										React.createElement("span", { className: "dsh-msg-item-time" }, fmtTime(item.time)),
									),
								),
							),
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
			// 最新 input / session 放入 ref，捕获阶段事件处理器只读 ref
			const inputRef = React.useRef(input);
			inputRef.current = input;
			const sessionRef = React.useRef(session);
			sessionRef.current = session;

			// 本插件最后一次通过 setDraft 写入的草稿（用于识别手动编辑）
			const lastAppliedRef = React.useRef(null);

			// 每次渲染从最新快照重建历史列表；新消息出现时自动收敛指针
			const nav = React.useMemo(() => {
				const entry = navFor(sessionId);
				const items = collectHistory(sessionRef.current);
				entry.history = items;
				if (entry.index > items.length - 1) entry.index = items.length - 1;
				return entry;
				// eslint-disable-next-line react-hooks/exhaustive-deps
			}, [sessionId, session]);

			// 穿梭中手动编辑草稿 → 自动退出穿梭，把当前草稿当作新的起点
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
				// 键盘回填后 input.draft === lastAppliedRef.current，不会触发退出
			});

			// 捕获阶段监听：在产品的 onKeyDown 之前决定是否拦截方向键
			React.useEffect(() => {
				const onKeyDown = (e) => {
					if (e.key !== "ArrowUp" && e.key !== "ArrowDown" && e.key !== "Escape") return;
					const t = e.target;
					if (!(t instanceof HTMLElement)) return;
					if (t.tagName !== "TEXTAREA") return; // 只在输入框聚焦时生效
					if (!t.closest("[data-input-scroll]")) return; // 必须是会话输入框
					if (t.readOnly || t.disabled) return; // 忙碌/只读态让位
					if (e.isComposing || e.keyCode === 229) return; // IME 组合输入
					if (e.ctrlKey || e.metaKey || e.altKey) return; // 保留系统快捷键
					if (hasOpenMenu()) return; // 弹出菜单开启时方向键让位

					const entry = navFor(sessionId);
					if (e.key === "ArrowUp" || e.key === "ArrowDown") {
						if (e.shiftKey) return; // 保留 Shift+↑/↓ 的选区扩展
						if (entry.history.length === 0) return;
						if (e.key === "ArrowDown" && entry.index === -1) return; // 未在穿梭，↓ 不拦截
						e.preventDefault();
						e.stopImmediatePropagation();

						const goingUp = e.key === "ArrowUp";
						if (goingUp) {
							if (entry.index === -1) {
								// 首次 ↑：暂存当前草稿，跳到最新的历史消息
								entry.stash = t.value;
								entry.index = entry.history.length - 1;
							} else if (entry.index > 0) {
								entry.index -= 1;
							}
							// 已在最旧一条，再按 ↑ 停在原地
						} else {
							if (entry.index >= entry.history.length - 1) {
								// 已到最新，再按 ↓：恢复进入穿梭前的草稿并退出
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

					// Escape：退出穿梭并恢复进入前的草稿（其余场景不拦截 Esc）
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

			// 非穿梭状态不占空间；穿梭时在输入框上方显示轻量提示条
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
.dsh-msg-toggle{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;border:none;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;transition:background-color .15s ease,color .15s ease}
.dsh-msg-toggle:hover{background:color-mix(in srgb,var(--dsw-alias-label-primary) 8%,transparent);color:var(--dsw-alias-label-primary)}
.dsh-msg-toggle-on{color:var(--dsw-alias-brand-primary);background:color-mix(in srgb,var(--dsw-alias-brand-primary) 10%,transparent)}
.dsh-msg-panel{position:fixed;box-sizing:border-box;display:flex;flex-direction:column;overflow:hidden;pointer-events:auto;z-index:60;background:var(--dsw-alias-bg-overlay);border:1px solid var(--dsw-alias-border-l1);border-radius:12px;box-shadow:0 8px 32px color-mix(in srgb,var(--dsw-alias-label-primary) 16%,transparent);font-size:13px;line-height:1.45;color:var(--dsw-alias-label-primary);animation:dsh-msg-panel-in .18s ease-out}
@keyframes dsh-msg-panel-in{from{opacity:0;transform:translateX(16px)}to{opacity:1;transform:none}}
.dsh-msg-panel-head{display:flex;align-items:center;gap:8px;padding:12px 14px 10px;border-bottom:1px solid var(--dsw-alias-border-l1)}
.dsh-msg-panel-title{font-size:14px;font-weight:600}
.dsh-msg-panel-count{font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-2);border-radius:8px;padding:0 7px}
.dsh-msg-panel-close{margin-left:auto;display:inline-flex;align-items:center;justify-content:center;width:26px;height:26px;border:none;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;transition:background-color .15s ease,color .15s ease}
.dsh-msg-panel-close:hover{background:color-mix(in srgb,var(--dsw-alias-label-primary) 8%,transparent);color:var(--dsw-alias-label-primary)}
.dsh-msg-panel-list{flex:1;min-height:0;overflow-y:auto;padding:6px;display:flex;flex-direction:column;gap:2px;scrollbar-width:thin}
.dsh-msg-panel-list::-webkit-scrollbar{width:6px}
.dsh-msg-panel-list::-webkit-scrollbar-thumb{background:color-mix(in srgb,var(--dsw-alias-label-secondary) 25%,transparent);border-radius:3px}
.dsh-msg-panel-empty{flex:1;display:flex;align-items:center;justify-content:center;color:var(--dsw-alias-label-secondary);font-size:13px;padding:24px}
.dsh-msg-item{display:flex;gap:10px;align-items:flex-start;width:100%;text-align:left;border:none;background:transparent;border-radius:8px;padding:8px 10px;cursor:pointer;color:inherit;font:inherit;transition:background-color .15s ease}
.dsh-msg-item:hover{background:color-mix(in srgb,var(--dsw-alias-label-primary) 6%,transparent)}
.dsh-msg-item-on{background:color-mix(in srgb,var(--dsw-alias-brand-primary) 12%,transparent)}
.dsh-msg-item-on .dsh-msg-item-text{color:var(--dsw-alias-brand-primary)}
.dsh-msg-item-avatar{flex:none;display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;border-radius:50%;margin-top:1px}
.dsh-msg-avatar-user{background:color-mix(in srgb,var(--dsw-alias-label-secondary) 16%,transparent);color:var(--dsw-alias-label-secondary)}
.dsh-msg-item-body{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px}
.dsh-msg-item-text{overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;word-break:break-word}
.dsh-msg-item-time{font-size:11px;color:var(--dsw-alias-label-secondary)}
@keyframes dsh-msg-flash-kf{0%{background-color:color-mix(in srgb,var(--dsw-alias-brand-primary) 30%,transparent)}100%{background-color:transparent}}
.dsh-msg-flash{animation:dsh-msg-flash-kf 1.6s ease-out}
.dsh-msg-history-strip{display:flex;align-items:center;gap:8px;justify-content:flex-end;padding:2px 4px 4px;font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary);user-select:none;animation:dsh-msg-strip-in .15s ease-out}
@keyframes dsh-msg-strip-in{from{opacity:0;transform:translateY(-4px)}to{opacity:1;transform:none}}
.dsh-msg-history-badge{color:var(--dsw-alias-brand-primary);background:color-mix(in srgb,var(--dsw-alias-brand-primary) 10%,transparent);border-radius:6px;padding:0 6px}
.dsh-msg-history-hint{opacity:.85;font-variant-numeric:tabular-nums}
@media (prefers-reduced-motion:reduce){.dsh-msg-panel{animation:none}.dsh-msg-flash{animation:none}.dsh-msg-history-strip{animation:none}}
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

			slots.inject("conversation.session.header.utilities", () =>
				slots.register(
					{ name: "conversation.session.header.utilities", id: "msg-jump-toggle", order: 10, label: "指令列表" },
					() => React.createElement(ToggleButton, null),
				),
			);

			// v0.2.0：输入框 ↑/↓ 历史消息穿梭（提示条 + 键盘拦截）
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

			slots.inject("shell.overlay", () =>
				slots.register(
					{ name: "shell.overlay", id: "msg-jump-panel", order: 100, label: "指令列表" },
					(props) => React.createElement(Panel, { useSessions: props.useSessions }),
				),
			);
		}

		exports.inject = inject;
		exports.apply = apply;
		return module.exports;
	}
});