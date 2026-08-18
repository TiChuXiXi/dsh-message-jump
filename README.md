# dsh-message-jump

DSH（DeepSeek Harness）web 消息增强插件：

- **指令导航条**：会话区左侧/右侧的丝滑悬浮指令导航条（Codex 时间线风格），每条已发送的用户指令是一个刻度，滚动联动定位、悬停预览内容、点击跳转，显示位置可在设置中切换左/右；
- **↑/↓ 历史消息穿梭**：输入框聚焦时按方向键上下键，像终端命令历史一样把当前会话已发送过的历史内容快速回填到输入框。

## 功能

### 一、指令导航条（v0.3.0 重构）

取代 v0.1/v0.2 的"右上角按钮 + 右侧大面板"，改为沿**会话区左缘或右缘**常驻的细长导航条，类似 Codex 的对话时间线：

- **滚动联动定位**：每条已发送的用户指令（含 `steering`）对应一个刻度条，所有刻度**等距集中在同一个小型容器里**（集中式堆叠，不随消息在全文中的位置分散）；**深色刻度 = 当前位于视口顶部的指令**，随滚动实时刷新（跳转后有 800ms 锁定，避免与点击抢焦点）；
- **丝滑悬停**：鼠标悬停时，以悬停刻度为中心向四周产生"宽度过渡"涟漪（`d=0→3` 逐级衰减，CSS transition 平滑过渡），旁边浮出该指令的内容预览 + 时间气泡；**自适应对齐**——导航条在左侧时刻度左对齐、悬停向右变宽，在右侧时右对齐、悬停向左变宽；
- **点击跳转**：点击刻度平滑滚动到对应消息（距顶部 16px 停靠）并闪烁高亮 1.6 秒；
- **位置可配置**：设置 → 常规 →"指令导航条位置"，可选**左侧 / 右侧**，立即生效并持久化（localStorage）；默认右侧。

### 二、输入框 ↑/↓ 历史消息穿梭（v0.2.0 新增）

在消息输入框聚焦时，直接使用键盘 **↑ / ↓** 快速穿梭当前会话已发送过的历史内容（类似终端/命令行按方向键翻阅命令历史的交互）：

- **↑ 回退**：把更早发送过的消息全文回填到输入框；连续按 ↑ 继续向前翻；
- **↓ 前进**：向更新的消息前进；翻到最新一条后再按 ↓ 会恢复你开始穿梭前输入框里未发送的草稿；
- **Esc 退出**：任何时候按 `Esc` 退出穿梭并恢复进入前的草稿；
- **草稿保护**：穿梭前输入框里未发送的内容会被暂存，退出后完整还原；穿梭中一旦手动编辑草稿，自动退出穿梭，不再覆盖你的输入；
- **轻量提示**：穿梭时输入框上方显示 `历史消息 ↑↓ n/m · Esc 退出` 提示条，当前选中的历史位置一目了然；
- **智能让位**：输入框忙碌/只读、输入法（IME）组合输入、`/` 命令候选菜单或下拉菜单开启时，↑/↓ 不会被劫持，产品原有交互不受影响。

## 安装

### 从 npm 安装（推荐）

```bash
dsh plugin --profile web add dsh-message-jump
```

安装完成后**重启 dsh web** 生效。

### 从本地源码安装（开发调试）

```bash
# 在插件目录的父目录执行
dsh plugin --profile web add ./dsh-message-jump
```

> Windows 注意：pnpm 在 Windows 上对跨盘绝对路径的 `link:` / `file:` 规格可能生成错误的链接。若 `dsh plugin` 提示 `dsh-message-jump declares no dsh.bundle`，手动修复链接后重试：
>
> ```powershell
> # 以 profile 目录为例
> Remove-Item "$env:USERPROFILE\.dsh\profiles\web\node_modules\dsh-message-jump" -Force
> New-Item -ItemType Junction -Path "$env:USERPROFILE\.dsh\profiles\web\node_modules\dsh-message-jump" -Target "<本插件绝对路径>"
> ```

### 从 GitHub 安装

