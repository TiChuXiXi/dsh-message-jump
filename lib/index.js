// dsh-message-jump 主机端（Node）半边
//
// 提供 Package-private RPC：msgjump.fullHistory → 返回本地会话**完整历史**
// 的用户指令列表（含尚未加载到聊天视图中的"更早"指令，按 seq 升序），
// 供浏览器导航条的刻度覆盖全量指令（不只当前已加载窗口）。
//
// 数据源：ctx.sessionQuery.readSession(sessionId).events（完整原始事件日志）。
export const apply = (ctx) => {
  const sessionQuery = ctx.get("sessionQuery");
  if (sessionQuery === undefined) return;

  const blockText = (blocks) => {
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
  };

  if (typeof harness === "undefined" || !harness || typeof harness.handle !== "function") return;
  harness.handle("msgjump.fullHistory", async (args) => {
    const sessionId = args && args.sessionId;
    if (!sessionId) return { items: [] };
    let events = [];
    try {
      const snap = await sessionQuery.readSession(sessionId);
      events = (snap && snap.events) || [];
    } catch (_e) {
      return { items: [] };
    }
    const items = [];
    for (const ev of events) {
      if (!ev || ev.type !== "user/message") continue;
      const msg = ev.data || {};
      // 只保留真实用户指令（人工输入 / 用户 steering）：source.kind === "user"。
      // 过滤掉系统注入的上下文（agent-instructions / skill-catalog /
      // at-file-mention / plugin 等），这些不应成为导航条刻度。
      if (!msg.source || msg.source.kind !== "user") continue;
      const text = blockText(msg.content).replace(/\s+$/, "").trim();
      if (!text) continue;
      // 连续重复去重（贴近聊天节点的收录规则）
      if (items.length > 0 && items[items.length - 1].text === text) continue;
      items.push({
        seq: ev.seq,
        time: ev.time || msg.time || 0,
        text: text.slice(0, 200),
      });
    }
    // 事件按序增加；再显式稳定排序兜底
    items.sort((a, b) => a.seq - b.seq);
    return { items };
  });
};
