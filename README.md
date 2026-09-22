# Hermes 壁纸引擎 · Hermes Wallpaper Engine

Hermes Desktop 的桌面壁纸插件 —— **单文件 `plugin.js`，零依赖、零构建**。
A single-file desktop wallpaper plugin for **Hermes Desktop** — no build step, no npm install, no dependencies beyond the host plugin SDK.

![status](https://img.shields.io/badge/status-live-brightgreen) ![license](https://img.shields.io/badge/license-MIT-blue)

---

## 支持范围 / What it supports

| 壁纸类型 / Kind | 扩展名 / Ext | 渲染方式 / How it renders | 备注 / Notes |
|---|---|---|---|
| 静态图片 / Still image | `jpg` `jpeg` `png` `webp` `gif` `bmp` `avif` | `<img>` 图层 | GIF/WebP 动画直接动 |
| 视频 / Video | `mp4` `webm` `mov` | `<video>` 图层 | 默认静音，可开声音；HEVC 在 Chromium 下不解码 → 请用 H.264 |
| 网页 / Web page | `html` `htm` | `<iframe>` 第三图层（不加 `sandbox`，与宿主同权限） | 可放任意 HTML/CSS/Canvas 动画 |
| Wallpaper Engine 场景 / Scene | 创意工坊 `scene.pkg` | **封面回退**：显示同目录 `preview.jpg/gif/png` | `.pkg` 本体永不进库；原生 WebGL 场景渲染见下方 Roadmap |
| Wallpaper Engine 视频·网页 | 同上 | 按上面 video / web 规则渲染 | —— |

### Wallpaper Engine 创意工坊（Steam appid 431960）

* **自动探测**：遍历 `A–Z` 全部盘符 × 4 种常见安装形态（`Program Files (x86)\Steam`、`Program Files\Steam`、`Steam`、`SteamLibrary`），**凡是存在的库全部挂载**（一台机器多个 Steam 库很常见）。
* **自动下钻**：创意工坊是 `<库>\steamapps\workshop\content\431960\<壁纸ID>\<本体>`，插件自动进一层找真正的壁纸文件。
* **剔除封面**：每个订阅目录自带的 `preview.jpg/gif/png` 不会混进壁纸池（只在 scene 场景壁纸的卡片里当封面用）。
* 首次启动自动挂载（幂等，只播一次种）；之后你手动删掉的库不会自己回来，面板里有按钮可再探测一次。

### 库面板 / Library grid

* 缩略图网格（`auto-fill` 60px 列 / 40px 高缩略图，一屏看很多张）
* 缩略图：图片 = 真图；**视频 = 壁纸目录自带的静态封面**（`preview.jpg` → `preview.gif` 逐级回退，纯 `<img>`，不给卡片建 `<video>`，零解码器开销）；网页 = 🌐 图标
* 文件名搜索 + 类型过滤（全部 / 图片 / 视频）+ 点卡片即应用
* 软隐藏单张（不删源文件）·「恢复全部」找回 ·「重新扫描」刷新

### 显示控制 / Display controls

适配模式 `cover` / `contain` / `fill` · 模糊度 · 亮度 · 对比度 · 饱和度 · 暗化遮罩 · 面板透明度 · 切换动画时长 · 深色/浅色**跟随系统自动同步**。

### 轮换 / Rotation

最多 5 个壁纸文件夹（逐个可启用）· 单个文件夹直接指定一张图 · 顺序/随机 ·「更换间隔」定时切换 · 失败自动回退（连续失败 5 次停止该张，界面恢复原主题）。

**扫描结果常驻 / Scan results persist**：文件夹扫描只做一次 —— 结果留在内存并落盘（TTL 6 小时）。换壁纸、定时轮换、重开面板都复用同一份列表，不再每次重扫硬盘（上百张壁纸 + 创意工坊深扫一次不便宜）。改过文件夹、或点「重新扫描」，立即真扫并刷新缓存。
Folder scans happen once: the result is cached in memory and on disk (6h TTL). Switching wallpapers, timed rotation and reopening the panel all reuse the same list instead of re-walking the folders. Editing folders or pressing Rescan forces a fresh scan.

### 快捷键 / Keybinds

| 快捷键 | 作用 |
|---|---|
| `Ctrl/Cmd + K` → `壁纸` | 打开壁纸设置 |
| Wallpaper: 换一张壁纸 | 立刻换下一张 |
| Wallpaper: 标记/取消标记当前壁纸 | 把当前这张标记为「喜欢 / 不喜欢」，轮换时优先避开 |
| Wallpaper: 重载窗口，应用右侧栏布局 | 布局异常时重载 |

---

## 安装 / Install

1. 找到 Hermes 的 home 目录：
   * Windows: `%LOCALAPPDATA%\hermes\`
   * macOS / Linux: `~/.local/share/hermes/`（或你自定义的 `HERMES_HOME`）
2. 把 `plugin.js` 放进 `desktop-plugins/wallpaper/`：

```
<hermes home>/desktop-plugins/wallpaper/plugin.js
```

3. **保存即生效**：桌面端用 `fs.watch` 监听 `plugin.js`（120ms 去抖）自动热重载，不用重启。
4. 打开设置：`Ctrl/Cmd + K` → 输入 `壁纸` → Wallpaper 设置 → 勾「启用图片背景」。
5. 图源二选一：**单图**（填绝对路径）或**壁纸文件夹**（≤5 个，逐个勾启用）。
6. 想直接吃 Wallpaper Engine 库：什么都不用填，首次启动会自动探测并挂载（日志里能看到 `steam-library added=…`）。

> `Ctrl/Cmd + K` 里的 “Reload desktop plugins” 只做目录增删扫描，对**已装载**的插件是 no-op；改代码靠自动热重载，彻底没反应就重启桌面端。

### 回退 / Rollback

改坏了就换回你上一份 `plugin.js`。建议自己留备份链：`plugin.js.bak_<版本>`（本仓库不带备份文件）。

---

## 已知限制 / Known limitations

* **`scene.pkg` 不原生渲染**：库里以 `preview.*` 封面回退显示（卡片和壁纸都是封面图）。完整的 Wallpaper Engine 场景需要 WebGL 播放器，见 Roadmap。
* **网页壁纸卡片缩略图只有 🌐 图标**：给每张 `.html` 挂一个 iframe 当缩略图的代价远大于收益。
* `preview.*` 一律不进壁纸池；`.pkg` 本体一律不进壁纸池。
* 壁纸文件夹上限 5 个（面板里校验）。
* 视频壁纸默认静音（Chromium 自动播放策略），面板里可开声音；开启后需要先点一下界面才会出声。
* 4K 视频壁纸会持续吃 GPU，笔记本注意。
* 视频卡片只显示静态封面，**开面板不会为每张视频壁纸起解码器**（v48 起，缩略图不再用 `<video>` 取帧）。
* HEVC/H.265 视频在 Chromium 里不解码 → 黑屏，请转成 H.264。

---

## Roadmap

* **场景壁纸真渲染（进行中）**：把 Wallpaper Engine 的 `.pkg` → `.tex` → `scene.json`（图层/材质/粒子/相机）解出来，走 WebGL 播放器在 `<iframe>` 里活体渲染，取代现在的封面回退。
* 网页壁纸缩略图（隐藏窗口截图）。
* 库面板：分级筛选、分页、多目录刷新按钮。

---

## 隐私 / Privacy

本仓库**只包含插件源码与文档**：

* ❌ 不含任何本机绝对路径（盘符与用户目录在运行时探测，代码里只有通用的 `A–Z` 盘符模板）
* ❌ 不含任何凭据、token、API key
* ❌ 不含任何壁纸订阅清单、文件名、收藏记录或使用日志
* ✅ 唯一的对外请求：创意工坊库探测走宿主提供的 `readDir` API，纯本地文件系统读取，不联网

---

## 来源与许可 / Credits & License

* 基于 [KonjacW/hermes-wallpaper-plugin](https://github.com/KonjacW/hermes-wallpaper-plugin) 的 v3 版本继续开发；**上游仓库未声明许可证**（`license: null`），因此本仓库的 MIT 许可**只覆盖本仓库的改动部分**，上游原始代码的权利仍归其作者。若你是上游作者并希望调整署名或许可方式，开 issue 即可。
* 本仓库相对上游的主要改动：视频壁纸（`<video>` 图层与声音开关）、网页壁纸（`<iframe>` 图层）、Wallpaper Engine 创意工坊库自动探测/多库挂载/下钻/封面剔除、壁纸库缩略图网格（搜索/过滤/软隐藏）、视频卡片静态封面缩略图（不建 `<video>`，省内存）、卡片缩小、多文件夹轮换、**扫描结果常驻缓存（内存 + 落盘，6 小时 TTL）** 与大量 UI/主题对齐。
* 本仓库自己的改动以 MIT 发布 —— 见 [LICENSE](LICENSE)。
