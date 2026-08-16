# dsh-message-jump

DSH（DeepSeek Harness）web 消息定位侧栏插件：在会话页右侧提供类似 DeepSeek 网页对话的**指令列表**面板，一键列出会话中的全部用户指令，点击即可平滑滚动定位到对应历史消息，不用再一点一点往上翻。

## 功能

- **指令列表**：会话页头部右侧新增"指令列表"图标按钮，点击后在会话区右侧滑出浮动面板，按时间列出会话中全部**用户指令消息**（含模型运行中插入的用户消息 `steering`），不收录模型回复与系统注入的上下文；
- **一键定位**：点击任一条目，会话区平滑滚动到该指令（距顶部 16px 停靠）并闪烁高亮 1.6 秒，面板内该条目同步保持可见并高亮；
- **滚动联动**：手动滚动聊天时，列表实时高亮当前位于视口顶部的指令（跳转后有 800ms 锁定，避免与点击定位抢焦点）；
- **多种关闭方式**：点击面板外部任意位置、按 `Esc`、点右上角 ×、再点头部开关按钮均可关闭；
- **主题适配**：全部样式使用 DSH 主题 CSS 变量（`--dsw-alias-*`），浅色 / 深色自动适配；新消息出现时列表即时更新。

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

1. 打开任意会话，点击会话头部右侧的"指令列表"图标按钮；
2. 面板列出全部用户指令（圆形用户头像 + 两行预览 + 时间）；
3. 点击任一条目即可定位到对应消息；
4. 点击面板外任意位置、`Esc` 或 × 关闭面板。

## 工作原理

插件是一个同时声明 `dsh.bundle.patch`（host 层）与 `dsh.client`（浏览器层）的包：

- `cordis.patch.yml`：向 web 组合树插入一条 loader 行 `message-jump`
- `lib/index.js`：host 半边（空插件，使 loader 行成立）
- `lib/client.js`：浏览器半边，注册两个插槽：
  1. `conversation.session.header.utilities`：头部"指令列表"开关按钮；
  2. `shell.overlay`：右侧浮动面板本体。

数据与定位不依赖任何私有接口：

- 列表数据来自会话快照 `ConversationSnapshot.chat`（与 `useSession` 同源），通过 `sessions.binding(id).session` 订阅；
- 滚动定位复用 DSH 聊天视图自身的稳定 DOM 锚点：每条消息渲染在带 `data-chat-anchor-key` 的节点上，滚动容器是 `[data-conversation-scroll]`，与产品内部的 `anchorElement` / `scrollerOf` 机制一致；
- 面板仅做只读查询与平滑滚动，不修改产品 DOM 结构（高亮仅为临时 CSS 类，1.6 秒后自动移除）。

## 自定义

编辑 `lib/client.js` 即可调整：

- `previewOf` 中的 `64`：预览文本截断长度
- 面板宽高（`Panel` 中 `width: 316`、边距 `12`）
- 是否把 `context` 注入消息也收进列表（`collectItems` 中放宽 `kind` 判断）

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