```bash
dsh plugin --profile web add github:TiChuXiXi/dsh-message-jump
```

## 使用

### 指令导航条

1. 打开任意会话，导航条沿会话区右缘（默认）显示，每条你发送过的指令对应一个刻度；
2. 滚动聊天，深色刻度实时标记当前视口顶部的指令；鼠标悬停刻度预览指令内容，点击刻度跳转定位并闪烁高亮；
3. 设置 → 常规 →"指令导航条位置"，切换**左侧 / 右侧**立即生效。

### 历史消息穿梭

1. 聚焦消息输入框，按 **↑** 回填最近一次发送过的内容；
2. 继续按 ↑ / ↓ 翻阅更早/更新的历史消息，输入框上方会显示当前位置 `n/m`；
3. 按 **Esc** 或翻到最新后继续按 **↓**，恢复进入穿梭前的草稿；
4. 穿梭中直接打字即可退出穿梭，开始编辑新内容。

## 工作原理

插件是一个同时声明 `dsh.bundle.patch`（host 层）与 `dsh.client`（浏览器层）的包：

- `cordis.patch.yml`：向 web 组合树插入一条 loader 行 `message-jump`
- `lib/index.js`：host 半边（空插件，使 loader 行成立）
- `lib/client.js`：浏览器半边，注册三个插槽：
  1. `shell.overlay`：会话区左/右缘的悬浮指令导航条（v0.3.0 重构）；
  2. `settings.general.item`：设置 → 常规 →"指令导航条位置"（左/右切换，localStorage 持久化）；
  3. `conversation.input.dock`：输入框上方的历史穿梭提示条（v0.2.0 新增）。

数据与定位不依赖任何私有接口：

- 列表数据来自会话快照 `ConversationSnapshot.chat`（与 `useSession` 同源），通过 `sessions.binding(id).session` 订阅；
- 滚动定位复用 DSH 聊天视图自身的稳定 DOM 锚点：每条消息渲染在带 `data-chat-anchor-key` 的节点上，滚动容器是 `[data-conversation-scroll]`，与产品内部的 `anchorElement` / `scrollerOf` 机制一致；导航条通过读取该容器 bounding rect 沿左/右缘垂直居中悬浮，刻度条在容器内等距堆叠；
- 导航条只做只读查询与平滑滚动，不修改产品 DOM 结构（高亮仅为临时 CSS 类，1.6 秒后自动移除）；
- 历史穿梭复用 `conversation.input.dock` 槽位提供的 `InputZone` owner props（`session` 会话快照 + `input` 输入状态）与公开的 `inputActions.setDraft()` 接口回填草稿；键盘监听挂在 `document` 捕获阶段、先于产品自身 `onKeyDown` 介入，且只在输入框聚焦、无弹出菜单争夺方向键、非 IME 组合输入时生效。

## 自定义

编辑 `lib/client.js` 即可调整：

- `RAIL_PAD` / `BAR_W` / `BAR_MAX_W` / `BAR_H` / `BAR_GAP`：贴边间距、刻度条默认/最大宽度、条高、条间距
- 悬停"宽度涟漪"的衰减半径：`barWidth` 中 `1 - d / 3`（`3` 即影响半径，改大涟漪更宽）
- 悬停预览截断长度：`previewOf` 中的 `96`
- 是否把 `context` 注入消息也收进导航条/列表（`collectItems` 中放宽 `kind` 判断）
- 历史穿梭收录范围：`collectHistory` 中放宽 `kind` 判断（目前只收 `user` / `steering`）
- 连续重复去重：`collectHistory` 中 `continue` 分支（默认连续相同的消息只记一次）

修改后重启 dsh web 生效。

## 文件结构

```
dsh-message-jump/
├── package.json        # dsh.bundle + dsh.client 声明
├── cordis.patch.yml    # bundle patch（插入 loader 行）
├── README.md
├── LICENSE             # MIT
└── lib/
    ├── index.js        # host 半边
    └── client.js       # 浏览器半边（核心逻辑）
```

## License

[MIT](LICENSE)
