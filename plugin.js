/**
 * Hermes desktop plugin — wallpaper (v3 安全版).
 * 图片背景 + 失败自动回退：
 *   - 启用前先用 <img> 预加载探测，图片可加载才注入壁纸
 *   - 图片加载失败 → 不注入任何样式，界面保持 Hermes 原始主题，面板显示错误
 *   - 取消启用 → 彻底清理所有注入，恢复原始主题
 * 保存为 <hermes home>/desktop-plugins/wallpaper/plugin.js
 * 保存到部署目录即**自动热重载**（桌面端 fs.watch 监听 plugin.js，120ms 去抖）。
 * 注意 ⌘K 的 "Reload desktop plugins" 只做目录增删扫描，对已装载的插件是 no-op。
 * 发布走 scripts/publish.sh（门禁 + 原子替换）。
 */

import {
  atom,
  cn,
  host,
  KEYBINDS_AREA,
  PALETTE_AREA,
  PANES_AREA,
  ROUTES_AREA,
  STATUSBAR_AREAS,
  useValue
} from '@hermes/plugin-sdk'
import { jsx, jsxs } from 'react/jsx-runtime'
import { useState } from 'react'

const ID = 'wallpaper'
const STORE_KEY = 'wallpaper-cfg-v8' // v8: 多壁纸文件夹（最多 5 个，逐个可启用）；v7/v6 自动迁移

// ── 默认参数 ──────────────────────────────────────────────────────────────
const DEFAULTS = {
  enabled: false,   // 默认关闭
  imagePath: '', // 默认空：首次打开设置面板由用户自行选择图片路径（本地路径或 http(s) 链接）
  blur: 4,           // px
  brightness: 0.6,   // 压暗亮壁纸，保证文字对比度
  dim: 0.2,          // 黑色遮罩
  surfaceAlpha: 0.55, // 内容底不透明度（独立一层，垫在文字下；壁纸从底下透出）
  // v24 文件夹定时轮换：
  folders: [],       // v36：壁纸文件夹列表（最多 5 个，每项 {path, enabled}；空 = 无文件夹图源）
  rotate: false,     // 定时轮换开关
  intervalMin: 15,   // 更换间隔（分钟）
  order: 'random',   // 'random' | 'shuffle' | 'seq'
  animStyle: 'fade-zoom', // 'none' | 'fade' | 'fade-zoom' | 'blur'
  animMs: 900,       // 切换动画时长（毫秒）
  // v39 视频声音（对齐 dsh 壁纸声音插件）：默认静音保证 autoplay 不被拒，
  // 用户开启后，首次手势（pointerdown/keydown）才真正出声
  videoSound: false,
  videoVolume: 0.6,
  // v40 对齐 dsh 壁纸面板：画面适配 / 对比度饱和度 / 视频倍速 / 隐藏壁纸
  fit: 'cover',      // 'cover' | 'contain' | 'fill'
  contrast: 1,       // 对比度
  saturate: 1,       // 饱和度
  videoSpeed: 1,     // 视频壁纸倍速（0.5x–2x）
  hidden: [],        // 软隐藏的壁纸绝对路径（不删源文件，可在面板恢复）
  // v41：Steam 创意工坊壁纸库（Wallpaper Engine 431960）—— 首次启动自动挂载并置 true；
  // 用户删掉后不再回填，面板「Steam 壁纸库」按钮可手动加回
  steamSeeded: false,
  // v28.4：诊断转储（默认关；打开后每次 apply 会 dump 全量槽位/深度诊断到日志，
  // 供配色审查用——实测会增加 ~0.5s 主线程阻塞与 ~100KB 日志）
  debugDump: false,
  // v33 锁定：冻结自动轮换 + 钉住当前这张（图源仍是文件夹；手动换图仍可用）
  locked: false,
  lockedPath: ''     // 锁定态钉住的图片绝对路径（重启后直接显示它，不再随机抽一张）
}

// ── 工具 ──────────────────────────────────────────────────────────────────
// Windows 路径 → file:/// URL（反斜杠、空格、中文都要转义）
function pathToFileUrl(p) {
  if (!p) return ''
  if (/^https?:\/\//i.test(p)) return p
  const norm = p.replace(/\\/g, '/')
  const withSlash = norm.startsWith('/') ? norm : '/' + norm
  return 'file://' + withSlash.split('/').map(encodeURIComponent).join('/').replace(/%3A/i, ':')
}

// 通用超时包装：任何 await 类探测都必须带超时，否则门锁永久卡死（该功能永久失效）
function withTimeout(promise, ms, label) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(label + ' 超时 ' + ms + 'ms')), ms)
    promise.then(
      (v) => { clearTimeout(t); resolve(v) },
      (e) => { clearTimeout(t); reject(e) }
    )
  })
}

// 预加载探测：图片可加载 → resolve(url)；失败 → reject
// v27: 加 8s 超时——file:// 大图偶发不触发 onload/onerror 会让调用方
// 永久 await（门锁卡死 → 手动切换全部失效）；v28 另有 token 门锁 6s 自愈兜底。
// v38: 视频/mp4|webm|mov 走 <video> loadeddata 探测（复用同一门锁/超时）
function probeImage(url) {
  const clean = String(url).split(/[?#]/)[0]
  if (/\.(mp4|webm|mov)$/i.test(clean)) {
    return new Promise((resolve, reject) => {
      const v = document.createElement('video')
      v.muted = true
      v.preload = 'auto'
      let done = false
      const finish = (fn, arg) => {
        if (done) return
        done = true
        clearTimeout(timer)
        v.removeAttribute('src')
        v.load()
        fn(arg)
      }
      const timer = setTimeout(() => {
        console.error('[wallpaper] probe TIMEOUT', url)
        finish(reject, new Error('视频探测超时: ' + url))
      }, 8000)
      v.onloadeddata = () => {
        console.error('[wallpaper][diag] probe OK video', url)
        finish(resolve, url)
      }
      v.onerror = () => {
        console.error('[wallpaper] probe FAIL', url)
        finish(reject, new Error('视频加载失败: ' + url))
      }
      v.src = url
    })
  }
  return new Promise((resolve, reject) => {
    const img = new Image()
    let done = false
    const finish = (fn, arg) => {
      if (done) return
      done = true
      clearTimeout(timer)
      fn(arg)
    }
    const timer = setTimeout(() => {
      console.error('[wallpaper] probe TIMEOUT', url)
      finish(reject, new Error('图片探测超时: ' + url))
    }, 8000)
    img.onload = () => {
      // 用 console.error 级别（日志只记录 level 3）输出诊断
      console.error('[wallpaper][diag] probe OK', url, 'size=' + img.naturalWidth + 'x' + img.naturalHeight)
      finish(resolve, url)
    }
    img.onerror = () => {
      console.error('[wallpaper] probe FAIL', url)
      finish(reject, new Error('图片加载失败: ' + url))
    }
    img.src = url
  })
}

// ── DOM 层管理 ────────────────────────────────────────────────────────────
// v24：bg 为切换动画的临时第二层（动画结束转正为 bg）
// v28：壁纸层改为固定双槽 A/B（换图 = 两槽交叉淡化），不再用 -next 临时 id
// v37：'hermes-wallpaper-css' 已移出本清单 —— 样式表不再跟图层一起被清。
// 否则任何一次图层回滚（图片 onerror、暂停态）都会把整套黑金配色一起删掉，用户看到
// 「壁纸 + 配色整体消失、回到默认主题」（V1），而且没有重注入路径。样式表由
// ensureWallpaperCss() 幂等注入，removeWallpaperCss() 只在显式关壁纸/卸载时删。
const LAYER_IDS = [
  'hermes-wallpaper-bg-a',
  'hermes-wallpaper-bg-b',
  'hermes-wallpaper-dim',
  'hermes-wallpaper-base'
]
// 历史版本残留 id 见 swap-state-machine 区的 WP_LEGACY_LAYER_IDS（单一来源）

// v28.4：诊断/转储开关（默认关）。排障时在设置面板打开，或直接改 storage。
function cfgDebug() { return !!($cfg && $cfg.get && $cfg.get().debugDump) }

// v37：按归属删元素 —— 只删自己的 / 已死实例的孤儿 / 无标记的旧残留，
// **绝不碰另一个还活着的实例的元素**（V1：旧实例一次误清就能抹掉新实例的配色与壁纸）。
// 全文件的「按 id 删 DOM」都收敛到这一个可审计点。
function removeOwnedById(id) {
  const live = Object.keys(wpInstanceLedger(window).live)
  for (const el of document.querySelectorAll('#' + id)) {
    const owner = el.dataset ? el.dataset.wpOwner : ''
    if (wpReapDecision(INSTANCE_ID, live, owner) === 'remove') el.remove()
  }
}

function cleanupLayers() {
  if (typeof document === 'undefined') return
  // 每个 id 可能因历史 bug 残留多个元素（getElementById 只能删第一个）→ 全清；
  // 删除一律走 removeOwnedById（v37 归属判定），理由见那里。
  for (const id of LAYER_IDS.concat(WP_LEGACY_LAYER_IDS)) removeOwnedById(id)
  const st = getRotatorState()
  wpTakeInflight(st)   // 清动画门锁 + 丢掉飞行层引用
  wpForceEndPick(st)   // 选图门也作废（评审 F2：归属化，别让旧流清掉新流）
  st.visible = 0
  st.currentPath = ''  // v35：图层清了，账本也跟着空
  // 评审 F1：清图层 = 配置代数变化，在飞 rotateOnce 的续体据此作废
  st.generation = (st.generation || 0) + 1
  if (st.queueTimer) { clearTimeout(st.queueTimer); st.queueTimer = null }
  if (st.applyTimer) { clearTimeout(st.applyTimer); st.applyTimer = null }
}

// ── 双槽图层工具（A/B 两槽，任意时刻最多两层）──────────────────────────────
// 槽位 id / 待删 id 集在 swap-state-machine 区里（纯逻辑、有单测）
const bgSlotId = wpBgSlotId

// 当前可见层（槽位账本为准；账本与 DOM 不一致时回退到任一存在层）
function currentLayerEl() {
  const st = getRotatorState()
  const slots = [bgSlotId(st.visible), bgSlotId(0), bgSlotId(1)]
  // v37（审查闭环 F3）：同一 id 可能同时存在多个实例的层（热重载残留的旧实例建的层
  // 没有归属标记，别人的层有）—— getElementById 只给文档序第一个，会把别人的层当
  // 「当前层」。先认自己的；再退到「无归属标记的旧残留」（v37 之前的构建建的）。
  for (const id of slots) {
    const own = document.querySelector('#' + id + '[data-wp-owner="' + INSTANCE_ID + '"]')
    if (own) return own
  }
  for (const id of slots) {
    const el = document.getElementById(id)
    if (el && (!el.dataset || !el.dataset.wpOwner)) return el
  }
  return null
}

// v39：0-1 夹取（音量）；非法输入回退 0.6
function wpClamp01(v) {
  const n = Number(v)
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0.6
}

// v39 声音解锁：浏览器只允许在用户手势后取消静音。保持 muted 自动播放，
// 首次 pointerdown/keydown 时把当前视频层解锁（同 dsh-plugin-wallpaper-sound 的做法）。
let wpSoundUnlockArmed = false
function wpArmSoundUnlock() {
  if (wpSoundUnlockArmed) return
  wpSoundUnlockArmed = true
  const once = () => {
    window.removeEventListener('pointerdown', once)
    window.removeEventListener('keydown', once)
    wpApplySoundToCurrent()
  }
  window.addEventListener('pointerdown', once, { passive: true })
  window.addEventListener('keydown', once)
}

// 把「已开启声音」落到当前视频层（新层创建时也会走一次）
function wpApplySoundToCurrent() {
  const cfg = $cfg ? $cfg.get() : null
  if (!cfg || !cfg.videoSound) return
  const el = typeof currentLayerEl === 'function' ? currentLayerEl() : null
  if (!el || el.tagName !== 'VIDEO') return
  el.muted = false
  el.volume = wpClamp01(cfg.videoVolume)
  const p = el.play()
  if (p && typeof p.catch === 'function') p.catch(() => {})
}

// 建一个槽位层（滤镜走 CSS 变量 --wp-blur/--wp-brightness，见 .wp-bg-layer 规则）
// v38: 视频走同槽 <video>（autoplay/muted/loop，复用双槽淡化；与图片同一套状态机）
function makeLayerEl(slot, isVideo, isWeb) {
  const el = document.createElement(isWeb ? 'iframe' : isVideo ? 'video' : 'img')
  el.id = bgSlotId(slot)
  el.className = 'wp-bg-layer'
  el.dataset.wpOwner = INSTANCE_ID   // v37：清理归属判定用（不许删另一个活实例的层）
  if (isWeb) {
    // v43：web 壁纸 = 一段本地网页（WE "web" 类型）。sandbox 不加 —— WE 网页壁纸要用脚本和
    // 同源 file:// 资源，加了就白屏。鼠标交互随 index 层的 pointer-events:none 一起关掉。
    el.setAttribute('allow', 'autoplay; fullscreen')
    el.setAttribute('scrolling', 'no')
    el.style.border = '0'
    el.style.background = 'transparent'
    // v43b：file:// 子文档跨文件不可读（contentDocument 恒为 null），LOAD 事件才是「网页真渲染了」的可用证据
    el.addEventListener('load', () => { el.dataset.wpLoaded = '1' })
  } else if (isVideo) {
    el.autoplay = true
    el.loop = true
    el.playsInline = true
    // v40：新建层按当前倍速播（与面板即时生效路径同源）
    try { el.playbackRate = Math.max(0.5, Math.min(2, Number(wpCfgCache && wpCfgCache.videoSpeed) || 1)) } catch (e) {}
    // v39：已开声音 + 本会话已有过用户手势 → 直接带声播；否则先静音，等手势解锁
    const vcfg = $cfg ? $cfg.get() : null
    const wantSound = !!(vcfg && vcfg.videoSound)
    const activated = !!(typeof navigator !== 'undefined' && navigator.userActivation && navigator.userActivation.hasBeenActive)
    if (wantSound && activated) {
      el.muted = false
      el.volume = wpClamp01(vcfg.videoVolume)
    } else {
      el.muted = true
      if (wantSound) wpArmSoundUnlock()
    }
  } else {
    el.alt = ''
    el.draggable = false
  }
  el.style.cssText =
    'position: fixed; inset: 0; z-index: 0; pointer-events: none;' +
    'width: 100vw; height: 100vh; object-fit: cover; object-position: center; opacity: 0;'
  return el
}

// 立刻落定某层：无过渡、opacity 1、回槽位 id、清掉内联 filter/transform（交回 CSS 变量）
function settleLayerEl(el, slot) {
  if (!el) return
  el.id = bgSlotId(slot)
  el.className = 'wp-bg-layer'
  el.style.transition = 'none'
  el.style.opacity = '1'
  el.style.transform = 'none'
  el.style.filter = ''
}

// 删掉除 keepSlot 之外的所有壁纸层（含历史残留 id）；待删清单由纯逻辑区给出
function removeOtherLayers(keepSlot) {
  // v37：同样过归属判定 —— 换图收尾也绝不许删另一个活实例的层
  for (const id of wpLayerIdsToRemove(keepSlot)) removeOwnedById(id)
}

// v40：画面适配取值 + 最近一次下发的配置（图层创建时按当前倍速起播）
const WP_FITS = ['cover', 'contain', 'fill']
let wpCfgCache = null

// 视觉参数实时应用（不重建图层）：模糊/亮度/遮罩/内容底透明度统一走 CSS 变量
function applyVisualParams(cfg) {
  const root = document.documentElement
  root.style.setProperty('--wp-blur', Math.max(0, Number(cfg.blur) || 0) + 'px')
  root.style.setProperty('--wp-brightness', String(Number(cfg.brightness) || 1))
  root.style.setProperty('--wp-dim', String(Math.max(0, Math.min(0.8, Number(cfg.dim) || 0))))
  root.style.setProperty('--wp-base-alpha',
    String(Math.max(0.3, Math.min(1, Number(cfg.surfaceAlpha) || 0.55))))
  // v40：画面适配 / 对比度 / 饱和度（对齐 dsh「壁纸效果」区，全部即时生效）
  root.style.setProperty('--wp-contrast', String(Math.max(0.2, Math.min(2, Number(cfg.contrast) || 1))))
  root.style.setProperty('--wp-saturate', String(Math.max(0, Math.min(3, Number(cfg.saturate) || 1))))
  root.style.setProperty('--wp-fit', WP_FITS.indexOf(cfg.fit) >= 0 ? cfg.fit : 'cover')
  wpCfgCache = cfg
  applyVideoSpeed(cfg)
}

// v40：视频倍速（对齐 dsh「视频倍速 0.5x–2x」）——对已有视频层即时生效，不重建图层
function applyVideoSpeed(cfg) {
  const sp = Math.max(0.5, Math.min(2, Number(cfg.videoSpeed) || 1))
  document.querySelectorAll('.wp-bg-layer').forEach((el) => {
    if (el.tagName === 'VIDEO') { try { el.playbackRate = sp } catch (e) {} }
  })
}

// 换图链路诊断：每次落定后打一行图层普查（验证「最多两层、零残层」）
function logLayerCensus(tag) {
  const st = getRotatorState()
  console.error('[wallpaper][diag] layers ' + tag
    + ' a=' + document.querySelectorAll('#hermes-wallpaper-bg-a').length
    + ' b=' + document.querySelectorAll('#hermes-wallpaper-bg-b').length
    + ' legacy=' + document.querySelectorAll('#hermes-wallpaper-bg, #hermes-wallpaper-bg-next').length
    + ' visibleSlot=' + st.visible + ' token=' + st.token)
  // v37 常驻证据（V1 的可断言行）：配色还在不在场。len=-1 = 样式表被删了 = V1 复发。
  const cssEl = document.getElementById('hermes-wallpaper-css')
  console.error('[wallpaper][diag] css ok len=' + (cssEl ? cssEl.textContent.length : -1)
    + ' owner=' + (cssEl && cssEl.dataset ? cssEl.dataset.wpOwner : 'none')
    + ' mine=' + INSTANCE_ID + ' live=' + wpLiveInstanceCount(window))
}

function injectWallpaper(cfg) {
  applyVisualParams(cfg)   // v28：模糊/亮度/遮罩/底透明度统一下发到 CSS 变量
  ensureWallpaperCss()     // v37：配色先于壁纸 —— 后面任何一步失败都不该带走整套主题
  const url = pathToFileUrl(cfg.imagePath)

  // 1) 背景层：用 <img> 标签而不是 CSS background-image！
  //    日志证实 <img> 能加载 file://（probe OK），而 CSS background 可能被 webSecurity 拦
  //    v28：固定在 A 槽，不再有 -next 临时层
  const st = getRotatorState()
  wpTakeInflight(st)
  st.visible = 0
  st.currentPath = cfg.imagePath   // v35：注入即当前图（本地路径或 http 原样）
  const bgEl = makeLayerEl(0, isVideoPath(cfg.imagePath), isWebPath(cfg.imagePath))
  bgEl.src = url
  if (bgEl.tagName === 'VIDEO') { bgEl.play().catch(() => {}) }
  bgEl.style.opacity = '1'
  document.body.appendChild(bgEl)
  // img 加载失败兜底：立即清理回退（不黑屏）
  bgEl.onerror = () => {
    console.error('[wallpaper][diag] img onerror fired, rolling back')
    // 评审 F5：只有它仍是当前可见层时才整站回退，否则只摘掉自己这一层
    //（换图后旧层仍可能挂着 onerror，无归属判定的 cleanupLayers 会误删可用壁纸）
    // 复核 N3：只有真回退才置错误态，免得「壁纸正常显示 + 状态栏报错」自相矛盾
    if (bgEl === currentLayerEl()) {
      // v37（V1）：这里以前调 cleanupLayers()，会把**整套样式表**一起删掉 ——
      // 用户看到「壁纸 + 配色整体消失、回到默认主题」，且没有重注入路径。
      // 现在只摘掉自己这一层，并保证配色仍然在场。
      bgEl.remove()
      ensureWallpaperCss()
      $status?.set('error')
    } else {
      console.error('[wallpaper][diag] stale layer onerror ignored (kept current layer)')
      bgEl.remove()
    }
  }
  // 注入后 3 秒复查 img 真实加载状态（complete/naturalWidth 是铁证）
  setTimeout(() => {
    const el = currentLayerEl()
    if (el) {
      if (el.tagName === 'VIDEO') { el.play().catch(() => {}) }
      console.error('[wallpaper][diag] 3s-check ' + (el.tagName === 'VIDEO'
        ? 'video.readyState=' + el.readyState + ' videoW=' + el.videoWidth + 'x' + el.videoHeight
        : el.tagName === 'IFRAME'
          ? 'iframe loadEvent=' + (el.dataset.wpLoaded === '1' ? 'yes' : 'no')
          : 'img.complete=' + el.complete + ' naturalW=' + el.naturalWidth + 'x' + el.naturalHeight),
        'id=' + el.id, 'src=' + String(el.src).slice(0, 80),
        'display=' + getComputedStyle(el).display,
        'visibility=' + getComputedStyle(el).visibility,
        'opacity=' + getComputedStyle(el).opacity)
    } else {
      console.error('[wallpaper][diag] 3s-check bg element MISSING')
    }
    // v28.4：深度诊断默认关闭。实测每次 apply 的深度诊断（150 槽位 × 多次
    // getComputedStyle/getBoundingClientRect + 每 pre 列表）会阻塞主线程
    // 数百毫秒并写 ~100KB 日志；对话卡顿的主因虽在 CSS，但这类一次性冻结
    // 同样能被感知。排障时在设置面板打开「诊断转储」即可恢复。
    if (!cfgDebug()) return
    // 深度诊断：壁纸层的 z 位置 + root 内实际覆盖元素
    {
      const rootEl = document.getElementById('root')
      if (rootEl) {
        const rcs = getComputedStyle(rootEl)
        const child = rootEl.firstElementChild
        const ccs = child ? getComputedStyle(child) : null
        console.error('[wallpaper][diag] root.z=' + rcs.zIndex,
          'root.bg=' + rcs.backgroundColor, 'root.bgImg=' + rcs.backgroundImage.slice(0, 40),
          'child.bg=' + (ccs ? ccs.backgroundColor : 'N/A'),
          'child.bgImg=' + (ccs ? ccs.backgroundImage.slice(0, 40) : 'N/A'),
          'child.backdrop=' + (ccs ? ccs.backdropFilter : 'N/A'),
          'child.class=' + (ccs ? String(child.className).slice(0, 60) : 'N/A'))
      }
    }
    // 深度诊断：代码块样式是否命中（统计 + 计算样式）
    try {
      const cards = document.querySelectorAll('#root [data-slot="code-card"]')
      const fences = document.querySelectorAll('#root [data-slot="aui_user-fence"]')
      const prose = document.querySelectorAll('#root .aui-prose-fence')
      const huge = document.querySelectorAll('#root .aui-md.font-mono')
      const artifacts = document.querySelectorAll('#root [data-slot="aui_artifact-card"]')
      const diffs = document.querySelectorAll('#root [data-slot="file-diff-panel"]')
      const cssEl = document.getElementById('hermes-wallpaper-css')
      const cssLen = cssEl ? cssEl.textContent.length : -1
      console.error('[wallpaper][diag] code-card count=' + cards.length,
        'user-fence count=' + fences.length, 'prose-fence count=' + prose.length,
        'huge-md count=' + huge.length, 'artifact count=' + artifacts.length,
        'diff-lines count=' + diffs.length, 'cssLen=' + cssLen,
        'userBubble=' + document.querySelectorAll("[data-role='user'] .composer-human-message").length)
      // v26: 金色关键面采样——变量链新键实际值 + 金边命中（气泡/代码块/overlay 卡片）
      try {
        const rcs = getComputedStyle(document.documentElement)
        const v26vars = ['--dt-muted-foreground', '--dt-accent', '--dt-composer-ring',
          '--dt-scrollbar-thumb', '--ui-success', '--dt-primary-solid']
        const v26s = v26vars.map(n => n + '=' + (rcs.getPropertyValue(n).trim() || 'none'))
        const bubble = document.querySelector("[data-role='user'] .composer-human-message")
        const overlayCard = document.querySelector('[data-overlay-surface] > div')
        const goldProbe = [
          'bubbleBorder=' + (bubble ? getComputedStyle(bubble).borderTopColor : 'none'),
          'cardBorder=' + (cards[0] ? getComputedStyle(cards[0]).borderTopColor : 'none'),
          'overlayCardBorder=' + (overlayCard ? getComputedStyle(overlayCard).borderTopColor : 'none')
        ]
        console.error('[wallpaper][diag] v26-gold ' + v26s.join(' ') + ' ' + goldProbe.join(' '))
        // v28：视觉参数变量实时值（验证「调参不重建图层」与变量链生效）
        const wpVars = ['--wp-blur', '--wp-brightness', '--wp-dim', '--wp-base-alpha',
          '--wp-contrast', '--wp-saturate', '--wp-fit']
          .map(n => n + '=' + (rcs.getPropertyValue(n).trim() || 'none'))
        const dimEl = document.getElementById('hermes-wallpaper-dim')
        const baseEl = document.getElementById('hermes-wallpaper-base')
        const layerInfo = (el) => el
          ? (getComputedStyle(el).backgroundColor + '/' + getComputedStyle(el).position
            + '/h' + el.getBoundingClientRect().height)
          : 'MISSING'
        console.error('[wallpaper][diag] v28-wp ' + wpVars.join(' ')
          + ' dim=' + layerInfo(dimEl) + ' base=' + layerInfo(baseEl))
      } catch (e) {
        console.error('[wallpaper][diag] v26-gold ERROR ' + e.message)
      }
      // 列出每个 code-card 的位置（top/height）+ streaming 状态，用于定位截图里的"上框"
      cards.forEach((c, i) => {
        const r = c.getBoundingClientRect()
        console.error('[wallpaper][diag] card#' + i + ' top=' + Math.round(r.top) +
          ' h=' + Math.round(r.height) + ' streaming=' + (c.getAttribute('data-streaming') || 'no'))
      })
      // 系统排查：列出页面里所有 <pre>（不管什么路径），看代码块真实结构
      const allPres = Array.from(document.querySelectorAll('#root pre'))
      console.error('[wallpaper][diag] TOTAL pre count=' + allPres.length)
      allPres.slice(0, 12).forEach((p, i) => {
        const r = p.getBoundingClientRect()
        const cls = String(p.className).slice(0, 60)
        console.error('[wallpaper][diag] pre#' + i + ' top=' + Math.round(r.top) +
          ' h=' + Math.round(r.height) + ' class=' + cls +
          ' slot=' + (p.getAttribute('data-slot') || 'none') +
          ' parentSlot=' + (p.parentElement?.getAttribute?.('data-slot') || 'none'))
      })
      // v23: 采样审查栏内第一个 pre 的 token span style，验证 light-dark 分支
      try {
        const panel = document.querySelector('#root [data-slot="file-diff-panel"]')
        if (panel) {
          const cs = getComputedStyle(panel).colorScheme
          const firstPre = panel.querySelector('pre.shiki')
          const sampleSpans = firstPre
            ? Array.from(firstPre.querySelectorAll('span[style], span[class*="shiki"]')).slice(0, 6)
            : []
          const sampleStyles = sampleSpans.map(s => String(s.getAttribute('style') || s.className).slice(0, 90))
          console.error('[wallpaper][diag] panelColorScheme=' + cs,
            'tokenSpanCount=' + (firstPre ? firstPre.querySelectorAll('span[style]').length : 0),
            'samples=' + JSON.stringify(sampleStyles))
        }
      } catch (e) {
        console.error('[wallpaper][diag] token sample ERROR', e.message)
      }
      // titlebar 专项：header 数量/背景 + icon-button 数量和 DOM 关系
      const headers = Array.from(document.querySelectorAll('#root header'))
      const tbtns = Array.from(document.querySelectorAll('.titlebar-icon-button'))
      console.error('[wallpaper][diag] header count=' + headers.length +
        ' titlebarBtn count=' + tbtns.length)
      headers.forEach((h, i) => {
        const cs = getComputedStyle(h)
        const r = h.getBoundingClientRect()
        console.error('[wallpaper][diag] header#' + i + ' top=' + Math.round(r.top) +
          ' h=' + Math.round(r.height) + ' bg=' + cs.backgroundColor +
          ' z=' + cs.zIndex + ' pos=' + cs.position)
      })
      tbtns.slice(0, 8).forEach((b, i) => {
        const r = b.getBoundingClientRect()
        console.error('[wallpaper][diag] tbtn#' + i + ' top=' + Math.round(r.top) +
          ' left=' + Math.round(r.left) + ' inHeader=' + (b.closest('header') ? 'yes' : 'NO') +
          ' color=' + getComputedStyle(b).color)
      })
      const probe = cards[0] || fences[0] || prose[0]
      if (probe) {
        const cs = getComputedStyle(probe)
        console.error('[wallpaper][diag] codeStyle bg=' + cs.backgroundColor,
          'color=' + cs.color, 'border=' + cs.borderTopWidth + ' ' + cs.borderTopColor,
          'radius=' + cs.borderTopLeftRadius, 'shadow=' + cs.boxShadow.slice(0, 40),
          'colorScheme=' + cs.colorScheme, 'font=' + cs.fontFamily.split(',')[0])
      }
    } catch (e) {
      console.error('[wallpaper][diag] codeStyle ERROR ' + e.message)
    }
  }, 3000)

  // 2) 暗化遮罩：在壁纸之上、内容之下（背景由 CSS 变量 --wp-dim 提供）
  const dimEl = document.createElement('div')
  dimEl.id = 'hermes-wallpaper-dim'
  document.body.appendChild(dimEl)

  // 3) 内容底：独立一层深色，垫在内容之下（只加一次，不叠加；--wp-base-alpha 控制）
  const baseEl = document.createElement('div')
  baseEl.id = 'hermes-wallpaper-base'
  document.body.appendChild(baseEl)
  // v37：注入完成即打图层次普查 + 「配色在场」证据（boot 的自动应用也走 injectWallpaper）
  logLayerCensus('inject')
}

// v37：整套黑金 CSS 的构建从 injectWallpaper 尾部搬到这里（**只搬不改内容**）。
// 目的：让样式表的生命周期与壁纸图层解耦（见 ensureWallpaperCss / cleanupLayers）。
function buildWallpaperStyleEl() {
  // 4) 内容浮层在最上；全透明穿透所有层（壁纸可见）+ 独立深色底只加一次（文字可读）
  //    教训：不要给每层加半透明背景——多层叠加 0.6^5≈0.08，壁纸被压死变黑屏
  const styleEl = document.createElement('style')
  styleEl.id = 'hermes-wallpaper-css'
  styleEl.textContent = `
    html, body { background: transparent !important; }
    #root {
      position: relative !important;
      z-index: 1 !important;
      background: transparent !important;
    }
    /* 全透明穿透：body 下所有元素（含 portal）背景透明，壁纸从任意层级透出；
       但浮动窗格（HUD，[data-floating-pane]，如工作台面板）例外 —— 应用给它的
       表面类（floating-hud.ts 的 HUD_SURFACE）就是一张不透明卡片，抹掉后窗口与
       壁纸融为一体、文字压在照片上不可读（实测 backgroundColor 变 rgba(0,0,0,0)）。
       :not() 里用后代选择器排除整棵子树（Chromium 88+ 支持）。 */
    body *:not([data-floating-pane]):not([data-floating-pane] *) {
      background: transparent !important;
    }
    /* 保护：独立内容底 + 暗化遮罩 + 壁纸层（ID 特异性高于 body *） */
    #hermes-wallpaper-dim { background: rgba(0, 0, 0, var(--wp-dim, 0.2)) !important; }
    #hermes-wallpaper-base { background: rgba(10, 24, 42, var(--wp-base-alpha, 0.55)) !important; }
    /* v28：垫层定位（原为内联样式，改走变量后必须保留定位，否则零尺寸 = 完全不遮罩） */
    #hermes-wallpaper-dim, #hermes-wallpaper-base {
      position: fixed !important; inset: 0 !important; z-index: 0 !important;
      width: 100vw !important; height: 100vh !important; pointer-events: none !important;
    }
    /* v28：壁纸层位置与滤镜统一走变量（实时调参不重建图层） */
    .wp-bg-layer {
      position: fixed !important; inset: 0 !important; z-index: 0 !important;
      width: 100vw !important; height: 100vh !important; pointer-events: none !important;
      object-fit: var(--wp-fit, cover) !important; object-position: center !important;
      filter: blur(var(--wp-blur, 4px)) brightness(var(--wp-brightness, 0.6)) contrast(var(--wp-contrast, 1)) saturate(var(--wp-saturate, 1));
    }
    /* titlebar：恢复深色底——body * transparent 抹掉了它，
       导致原生关闭/最大化按钮（暖白 symbolColor）和 DOM 工具按钮在亮壁纸上不可见 */
    #root header {
      background: rgba(10, 24, 42, 0.72) !important;
      border-bottom: 1px solid var(--wallpaper-gold-edge) !important;
      backdrop-filter: blur(14px) !important;
      -webkit-backdrop-filter: blur(14px) !important;
    }
    /* titlebar 工具按钮（fixed 定位 cluster，不在 header 内，必须全局选）：
       深色胶囊底 + 暖白图标，亮壁纸上清晰可见 */
    .titlebar-icon-button {
      background-color: rgba(10, 24, 42, 0.6) !important;
      color: rgba(245, 239, 226, 0.9) !important;
      border-radius: 6px !important;
    }
    .titlebar-icon-button:hover {
      color: #fff8ec !important;
      background-color: rgba(10, 24, 42, 0.85) !important;
    }

    /* v25 消息身份：用户发言=唯一卡片（暖白淡底+细金边+圆角），
       助手回复=无框无底文本流。扫视历史：金边卡片即「我说的」。
       （v24 曾给 user/assistant root 各涂 0.06/0.04 淡白底，差异
       仅 2% 透明度，几乎不可辨——已弃。卡片底落在 core 原生气泡
       button.composer-human-message 上，不涂整条 root。） */
    [data-slot='aui_user-message-root'] {
      background-color: transparent !important;
      border-radius: 0 !important;
      /* 禁用 sticky：不要在页面顶端固定显示上一次说的话 */
      position: static !important;
      z-index: auto !important;
    }
    [data-role='user'] .composer-human-message {
      background-color: rgba(255, 250, 240, 0.08) !important;
      border: 1px solid rgba(201, 160, 92, 0.32) !important;
    }
    [data-role='user'] .composer-human-message:hover {
      border-color: rgba(201, 160, 92, 0.5) !important;
    }
    /* 助手消息：透明文本流，间距交给 turn-pair 既有机制 */
    [data-slot='aui_assistant-message-root'] {
      background-color: transparent !important;
      padding: 0 !important;
      margin-top: 0 !important;
      border-radius: 0 !important;
    }
    /* 用户消息与助手消息间距拉开 */
    [data-slot='aui_user-message-root'] {
      margin-top: 16px !important;
    }
    /* v26: 新对话空态大 HERMES AGENT Wordmark（core chat/intro.tsx + wordmark.tsx，
       data-slot='aui_intro'）。core dark 分支 dark:text-foreground/90 = 暖白，且
       mix-blend-plus-lighter 会把字与壁纸亮区加白 → 按用户期望恢复金字本体
       （light 分支 text-midground 已走 dt-midground=金，无需处理）。 */
    [data-slot='aui_intro'] .wordmark {
      color: #c9a05c !important;
      mix-blend-mode: normal !important;
    }
    /* ── v27 界面微交互：keyframes + 触发类 ───────────────────────────
       纪律：只动 transform/opacity/box-shadow；金辉仅交互反馈瞬时出现；
       入场类由 observer 加在新挂载元素上（历史会话不播）。 */
    @keyframes wp-in-msg {
      from { opacity: 0; transform: translateY(12px) scale(0.985); }
      to { opacity: 1; transform: translateY(0) scale(1); }
    }
    @keyframes wp-in-card {
      from { opacity: 0; transform: translateY(8px) scale(0.99); }
      to { opacity: 1; transform: translateY(0) scale(1); }
    }
    @keyframes wp-ring {
      0% { opacity: 1; transform: scale(0.35); }
      100% { opacity: 0; transform: scale(1.7); }
    }
    @keyframes wp-breathe {
      0%, 100% { opacity: 0.82; }
      50% { opacity: 1; }
    }
    @keyframes wp-swap-flash {
      0% { opacity: 1; }
      100% { opacity: 0; }
    }
    /* 无障碍关停：系统减弱动态 + core 动画暂停机制对齐（显式逐类；
       aui_response-loading 是 React 元素不能手动挂类，用元素选择器关停） */
    @media (prefers-reduced-motion: reduce) {
      .wp-in-msg, .wp-in-card, .wp-swap-flash,
      [data-slot='aui_response-loading'] {
        animation: none !important;
      }
    }
    :root[data-renderer-animations-paused] .wp-in-msg,
    :root[data-renderer-animations-paused] .wp-in-card,
    :root[data-renderer-animations-paused] .wp-swap-flash,
    :root[data-renderer-animations-paused] [data-slot='aui_response-loading'] {
      animation-play-state: paused !important;
    }
    /* 入场触发：用户气泡弹性滑入；助手根/代码卡/工具卡轻升淡入 */
    .wp-in-msg {
      animation: wp-in-msg 0.36s cubic-bezier(0.33, 1.4, 0.62, 1) both !important;
    }
    .wp-in-card {
      animation: wp-in-card 0.3s cubic-bezier(0.25, 1, 0.5, 1) both !important;
    }
    /* v27：生成中思考行慢呼吸（2.4s 循环，0.82-1.0 克制幅度）；
       生成行含动态文本，幅度小不干扰阅读 */
    [data-slot='aui_response-loading'] {
      animation: wp-breathe 2.4s ease-in-out infinite !important;
    }
    /* v27：壁纸就位金框闪现（swap 完成时 0.55s 一次） */
    .wp-swap-flash {
      animation: wp-swap-flash 0.55s ease-out 1 !important;
    }
    /* v27.7：分隔线可见性增强——原 v27.6 两端淡到透明导致整条变虚、
       壁纸上不够醒目。改：两端留淡底衬（不再消失）、中间主金提亮到 0.6、
       淡出区间收窄到 10%/90%，保证整条边界可辨，仍保留柔和渐隐不棱角。 */
    [data-tree-split] > div > [role='separator'] > span:first-child {
      opacity: 1 !important;
      background-color: transparent !important;
      background-image: linear-gradient(to bottom,
        rgba(201, 160, 92, 0.16) 0%,
        rgba(201, 160, 92, 0.60) 10%,
        rgba(201, 160, 92, 0.60) 90%,
        rgba(201, 160, 92, 0.16) 100%) !important;
    }
    [data-tree-split] > div > [role='separator']:hover > span:first-child {
      background-image: linear-gradient(to bottom,
        rgba(201, 160, 92, 0.34) 0%,
        rgba(201, 160, 92, 0.90) 10%,
        rgba(201, 160, 92, 0.90) 90%,
        rgba(201, 160, 92, 0.34) 100%) !important;
    }
    :root {
      --conversation-turn-gap: 0.875rem !important;
      --wallpaper-gold-quiet: rgba(201, 160, 92, 0.24);
      --wallpaper-gold-edge: rgba(201, 160, 92, 0.40);
      --wallpaper-gold-hover: rgba(201, 160, 92, 0.24);
      --wallpaper-gold-selected: #c9a05c;
      --wallpaper-gold-label: #d9b87a;
      --wallpaper-on-gold: #0a182a;
      /* v28：壁纸视觉参数（由插件 JS 实时写入，换图/调参不重建图层） */
      --wp-blur: 4px;
      --wp-brightness: 0.6;
      --wp-dim: 0.2;
      --wp-base-alpha: 0.55;
    }

    /* v25 overlay 面板底：设置/命令中心/agents/cron/profiles 等
       OverlayView 覆盖层（core overlay-view.tsx）。卡片 bg 被
       body * transparent 抹掉后内容直接浮在壁纸上——恢复三层：
       蒙层压暗 + 卡片深海军毛玻璃 + 细金边。（唯一锚点
       data-overlay-surface；卡片是它的直接子 div。侧栏列无稳定
       class 不单独恢复，靠卡片统一底防叠层。） */
    [data-overlay-surface] {
      background-color: rgba(0, 0, 0, 0.22) !important;
      backdrop-filter: blur(2px) !important;
      -webkit-backdrop-filter: blur(2px) !important;
    }
    [data-overlay-surface] > div {
      background-color: rgba(10, 24, 42, 0.62) !important;
      backdrop-filter: blur(16px) !important;
      -webkit-backdrop-filter: blur(16px) !important;
      border-color: rgba(201, 160, 92, 0.3) !important;
      box-shadow: 0 6px 24px rgba(0, 0, 0, 0.35) !important;
    }
    /* overlay 内按钮 hover：淡金反馈（core hover 用 --chrome-action-hover，
       背景被 body * 抹掉）。:where() 降权，避免盖过下面 active 深底。 */
    :where([data-overlay-surface]) button:not(:disabled):hover,
    :where([data-overlay-surface]) [role='button']:not(:disabled):hover {
      background-color: rgba(201, 160, 92, 0.14) !important;
    }
    /* overlay 导航 active 顶层项：深海军底 + 金左边条（聊天侧栏 v23d 同款）。
       active 是纯 className 分支（无 DOM 属性）：顶层 active 项带
       bg-(--ui-bg-tertiary)，inactive 为 bg-transparent。nested active 与
       hover 同用 --chrome-action-hover 无法区分，不特判。 */
    [data-overlay-surface] button[class*='bg-(--ui-bg-tertiary)'] {
      background-color: rgba(10, 24, 42, 0.85) !important;
      box-shadow: inset 2px 0 0 #c9a05c !important;
    }

    /* 普通代码块（非审查栏）：亚克力框（v23 用户新要求）。
       深色半透明毛玻璃 + 细金边，呼应审查栏风格；背景只加在容器上一层
       （不叠层，避免压死壁纸）。color-scheme: dark 让 Shiki light-dark() 取
       dark 分支（亮色 token），再配合下面的全局 token 色值映射。 */
    #root [data-slot='code-card'],
    #root [data-slot='aui_user-fence'],
    #root [data-slot='aui_artifact-card'] {
      background-color: rgba(10, 24, 42, 0.38) !important;
      backdrop-filter: blur(12px) !important;
      -webkit-backdrop-filter: blur(12px) !important;
      /* v23f：金边 0.22 → 0.35——暗壁纸暗区上 0.22 合成仅 1.46-1.53:1 近隐形，
         代码块与周围融合（背景适配专项 B2） */
      border: 1px solid rgba(201, 160, 92, 0.35) !important;
      border-radius: 10px !important;
      color: #e8e2d4 !important;
      color-scheme: dark !important;
    }
    /* prose 代码块（纯文本 fence）：淡色亚克力底，不干扰阅读 */
    #root .aui-prose-fence {
      background-color: rgba(10, 24, 42, 0.28) !important;
      border-radius: 8px !important;
      color: #e8e2d4 !important;
    }

    /* 代码字体：JetBrains Mono NL（无连字，已装），中文注释回退雅黑。
       code-card-body 自带 font-mono class，必须用 !important 覆盖。 */
    #root [data-slot='code-card'], #root [data-slot='code-card-body'] {
      font-family: 'JetBrains Mono NL', 'JetBrains Mono', Consolas, 'Microsoft YaHei', monospace !important;
    }
    #root [data-slot='aui_user-fence'] code {
      font-family: 'JetBrains Mono NL', 'JetBrains Mono', Consolas, 'Microsoft YaHei', monospace !important;
    }

    /* 代码审查栏 / diff 对比（data-slot='file-diff-panel'）：特殊背景——深色毛玻璃，
       半透明悬浮效果。背景只加在容器上，内部 pre.shiki 保持透明
       （pre 高度可贯穿整个面板，不能给它染色——否则看起来像整窗口变深）。 */
    #root [data-slot='file-diff-panel'] {
      /* v23f：底色 rgba(8,18,34) 统一为全站 rgba(10,24,42)（F2 单一来源）；
         金边 0.3 → 0.4 与普通代码块 0.35 形成层次（B4） */
      background-color: rgba(10, 24, 42, 0.45) !important;
      backdrop-filter: blur(14px) !important;
      -webkit-backdrop-filter: blur(14px) !important;
      color: #e8e2d4 !important;
      border-radius: 10px !important;
      border: 1px solid rgba(201, 160, 92, 0.4) !important;
      box-shadow: 0 4px 18px rgba(0, 0, 0, 0.45) !important;
      /* v23: Shiki token 用 light-dark() 双值，受 color-scheme 影响。
         全局 colorScheme=light 时取 github-light-default（深色 token），
         在深色毛玻璃底上不可读且被统一覆盖成灰白。强制本容器 dark 分支，
         让 github-dark-dimmed 的完整亮色 token 正常显示。 */
      color-scheme: dark !important;
    }
    /* file-diff-panel 内部 Shiki：透明背景，避免叠第二层深色。
       v23: 所有 shiki pre 强制 dark 分支，保证任意容器内 light-dark() 取亮色 token */
    #root [data-slot='file-diff-panel'] .shiki,
    #root [data-slot='file-diff-panel'] .shiki code {
      background: transparent !important;
      border: none !important;
      box-shadow: none !important;
    }
    #root .shiki {
      color-scheme: dark !important;
    }
    /* 代码配色（v23 暖金定制版，用户选定；v23b 扩展到所有代码块）：
       Shiki token 是内联 color: light-dark(#lightHex, #darkHex) 双值。
       ① 容器/.shiki 强制 color-scheme: dark → light-dark() 取 dark 分支（亮色）；
       ② 下面按 light 分支色值（github-light-default）精确选择 token span 再强制映射，
       双保险 + 可完全自定义配色。之前的 .keyword/.string 类选择器不命中
       react-shiki 的内联 style 结构，导致所有 token 被统一覆盖成灰白（用户看到的「统一白色」）。
       暖金定制：主文字暖白 #e8e2d4、关键字金橙 #e0a45e、字符串浅蓝 #8cc5ff、
       数字暖金 #e8c07a、函数青 #7fd0c4（去紫）、类型/类淡绿 #a8d8a8、
       注释灰蓝 #8b949e 斜体、错误红 #e06c6c。 */
    #root .shiki span[style*='#cf222e'] {
      color: #e0a45e !important;
    }
    #root .shiki span[style*='#0a3069'] {
      color: #8cc5ff !important;
    }
    #root .shiki span[style*='#0550ae'] {
      color: #e8c07a !important;
    }
    #root .shiki span[style*='#8250df'] {
      color: #7fd0c4 !important;
    }
    #root .shiki span[style*='#953800'] {
      color: #a8d8a8 !important;
    }
    #root .shiki span[style*='#116329'] {
      color: #a8d8a8 !important;
    }
    #root .shiki span[style*='#1f2328'] {
      color: #e8e2d4 !important;
    }
    #root .shiki span[style*='#6e7781'],
    #root .shiki span[style*='#57606a'] {
      color: #8b949e !important;
      font-style: italic !important;
    }
    /* v23c：github-dark-dimmed 暗分支 token（codeToTokens 路径输出单值 hex，
       切 dark 模式时 light 分支选择器全落空 → 函数 #dcbdfb 紫/字符串亮蓝爆出。
       双保险补暗分支映射；react-shiki 双值路径已被上方 light 规则覆盖，不冲突。 */
    #root .shiki span[style*='#dcbdfb'] {
      color: #7fd0c4 !important;
    }
    #root .shiki span[style*='#6cb6ff'], #root .shiki span[style*='#f69d50'] {
      color: #e8c07a !important;
    }
    #root .shiki span[style*='#96d0ff'] {
      color: #8cc5ff !important;
    }
    #root .shiki span[style*='#f47067'] {
      color: #e0a45e !important;
    }
    #root .shiki span[style*='#8ddb8c'] {
      color: #a8d8a8 !important;
    }
    #root .shiki span[style*='#adbac7'] {
      color: #e8e2d4 !important;
    }
    #root .shiki span[style*='#768390'],
    #root .shiki span[style*='#2d333b'],
    #root .shiki span[style*='#cdd9e5'] {
      color: #8b949e !important;
      font-style: italic !important;
    }
    /* v23d：暗分支错误红 #ff938a（invalid/error/markup.deleted）原被映射成关键字金，
       与基线「错误 #e06c6c」矛盾 → 改回错误红。放 #82071e 规则之后保证双值路径
       light-dark(#82071e, #ff938a) 两条都命中时后规则（错误红）胜出。 */
    #root .shiki span[style*='#82071e'],
    #root .shiki span[style*='#ff938a'] {
      color: #e06c6c !important;
    }
    /* light 分支漏网特殊 token（markup.ignored/untracked 近白、carriage-return）→ 灰蓝注释 */
    #root .shiki span[style*='#eaeef2'], #root .shiki span[style*='#f6f8fa'] {
      color: #8b949e !important;
      font-style: italic !important;
    }
    /* v23d：审查栏/预览 diff 的 TokenizedDiffBody（codeToTokens 路径）渲染裸 span，
       没有 .shiki 祖先——上面 #root .shiki 规则全部不命中，原始 github-dark-dimmed
       色直出（函数紫 #dcbdfb / 字符串亮蓝 #96d0ff / 关键字红 #f47067，违反零紫零亮蓝）。
       补 panel 级映射：精确限定在 file-diff-panel 内（勿用全局 #root span[style*=...]，
       会误伤其他内联色）。与 .shiki 分支同值，双路径统一。 */
    #root [data-slot='file-diff-panel'] span[style*='#dcbdfb'] {
      color: #7fd0c4 !important;
    }
    #root [data-slot='file-diff-panel'] span[style*='#96d0ff'],
    #root [data-slot='file-diff-panel'] span[style*='#0a3069'] {
      color: #8cc5ff !important;
    }
    #root [data-slot='file-diff-panel'] span[style*='#f47067'],
    #root [data-slot='file-diff-panel'] span[style*='#cf222e'] {
      color: #e0a45e !important;
    }
    #root [data-slot='file-diff-panel'] span[style*='#f69d50'],
    #root [data-slot='file-diff-panel'] span[style*='#6cb6ff'],
    #root [data-slot='file-diff-panel'] span[style*='#0550ae'] {
      color: #e8c07a !important;
    }
    #root [data-slot='file-diff-panel'] span[style*='#8ddb8c'],
    #root [data-slot='file-diff-panel'] span[style*='#953800'],
    #root [data-slot='file-diff-panel'] span[style*='#116329'] {
      color: #a8d8a8 !important;
    }
    #root [data-slot='file-diff-panel'] span[style*='#adbac7'],
    #root [data-slot='file-diff-panel'] span[style*='#1f2328'] {
      color: #e8e2d4 !important;
    }
    #root [data-slot='file-diff-panel'] span[style*='#768390'],
    #root [data-slot='file-diff-panel'] span[style*='#6e7781'],
    #root [data-slot='file-diff-panel'] span[style*='#57606a'],
    #root [data-slot='file-diff-panel'] span[style*='#2d333b'],
    #root [data-slot='file-diff-panel'] span[style*='#cdd9e5'],
    #root [data-slot='file-diff-panel'] span[style*='#eaeef2'],
    #root [data-slot='file-diff-panel'] span[style*='#f6f8fa'] {
      color: #8b949e !important;
      font-style: italic !important;
    }
    #root [data-slot='file-diff-panel'] span[style*='#82071e'],
    #root [data-slot='file-diff-panel'] span[style*='#ff938a'] {
      color: #e06c6c !important;
    }
    /* v23f：panel 裸 span 路径漏 #8250df（light 模式 entity.name.function /
       meta.diff.range，github-light-default 唯一漏网色）——TokenizedDiffBody
       在 light 模式下输出单值 hex，函数名/方法名紫色直出违反零紫铁律。
       与 .shiki 路径同值映射为函数青。 */
    #root [data-slot='file-diff-panel'] span[style*='#8250df'] {
      color: #7fd0c4 !important;
    }
    /* v23f：CodeMirror 代码编辑器（preview 编辑模式）——HighlightStyle 注入
       .tok-* 类，Shiki 双路径映射不覆盖：dark 函数紫 #d2a8ff（零紫违规）、
       light 深蓝 #0a3069/#0550ae 1.1-2.7:1 不可读、selection 亮蓝
       rgba(56,139,253,0.25)。统一为暖金调（与代码块同值）。 */
    .cm-editor {
      color: #e8e2d4 !important;
    }
    .cm-editor .tok-keyword { color: #e0a45e !important; }
    .cm-editor .tok-string { color: #8cc5ff !important; }
    .cm-editor .tok-number, .cm-editor .tok-bool, .cm-editor .tok-atom { color: #e8c07a !important; }
    .cm-editor .tok-function { color: #7fd0c4 !important; }
    .cm-editor .tok-typeName, .cm-editor .tok-className, .cm-editor .tok-namespace { color: #a8d8a8 !important; }
    .cm-editor .tok-comment { color: #8b949e !important; font-style: italic !important; }
    .cm-editor .tok-tagName { color: #a8d8a8 !important; }
    .cm-editor .cm-selectionBackground, .cm-editor .cm-content ::selection {
      background-color: rgba(201, 160, 92, 0.25) !important;
    }
    /* v23d：Shiki token 有 .shiki 祖先时可能同时命中上方 .shiki 规则与下方 panel 规则
       （file-diff-panel 内的 shiki pre 同时匹配两者，同值无冲突）；若无 .shiki 祖先
       （TokenizedDiffBody 裸 span）则仅 panel 规则生效。 */
    /* 审查栏文件名 header（plugin.js 路径行）：紧邻 file-diff-panel 上方的路径条。
       用 :has(+ file-diff-panel) 精确命中，避免把 review 栏其他区块也染色。
       v23d：该规则降级为 fallback——真实场景 header 与 panel 被中间层隔开，
       由 .hermes-review-box（JS 标记共同父容器）统一染色覆盖。
       v23d 修正：fallback 不再染色/加 blur（工具卡 diff 的 panel 前一个兄弟常是
       TerminalTranscript/图片等，整块染色会误伤；且 holder 0.45 叠 panel 0.45
       形成双层深底）。只保留顶圆角衔接，底色交给 hermes-review-box。 */
    #root div:has(+ [data-slot='file-diff-panel']) {
      border-radius: 10px 10px 0 0 !important;
    }
    /* v23d：审查栏统一黑框——文件名行 + 审查代码框合成一块。
       JS（unifyReviewBox）给共同父容器加 hermes-review-box 标记；
       边框/圆角/投影只加在父容器上，内部 header/panel 全部透明防双层叠色。
       特异性高于上方 [data-slot='file-diff-panel'] 与 :has 两条 fallback 规则。
       v23d 修正：> div 收窄为 > div:first-child（只清文件名 header），
       避免误标记时清掉容器内其他子 div 的金色边框（曾导致工具卡金边消失）。 */
    #root .hermes-review-box {
      background-color: rgba(10, 24, 42, 0.45) !important;
      backdrop-filter: blur(14px) !important;
      -webkit-backdrop-filter: blur(14px) !important;
      border: 1px solid rgba(201, 160, 92, 0.4) !important;
      border-radius: 10px !important;
      box-shadow: 0 4px 18px rgba(0, 0, 0, 0.45) !important;
    }
    #root .hermes-review-box > div:first-child,
    #root .hermes-review-box [data-slot='file-diff-panel'] {
      background: transparent !important;
      border: none !important;
      border-radius: 0 !important;
      box-shadow: none !important;
      backdrop-filter: none !important;
      -webkit-backdrop-filter: none !important;
    }
    /* diff 行 tint：深色毛玻璃底上，增/删行用半透明绿/红 + 亮色前景，保证可辨 */
    :root {
      --ui-diff-add-background: rgba(64, 160, 90, 0.28) !important;
      --ui-diff-add-border: #8aa68f !important;
      --ui-diff-add-foreground: #c8f0d4 !important;
      --ui-diff-remove-background: rgba(200, 80, 80, 0.26) !important;
      --ui-diff-remove-border: #e06c6c !important;
      --ui-diff-remove-foreground: #f5d0d0 !important;
    }
    #root [data-slot='file-diff-panel'] span[class*='ui-diff-add'] {
      background-color: rgba(64, 160, 90, 0.28) !important;
      border-left-color: #8aa68f !important;
      color: #c8f0d4 !important;
    }
    #root [data-slot='file-diff-panel'] span[class*='ui-diff-remove'] {
      background-color: rgba(200, 80, 80, 0.26) !important;
      border-left-color: #e06c6c !important;
      color: #f5d0d0 !important;
    }

    /* v23c：全站选中态——core 默认 --ui-selection-background 是 0.55 亮金，
       选中代码时整片金黄盖死 token 色（实测对比度仅 2.97:1）。改为半透明金
       rgba(201,160,92,0.25)：token 色透过可见（8.27:1），文字保持原色不反色。 */
    ::selection, *::selection {
      background: rgba(201, 160, 92, 0.25) !important;
      color: inherit !important;
    }

    /* v23c：streaming 思考标签的 shimmer 用 background-clip:text + 透明文字，
       body 全透明规则抹掉其渐变背景后文字会隐形。恢复为 currentColor 静态文字。 */
    #root .shimmer {
      -webkit-text-fill-color: currentColor !important;
      background-image: none !important;
      color: inherit !important;
    }

    /* v23c：portal 浮层（Radix 渲染到 body 下）被 body * 透明规则抹掉底色，
       逐面恢复深海军底（浮层是独立层，可加底）。文字继承暖白变量。 */
    [data-slot='tooltip-content'] span {
      background-color: rgba(10, 24, 42, 0.95) !important;
      color: #f5efe2 !important;
      /* v23f：暗壁纸暗区上 tooltip 与背景 1.06:1 无边界（唯一无金边浮层）→ 补 1px 金边 */
      border: 1px solid rgba(201, 160, 92, 0.25) !important;
      border-radius: 4px !important;
    }
    [data-slot='dropdown-menu-content'],
    [data-slot='dropdown-menu-sub-content'],
    [data-slot='select-content'],
    [data-slot='popover-content'],
    /* v23d: context-menu 被 v23c 逐面恢复漏掉——右键菜单透明面板+无 hover 反馈 */
    [data-slot='context-menu-content'],
    [data-slot='context-menu-sub-content'] {
      background-color: rgba(10, 24, 42, 0.92) !important;
      border: 1px solid var(--wallpaper-gold-edge) !important;
      backdrop-filter: blur(12px) !important;
      -webkit-backdrop-filter: blur(12px) !important;
    }
    [data-slot='dropdown-menu-item']:focus,
    [data-slot='context-menu-item']:focus,
    /* v23d: select/popover 列表项 hover 填充同被 body * 抹掉，一并恢复 */
    [data-slot='select-item']:focus {
      background-color: rgba(201, 160, 92, 0.14) !important;
    }
    /* v23d: 浮层箭头 fill=bg-popover 被抹 → 箭头隐形，恢复深海军。
       v26: dropdown-menu-arrow slot 已从 core 移除（新下拉无箭头或复用
       popover-arrow），该选择器成为无害死规则，保留兼容旧 core。 */
    [data-slot='popover-arrow'], [data-slot='dropdown-menu-arrow'] {
      fill: rgba(10, 24, 42, 0.92) !important;
    }
    /* 主按钮恢复底色（bg-primary 被 body * 抹掉后只剩深色字 = 近乎不可见 ——
       用户报告的「提问卡提交键没有金色气泡」就是这个）；金底深字由
       --dt-primary/--dt-primary-foreground 变量决定。
       v34 特异性修复：这条原来是裸属性选择器 (0,2,0,0)，被上面的全局穿透规则
       body *:not(...):not(...) (0,2,0,1) 压过 —— 也就是说它**一直是条死规则**，
       所有 variant=default 的主按钮底色都被抹掉了。加 body 元素前缀把它提到
       (0,2,0,1)：与穿透规则打平后靠「本规则写在它之后」取胜；
       而 composer 发送键的专项规则（[data-slot='composer-fade'] button[...]，
       同样 (0,2,0,1)）写在更后面，所以发送键仍然是它自己的 #ece6d8。
       **顺序即契约**：本规则必须排在穿透规则之后、composer 专项规则之前
       （tests/lock-wiring.test.mjs 里有下标断言兜底）。 */
    body [data-slot='button'][data-variant='default'] {
      background-color: var(--dt-primary) !important;
    }
    [data-slot='dialog-content'], [data-slot='sheet-content'] {
      background-color: rgba(10, 24, 42, 0.92) !important;
      /* v23f：金边 0.28 → 0.35（暗壁纸暗区上浮层与背景 1.06:1，金边承担边界） */
      border: 1px solid rgba(201, 160, 92, 0.35) !important;
    }
    [data-slot='dialog-overlay'], [data-slot='sheet-overlay'] {
      background-color: rgba(0, 0, 0, 0.22) !important;
    }
    /* alert（含 toast 内部）：深海军底 + 金边（success/warning/default 语义正确）。
       v23d 修正：之前全变体统一砖红边，success/info toast 看起来像错误——
       仅 destructive 变体（core class border-destructive）保持暖砖红边。 */
    [data-slot='alert'] {
      background-color: rgba(10, 24, 42, 0.85) !important;
      border-color: rgba(201, 160, 92, 0.3) !important;
    }
    [data-slot='alert'][class*='border-destructive'] {
      border-color: rgba(192, 122, 110, 0.35) !important;
    }
    /* switch/checkbox：checked 金轨道 + 暖白 thumb（thumb 被 --dt-background:transparent
       污染成隐形，必须显式恢复）；checkbox 未选中深海军底、选中金底深勾 */
    [data-slot='switch'][data-state='checked'] {
      background-color: #c9a05c !important;
    }
    /* v23d: switch 未选中轨道被 body * 抹掉 → 透明药丸只剩描边，补淡暖白底 */
    [data-slot='switch'][data-state='unchecked'] {
      background-color: rgba(245, 239, 226, 0.08) !important;
    }
    [data-slot='switch-thumb'] {
      background-color: #f5efe2 !important;
    }
    [data-slot='checkbox'] {
      background-color: #16304f !important;
      border-color: rgba(201, 160, 92, 0.35) !important;
    }
    [data-slot='checkbox'][data-state='checked'] {
      background-color: #c9a05c !important;
    }
    /* 原生 checkbox（设置面板）tick 金色 */
    input[type='checkbox'] {
      accent-color: #c9a05c !important;
    }
    /* kbd 键帽：文字提亮（58% → 78%），边框随 --ui-stroke-* 自动转暖金。
       v23d: 边框 α 0.164 在亮底几乎隐形 → 提到 0.3 让键帽轮廓清晰 */
    [data-slot='kbd'] {
      color: rgba(245, 239, 226, 0.78) !important;
      background-color: rgba(10, 24, 42, 0.35) !important;
      /* v23f：边框 α 0.3 → 0.45（键帽轮廓 1.56-1.72 → ≈2.1:1，暗壁纸上可辨） */
      border-color: rgba(201, 160, 92, 0.45) !important;
    }

    /* v38：提问卡（clarify）选择态区分 —— 用户报告「选了我却看不出选了什么」。
       根因（两侧源码实测）：core 对「已选中」只把文字从 --ui-text-secondary 提到
       --ui-text-primary（clarify-tool.tsx:268），没有底色/边框/字重差异；而本插件把
       这两级定成相邻暖白，卡片背景又全被上面的穿透规则抹成透明（提问卡不是
       [data-floating-pane]）→ 净效果就是「同色」。
       修法：**只给选中项加结构性标识**（金底 + 2px 不透明金左条 + 加粗 + 键帽金底），
       **不压暗未选中项的文字**。为什么不压暗：提问卡表面是透明的，文字直接压在
       壁纸+垫层上（--wp-base-alpha 默认 0.55），压暗文字 = 直接吃掉亮壁纸下的可读性
       预算；而且最暗那档（core 的 tertiary，见下方 --ui-text-tertiary）已经被
       (Recommended) 标记占用，压到那一档还会撞色。区分靠不透明金条 + 字重，
       亮壁纸/暗壁纸上都成立（可推导的判据：改动后选中项的对比度不得低于未选中项）。
       钩子全取自 core 的稳定属性：data-choice / aria-pressed / data-clarify-settled /
       data-highlighted；多选题复用同一颗 ChoiceButton，一套规则全覆盖。
       **顺序=卫生约定**（真正承重的是特异性 (0,3,2)/(0,4,2) 压过穿透的 (0,2,1)，
       写在穿透规则前面也照样生效）；见 tests/clarify-choice-gate.test.mjs 与
       tools/css_probe.mjs（把本块整体删掉必须让探针变红 —— 用 tools/probe_ablation.sh 复现）。 */
    /* 选中：金底 + 左侧金条（inset 阴影，不改布局）+ 一级暖白 + 加粗。
       未选中态一律用 :not([aria-pressed='true']) —— 已答卡的「补答」行动作不传
       selected，React 会整个省略 aria-pressed，写成 [aria-pressed='false'] 会静默失效。 */
    body [data-slot='clarify-inline'] button[data-choice][aria-pressed='true'] {
      background-color: rgba(201, 160, 92, 0.16) !important;
      box-shadow: inset 2px 0 0 0 #c9a05c !important;
      color: #f5efe2 !important;
      font-weight: 600 !important;
    }
    /* 悬停 / 键盘光标不许盖掉选中态（否则鼠标一移过去就分不清选没选） */
    body [data-slot='clarify-inline'] button[data-choice][aria-pressed='true']:hover,
    body [data-slot='clarify-inline'] button[data-choice][aria-pressed='true'][data-highlighted] {
      background-color: rgba(201, 160, 92, 0.24) !important;
      color: #fff8ec !important;
    }
    /* 键盘光标停在「未选中」项上：给淡暖白底，**不改字色**（core 的
       hover:bg-(--chrome-action-hover) 被穿透规则抹掉，光标原本完全不可见） */
    body [data-slot='clarify-inline'] button[data-choice]:not([aria-pressed='true'])[data-highlighted] {
      background-color: rgba(245, 239, 226, 0.06) !important;
    }
    /* 键帽：选中行金底深字（core 的 bg-primary 同样被穿透规则抹掉） */
    body [data-slot='clarify-inline'] button[data-choice][aria-pressed='true'] [data-slot='kbd'] {
      background-color: #c9a05c !important;
      color: #0a182a !important;
      border-color: #c9a05c !important;
    }
    /* 自定义答案行：core 渲染成 <label>（没有 aria-pressed；里面键帽的 selected 绑的是
       「输入框非空」）→ 用 :has(input:not(:placeholder-shown)) 把「我正在用自定义答案」
       显示出来。同样只加结构标识、不改字色；浏览器不支持 :has() 时这条规则直接失效，
       不会造成错误渲染。 */
    body [data-slot='clarify-inline'] label:has(textarea:not(:placeholder-shown)) {
      box-shadow: inset 2px 0 0 0 rgba(201, 160, 92, 0.7) !important;
    }
    /* 已答卡：给「我当时选的」那行一条金左条（全状态都给，金条表达的是「这是你的回答」，
       不是「成功」）。**颜色只给正常答案提亮** —— error 行是 .text-destructive、
       skipped 行是 .italic + tertiary（clarify-tool.tsx:344-345 与 :852-853），
       无差别提亮会把语义色抹掉（首版就踩了这个坑，见 README v38 记要）。 */
    body [data-slot='clarify-inline'][data-clarify-settled] [data-clarify-answer] {
      box-shadow: inset 2px 0 0 0 rgba(201, 160, 92, 0.7) !important;
      padding-left: 0.5rem !important;
    }
    body [data-slot='clarify-inline'][data-clarify-settled] p[data-clarify-answer]:not(.text-destructive):not(.italic) {
      color: #f5efe2 !important;
    }

    /* v23c 追加：命令面板（Ctrl+K，Dialog.Content 无 data-slot 且 bg-popover 被抹）
       与 / 触发补全抽屉（composerPanelCard 同被抹）——整面板透明、文字叠壁纸不可读。
       背景加在 cmdk 根 / 抽屉容器上（均填满各自父容器）。 */
    [data-slot='command'],
    [data-slot='composer-completion-drawer'] {
      background-color: rgba(10, 24, 42, 0.92) !important;
      backdrop-filter: blur(12px) !important;
      -webkit-backdrop-filter: blur(12px) !important;
    }
    /* v23d: 嵌在浮层内的 Command（model-picker/searchable-select/language-switcher/
       combobox-input/base-branch-picker）不再叠底——外层 popover/dialog 已 0.92 深底，
       内层再 0.92 → 0.9936 实心发黑 + header/body 交界出现分层带（B2 双层深底）。
       注意 Ctrl+K 命令面板的 Dialog.Content 无 data-slot，不受此规则影响（底仍由
       [data-slot='command'] 提供）。 */
    [data-slot='popover-content'] [data-slot='command'],
    [data-slot='dialog-content'] [data-slot='command'],
    [data-slot='dropdown-menu-content'] [data-slot='command'] {
      background-color: transparent !important;
      backdrop-filter: none !important;
      -webkit-backdrop-filter: none !important;
    }
    /* v23d: cmdk 搜索框在深底面板内保持透明——全站 input 毛玻璃规则（下方）会二次叠底
       并加双边框/圆角，搜索区比面板更黑、聚焦金框突兀。
       v23d 修复：必须同时清 backdrop-filter（blur 14px 残留会让透明背景在深底上
       形成发黑发雾的一块）；input:focus 变体提高特异性压过全站聚焦金框规则
       （同特异性后写者胜，全站 input:focus 在 638 行会覆盖 border:none）。 */
    [data-slot='command'] input,
    [data-slot='command'] input:focus {
      background: transparent !important;
      border: none !important;
      border-radius: 0 !important;
      box-shadow: none !important;
      outline: none !important;
      backdrop-filter: none !important;
      -webkit-backdrop-filter: none !important;
    }
    /* 命令面板/补全抽屉选中行：bg-accent/bg-tertiary 被 body * 抹掉 → 无选中反馈。
       恢复淡金高亮（已随 --ui-accent 转金系，此处只恢复显示） */
    [data-slot='command-item'][data-selected='true'],
    [data-slot='composer-completion-drawer'] [data-highlighted] {
      background-color: rgba(201, 160, 92, 0.14) !important;
      color: #f5efe2 !important;
    }
    /* 命令分组标题：sticky 底原 bg-popover 被抹，容器深底已够，改透明防叠色 */
    [data-slot='command'] [cmdk-group-heading] {
      background-color: transparent !important;
    }

    /* 输入框/编辑器：深色半透明毛玻璃（v21 基线），暖白字。
       v23f：排除 range/checkbox——原生控件不应被输入框化
       （0.5 深底+blur14+白边+10px 圆角套在 slider/checkbox 上破坏控件语义）。 */
    [data-slot='composer-rich-input'], [data-slot='composer'] [contenteditable='true'],
    input:not([type='range']):not([type='checkbox']), textarea, select {
      background: rgba(6, 14, 26, 0.5) !important;
      backdrop-filter: blur(14px) !important;
      -webkit-backdrop-filter: blur(14px) !important;
      color: #f5efe2 !important;
      caret-color: #f5efe2 !important;
      border: 1px solid rgba(255, 255, 255, 0.22) !important;
      border-radius: 10px !important;
      box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.06) !important;
    }
    /* v23f：range slider 保持原生透明轨道（accent-color 金 thumb 由 598 行负责） */
    input[type='range'] {
      background: transparent !important;
      border: none !important;
      border-radius: 0 !important;
      box-shadow: none !important;
      backdrop-filter: none !important;
      -webkit-backdrop-filter: none !important;
    }
    /* 输入框聚焦：金色边框 + 克制外环，明确键盘焦点但不制造光晕 */
    [data-slot='composer-rich-input']:focus, input:focus, textarea:focus, select:focus,
    [data-slot='composer-rich-input']:focus-visible, input:focus-visible, textarea:focus-visible, select:focus-visible {
      border-color: var(--wallpaper-gold-selected) !important;
      outline: 1px solid var(--wallpaper-gold-selected) !important;
      outline-offset: 2px;
      box-shadow: none !important;
    }
    /* 输入框 placeholder：v23c 曾以 0.5 暖白声明但被 core 1563 行同语义规则
       （特异性 (0,2,1) + !important）压制从未生效，实际显示 var(--ui-text-tertiary)
       #b4b0a4 实色。v23f 定版：插件升级到同特异性显式接管（视觉不变，
       消除对 core 规则的依赖）。其他 input/textarea 的 0.5 暖白保留。 */
    input::placeholder, textarea::placeholder,
    [data-slot='composer-rich-input']:is(:empty, [data-empty])::before {
      color: var(--ui-text-tertiary) !important;
    }
    /* 输入框右侧功能控件（模型选择/语音/唤醒词等）：深色圆角胶囊底，空输入时也可见。
       真实 DOM 链：composer-dock → composer-root → composer-surface → composer-fade。
       工具栏按钮均为 Button 组件（data-slot='button' + data-variant='ghost'）。 */
    [data-slot='composer-fade'] button[data-variant='ghost'] {
      background-color: rgba(10, 24, 42, 0.6) !important;
      color: #f5efe2 !important;
      border: 1px solid rgba(255, 255, 255, 0.1) !important;
      border-radius: 8px !important;
    }
    [data-slot='composer-fade'] button[data-variant='ghost']:hover {
      background-color: rgba(10, 24, 42, 0.8) !important;
      color: #fff8ec !important;
    }
    /* send/语音主按钮（variant=default 实心圆）：恢复可见——body * transparent
       曾把 bg-foreground/text-background 全抹成透明，导致发送按钮隐形。 */
    [data-slot='composer-fade'] button[data-variant='default'] {
      background-color: #ece6d8 !important;
      color: #0a182a !important;
      border: none !important;
    }
    [data-slot='composer-fade'] button[data-variant='default']:hover {
      background-color: #f5efe2 !important;
    }
    [data-slot='composer-fade'] button[data-variant='default']:disabled {
      background-color: rgba(236, 230, 216, 0.35) !important;
      /* v23d 注释按过暗底估算 ≈3.5:1；v23f 实测亮区 1.66-1.95:1（disabled
         语义允许低对比，基线 0.42 字色保持） */
      color: rgba(245, 239, 226, 0.42) !important;
    }
    /* v27：发送钮按压——瞬时缩格 + 中心金辉扩散（0.5s 一次，反馈后即隐） */
    [data-slot='composer-fade'] button[data-variant='default'] {
      position: relative !important;
      overflow: hidden !important;
    }
    [data-slot='composer-fade'] button[data-variant='default']:active {
      transform: scale(0.95) !important;
    }
    [data-slot='composer-fade'] button[data-variant='default']::after {
      content: '' !important;
      pointer-events: none !important;
      position: absolute !important;
      inset: 0 !important;
      border-radius: inherit !important;
      background: radial-gradient(circle, rgba(201, 160, 92, 0.5) 0%, rgba(201, 160, 92, 0) 62%) !important;
      opacity: 0 !important;
    }
    [data-slot='composer-fade'] button[data-variant='default']:active::after {
      animation: wp-ring 0.5s ease-out 1 !important;
      opacity: 1 !important;
    }
    /* 通用轻按反馈：图标/小按钮 active 缩格（瞬态刻度感；刻意不加
       transition，避免覆盖 core 既定 transition 属性） */
    [data-slot='composer'] button:not(:disabled):active,
    [data-slot='aui_msg-actions'] button:not(:disabled):active,
    .titlebar-icon-button:active,
    [data-slot='sidebar'] [data-slot='row-button']:active {
      transform: scale(0.93) !important;
    }

    :root {
      /* 文字：暖白系（深色内容底上清晰；呼应壁纸暖白粉调） */
      --theme-foreground: #ece6d8 !important;
      --ui-base: #ece6d8 !important;
      --ui-text-primary: #f5efe2 !important;
      --ui-text-secondary: #d8d2c2 !important;
      --ui-text-tertiary: #b4b0a4 !important;
      --ui-text-quaternary: #8f8c82 !important;
      --ui-inline-code-foreground: #f5efe2 !important;
      --dt-background: transparent !important;
      --color-background: transparent !important;

      /* v23c：accent 源亮蓝 #0053FD → 金。一次修复链接/引用/滑块/checkbox/
         row hover/焦点环/全部 --ui-stroke-* 派生边框（dump 实测 143 个蓝边框） */
      --theme-primary: #c9a05c !important;
      --theme-midground: #c9a05c !important;
      --theme-warm: #c9a05c !important;
      --ui-accent: #c9a05c !important;
      --ui-accent-secondary: #c9a05c !important;
      --theme-secondary: color-mix(in srgb, #c9a05c 12%, #f5efe2) !important;
      --theme-accent-soft: color-mix(in srgb, #c9a05c 18%, #f5efe2) !important;

      /* v23c：语义色三件套（用户确认方向）+ 默认八色收敛为低饱和暖调、零紫零亮蓝 */
      --ui-ok: #8aa68f !important;
      --ui-warn: #c9a05c !important;
      --ui-error: #c07a6e !important;
      --ui-red: #c07a6e !important;
      --ui-orange: #c9a05c !important;
      --ui-yellow: #c9a05c !important;
      --ui-green: #8aa68f !important;
      --ui-purple: #8cc5ff !important;
      --ui-blue: #8cc5ff !important;
      --ui-cyan: #7fd0c4 !important;

      /* v23c：dt-* 系统变量（applyTheme 注入的默认亮蓝/亮红/深字 → 金系+暖砖红+暖白字） */
      --dt-primary: #c9a05c !important;
      --dt-primary-foreground: #0a182a !important;
      --dt-secondary-foreground: #e8e2d4 !important;
      --dt-accent-foreground: #f5efe2 !important;
      --dt-border: rgba(201, 160, 92, 0.22) !important;
      --dt-ring: rgba(201, 160, 92, 0.5) !important;
      --dt-muted: rgba(10, 24, 42, 0.35) !important;
      --dt-midground: #c9a05c !important;
      --dt-destructive: #c07a6e !important;
      --dt-destructive-foreground: #f5efe2 !important;
      --ui-selection-background: rgba(201, 160, 92, 0.25) !important;

      /* v23c：theme seeds 亮白 → 深海军蓝（防 dt-popover/残余 surface 露亮白） */
      --theme-background-seed: #0a182a !important;
      --theme-sidebar-seed: #0a182a !important;
      --theme-card-seed: #0a182a !important;
      --theme-elevated-seed: #0a182a !important;
      --theme-bubble-seed: #0a182a !important;

      /* v23c：diff 边框去霓虹（add 对齐柔灰绿；remove 保留暖金错误红基线） */
      --ui-diff-add-border: #8aa68f !important;

      /* v23d：context-usage 类别色——v23c 八色收敛把 orange/yellow 都收敛成 #c9a05c，
         skills 与 memory 完全同色（ΔE=0）无法辨识 → memory 改深金棕拉开；
         mcp 由 red+purple mix 成灰紫 #b18f96 → 改暖灰（零紫）。
         其余类别已可辨（tools 浅蓝 / rules 灰绿 / subagents 蓝青 / conversation 青）。 */
      --context-usage-memory: #a8906b !important;
      --context-usage-mcp: #b09a8a !important;

      /* v23d：tool-memory-legendary 去紫去发光——core 渐变含 #c4b5fd 紫 + --ui-purple
         派生浅蓝，且标题用 background-clip:text + color:transparent 被 body * 抹掉
         渐变后文字隐形（与 .shimmer 同类 bug，见下方 .tool-memory-legendary-title 规则）。
         变量全部收敛为金/暖白，去渐变去光晕。 */
      --tool-memory-legendary-from: #c9a05c !important;
      --tool-memory-legendary-mid: #c9a05c !important;
      --tool-memory-legendary-to: #e8c07a !important;
      --tool-memory-legendary-icon: #e8c07a !important;
      --tool-memory-legendary-meta: #b4b0a4 !important;
      --tool-memory-legendary-glow: rgba(201, 160, 92, 0.3) !important;

      /* v23d：badge warn（amber-600 硬编码饱和橙）→ 金系（插件侧可覆盖，非 core 改动） */
      --ui-badge-warn-fg: #c9a05c !important;

      /* v26（core 9d865810b6）：@theme inline 语义类直链 --dt-* 且 applyTheme
         inline 直写更多键（azur-navy skin 转换值：mutedForeground=#8fa3b8 蓝灰等）。
         补未覆盖的高频消费键，恢复 v23f 观感。旧 core 无这些键或引用面小，
         首次覆盖不会影响旧版本（多写无害）。 */
      --dt-muted-foreground: #b4b0a4 !important;
      --dt-accent: rgba(201, 160, 92, 0.22) !important;
      --dt-scrollbar-thumb: rgba(201, 160, 92, 0.3) !important;
      --ui-success: #8aa68f !important;
      --dt-primary-solid: #c9a05c !important;
      --dt-primary-solid-foreground: #0a182a !important;
    }

    /* v23d：tool-memory-legendary 标题文字隐形修复——body * 抹掉渐变背景后
       background-clip:text + color:transparent 的标题完全不可见；恢复静态暖金字。
       glyph 光晕（drop-shadow 蓝色）同去。 */
    #root .tool-memory-legendary-title {
      background-image: none !important;
      -webkit-text-fill-color: #e8c07a !important;
      color: #e8c07a !important;
    }
    #root .tool-memory-legendary-glyph {
      filter: none !important;
    }
    /* v23f：badge 底色被 body* 抹掉 → 金/砖红小字 2.0-2.8:1 不可读（0.6-0.65rem
       小字需 ≥4.5）。恢复深海军底（与浮层同系），warn 文字提亮金，destructive
       文字提亮暖红 #d99a8a（≈4.5:1）。 */
    [data-slot='badge'] {
      background-color: rgba(10, 24, 42, 0.55) !important;
    }
    [data-slot='badge'][class*='text-amber-600'],
    [data-slot='badge'][class*='text-amber-500'] {
      color: #d9b87a !important;
    }
    [data-slot='badge'][class*='bg-amber-500'] {
      background-color: rgba(201, 160, 92, 0.12) !important;
    }
    [data-slot='badge'][class*='text-destructive'] {
      color: #d99a8a !important;
    }
    /* v23f：E 区 amber 漏网金化——pane-tab dirty 圆点 / status-dot（实心
       bg-amber-500）、model-picker 警告条目（浮层内淡底 + amber 文字）。
       实心点转金（badge 内已有更精确规则不受影响）。 */
    [class*='bg-amber-500'] {
      background-color: rgba(201, 160, 92, 0.9) !important;
    }
    [data-slot='popover-content'] [class*='bg-amber-500/15'] {
      background-color: rgba(201, 160, 92, 0.14) !important;
    }
    [class*='text-amber-600'], [class*='text-amber-700'], [class*='text-amber-400'] {
      color: #d9b87a !important;
    }
    /* v23f：core 硬编码亮蓝/紫/粉防御性映射（message-reactions hover tint /
       preview-console info / file-tree R 图标，dump 未渲染时无残留，悬停展开时暴露） */
    [class*='bg-sky-500'], [class*='bg-violet-500'], [class*='bg-pink-500'] {
      background-color: rgba(201, 160, 92, 0.14) !important;
    }
    [class*='text-sky-700'], [class*='text-sky-300'] {
      color: #7fd0c4 !important;
    }
    [class*='text-sky-500'] {
      color: #8cc5ff !important;
    }
    /* v23d：arc-nous 装饰弧硬编码亮蓝 #4f8cff+橙 #ff8c42（Nous Portal hero）→ 金 */
    .arc-nous {
      --arc-c1: #c9a05c !important;
      --arc-c2: rgba(201, 160, 92, 0.45) !important;
    }

    /* v23d：侧边栏选中态/交互反馈——core 的 --ui-row-active-background 是 gold 8%
       mix（α≈0.126），叠亮壁纸合成底后 1.13:1 几乎不可见（纯半透明金永远不够）。
       在 sidebar 作用域覆盖变量为深海军底（选中行本身是交互态层，只影响一行，
       不与「深色底只加一次」铁律冲突）+ 金左边条保留「少量金」点缀。 */
    #root [data-slot='sidebar'] {
      --ui-row-active-background: rgba(10, 24, 42, 0.92) !important;
      --ui-control-active-background: rgba(10, 24, 42, 0.92) !important;
      --ui-row-hover-background: var(--wallpaper-gold-hover) !important;
      --ui-control-hover-background: var(--wallpaper-gold-hover) !important;
      border-color: var(--wallpaper-gold-quiet) !important;
    }
    #root [data-slot='sidebar'] [data-active='true'] {
      background-color: rgba(201, 160, 92, 0.18) !important;
      border-left: 2px solid var(--wallpaper-gold-selected) !important;
      color: #fff8ec !important;
    }
    /* v23f：hover 双通道反馈——底 α 0.32 + 文字提亮 */
    #root [data-slot='sidebar'] [data-slot='row-button']:hover,
    #root [data-slot='sidebar'] [data-slot='context-menu-trigger']:hover {
      color: #fff8ec !important;
    }
    /* v23f：分组标签（SidebarPanelLabel，PINNED/SESSIONS/CRON JOBS）恢复金色——
       用户明确要求。0.64rem 小字原金 #c9a05c 亮区 2.68-2.83:1 不可读 →
       提亮金 #d9b87a（双基准亮区 3.43-3.62、保守配置 5.82-5.98 ≥3:1）
       + font-weight 600 补偿小字感知。dot 保持 #c9a05c 作深金锚点。 */
    #root [data-slot='sidebar'] [class*='uppercase'] {
      color: #d9b87a !important;
      font-weight: 600 !important;
    }
    /* v23d：侧边栏搜索框未聚焦 opacity-30 叠亮壁纸 → 图标/占位 1.2-1.6:1 几乎消失 */
    #root [data-slot='sidebar'] [data-slot='context-menu-trigger'] {
      opacity: 1 !important;
    }
    /* v23d：profile 区按钮 opacity-55 + 三级字 亮底 1.53:1 → 提亮 */
    #root [data-slot='sidebar'] [data-slot='profile-rail'] {
      opacity: 1 !important;
      color: #d8d2c2 !important;
    }

    /* v23d：GFM callout（> [!NOTE]/[!TIP]/...）——core 标题用 Tailwind 硬编码
       text-blue-600 / text-violet-600（亮蓝/紫，违反零蓝零紫）且容器 bg-muted/25
       被 body * 抹掉、边框 1.44:1 近隐形。恢复深底+金边，标题按语义映射暖调：
       note→青、tip→柔灰绿、important/warning→金、caution→暖砖红。 */
    #root [data-slot='aui_markdown-alert'] {
      background-color: rgba(10, 24, 42, 0.35) !important;
      border-color: rgba(201, 160, 92, 0.25) !important;
    }
    #root [data-slot='aui_markdown-alert'] [class*='text-blue-600'],
    #root [data-slot='aui_markdown-alert'] [class*='text-blue-400'] {
      color: #7fd0c4 !important;
    }
    #root [data-slot='aui_markdown-alert'] [class*='text-violet-600'],
    #root [data-slot='aui_markdown-alert'] [class*='text-violet-400'],
    #root [data-slot='aui_markdown-alert'] [class*='text-amber-600'],
    #root [data-slot='aui_markdown-alert'] [class*='text-amber-400'] {
      color: #c9a05c !important;
    }
    #root [data-slot='aui_markdown-alert'] [class*='text-emerald-600'],
    #root [data-slot='aui_markdown-alert'] [class*='text-emerald-400'] {
      color: #8aa68f !important;
    }
    #root [data-slot='aui_markdown-alert'] [class*='text-rose-600'],
    #root [data-slot='aui_markdown-alert'] [class*='text-rose-400'] {
      color: #c07a6e !important;
    }
    /* v23d：普通引用（blockquote）左边条 --ui-stroke-tertiary 金 10% mix 合成后
       1.44:1 近隐形 → 金边 0.4（≈2.6:1 可辨）。v23f：亮区合成仅 1.49-1.55:1
       → α 提至 0.55（亮区 ≈2.0-2.3:1，仍点缀级） */
    #root [data-slot='aui_assistant-message-content'] .aui-md blockquote {
      border-color: rgba(201, 160, 92, 0.55) !important;
    }
    /* v23d：行内代码无背景与正文同色 → 淡金底（精确容器内，:not(pre) 防误伤代码块） */
    #root [data-slot='aui_assistant-message-content'] .aui-md :not(pre) code {
      background: rgba(201, 160, 92, 0.14) !important;
      border-radius: 4px !important;
      padding: 0 0.2em !important;
    }
    /* v23f：用户消息行内代码补同款淡金底（v23d 只覆盖了助手侧，两侧不一致） */
    #root [data-slot='aui_user-message-root'] :not(pre) code {
      background: rgba(201, 160, 92, 0.14) !important;
      border-radius: 4px !important;
      padding: 0 0.2em !important;
    }
    /* v23f：链接与 @引用金 #c9a05c 在壁纸亮区 2.33-2.83:1 不可读 → 提亮金 #d9b87a
       （亮区 3.0-3.6、深底 5.98）。只命中聊天区链接/引用，不碰 --ui-accent 全局
       （主按钮金底/滑块/checkbox 等保持 #c9a05c）。file/folder 中性引用保持二级暖白。 */
    #root [data-slot='aui_assistant-message-content'] .aui-md a,
    #root [data-slot='aui_user-message-root'] a {
      color: #d9b87a !important;
    }
    #root [data-slot='aui_assistant-message-content'] [data-ref='url'],
    #root [data-slot='aui_assistant-message-content'] [data-ref='image'],
    #root [data-slot='aui_assistant-message-content'] [data-ref='session'],
    #root [data-slot='aui_assistant-message-content'] [data-ref='theme'],
    #root [data-slot='aui_assistant-message-content'] [data-ref='command'],
    #root [data-slot='aui_assistant-message-content'] [data-ref='tool'],
    #root [data-slot='aui_assistant-message-content'] [data-ref='skill'],
    #root [data-slot='aui_assistant-message-content'] [data-ref='git'],
    #root [data-slot='aui_assistant-message-content'] [data-ref='diff'],
    #root [data-slot='aui_assistant-message-content'] [data-ref='staged'],
    #root [data-slot='aui_assistant-message-content'] .ref:not([data-ref]) {
      --ref-color: #d9b87a !important;
    }
    /* v23f：工具卡 scaffold 行 opacity 0.67 使工具名有效对比仅 2.56-2.77:1 →
       0.8（保留 core 淡化层次与 hover 恢复交互，hover/focus 仍需显式覆盖
       否则被 !important 压住无法提亮） */
    #root [data-slot='aui_assistant-message-content'] [data-conversation-scaffold] {
      opacity: 0.8 !important;
    }
    #root [data-slot='aui_assistant-message-content'] [data-conversation-scaffold]:is(:hover, :has(:focus-visible)) {
      opacity: 1 !important;
    }
    /* v23f：滚动条金 thumb 常态 18%（--dt-midground color-mix）在深底/暗壁纸上
       1.2-1.4:1 近隐形 → 常态 0.3 / hover 0.55（≈1.55 / 2.6:1 可发现）。
       只提透明度不改金色基线；portal 滚动条在 body 下不加 #root 前缀。 */
    #root .scrollbar-dt::-webkit-scrollbar-thumb,
    #root .scrollbar-fade::-webkit-scrollbar-thumb,
    #root .scrollbar-dt *::-webkit-scrollbar-thumb,
    #root .scrollbar-fade *::-webkit-scrollbar-thumb {
      background: rgba(201, 160, 92, 0.3) !important;
    }
    #root .scrollbar-dt::-webkit-scrollbar-thumb:hover,
    #root .scrollbar-fade::-webkit-scrollbar-thumb:hover,
    #root .scrollbar-dt *::-webkit-scrollbar-thumb:hover,
    #root .scrollbar-fade *::-webkit-scrollbar-thumb:hover {
      background: rgba(201, 160, 92, 0.55) !important;
    }
    .dt-portal-scrollbar::-webkit-scrollbar-thumb {
      background: rgba(201, 160, 92, 0.3) !important;
    }
    .dt-portal-scrollbar::-webkit-scrollbar-thumb:hover {
      background: rgba(201, 160, 92, 0.55) !important;
    }
    /* v23f：活动 tab 背景被 body* 抹掉，仅靠 2px 金下划线区分 → 淡深底一层
       （交互态层，不叠层；data-active 限定防通配误伤） */
    #root [class*='group/tab'][data-active='true'] {
      background-color: rgba(10, 24, 42, 0.35) !important;
    }
  `
  return styleEl
}

// v37：样式表生命周期 —— 与壁纸图层解耦。
// 归属：最新注入它的实例持有它（data-wp-owner）；已死实例的残留可回收；
// 另一个**还活着**的实例持有的不许动（wpReapDecision）。
function ensureWallpaperCss() {
  const existing = document.getElementById('hermes-wallpaper-css')
  if (existing && existing.dataset && existing.dataset.wpOwner === INSTANCE_ID) return existing
  if (existing && existing.dataset &&
      wpReapDecision(INSTANCE_ID, Object.keys(wpInstanceLedger(window).live), existing.dataset.wpOwner) === 'keep') {
    return existing   // 另一个活实例正持有样式表：安全优先，留着它
  }
  if (existing) existing.remove()
  const el = buildWallpaperStyleEl()
  el.dataset.wpOwner = INSTANCE_ID
  document.head.appendChild(el)
  return el
}

// 只在「用户显式关掉壁纸」与「本实例卸载（含宿主停用插件）」时调用 ——
// 图层回滚永远不许走这条路。
function removeWallpaperCss() {
  removeOwnedById('hermes-wallpaper-css')
}

// ── 状态（atom + storage 持久化）─────────────────────────────────────────
let $cfg = null

// 应用状态：'idle' | 'applying' | 'applied' | 'error'
let $status = null
// v24：上次轮换信息（面板反馈用）
let $lastSwap = null

// 模块级 storage 句柄（register 时绑定）
let ctxStorageSet = () => {}
// v47：壁纸库常驻 —— 扫描结果落盘通道。用独立 storage 键，不写进 cfg，
// 免得「写配置 → 触发重新应用壁纸」绕一圈自己打自己。
const LIB_CACHE_KEY = 'wallpaper-libcache-v1'
let libCacheIO = { get: () => null, set: () => {} }

// v37：本模块实例的身份 + 各副作用的清理句柄。热重载会新建一份模块，模块级 let 会重置，
// 所以这些句柄只服务「当前实例自己」；跨实例的事实一律走 #region instance-registry 的账本。
let INSTANCE_ID = ''
let overlayProbeDispose = null
let titlebarDispose = null
let reviewBoxDispose = null
let entranceDispose = null
let entranceMo = null
let entranceRetry = 0
let autoApplyTimer = null
let dumpTimer = null

// v25 诊断：设置等 OverlayView 覆盖层打开时输出卡片命中证据。
// 插件 CSS 注入后卡片应有深海军毛玻璃底；若显示 transparent/none 则
// 要么规则未命中要么插件未启用，据此区分「没写对」与「没开插件」。
function startOverlayProbe() {
  if (window.__hermesWallpaperOverlayProbe) return null
  window.__hermesWallpaperOverlayProbe = true
  let seen = false
  // v28.6：硬预算兜底——v28.4 只在「命中浮层」时 disconnect，但用户很可能整场都不打开
  // 设置 / 命令面板，这种情况下每次 body 变更仍会跑一次全文档 querySelectorAll（永久常驻）。
  // 预算用尽即摘除：探针只服务首次配色核对，不是常驻功能。
  let budget = 600
  const mo = new MutationObserver(() => {
    if (--budget <= 0) {
      mo.disconnect()
      console.error('[wallpaper][diag] v25 overlay probe budget exhausted')
      return
    }
    const ov = document.querySelectorAll('[data-overlay-surface]')
    if (ov.length && !seen) {
      seen = true
      const card = ov[0].firstElementChild
      const cs = card ? getComputedStyle(card) : null
      console.error('[wallpaper][diag] v25 overlay open card.bg=' + (cs ? cs.backgroundColor : 'N/A') +
        ' backdrop=' + (cs ? cs.backdropFilter : 'N/A') +
        ' border=' + (cs ? cs.borderColor : 'N/A'))
      // v28.4：诊断命中即断开——旧实现永不 disconnect，每次 body 变更都跑一次
      // 全文档 querySelectorAll（对话流式期间每秒几十次 = 可测量的常驻开销）
      mo.disconnect()
      console.error('[wallpaper][diag] v25 overlay probe disconnected')
    }
  })
  mo.observe(document.body, { childList: true, subtree: true })
  // v37（审查闭环 F1）：探针观察者也要有回收句柄 —— 以前它只有 window 守卫，
  // 卸载后观察者仍在直到把 600 次预算烧完（重载后又武装一个新的 → 短暂叠加）。
  return () => {
    try { mo.disconnect() } catch {}
    overlayProbeDispose = null
  }
}

function initStore(ctx) {
  // v8 迁移：v7（单文件夹）/v6 旧配置合并进新 schema，再把旧单文件夹字段收成 folders[]
  //（用户已有的 enabled/路径/全部参数都不丢；旧键只在成功迁移后删除）
  // 评审 F8：旧键只在**当前存档为空**时才作为数据源。v36 把「上一代的活跃键 v7」变成了 legacy，
  // 若旧键删除失败（remove 抛错被静默吞）而这里仍优先读它，用户之后改的设置每次重启都会被
  // 冻结的旧快照覆盖 —— 爆炸半径从「几乎不可能」变成「每次启动」。
  const currentRaw = (() => { try { return ctx.storage.get(STORE_KEY, null) } catch { return null } })()
  // 一次就把值读到手（评审 D7：不要第二次裸读 —— 宿主若换成会抛的 IPC 实现，异常会冒泡出
  // initStore 让整个插件注册失败，而这里本该退化成 DEFAULTS）
  const legacyPick = (!currentRaw || typeof currentRaw !== 'object')
    ? (['wallpaper-cfg-v7', 'wallpaper-cfg-v6'].map((k) => {
      try { return { key: k, value: ctx.storage.get(k, null) } } catch { return null }
    }).find((x) => x && x.value && typeof x.value === 'object') || null)
    : null
  const legacyKey = legacyPick ? legacyPick.key : ''
  const legacy = legacyPick ? legacyPick.value : null
  // v33：一律与 DEFAULTS 合并 —— 旧存档没有新增字段（如 locked）时不会读到 undefined
  const base = legacy && typeof legacy === 'object'
    ? { ...DEFAULTS, ...legacy }
    // v37 审查闭环（3）：这里是第二次读 —— 必须同样带 try/catch。宿主若换成会抛的实现，
    // 异常会冒到 register 的 catch，而那时旧实例的样式表已被删、新实例又没来得及注入 = V1 原状。
    : { ...DEFAULTS, ...(currentRaw || (() => { try { return ctx.storage.get(STORE_KEY, DEFAULTS) } catch { return DEFAULTS } })() || {}) }
  const stored = wpMigrateFolders(base)
  $cfg = atom(stored)
  $status = atom('idle')
  $lastSwap = atom(null)
  // v36 启动指纹：活体验证靠它把日志归属到具体构建（热重载会留下旧实例，行号/指纹是唯一线索）
  console.error('[wallpaper][diag] boot build=' + WP_BUILD
    + ' folders=' + wpNormalizeFolders(stored.folders).length + '/' + wpActiveFolders(stored).length
    + ' source=' + wpFolderSourceState(stored) + ' enabled=' + !!stored.enabled)
  // 评审 D1（阻断级）：迁移采用旧键时**必须先落盘 v8 再删旧键**。
  // $cfg.listen 只在值「变化」时写（nanostores 的 listen 不像 subscribe 那样立即回调），
  // 而宿主 storage.remove 永不抛 —— 只删不写的话，用户装完不改任何设置就没有 v8 存档，
  // 第二次启动无档可读 → 全部设置回默认，且旧键已被物理删除（升级即丢配置）。
  if (legacyKey) {
    try { ctx.storage.set(STORE_KEY, stored) } catch (e) {
      console.error('[wallpaper] migrate persist FAIL', e && e.message)
    }
    // 删不掉也要留痕（有上面那次落盘兜底，最多丢一次迁移，不会永久回滚用户设置）
    try { ctx.storage.remove(legacyKey) } catch (e) {
      console.error('[wallpaper] legacy key remove FAIL', legacyKey, e && e.message)
    }
  }

  // 持久化只有这一条路径：$cfg 变更 → storage.set。**没有** storage 事件监听（避免 storage 事件回环
  // → 无限循环拖死渲染进程）；所以删掉下面这个 listen 会让全部设置（含 v33 的 locked/lockedPath）静默丢失。
  $cfg.listen((value) => {
    ctx.storage.set(STORE_KEY, value)
  })

  // 初始状态：默认关闭 → 只清理，不注入
  $status.set('idle')
  cleanupLayers()
  // v37：配色 = 「插件启用」，不跟图层的成败/守卫绑定。以前这里删掉样式表之后只有那条
  // 800ms auto-apply（守卫：enabled && 有启用文件夹）会重新注入 → 暂停态/无图源时
  // 配色就永久消失（V1 的第二个入口）。现在按 enabled 立即补回。
  if (stored.enabled) {
    ensureWallpaperCss()
    // v37（审查 M6）：自愈挂在 titlebar 观察者里，而它此前只在 applyWallpaper 成功路径武装 ——
    // 暂停态/无图源的启动路径注入了配色却没有守护，僵尸删表后不会自愈。
    startTitleBarAssert()
  }

  // v23d 修复：启动时若存储配置已启用且有图片路径，自动应用壁纸。
  // 否则重启后插件从不注入 CSS（applyWallpaper 只在用户手动操作时被调用），
  // 所有插件配色（金色/暖白/浮层/选中态）全部失效退回默认主题。
  // v24：文件夹轮换模式同样自动恢复（rotate && 有启用的文件夹 视为有图源）。
  const savedCfg = $cfg.get()
  // v41：首次启动自动挂载 Steam 创意工坊壁纸库（Wallpaper Engine 431960）。
  // 幂等靠 steamSeeded —— 只在没播过种时试一次；用户删掉后不再回填（面板按钮可手动加回）。
  if (!savedCfg.steamSeededV45) {
    wpEnsureSteamLibrary().catch((e) => console.error('[wallpaper] steam seed FAIL', e && e.message))
  }
  // v28：图源 = 文件夹或单图（不再要求 rotate 同时开启）
  if (savedCfg.enabled && (wpActiveFolders(savedCfg).length > 0 || savedCfg.imagePath)) {
    autoApplyTimer = setTimeout(() => {
      autoApplyTimer = null
      try {
        applyWallpaper($cfg.get())
      } catch (e) {
        console.error('[wallpaper] auto-apply ERROR', e.message)
      }
    }, 800)
  }
  overlayProbeDispose = startOverlayProbe()

}

// ── v24 文件夹定时轮换 + 切换动画 ───────────────────────────────────────────
const IMG_EXT = /\.(jpe?g|png|webp|gif|bmp|avif|mp4|webm|mov|x?html?)$/i
// ponytail: videos reuse the image rotator path; separate pipeline skipped until needed
const VID_EXT = /\.(mp4|webm|mov)$/i
// v43：web 壁纸（Wallpaper Engine "web" 类型，入口 index.html）—— 用 <iframe> 跑
const WEB_EXT = /\.x?html?$/i
const isWebPath = (p) => WEB_EXT.test(String(p).split(/[?#]/)[0])
// v38: http 后缀 query/hash 去掉再判（直链 ?token= 这类不断尾）
function isVideoPath(p) {
  if (!p) return false
  const clean = String(p).split(/[?#]/)[0]
  return VID_EXT.test(clean)
}
// v27.3 排除前缀的唯一字符串在纯逻辑区（v35 迁入，见 WP_EXCLUDED_PREFIX）
const ROTATOR_MAX_FAILS = 5

// Steam 创意工坊 Wallpaper Engine 库（appid 431960，Steam 公开应用号）。
// v45：不再写死盘符顺序 —— 遍历所有盘符 × 四种常见安装形态，**凡是存在的库全部挂载**
//（一台机器装多个 Steam 库很常见，只取第一个命中会整库漏掉）。
const WP_STEAM_DRIVES = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('')
// ponytail: 26 盘 × 4 形态 = 104 次 readDir，探测时并行且各带 3s 超时；不存在的盘 ENOENT 立刻返回。
const WP_STEAM_CANDIDATES = WP_STEAM_DRIVES.flatMap((d) => [
  d + ':\\Program Files (x86)\\Steam\\steamapps\\workshop\\content\\431960',
  d + ':\\Program Files\\Steam\\steamapps\\workshop\\content\\431960',
  d + ':\\Steam\\steamapps\\workshop\\content\\431960',
  d + ':\\SteamLibrary\\steamapps\\workshop\\content\\431960',
])
// 创意工坊每个壁纸目录都带 preview.jpg / preview.gif（封面图，不是壁纸本体）—— 一律剔除，
// 否则有多少个订阅就多出多少张封面进池。
const WP_PREVIEW_RE = /^preview(\.|$)/i
// 下钻上限：Steam 库是 431960/<壁纸ID>/<本体> 两层；子目录再多也不无限扫
const WP_DEEP_SUBDIR_MAX = 400
const WP_DEEP_BATCH = 8

const ROTATOR_STATE_KEY = '__hermesWallpaperRotatorStateV1'
const ROTATOR_OWNER = Symbol('hermes-wallpaper-rotator')

// #region swap-state-machine
// 换壁纸的「门锁 + 双层槽位（A/B）」状态机：纯逻辑、零 DOM 依赖。
// tests/harness.mjs 会抽取本区真实源码在 Node 里单测（改这里 = 改测试对象，零漂移）。
// 不变量：
//   I1 任意时刻最多一次「飞行中的换图」（st.token !== 0）
//   I2 飞行中时目标槽必然不等于可见槽（双槽缓冲，永不出现第三层）
//   I3 被取代的令牌禁止再落定图层（只允许取代它的新请求落定）
//   I4 门锁自愈：await 卡死不返回时超时强制解锁（手动切换永不被永久锁死）
const SWAP_LOCK_MAX_MS = 6000   // 动画门锁上限（动画 ms+80 之后仍未落定 = 异常）
// 选图阶段上限：必须 > readDir 超时(4000) + probe 超时(8000)，否则慢路径上自愈会
// 误判「卡死」并把真正的在飞选图放进来（评审 F2）。另用 pickId 保证只有发起者能复位。
const SWAP_PICK_MAX_MS = 13000

// 壁纸层 id：固定双槽 A/B（纯逻辑，便于单测归属判定）
function wpBgSlotId(slot) { return slot === 0 ? 'hermes-wallpaper-bg-a' : 'hermes-wallpaper-bg-b' }
// 历史版本残留 id（热重载/旧 bug 可能与新层共存）
const WP_LEGACY_LAYER_IDS = ['hermes-wallpaper-bg', 'hermes-wallpaper-bg-next']
// 该删哪些层：除保留槽外全部（含 legacy id）。评审 F3：让「保留槽写反」这类
// 回归有测试兜底，而不是靠人读代码。
function wpLayerIdsToRemove(keepSlot) {
  const keep = wpBgSlotId(keepSlot)
  return [wpBgSlotId(0), wpBgSlotId(1)].concat(WP_LEGACY_LAYER_IDS).filter((id) => id !== keep)
}

function wpNewSwapState() {
  return {
    seq: 0,            // 单调递增令牌序列
    token: 0,          // 飞行中的令牌（0 = 空闲）
    startedAt: 0,      // 本次飞行开始时间（自愈用）
    slot: 0,           // 飞行中的目标槽位（0 = A / 1 = B）
    visible: 0,        // 当前可见槽位
    currentPath: '',   // v35：当前展示图的路径账本（改名后 DOM 的 src 是旧路径，只能靠它）
    pendingEl: null,   // 飞行中的层元素（快速前进时直接落定它，不靠 id 反查）
    picking: false,    // 选图阶段（readDir/probe）重入保护
    pickingAt: 0,
    pickId: 0,         // 选图归属：只有发起者能复位 picking（评审 F2）
    queueTimer: null,  // 连点去抖计时器
    applyTimer: null   // 设置变更去抖计时器
  }
}

// 取走飞行中的请求（快速前进）：清锁并交出 { token, slot, el }
function wpTakeInflight(st) {
  if (st.token === 0) return null
  const taken = { token: st.token, slot: st.slot, el: st.pendingEl || null }
  st.token = 0
  st.startedAt = 0
  st.pendingEl = null
  return taken
}

// 开一次换图。内部先取走飞行中的请求（I1/I3）；被取代的层落定后即为可见层，
// 故新目标槽 = 它的反面（I2）。
function wpBeginSwap(st, now) {
  const cancel = wpTakeInflight(st)
  st.seq += 1
  st.token = st.seq
  st.startedAt = now
  if (cancel) st.visible = cancel.slot
  st.slot = st.visible === 0 ? 1 : 0
  st.pendingEl = null
  return { token: st.token, slot: st.slot, cancel }
}

// 落定：只有当前令牌可以改写槽位并解锁，返回 true 表示调用方可以动图层
// v35：落定 = 屏幕上换成这张图 → 顺手记路径账本（只接受当前令牌的写入）
function wpFinishSwap(st, token, path) {
  if (token !== st.token) return false
  st.visible = st.slot
  st.token = 0
  st.startedAt = 0
  st.pendingEl = null
  if (typeof path === 'string' && path) st.currentPath = path
  return true
}

// 异常中止（图片 onerror 等）：只对当前令牌生效
function wpAbortSwap(st, token) {
  if (token !== st.token) return false
  st.token = 0
  st.startedAt = 0
  st.pendingEl = null
  return true
}

function wpShouldForceUnlock(st, now) {
  return st.token !== 0 && (now - st.startedAt) > SWAP_LOCK_MAX_MS
}

function wpPickStale(st, now) {
  return !!st.picking && (now - (st.pickingAt || 0)) > SWAP_PICK_MAX_MS
}

// 选图归属（评审 F2）：发起者拿到 pickId，只有它（或强制复位）能关掉 picking
function wpStartPick(st, now) {
  st.pickId = (st.pickId || 0) + 1
  st.picking = true
  st.pickingAt = now
  return st.pickId
}

function wpEndPick(st, pickId) {
  if (pickId !== st.pickId) return false   // 已被强制复位/被新选图取代 → 不许清别人的门
  st.picking = false
  return true
}

function wpForceEndPick(st) {
  st.pickId = (st.pickId || 0) + 1
  st.picking = false
  return st.pickId
}

// v33 锁定（纯逻辑，零 DOM）：锁定 = 冻结自动轮换 + 钉住当前一张，与 rotate 开关解耦。
// 放在纯区里是为了让「锁定后不再排下一次轮换」这条判定对单测可见（tests/lock.test.mjs）。
function wpAutoRotateAllowed(cfg) {
  if (!cfg) return false
  if (cfg.locked) return false   // 锁定优先：即使 rotate 仍勾选也不放行
  return !!cfg.rotate
}

// v33 锁定：勾选锁定时「钉住的图」= 此刻屏幕上这张。必须每次勾选都重钉 ——
// 只在首次写会让「锁定A → 解锁 → 换到D → 再锁定」在重启后回到 A（评审发现的真 bug）。
function wpPinOnLock(cfg, current) {
  const prev = (cfg && cfg.lockedPath) || ''
  if (!cfg || !cfg.locked) return prev   // 未锁定 = 不动钉图
  return current || prev                 // 取不到当前图（壁纸还没应用）时保留旧值
}

// ── v35 like 标记（纯逻辑，零 DOM）─────────────────────────────────────────
// 「标记」= 原地改名加前缀，与 v27.3「排除」共用同一机制（bridge renamePath 只能
// 同目录改名、newName 不许含斜杠）。
// 两个前缀的唯一字符串放在本区（有单测）；模块区用别名 EXCLUDED_PREFIX 沿用旧名。
const WP_EXCLUDED_PREFIX = '_excluded_'
const LIKED_PREFIX = '_liked_'

// 路径归一（比较用）：反斜杠 → 正斜杠，忽略大小写
// v35：从模块区迁入本区 —— 纯区不能引用区外标识符（抽取出来的源码里没有它们）
function normPath(p) {
  return String(p).replace(/\\/g, '/').toLowerCase()
}

// 标记计划：纯逻辑，不碰文件系统（调用方把 newName 交给 hd.renamePath）。
// 返回 { ok:true, action:'like'|'unlike', newName, newPath } 或 { ok:false, error }
function wpLikePlan(path) {
  if (!path) return { ok: false, error: '无当前壁纸' }
  const p = String(path)
  if (/^https?:\/\//i.test(p)) return { ok: false, error: '远程壁纸无法改名' }
  const base = p.split(/[\\/]/).pop() || ''
  if (!base) return { ok: false, error: '无法解析文件名' }
  if (base.startsWith(WP_EXCLUDED_PREFIX)) return { ok: false, error: '该壁纸已被排除，先恢复原名' }
  const dir = p.slice(0, p.length - base.length)   // 含结尾分隔符，原样保留
  if (base.startsWith(LIKED_PREFIX)) {
    const bare = base.slice(LIKED_PREFIX.length)
    if (!bare) return { ok: false, error: '无法解析文件名' }
    return { ok: true, action: 'unlike', newName: bare, newPath: dir + bare }
  }
  return { ok: true, action: 'like', newName: LIKED_PREFIX + base, newPath: dir + LIKED_PREFIX + base }
}

// 改名后修正路径账本 / 锁定钉图：只有确实等于旧路径才替换（防误改别的图）
function wpReplaceTrackedPath(current, oldPath, newPath) {
  if (!current || !oldPath || !newPath) return current || ''
  return normPath(current) === normPath(oldPath) ? newPath : current
}

// v35：改名成功后「账本该写成什么」。三种情况（评审 finding 1：修复自身引入的回归）：
//   账本为空（例如刚热重载到 v35、账本还没建立）→ 补上这次改名的结果；
//   账本 == 这次改名的基准（正常路径）→ 跟上新名字；
//   账本 ≠ 基准（rename 的 await 期间「换图落定 / 快速前进」写进了更新的那张）
//     → 保留更新值；无条件覆盖会让账本指向一张屏幕上看不见的图（= F1 同族症状）。
// 与 wpReplaceTrackedPath 的区别只在第一条：配置字段（imagePath 等）为空时必须保持为空，
// 所以两者不能合并。
function wpLedgerAfterRename(current, oldPath, newPath) {
  if (!newPath) return current || ''
  if (!current) return newPath
  return normPath(current) === normPath(oldPath) ? newPath : current
}

// v35：快速前进（连点时把被取代的飞行层立刻落定成可见层 = 屏幕上换成它）也必须记账。
// wpBeginSwap 已经改过 st.visible，这里只负责把账本对齐到「刚成为可见的那张」——
// 不记的话账本会停在上一张，like 就会去改名一张屏幕上根本看不见的图（评审 finding 1）。
function wpFastForward(st, path) {
  if (typeof path !== 'string' || !path) return false
  st.currentPath = path
  return true
}

// v35：改名成功后把配置里所有指向旧路径的字段一起对齐，返回「需要写的那份」或 null。
// 漏了 imagePath → 单图模式重启后 probe 旧名失败，壁纸和整套配色一起消失（评审 finding 2）；
// 漏了 lockedPath → 锁定态重启后钉不住那张。返回 null = 没有字段命中 → 不白写 storage。
function wpRepointConfig(cfg, oldPath, newPath) {
  if (!cfg || !oldPath || !newPath) return null
  const lockedPath = wpReplaceTrackedPath(cfg.lockedPath, oldPath, newPath)
  const imagePath = wpReplaceTrackedPath(cfg.imagePath, oldPath, newPath)
  if (lockedPath === (cfg.lockedPath || '') && imagePath === (cfg.imagePath || '')) return null
  return { ...cfg, lockedPath, imagePath }
}

// ── v36 多文件夹（纯逻辑，零 DOM）───────────────────────────────────────────
// 需求：壁纸文件夹最多 5 个，每个可单独启用/停用；未启用的不参与扫描与轮换。
// 图源的唯一出处 = wpActiveFolders(cfg)：任何「有没有图源 / 扫哪些目录」的判断都必须走它，
// 不许再读旧单文件夹字段（v≤35 的 folderPath，迁移后删除，wiring 门禁会数残留）。
const WP_MAX_FOLDERS = 5
const WP_BUILD = 'v47-persist-lib'   // v46：视频卡片用 #t=1 出真帧缩略图；多 Steam 库全挂；场景壁纸渲染图走 we-scene 产物

// 文件夹比较键：normPath（大小写/斜杠方向）+ 去掉尾部分隔符。
// 评审发现：normPath 不归尾斜杠，`D:/bg` 与 `D:/bg/` 会被当成两本 → 同一目录扫两遍、
// 面板张数翻倍、合并去重也失效。文件夹去重一律用 wpFolderKey；不动 normPath（它还被
// like/账本复用，改它要重新验那两条链）。
function wpFolderKey(p) {
  return normPath(p).replace(/\/+$/, '')
}

// 归一化 folders：丢空路径、按 wpFolderKey 去重、截到 WP_MAX_FOLDERS、enabled 归布尔。
// 幂等：对已归一化的输入返回等值结果（任何写 folders 的入口都先过它）。
function wpNormalizeFolders(list) {
  const out = []
  const seen = new Set()
  for (const item of Array.isArray(list) ? list : []) {
    const raw = item && typeof item === 'object' ? item : { path: item }
    const path = String(raw.path == null ? '' : raw.path).trim()
    if (!path) continue
    const key = wpFolderKey(path)
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ path, enabled: raw.enabled !== false })
    if (out.length >= WP_MAX_FOLDERS) break
  }
  return out
}

// 参与扫描/轮换的文件夹路径（唯一图源）
function wpActiveFolders(cfg) {
  if (!cfg) return []
  return wpNormalizeFolders(cfg.folders).filter((f) => f.enabled).map((f) => f.path)
}

// 图源指纹：**启用中的**文件夹集合（排序后）压成稳定字符串。
// rotateOnce 的 await 之后用它比对「图源是否换过」。
// 只算启用项（评审）：编辑/删除一个已停用的行、或调整列表顺序，不该作废一次在飞换图
// （那会表现为「点了换一张没反应」）；而启用/停用/增删/改路径都会改变集合，
// 仍是 v≤35 单路径比较的超集。
function wpFolderSignature(cfg) {
  return wpActiveFolders(cfg).map(wpFolderKey).sort().join('|')
}

// 某个路径是否落在这些文件夹里（用于「锁定的图已不在任何启用文件夹里」的诊断）
function wpPathUnderFolders(path, folderPaths) {
  const p = wpFolderKey(path)
  if (!p) return false
  return (Array.isArray(folderPaths) ? folderPaths : []).some((f) => {
    const k = wpFolderKey(f)
    return !!k && (p === k || p.startsWith(k + '/'))
  })
}

// 图源状态：面板 / chip / applyWallpaper 必须用同一个判据，否则三处各说各话（评审 D2）。
//   'none'   = 没有配置任何文件夹（单图模式或无图源）
//   'paused' = 配了文件夹但一本都没启用（暂停：会话内保留当前画面，不轮换）
//   'active' = 至少一本启用
function wpFolderSourceState(cfg) {
  if (!cfg) return 'none'
  const rows = wpNormalizeFolders(cfg.folders)
  if (rows.length === 0) return 'none'
  return rows.some((f) => f.enabled) ? 'active' : 'paused'
}

// 追加一个文件夹（去重/上限/空值都拒绝，失败时原列表原样带回）
function wpAddFolder(list, path) {
  const cur = wpNormalizeFolders(list)
  const p = String(path == null ? '' : path).trim()
  if (!p) return { ok: false, folders: cur, error: '路径为空' }
  if (cur.some((f) => wpFolderKey(f.path) === wpFolderKey(p))) return { ok: false, folders: cur, error: '该文件夹已在列表里' }
  if (cur.length >= WP_MAX_FOLDERS) return { ok: false, folders: cur, error: '最多 ' + WP_MAX_FOLDERS + ' 个文件夹' }
  return { ok: true, folders: cur.concat([{ path: p, enabled: true }]) }
}

// 批量添加（系统对话框可一次选多个目录）：空路径不算错误（对话框不会返回空串）
function wpAddFolders(list, paths) {
  let folders = wpNormalizeFolders(list)
  const errors = []
  for (const p of Array.isArray(paths) ? paths : []) {
    const r = wpAddFolder(folders, p)
    if (r.ok) folders = r.folders
    else if (r.error !== '路径为空') errors.push(r.error)
  }
  return { folders, errors }
}

// 编辑某行的路径：清空 = 删除该行；与别的行重复 = 删掉被编辑的这行（保留原先那条）
function wpReplaceFolder(list, index, path) {
  const cur = wpNormalizeFolders(list)
  if (!(index >= 0 && index < cur.length)) return cur
  const next = cur.slice()
  const p = String(path == null ? '' : path).trim()
  if (!p) { next.splice(index, 1); return next }
  if (next.some((f, i) => i !== index && wpFolderKey(f.path) === wpFolderKey(p))) { next.splice(index, 1); return next }
  next[index] = { path: p, enabled: cur[index].enabled }
  return next
}

function wpSetFolderEnabled(list, index, on) {
  const cur = wpNormalizeFolders(list)
  if (!(index >= 0 && index < cur.length)) return cur
  const next = cur.slice()
  next[index] = { path: cur[index].path, enabled: !!on }
  return next
}

function wpRemoveFolder(list, index) {
  const cur = wpNormalizeFolders(list)
  if (!(index >= 0 && index < cur.length)) return cur
  const next = cur.slice()
  next.splice(index, 1)
  return next
}

// v≤35 → v36 迁移：单文件夹 folderPath 收成 folders[{path, enabled:true}]，并删掉旧字段。
// 幂等：已有 folders 时只做归一化，不碰它的内容。
function wpMigrateFolders(cfg) {
  const next = { ...(cfg || {}) }
  const legacyPath = String(next.folderPath == null ? '' : next.folderPath).trim()
  const hasFolders = Array.isArray(next.folders) && next.folders.length > 0
  next.folders = wpNormalizeFolders(hasFolders ? next.folders : (legacyPath ? [{ path: legacyPath, enabled: true }] : []))
  delete next.folderPath
  return next
}

// 多文件夹图片列表合并：按 normPath 跨目录去重 + 自然排序
// （order='seq' 因此按完整路径交错遍历各文件夹 —— 见计划 §七）
function wpMergeImageLists(lists) {
  const seen = new Set()
  const out = []
  for (const list of Array.isArray(lists) ? lists : []) {
    for (const p of Array.isArray(list) ? list : []) {
      const key = normPath(p)
      if (seen.has(key)) continue
      seen.add(key)
      out.push(p)
    }
  }
  return out.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
}
// #endregion swap-state-machine

// #region instance-registry
// 跨实例账本（host 由调用方传入，生产里 host = window）。**为什么必须挂 window**：
// 热重载会新建一份模块，模块级变量在新旧实例之间互不可见 ——「重载后还剩几个实例、
// 每个实例的观察者/定时器清干净没有」只有 window 上的状态说得清（v27 的
// __wpTitlebarThrottle 是同一个教训）。这里是零 DOM 纯逻辑，单测传普通对象即可。
function wpInstanceLedger(host) {
  if (!host.__wpInstanceLedgerV1) {
    host.__wpInstanceLedgerV1 = { seq: 0, live: {}, history: [] }
  }
  return host.__wpInstanceLedgerV1
}

function wpRegisterInstance(host, build, at) {
  const led = wpInstanceLedger(host)
  led.seq += 1
  const id = 'i' + led.seq
  led.live[id] = { build: String(build || ''), at: at || 0, pending: [], cleaned: [] }
  led.history.push({ id: id, build: String(build || ''), at: at || 0, event: 'register' })
  wpTrimHistory(led)
  return id
}

function wpDisposeInstance(host, id) {
  const led = wpInstanceLedger(host)
  if (!led.live[id]) return false          // 幂等：重复 dispose 不改账
  const rec = led.live[id]
  led.history.push({ id: id, event: 'dispose', cleaned: rec.cleaned.length, pending: rec.pending.length })
  wpTrimHistory(led)
  delete led.live[id]
  return true
}

function wpIsLive(host, id) {
  return !!wpInstanceLedger(host).live[id]
}

function wpMarkCleanup(host, id, key) {
  const rec = wpInstanceLedger(host).live[id]
  if (!rec || rec.pending.indexOf(key) >= 0) return false
  rec.pending.push(key)
  return true
}

function wpMarkCleaned(host, id, key) {
  const rec = wpInstanceLedger(host).live[id]
  if (!rec) return false
  const i = rec.pending.indexOf(key)
  if (i < 0) return false
  rec.pending.splice(i, 1)
  rec.cleaned.push(key)
  return true
}

function wpLiveInstanceCount(host) {
  return Object.keys(wpInstanceLedger(host).live).length
}

function wpPendingCleanups(host) {
  const live = wpInstanceLedger(host).live
  const out = []
  // 只报「还有没清干净的」实例：pending 为空的条目是噪音，不算泄漏证据
  for (const id of Object.keys(live)) {
    if (live[id].pending.length > 0) out.push({ id: id, pending: live[id].pending.slice() })
  }
  return out
}

function wpEvictStaleInstances(host, keepId) {
  const led = wpInstanceLedger(host)
  const evicted = []
  for (const id of Object.keys(led.live)) {
    if (id === keepId) continue
    evicted.push(id)
    led.history.push({ id: id, event: 'evicted' })
    delete led.live[id]
  }
  wpTrimHistory(led)
  return evicted
}

// 清理图层/样式表时该不该删这个元素？
//   'remove' = 自己的 / 祖先实例已死（孤儿）/ 没有归属标记（旧版本残留）
//   'keep'   = 属于另一个**还活着**的实例 —— 绝不许动
// V1 根因就是这个：cleanupLayers 原来全局按 id 删，旧实例一跑就把新实例的样式表删了。
function wpReapDecision(myOwner, liveOwners, elOwner) {
  const owner = String(elOwner || '')
  if (owner === String(myOwner || '')) return 'remove'
  if (owner === '') return 'remove'
  const live = Array.isArray(liveOwners) ? liveOwners : []
  for (const id of live) {
    if (String(id) === owner) return 'keep'
  }
  return 'remove'
}

function wpTrimHistory(led, max) {
  const cap = max || 50
  if (led.history.length > cap) led.history.splice(0, led.history.length - cap)
}
// #endregion instance-registry


// v35：两个改名前缀的唯一字符串在纯逻辑区（有单测）；模块别名沿用旧名，
// listImagesInFolder / excludeCurrentWallpaper 都不用改。
const EXCLUDED_PREFIX = WP_EXCLUDED_PREFIX

function getRotatorState() {
  const global = window
  if (!global[ROTATOR_STATE_KEY]) {
    global[ROTATOR_STATE_KEY] = {
      ...wpNewSwapState(),
      active: false,
      timer: null,
      generation: 0,
      seqIdx: -1,
      fails: 0,
      // v27.2: 洗牌队列（order='shuffle'）。一轮 = 打乱后的全部图各一次；
      // 每次切换前重扫文件夹，从队列剔除已删图，重洗时纳入新图（自适应）。
      shuffleQueue: []
    }
  }
  const st = global[ROTATOR_STATE_KEY]
  // 兼容：热重载前写入 window 的旧 state 缺新字段（模块级 let 会重置，window 上的不会）
  if (!Array.isArray(st.shuffleQueue)) st.shuffleQueue = []
  if (typeof st.seq !== 'number') st.seq = 0
  if (typeof st.token !== 'number') st.token = 0
  if (typeof st.startedAt !== 'number') st.startedAt = 0
  if (typeof st.slot !== 'number') st.slot = 0
  if (typeof st.visible !== 'number') st.visible = 0
  if (typeof st.currentPath !== 'string') st.currentPath = ''
  if (!('pendingEl' in st)) st.pendingEl = null
  if (!('picking' in st)) st.picking = false
  if (typeof st.pickingAt !== 'number') st.pickingAt = 0
  if (typeof st.pickId !== 'number') st.pickId = 0
  if (typeof st.generation !== 'number') st.generation = 0
  if (!('queueTimer' in st)) st.queueTimer = null
  if (!('applyTimer' in st)) st.applyTimer = null
  // v28：旧门锁字段的语义已由 token 取代，直接清掉避免旧实例误读
  delete st.swapInFlight
  delete st.pendingSwap
  return st
}

// 读取文件夹图片列表（每次切换前重扫 → 新增图片自动进池）
// 注：参数名用 dirPath —— v36 起「旧单文件夹字段」必须在纯区迁移函数之外全文件清零
// （接线门禁的负断言按整行扫文本，参数名也算残留；图源的唯一出处是 wpActiveFolders）。
// v41：本层媒体文件筛选 —— 不吃子目录、不吃 _excluded_ 前缀、不吃创意工坊 preview 封面。
function wpPickMediaFiles(entries) {
  return (Array.isArray(entries) ? entries : [])
    .filter((e) => !e.isDirectory && IMG_EXT.test(e.name)
      && !e.name.startsWith(EXCLUDED_PREFIX) && !WP_PREVIEW_RE.test(e.name))
    .map((e) => e.path)
}

async function listImagesInFolder(dirPath) {
  const hd = window.hermesDesktop
  if (!dirPath || !hd || typeof hd.readDir !== 'function') return []
  const readEntries = async (p) => {
    const res = await withTimeout(hd.readDir(p), 4000, 'readDir')
    return Array.isArray(res && res.entries) ? res.entries : []
  }
  try {
    const entries = await readEntries(dirPath)
    let files = wpPickMediaFiles(entries)
    // v41（Steam 创意工坊形态）：431960/<壁纸ID>/<本体> —— 本层一个媒体文件都没有、却有子目录时
    // 下钻一层，把每个壁纸目录的本体收上来（封面 preview.* 已在 wpPickMediaFiles 里剔除）。
    // 只在「本层为空」时下钻 —— 普通壁纸文件夹（本层直接放图）行为完全不变。
    if (files.length === 0) {
      const subs = entries.filter((e) => e.isDirectory && !e.name.startsWith('.')).slice(0, WP_DEEP_SUBDIR_MAX)
      if (subs.length) {
        const deep = []
        for (let i = 0; i < subs.length; i += WP_DEEP_BATCH) {
          const chunk = subs.slice(i, i + WP_DEEP_BATCH)
          // v43：WE 独占格式（scene.pkg / text / application）浏览器渲染不了 —— 退回该壁纸
          // 目录的封面图（preview.*），至少让它在库里可见可选；能渲染的本体（mp4/webm/html）优先。
          const pickOne = (es) => {
            const m = wpPickMediaFiles(es)
            if (m.length) return m
            return (Array.isArray(es) ? es : [])
              .filter((e) => !e.isDirectory && !e.name.startsWith(EXCLUDED_PREFIX) && WP_PREVIEW_RE.test(e.name))
              .map((e) => e.path)
          }
          const got = await Promise.all(chunk.map((s) => readEntries(s.path).then(pickOne).catch(() => [])))
          for (const g of got) deep.push(g)
        }
        files = wpMergeImageLists(deep)
        console.error('[wallpaper][diag] deep-scan ' + dirPath + ' subs=' + subs.length + ' files=' + files.length)
      }
    }
    return files.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
  } catch (e) {
    console.error('[wallpaper] readDir FAIL', dirPath, e.message)
    return []
  }
}

// v36：多文件夹扫描 —— 每个目录各自带 4s 超时（在 listImagesInFolder 内），并行发起，
// 合并后跨目录去重 + 自然排序。per 供面板逐目录报张数。
const SCAN_TTL_MS = 6 * 60 * 60 * 1000   // v47：扫描结果常驻 6 小时（过期自动重扫）
let wpScanCache = { key: '', at: 0, val: null }   // ponytail: 进程内单槽；要每个文件夹各自 TTL 再说

// 文件夹集合指纹：顺序无关、斜杠/大小写无关
function wpScanKey(paths) {
  return (Array.isArray(paths) ? paths.filter(Boolean) : [])
    .map((p) => String(p).replace(/[\\/]+/g, '/').replace(/\/+$/, '').toLowerCase())
    .sort().join('|')
}

// 常驻库读取：内存 → 落盘。key 不一致（文件夹改过）或过期（TTL）就算没有。
function wpCachedLibrary(paths) {
  const key = wpScanKey(paths)
  const now = Date.now()
  if (wpScanCache.val && wpScanCache.key === key && (now - wpScanCache.at) < SCAN_TTL_MS) {
    return wpScanCache.val.files
  }
  const disk = libCacheIO.get()
  if (!disk || !Array.isArray(disk.files) || disk.files.length === 0) return []
  if (disk.key !== key || !(now - disk.at < SCAN_TTL_MS)) return []
  wpScanCache = { key, at: disk.at, val: { files: disk.files, per: [] } }
  console.error('[wallpaper][diag] lib-cache hit disk files=' + disk.files.length)
  return disk.files
}

async function scanImageFolders(paths, force) {
  const list = Array.isArray(paths) ? paths.filter(Boolean) : []
  const key = wpScanKey(list)
  // v47：换图 / 轮换 / 面板共用同一份扫描结果，不再每次重扫（上百张壁纸深扫一次不便宜）。
  // force=true 绕过缓存 —— 点「重新扫描」、刚改过文件夹时用。
  if (!force) {
    const files = wpCachedLibrary(list)
    if (files.length > 0) return { files, per: (wpScanCache.val && wpScanCache.val.per) || [] }
  }
  // 评审：per 必须与 list 同序 —— 在并发回调里 push 得到的是「完成顺序」，
  // 面板的逐目录张数会错位（哪个目录是 ⚠0 也看不出）
  const lists = await Promise.all(list.map((p) => listImagesInFolder(p)))
  const per = list.map((p, i) => ({ path: p, count: lists[i].length }))
  const val = { files: wpMergeImageLists(lists), per }
  wpScanCache = { key, at: Date.now(), val }
  if (val.files.length > 0) libCacheIO.set({ key, at: wpScanCache.at, files: val.files })
  return val
}

async function listImagesInFolders(paths) {
  const r = await scanImageFolders(paths)
  return wpDropHidden(r.files)   // v40：软隐藏的壁纸不进轮换池
}

// v41：探测本机 Steam 创意工坊壁纸库。候选并行试探，返回第一个「至少含一个子目录」的命中项。
// v45：本机有两个 Steam 库（E: 44 个 / F: 121 个）——「只取第一个命中」会整个漏掉 F:，
// 改成返回全部命中，由调用方逐个挂载。
async function wpDetectSteamLibraries() {
  const hd = window.hermesDesktop
  if (!hd || typeof hd.readDir !== 'function') return []
  const hits = await Promise.all(WP_STEAM_CANDIDATES.map(async (p) => {
    try {
      const res = await withTimeout(hd.readDir(p), 3000, 'readDir')
      const subs = (Array.isArray(res && res.entries) ? res.entries : []).filter((e) => e.isDirectory)
      return subs.length > 0 ? { path: p, count: subs.length } : null
    } catch (e) { return null }
  }))
  return hits.filter(Boolean)
}

async function wpDetectSteamLibrary() {
  const found = (await wpDetectSteamLibraries())[0]
  console.error('[wallpaper][diag] steam-detect ' + (found ? found.path + '(' + found.count + ')' : 'none'))
  return found ? found.path : null
}

// v41：把 Steam 壁纸库挂进 folders（首次启动做一次，标记 steamSeeded；用户删掉后不再回填，
// 想加回来点面板「Steam 壁纸库」按钮 = force）。已存在/已满同样记标记，避免每次启动重试。
async function wpEnsureSteamLibrary(force) {
  const cfg = $cfg && typeof $cfg.get === 'function' ? $cfg.get() : null
  if (!cfg) return null
  // v45：闸门换成 steamSeededV45 —— 旧版本只挂过第一个库的人会再补种一次，
  // 把其余 Steam 库也挂上；之后再手动删掉就真的不回了。
  if (cfg.steamSeededV45 && !force) return null
  const dirs = await wpDetectSteamLibraries()
  if (!dirs.length) {
    if (force) return { ok: false, error: '没找到 Steam 创意工坊壁纸库（候选路径都不存在）' }
    return null
  }
  let folders = wpNormalizeFolders(cfg.folders)
  let added = 0
  for (const d of dirs) {
    const r = wpAddFolder(folders, d.path)
    if (r.ok) { folders = r.folders; added++ }
  }
  const next = { ...cfg, folders, steamSeeded: true, steamSeededV45: true }
  $cfg.set(next)
  ctxStorageSet(next)
  console.error('[wallpaper][diag] steam-library added=' + added + '/' + dirs.length + ' ' +
    dirs.map((d) => d.path + '(' + d.count + ')').join(' | '))
  if (added && next.enabled && !cfg.imagePath) {
    try { applyWallpaper(next) } catch (e) { console.error('[wallpaper] steam apply ERROR', e.message) }
  }
  return { ok: added > 0, path: dirs[0].path, error: added ? undefined : '全部已在列表里' }
}

// v40：软隐藏（对齐 dsh「隐藏 / 恢复」）——只在池与库里剔除，不碰源文件
function wpHiddenSet() {
  let cfg = null
  try { cfg = ($cfg && typeof $cfg.get === 'function') ? $cfg.get() : null } catch (e) { cfg = null }
  if (!cfg) cfg = wpCfgCache
  const list = (cfg && Array.isArray(cfg.hidden)) ? cfg.hidden : []
  return new Set(list.filter(Boolean).map(normPath))
}

function wpDropHidden(list) {
  const hid = wpHiddenSet()
  if (!hid.size) return list
  return (Array.isArray(list) ? list : []).filter((p) => !hid.has(normPath(p)))
}

// 面板用：算出隐藏后的新列表（hide=true 追加 / false 移除）
function wpNextHidden(cfg, p, hide) {
  const cur = (cfg && Array.isArray(cfg.hidden)) ? cfg.hidden : []
  const key = normPath(p)
  const next = cur.filter((x) => normPath(x) !== key)
  if (hide) next.push(p)
  return next
}

// v27.3: 排除当前壁纸——原地改名加 _excluded_ 前缀。bridge renamePath 只能
// 同目录改名，无法跨目录移动，故用「改名前缀 + 扫描过滤」实现等效移出。
// 文件留在原目录，用户可手动改回原名恢复。
async function excludeCurrentWallpaper() {
  const hd = window.hermesDesktop
  if (!hd || typeof hd.renamePath !== 'function') return { ok: false, error: '当前环境不支持文件改名' }
  const cur = currentImagePath()
  if (!cur) return { ok: false, error: '无当前壁纸' }
  if (/^https?:\/\//i.test(cur)) return { ok: false, error: '远程壁纸无法改名' }
  const base = cur.split(/[\\/]/).pop()
  if (!base) return { ok: false, error: '无法解析文件名' }
  if (base.startsWith(EXCLUDED_PREFIX)) return { ok: false, error: '该壁纸已被排除' }
  const newName = EXCLUDED_PREFIX + base
  try {
    await hd.renamePath(cur, newName)
    // v35：账本与配置字段跟上新文件名（改名后 DOM 的 src 仍是旧路径）；评审 finding 4
    const newPath = cur.slice(0, cur.length - base.length) + newName
    const st = getRotatorState()
    st.currentPath = wpLedgerAfterRename(st.currentPath, cur, newPath)
    const next = wpRepointConfig($cfg ? $cfg.get() : null, cur, newPath)
    if (next) { $cfg.set(next); ctxStorageSet(next) }
    console.error('[wallpaper][diag] excluded current → ' + newName)
    return { ok: true, newName }
  } catch (e) {
    console.error('[wallpaper] exclude FAIL', e.message)
    return { ok: false, error: e.message }
  }
}

// v35 like：把当前展示图原地改名加/去 _liked_ 前缀（可逆、不移动目录、仍留在轮换池）。
// 不改 DOM 的 src —— 改 src 会重新读盘 + 解码整张图（实测 0.5-4.5s 主线程停顿），
// 只改「路径账本」；账本让第二次按键（取消标记）和锁定钉图都拿到正确的新名字。
let likeInFlight = false

async function toggleLikeCurrent() {
  if (likeInFlight) return { ok: false, error: '正在标记，请稍候' }
  const hd = window.hermesDesktop
  if (!hd || typeof hd.renamePath !== 'function') return { ok: false, error: '当前环境不支持文件改名' }
  const cur = currentImagePath()
  const plan = wpLikePlan(cur)
  console.error('[wallpaper][diag] like plan action=' + (plan.ok ? plan.action : 'reject')
    + ' path=' + String(cur).slice(-40) + (plan.ok ? '' : ' err=' + plan.error))
  if (!plan.ok) return plan
  likeInFlight = true
  try {
    // 在飞门必须带超时：renamePath 的 IPC 万一不返回，门就会永久卡死（v28 的门锁教训）。
    // 6s 与本文件既有门锁上限（SWAP_LOCK_MAX_MS）同量级，同盘改名的正常耗时是毫秒级。
    await withTimeout(hd.renamePath(cur, plan.newName), 6000, 'renamePath')
  } catch (e) {
    console.error('[wallpaper] like FAIL', e.message)
    // 超时 ≠ 改名没发生（IPC 可能只是回得晚，文件其实已经改好）：不许谎报「失败」，也不许
    // 按「没改成」去写账本/配置把状态搞分叉（评审 finding 3），交回一句能自查的话
    if (/超时/.test(String(e && e.message))) {
      return { ok: false, unknown: true, error: '改名超时，结果未知（文件可能已改好，请看下文件名）' }
    }
    return { ok: false, error: e.message }
  } finally {
    likeInFlight = false
  }
  // 账本按「只要没人写过更新的那张就对齐新名字」写（见 wpLedgerAfterRename）
  const st = getRotatorState()
  st.currentPath = wpLedgerAfterRename(st.currentPath, cur, plan.newPath)
  // 配置里所有指向旧路径的字段一起对齐：单图 imagePath（漏了 → 重启后 probe 旧名失败，
  // 壁纸和整套配色一起消失）、锁定 lockedPath（漏了 → 重启后钉不住那张）
  const next = wpRepointConfig($cfg ? $cfg.get() : null, cur, plan.newPath)
  if (next) {
    $cfg.set(next)          // 更新 atom（面板即时反映）
    ctxStorageSet(next)     // 显式落盘（见 initStore 注释：不把持久化只押在 atom 的 listen 上）
  }
  console.error('[wallpaper][diag] like done action=' + plan.action + ' → ' + plan.newName
    + ' tracked=' + String(st.currentPath).slice(-40) + ' cfgRepointed=' + !!next)
  return { ok: true, action: plan.action, newName: plan.newName, newPath: plan.newPath }
}

// 三个入口（面板按钮 / 命令面板 / 快捷键）共用一条动作 + 一份反馈
async function likeCurrentWithFeedback() {
  const r = await toggleLikeCurrent()
  const msg = r.ok
    ? (r.action === 'like' ? '已标记：' : '已取消标记：') + r.newName
    : (r.unknown ? r.error : '标记失败：' + (r.error || '未知错误'))
  try { host.notify({ kind: r.ok ? 'info' : 'error', durationMs: 3000, message: msg }) } catch {}
  return { ...r, msg }
}

// 当前展示图的绝对路径（v35：先读图层账本 —— 改名（like/排除）后 DOM 的 src 仍指向
// 旧路径，只有账本知道新名字；账本为空时回落到从可见层 src 还原）
function currentImagePath() {
  const st = getRotatorState()
  if (st.currentPath) return st.currentPath
  const el = currentLayerEl()
  if (!el || !el.src) return ''
  try {
    const u = new URL(el.src)
    if (u.protocol === 'file:') {
      return decodeURIComponent(u.pathname.replace(/^\/+/, ''))
    }
  } catch {}
  return el.src
}

// v33 锁定：把「当前实际显示的那张」钉进配置。锁定态下重启/改图源后仍显示它，
// 而不是重新随机抽一张。只在值真的变化时写一次 storage（其余情况零开销）。
function pinLockedPath(path) {
  if (!path) return
  const cfg = $cfg ? $cfg.get() : null
  if (!cfg || !cfg.locked) return
  if (normPath(cfg.lockedPath || '') === normPath(path)) return
  const next = { ...cfg, lockedPath: path }
  $cfg.set(next)          // 更新 atom（设置面板即时反映）
  ctxStorageSet(next)     // 显式落盘：不把持久化只押在 atom 的 listen 上（见 initStore 注释）
  console.error('[wallpaper][diag] lock pin path=' + String(path).slice(-40))
}

// Fisher-Yates 洗牌（返回新数组，不改原数组）
function shuffleArray(arr) {
  const a = arr.slice()
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    const t = a[i]; a[i] = a[j]; a[j] = t
  }
  return a
}

// 构建洗牌队列：打乱全部图，当前图（若在池内）移到末尾——
// 一轮里每张恰好一次，且当前图不立即重复（等整轮播完才再次出现）。
function buildShuffleQueue(list, current) {
  const cur = normPath(current)
  const idx = cur ? list.findIndex((p) => normPath(p) === cur) : -1
  const rest = idx >= 0 ? list.filter((_, i) => i !== idx) : list.slice()
  const q = shuffleArray(rest)
  if (idx >= 0) q.push(list[idx])
  return q
}

// 池中选下一张（顺序：指针推进；随机：避免与当前重复；洗牌：队列各一次）
function pickNext(list, current, order) {
  if (list.length === 0) return ''
  if (list.length === 1) return list[0]
  if (order === 'seq') {
    const state = getRotatorState()
    state.seqIdx = (state.seqIdx + 1) % list.length
    return list[state.seqIdx]
  }
  if (order === 'shuffle') {
    const state = getRotatorState()
    // 自适应删除：剔除队列里已不在当前文件夹的图（用户删图后不卡住）
    const valid = new Set(list.map((p) => normPath(p)))
    state.shuffleQueue = state.shuffleQueue.filter((p) => valid.has(normPath(p)))
    // 队列空 → 用最新 list 重洗（新增图自动纳入下一轮）
    if (state.shuffleQueue.length === 0) {
      state.shuffleQueue = buildShuffleQueue(list, current)
    }
    return state.shuffleQueue.shift()
  }
  const cur = normPath(current)
  const pool = cur ? list.filter((p) => normPath(p) !== cur) : list
  return pool[Math.floor(Math.random() * pool.length)]
}

// 首次加载选图（seq：指针指向当前/首张；random：随机一张；shuffle：预生成队列）
function pickFirst(list, order, current) {
  if (list.length === 0) return ''
  if (order === 'seq') {
    const state = getRotatorState()
    const start = current ? list.findIndex((p) => normPath(p) === normPath(current)) : 0
    state.seqIdx = start >= 0 ? start : 0
    return list[state.seqIdx]
  }
  if (order === 'shuffle') {
    const state = getRotatorState()
    // 预生成一轮队列；当前图在池内则保留首帧（不闪），队列中它已被移到末尾
    state.shuffleQueue = buildShuffleQueue(list, current)
    const keepCurrent = current && list.some((p) => normPath(p) === normPath(current))
    if (keepCurrent) return current
    return state.shuffleQueue.length ? state.shuffleQueue.shift() : (list[0] || '')
  }
  return current && list.some((p) => normPath(p) === normPath(current))
    ? current
    : list[Math.floor(Math.random() * list.length)]
}

// 壁纸切换动画：双槽 <img> 交叉过渡（新层插在 dim 之前，垫层顺序不变）
// v27: 壁纸就位反馈——全屏细金框闪现 0.55s（瞬态完成反馈；
// 状态栏 chip 是 React 组件无稳定 class 锚点，故用位置无关的全屏框）。
function wpSwapFlash() {
  try {
    const flash = document.createElement('div')
    flash.className = 'wp-swap-flash'
    flash.style.cssText =
      'position: fixed; inset: 0; z-index: 3; pointer-events: none;' +
      'border: 1px solid rgba(201, 160, 92, 0.85);' +
      'box-shadow: inset 0 0 26px rgba(201, 160, 92, 0.16);'
    document.body.appendChild(flash)
    setTimeout(() => flash.remove(), 750)
  } catch (e) { /* 光效失败不影响轮换 */ }
}

// 换图收尾：令牌仍是当前令牌才允许动图层（I3）；落定后删掉其它所有层（I2）
function finishSwapTimer(st, token, slot, url, el) {
  if (!wpFinishSwap(st, token, urlToPath(url))) {
    // 已被更新的请求取代：它的层已由「快速前进」路径落定，这里绝不许再碰图层
    console.error('[wallpaper][diag] swap superseded token=' + token + ' cur=' + st.token)
    return
  }
  // v37 审查闭环（§3）：用「我建的那一层」落定，而不是 getElementById（多实例时会拿到别人的层）
  settleLayerEl(el || document.getElementById(bgSlotId(slot)), slot)
  removeOtherLayers(slot)
  wpSwapFlash()
  logLayerCensus('ok')
  console.error('[wallpaper][diag] swap done token=' + token + ' slot=' + slot
    + ' url=' + String(url).slice(-40))
  // v37：换图路径此前**没有任何复核**（3s-check 只挂在 injectWallpaper 上）→ 换图把
  // 屏幕清空时插件无感、无日志。这里补一条同口径的复核。
  setTimeout(() => {
    const el = currentLayerEl()
    if (el && el.tagName === 'VIDEO') { el.play().catch(() => {}) }
    console.error('[wallpaper][diag] 3s-check[swap] ' + (el
      ? (el.tagName === 'VIDEO' ? 'video.readyState=' + el.readyState : 'img.complete=' + el.complete) + ' id=' + el.id
      : 'bg element MISSING'))
  }, 3000)
}

// 换一张壁纸：固定双槽交叉淡化。
// 关键保证：① 任意时刻最多两层（I2）；② 被取代的层立刻落定，绝不留半透明残层；
//           ③ 迟到的定时器永远改不了别人的图层（I3）；④ 每次点击都有可见结果。
function swapToImage(url, cfg) {
  const st = getRotatorState()
  const oldEl = currentLayerEl()
  console.error('[wallpaper][diag] swap anim style=' + cfg.animStyle + ' ms=' + cfg.animMs
    + ' hasOld=' + !!oldEl + ' url=' + String(url).slice(0, 80))
  if (!oldEl) {
    // 没有可见层（首帧/被清干净）→ 直接注入，不起动画
    injectWallpaper({ ...cfg, imagePath: urlToPath(url) })
    return
  }

  // ① 开新请求；若已有飞行中的层，立刻把它落定成可见层（连点快速前进）
  const { token, slot, cancel } = wpBeginSwap(st, Date.now())
  if (cancel) {
    const cancelledEl = cancel.el || document.getElementById(bgSlotId(cancel.slot))
    // v37 审查闭环（§3）：快速前进也只落定自己的层（或 v37 之前留下的无标记残留）
    const cancelledOwner = cancelledEl && cancelledEl.dataset ? cancelledEl.dataset.wpOwner : ''
    if (!cancelledOwner || cancelledOwner === INSTANCE_ID) settleLayerEl(cancelledEl, cancel.slot)
    // v35：快速前进 = 屏幕上换成这张，账本必须跟着换（否则 like 会去改上一张的文件）。
    // 只认飞行层自己的 src：反查出来的元素可能是同 id 残留层或上一张（src 是改名前的旧名），
    // 把那种陈旧路径写进账本会让下一次 like 报 ENOENT（评审 finding 2）。
    wpFastForward(st, cancel.el && cancel.el.src ? urlToPath(cancel.el.src) : '')
    console.error('[wallpaper][diag] swap fast-forward prev=' + cancel.token + ' slot=' + cancel.slot)
  }

  // ② 目标槽先清干净（防历史残层占位导致两层同 id）—— 同样只清自己的/孤儿的
  removeOwnedById(bgSlotId(slot))

  const el = makeLayerEl(slot, isVideoPath(url), isWebPath(url))
  el.src = url
  if (el.tagName === 'VIDEO') { el.play().catch(() => {}) }
  st.pendingEl = el
  el.onerror = () => {
    console.error('[wallpaper] swap img onerror, rollback', url)
    el.remove()
    if (wpAbortSwap(st, token)) console.error('[wallpaper][diag] swap aborted token=' + token)
  }
  const dimEl = document.getElementById('hermes-wallpaper-dim')
  if (dimEl) document.body.insertBefore(el, dimEl)
  else document.body.appendChild(el)

  const style = cfg.animStyle
  const ms = Math.max(0, Math.min(5000, Number(cfg.animMs) || 0))
  if (style === 'fade-zoom') el.style.transform = 'scale(1.07)'
  if (style === 'blur') el.style.filter = 'blur(30px) brightness(var(--wp-brightness, 0.6))'
  void el.offsetWidth   // 强制 reflow，保证初始态已提交，过渡才会跑
  const trans = style === 'fade-zoom'
    ? 'opacity ' + ms + 'ms ease, transform ' + ms + 'ms ease-out'
    : style === 'blur'
      ? 'opacity ' + ms + 'ms ease, filter ' + ms + 'ms ease'
      : 'opacity ' + ms + 'ms ease'
  el.style.transition = trans
  el.style.opacity = '1'
  if (style === 'fade-zoom') el.style.transform = 'scale(1)'
  if (style === 'blur') {
    el.style.filter = 'blur(var(--wp-blur, 4px)) brightness(var(--wp-brightness, 0.6))'
  }

  const wait = (style === 'none' || ms === 0) ? 0 : ms + 80
  console.error('[wallpaper][diag] swap start token=' + token + ' slot=' + slot
    + ' wait=' + wait + ' url=' + String(url).slice(-40))
  setTimeout(() => finishSwapTimer(st, token, slot, url, el), wait)
}

// file:// URL → 本地路径（供回写 imagePath 用；http 原样）
function urlToPath(url) {
  try {
    const u = new URL(url)
    if (u.protocol === 'file:') return decodeURIComponent(u.pathname.replace(/^\/+/, ''))
  } catch {}
  return url
}

// v28：配置一律现读 $cfg —— 旧实现把 cfg 闭包进 timer，改设置后旧值会一直生效
function scheduleNext() {
  const state = getRotatorState()
  if (!state.active || state.owner !== ROTATOR_OWNER) return
  const cfg = $cfg ? $cfg.get() : null
  // 手动换图模式（rotate=false）不排定时器；v33：锁定态一律不排（与 rotate 是否勾选无关）
  if (!cfg || !wpAutoRotateAllowed(cfg)) {
    // 锁定/关轮换 = 连已排的那一次也不留（直接改 storage 之类的旁路也在这里被收口）
    if (state.timer) { clearTimeout(state.timer); state.timer = null }
    if (cfg && cfg.locked) console.error('[wallpaper][diag] scheduleNext blocked locked=true')
    return
  }
  if (state.timer) clearTimeout(state.timer)
  const mins = Math.max(1, Math.min(240, Number(cfg.intervalMin) || 1))
  const generation = state.generation
  state.timer = setTimeout(() => {
    const current = getRotatorState()
    if (current.owner === ROTATOR_OWNER && current.generation === generation) rotateOnce($cfg.get())
  }, mins * 60000)
}

function stopRotator() {
  const state = getRotatorState()
  if (state.owner !== ROTATOR_OWNER) return
  state.active = false
  state.generation++
  if (state.timer) { clearTimeout(state.timer); state.timer = null }
  if (state.queueTimer) { clearTimeout(state.queueTimer); state.queueTimer = null }
}

// 轮换/换图一次：重扫目录 → 选下一张 → 预加载 → 双槽淡化
// v28: manual=true 时不受 cfg.rotate 约束 —— 手动换图与自动轮换彻底解耦
//      （旧实现 rotate=false 时「换一张」静默什么都不做 = 手动切换被阻塞）
async function rotateOnce(cfg, opts = {}) {
  const manual = !!opts.manual
  const state = getRotatorState()
  const now = Date.now()
  // 评审 F1：记下配置代数。await 期间任何配置变更（关壁纸/换图源/清图层）都会
  // 自增 generation（stopRotator/cleanupLayers），续体据此作废，避免过期结果落定。
  const gen = state.generation

  if (state.owner !== ROTATOR_OWNER) {
    console.error('[wallpaper][diag] rotate skipped owner=false manual=' + manual)
    return
  }
  const activeFolders = wpActiveFolders(cfg)
  if (!cfg.enabled || activeFolders.length === 0) {
    // 早退发生在 try 之外 → 到不了 finally 里的 scheduleNext()。必须显式停掉轮换：
    // 否则 state.active 仍为 true、$status 不变，定时器链静默断掉且不可自愈（评审 F11）
    console.error('[wallpaper][diag] rotate skipped enabled=' + cfg.enabled
      + ' folders=' + activeFolders.length + ' manual=' + manual)
    stopRotator()
    return
  }
  if (!manual && !wpAutoRotateAllowed(cfg)) return   // 自动轮换关闭/已锁定 → 定时器不该走到这

  // 选图阶段重入保护。卡死超过 SWAP_PICK_MAX_MS 视为失效并强制复位，
  // 否则 readDir/probe 永不返回会让「换一张」永久静默失效。
  // 复位走 wpForceEndPick（作废旧 pickId），最后来的选图才持有门（评审 F2）。
  if (state.picking) {
    if (wpPickStale(state, now)) {
      console.error('[wallpaper][diag] picking force-reset stuck=' + (now - state.pickingAt) + 'ms')
      wpForceEndPick(state)
    } else {
      console.error('[wallpaper][diag] rotate skipped (picking) manual=' + manual)
      return
    }
  }
  const pickId = wpStartPick(state, now)

  try {
    const list = await listImagesInFolders(activeFolders)
    if (list.length === 0) {
      state.fails++
      console.error('[wallpaper] folders empty:', activeFolders.join(' | '))
      $status?.set('error')
      if (manual) {
        host.notify({ kind: 'error', durationMs: 3000, message: '换图失败：已启用的文件夹里没有可用图片' })
      }
      if (state.fails >= ROTATOR_MAX_FAILS) stopRotator()
      return
    }
    state.fails = 0
    const current = currentImagePath()
    const nextPath = pickNext(list, current, cfg.order)
    console.error('[wallpaper][diag] rotate pick manual=' + manual + ' n=' + list.length
      + ' next=' + String(nextPath).slice(-40))
    const url = pathToFileUrl(nextPath)
    await probeImage(url)
    // 评审 F1：await 结束后必须重新校验「配置代数 + 当前配置」，否则关掉壁纸/
    // 换图源之后，过期续体会把旧图（甚至整站壁纸）重新注回屏幕。
    const after = getRotatorState()
    if (after.owner !== ROTATOR_OWNER || after.generation !== gen) {
      console.error('[wallpaper][diag] rotate aborted (stale gen=' + gen
        + ' now=' + after.generation + ') manual=' + manual)
      return
    }
    const live = $cfg ? $cfg.get() : cfg
    if (!live.enabled || wpActiveFolders(live).length === 0) {
      console.error('[wallpaper][diag] rotate aborted (config changed) manual=' + manual)
      return
    }
    // 复核 N4：图源本身换掉时（去抖 250ms + applyWallpaper 自身的 await 窗口）也要作废——
    // 否则用旧目录选出的图会盖住新图源
    if (wpFolderSignature(live) !== wpFolderSignature(cfg)) {
      console.error('[wallpaper][diag] rotate aborted (folder changed) manual=' + manual)
      return
    }
    swapToImage(url, live)   // 用最新配置（动画风格/时长可能刚被改过）
    pinLockedPath(nextPath)  // v33：锁定态手动换图后，钉住的图跟着走（非锁定 = 空操作）
    $status?.set('applied')
    $lastSwap?.set({ time: Date.now(), name: nextPath.split(/[\\/]/).pop() })
  } catch (err) {
    state.fails++
    console.error('[wallpaper] rotate FAIL', err.message)
    if (manual) {
      host.notify({ kind: 'error', durationMs: 3000, message: '换图失败：' + err.message })
    }
    if (state.fails >= ROTATOR_MAX_FAILS) {
      stopRotator()
      $status?.set('error')
    }
  } finally {
    wpEndPick(state, pickId)   // 只有本次选图仍持有门时才复位（评审 F2）
    scheduleNext()
  }
}

function startRotator() {
  const state = getRotatorState()
  if (state.timer) clearTimeout(state.timer)
  state.owner = ROTATOR_OWNER
  state.active = true
  state.generation++
  scheduleNext()
}

// 手动「换一张」入口：连点去抖（最后一次生效）+ 门锁自愈 + 确保轮换态接管
// v28: 与 rotate 开关无关 —— 只要设了壁纸文件夹就能手动换图
function requestSwap() {
  const cfg = $cfg ? $cfg.get() : null
  if (!cfg) return
  if (!cfg.enabled) {
    console.error('[wallpaper][diag] requestSwap ignored (disabled)')
    host.notify({ kind: 'error', durationMs: 3000, message: '壁纸未启用：请先在壁纸设置里勾选「启用图片背景」' })
    return
  }
  if (wpActiveFolders(cfg).length === 0) {
    console.error('[wallpaper][diag] requestSwap ignored (no active folder)')
    host.notify({ kind: 'error', durationMs: 3000, message: '手动换图需要先添加并启用至少一个「壁纸文件夹」' })
    return
  }
  const state = getRotatorState()
  const now = Date.now()
  if (wpShouldForceUnlock(state, now)) {
    console.error('[wallpaper][diag] swap lock force-unlock stuck=' + (now - state.startedAt) + 'ms')
    wpTakeInflight(state)
  }
  if (!state.active || state.owner !== ROTATOR_OWNER) startRotator()
  // 去抖：连点合并成一次（150ms 内的最后一次生效），避免叠出多层动画
  if (state.queueTimer) clearTimeout(state.queueTimer)
  console.error('[wallpaper][diag] requestSwap armed (token=' + state.token
    + ' picking=' + state.picking + ' gen=' + state.generation + ' locked=' + !!cfg.locked + ')')
  state.queueTimer = setTimeout(() => {
    state.queueTimer = null
    console.error('[wallpaper][diag] requestSwap fire')
    rotateOnce($cfg.get(), { manual: true })
  }, 150)
}

// 显式应用（用户操作时调用）：探测图片 → 成功注入 / 失败回退
async function applyWallpaper(cfg) {
  if (typeof document === 'undefined') return
  // 先记录当前图（cleanup 会删除图层，之后无法还原）
  // v33：锁定态把「钉住的那张」当作当前图 —— pickFirst() 会优先保留它（重启后仍是同一张）
  const current = currentImagePath() || (cfg.locked && cfg.lockedPath ? cfg.lockedPath : '')
  if (cfg.locked) console.error('[wallpaper][diag] locked apply pin=' + String(current).slice(-40))

  // v36：图源由「有没有启用的文件夹」决定（不再要求 rotate 同时开启）。旧行为：只设文件夹、
  // 关掉定时轮换 → 这里直接 return，而 cleanupLayers 已经跑过 → 壁纸与全部黑金 CSS
  // 一起消失、手动换图按钮也消失（用户报告的「手动切换阻塞」）。
  // 另外 cleanup 不再放在 await 之前——否则探测期间壁纸整个消失（闪黑）。
  const folders = wpActiveFolders(cfg)
  const folderMode = folders.length > 0
  const sourceState = wpFolderSourceState(cfg)
  // v36 评审 F4：有 folders 但**全部停用** = 「暂停轮换」，不是「关掉壁纸」。
  // 下面那个 idle 分支会 cleanupLayers()，把整站壁纸和配置好的配色一起抹掉、titlebar 复位
  // （用户会当成 bug：勾掉最后一个勾，主题没了）。屏幕上有图就留着，只停轮换。
  // 注：重启后内存里那张图没了（没有图层）→ 不满足条件，按既有的「无图源」处理（评审 D2）。
  if (cfg.enabled && sourceState === 'paused' && currentImagePath()) {
    stopRotator()
    $status?.set('applied')
    console.error('[wallpaper][diag] v36 pause: 0 active folders, keep current image')
    return
  }
  if (!cfg.enabled || (!cfg.imagePath && !folderMode)) {
    stopRotator()
    cleanupLayers()
    // v37（审查 M2）：只有「用户显式关掉壁纸」才撤配色。enabled 但无图源（暂停态/图被删光）
    // 绝不能撤 —— 那正是用户眼里的「壁纸+配色整体消失」（声明见文件头与 initStore 的注释）。
    if (!cfg.enabled) removeWallpaperCss()
    $status?.set('idle')
    // 壁纸关闭时：原生 titlebar 按钮恢复 Hermes 主题色（暖白）
    restoreTitleBarTheme()
    return
  }

  $status?.set('applying')

  try {
    // ① 先探测（文件夹模式：重扫目录 + 首张仍在池中则保留）
    let imagePath = ''
    if (folderMode) {
      const list = await listImagesInFolders(folders)
      if (list.length === 0) throw new Error('已启用的文件夹中没有图片: ' + folders.join(' | '))
      imagePath = pickFirst(list, cfg.order, current)
    } else {
      imagePath = cfg.imagePath
    }
    await probeImage(pathToFileUrl(imagePath))

    // ② 探测通过才清旧层并注入（失败时保持当前壁纸不动）
    stopRotator()
    cleanupLayers()
    injectWallpaper({ ...cfg, imagePath })
    pinLockedPath(imagePath)   // v33：锁定态钉住真正显示的那张（换文件夹/旧图被删时自动跟上）
    applyTitleBarTheme()
    startTitleBarAssert()
    startReviewBoxObserver()
    startEntranceObserver()
    $status?.set('applied')
    $lastSwap?.set({ time: Date.now(), name: imagePath.split(/[\\/]/).pop() })
    // 自动轮换只由 rotate 控制（手动换图不需要）
    if (folderMode) startRotator()
    // v26: 轮换模式也要 dump 配色（此前只有单图分支会 dump，轮换模式下全天零 dump）
    dumpTimer = setTimeout(() => { dumpTimer = null; dumpColorData() }, 4500)
  } catch (err) {
    $status?.set('error')
    // eslint-disable-next-line no-console
    console.error('[wallpaper]', err.message)
  }
}

// ── 原生 titlebar 按钮（Windows 关闭/最大化/最小化）──
// 这些是 Electron titleBarOverlay 原生渲染，CSS 碰不到；symbolColor 由
// hermes:titlebar-theme IPC 的 foreground 决定。壁纸开启时壁纸亮色透到
// titlebar 区域，暖白按钮看不见 → 改成深色；关闭时恢复 Hermes 主题色。
// v23: 用户要求图标纯白；Hermes 主题系统 applyTheme 也会调 setTitleBarTheme
// （foreground=c.foreground），可能在插件之后覆盖，所以加 MutationObserver
// 在主题重渲染后重新断言白色。
// v23b: 用户反馈纯白太突出 → 调低亮度，用柔和暖白 #ece6d8（呼应皮肤主文字）。
const TITLEBAR_ON = { background: '#0a182a', foreground: '#ece6d8' }

let titlebarAssertStarted = false

// 主题系统（applyTheme）会在皮肤/模式变化时再次调用 setTitleBarTheme 覆盖插件色。
// 监听 root 的 data-hermes-theme / data-hermes-mode 属性，变化后重新断言白色。
function startTitleBarAssert() {
  if (titlebarAssertStarted || typeof MutationObserver === 'undefined') return
  titlebarAssertStarted = true
  const root = document.documentElement
  const reapply = () => {
    // v37 泄漏自证：本实例已被卸载却还在跑观察者 → 打 LEAK（这就铁证）
    if (!wpIsLive(window, INSTANCE_ID)) {
      console.error('[wallpaper][diag] LEAK titlebar observer from disposed instance ' + INSTANCE_ID)
    }
    if ($cfg?.get()?.enabled) {
      // v37 自愈：修复前的实例（僵尸 blob）里还有按 id 全局删样式表的旧代码路径
      // （图片 onerror 回滚）。它们没法事后修，所以由活着的新实例兜住：主题每次重绘
      // （约 60s 一次）顺手确认一次「配色还在场」，被删了就补回来。
      // 归属判定保证不会去抢另一个活实例的样式表（见 ensureWallpaperCss）。
      ensureWallpaperCss()
      applyTitleBarTheme()
    }
  }
  const mo = new MutationObserver(() => reapply())
  mo.observe(root, { attributes: true, attributeFilter: ['data-hermes-theme', 'data-hermes-mode'] })
  // 兜底：延迟再断言一次（applyTheme 可能晚于插件注册）
  const t1 = setTimeout(reapply, 800)
  const t2 = setTimeout(reapply, 3000)
  titlebarDispose = () => {
    mo.disconnect()
    clearTimeout(t1)
    clearTimeout(t2)
    titlebarDispose = null
  }
}

// v26: core applyTheme 依赖网络扩大（registry/backend 皮肤推送即重绘，
// context.tsx L457-479），observer 触发频繁 → 日志节流：值与上次相同且
// 距上次 <60s 时不再重复打印（API 断言本身每次仍执行，防 core 覆盖）。
// v27: 节流状态挂 window 共享——热重载会累积多个旧 blob 实例（各自的
// 模块级变量互不相通），每实例每 60s 各打一条 titlebar 日志刷屏。
// 共享 window.__wpTitlebarThrottle 后，60s 窗口内只有最先通过的实例打一条。
function getTitlebarThrottle() {
  if (!window.__wpTitlebarThrottle) window.__wpTitlebarThrottle = { at: 0, fg: '' }
  return window.__wpTitlebarThrottle
}

function applyTitleBarTheme() {
  try {
    // preload 暴露的 API：window.hermesDesktop.setTitleBarTheme
    const bridge = window.hermesDesktop || window.desktop
    if (bridge && typeof bridge.setTitleBarTheme === 'function') {
      bridge.setTitleBarTheme(TITLEBAR_ON)
      const now = Date.now()
      const fg = getComputedStyle(document.documentElement).getPropertyValue('--theme-foreground').trim() || 'none'
      const t = getTitlebarThrottle()
      if (now - t.at > 60000 || fg !== t.fg) {
        t.at = now
        t.fg = fg
        console.error('[wallpaper][diag] titlebar theme applied', TITLEBAR_ON.foreground,
          'themeFg=' + fg)
      }
    } else {
      console.error('[wallpaper][diag] setTitleBarTheme API NOT available')
    }
  } catch (e) {
    console.error('[wallpaper][diag] titlebar theme ERROR', e.message)
  }
}

// v23d: 审查栏统一黑框——文件名行与 file-diff-panel 被中间层隔开（非相邻兄弟），
// 纯 CSS :has 无法精确选中共同父容器（会误伤 review 根容器）。用 JS 找到
// 「含文件名行的父容器 + 含 panel 的容器」的共同父级，加 hermes-review-box 标记，
// 由 CSS 把两块染成一个整体黑框。文件名行判定：文本含路径分隔符/扩展名，
// 排除 preview 面板的编辑按钮、工具卡 diff 等无文件名行的场景。
function unifyReviewBox() {
  if (typeof document === 'undefined') return
  document.querySelectorAll('#root [data-slot="file-diff-panel"]').forEach((panel) => {
    // v23d: 工具卡 diff（fallback.tsx 渲染）前一个兄弟常是 TerminalTranscript/图片，
    // 误标会把整卡染成深色框——跳过 tool-block 内实例
    if (panel.closest('[data-slot="tool-block"]')) return
    const holder = panel.parentElement
    const header = holder ? holder.previousElementSibling : null
    const box = holder ? holder.parentElement : null
    if (!box || box === document.body || !header || header.nodeType !== 1) return
    if (header.hasAttribute('data-slot')) return
    const t = (header.textContent || '').trim()
    if (t.length < 2 || !/[\/\\]|\.\w{1,8}\s*$/.test(t)) return
    box.classList.add('hermes-review-box')
  })
}

let reviewBoxObsStarted = false
let reviewBoxRaf = 0
let reviewBoxLastAt = 0
function scheduleReviewBox() {
  // v28.4：合并 + 节流——旧实现对每次 body 变更同步跑全文档查询
  //（流式对话期间每秒几十次）。review 框标记是幂等的，300ms 粒度完全够用。
  const now = Date.now()
  if (reviewBoxRaf) return
  const wait = Math.max(0, 300 - (now - reviewBoxLastAt))
  reviewBoxRaf = window.setTimeout(() => {
    reviewBoxRaf = 0
    reviewBoxLastAt = Date.now()
    const t0 = performance.now()
    unifyReviewBox()
  }, wait)
}

function startReviewBoxObserver() {
  if (reviewBoxObsStarted || typeof MutationObserver === 'undefined') return
  reviewBoxObsStarted = true
  // review 栏是动态挂载的（打开才渲染），监听 body 子树变化，发现 panel 即标记
  const mo = new MutationObserver(() => {
    if (!wpIsLive(window, INSTANCE_ID)) {
      console.error('[wallpaper][diag] LEAK review-box observer from disposed instance ' + INSTANCE_ID)
    }
    scheduleReviewBox()
  })
  mo.observe(document.body, { childList: true, subtree: true })
  const t = setTimeout(unifyReviewBox, 3500)
  reviewBoxDispose = () => {
    mo.disconnect()
    clearTimeout(t)
    if (reviewBoxRaf) { clearTimeout(reviewBoxRaf); reviewBoxRaf = 0 }
    reviewBoxDispose = null
  }
}

// ── v27 入场动画：给「新挂载」的消息/卡加一次性动画类 ──
// v27.1 修复历史误触发：Hermes thread 是虚拟化列表，「Show earlier」加载
// 历史往容器顶部 prepend，新消息往底部 append。用「批量阈值 + append 基线」
// 两信号区分：批量（历史翻页 / 会话切换整批重建）跳过；单个新增且位于
// 已知最后消息之后（append）才播。animationend 后移除类，重挂载不重播。
const WP_MSG = '.composer-human-message'
// v28.6：去掉 aui_assistant-message-root——流式期间该根节点会被 markdown 重渲染反复重建，
// 每次重建都重播一次 0.3s 入场动画（类名抖动 + animationend 监听器增删）。
// 代码卡 / 工具卡挂载一次即稳定，保留入场动画。
const WP_CARD = '[data-slot="code-card"], [data-slot="tool-block"]'
let entranceObsStarted = false
let lastSeenMsg = null // 已知消息里 DOM 顺序最后的节点（append/prepend 基线）

function startEntranceObserver() {
  if (entranceObsStarted || typeof MutationObserver === 'undefined') return
  entranceObsStarted = true
  // v37 审查闭环（L2）：句柄必须**在函数入口就存在**。原实现只在 attach() 成功里赋值，
  // 而失败路径排的 5s 重试定时器（entranceRetry）与它互斥 → 该定时器永远不会被清，
  // 5s 后死实例醒来还会新建一个永不断开的观察者。
  entranceDispose = () => {
    if (entranceMo) { entranceMo.disconnect(); entranceMo = null }
    if (entranceRetry) { clearTimeout(entranceRetry); entranceRetry = 0 }
    entranceDispose = null
  }
  const attach = () => {
    const el = document.querySelector('[data-slot="aui_thread-content"]')
    if (!el) return false
    // 基线：把当前容器里 DOM 顺序最后的消息节点记为 lastSeenMsg，
    // 此后只有 append 到它之后的新消息才播（已存在的历史不播）。
    let base = null
    el.querySelectorAll(WP_MSG + ', ' + WP_CARD).forEach((n) => {
      if (!base || (base.compareDocumentPosition(n) & Node.DOCUMENT_POSITION_FOLLOWING)) base = n
    })
    lastSeenMsg = base
    const mo = new MutationObserver((muts) => {
      if (!wpIsLive(window, INSTANCE_ID)) {
        console.error('[wallpaper][diag] LEAK entrance observer from disposed instance ' + INSTANCE_ID)
      }
      const added = new Map() // node -> kind，天然去重（嵌套 addedNode 会重复 querySelectorAll）
      muts.forEach((m) => {
        m.addedNodes.forEach((n) => {
          if (!n || n.nodeType !== 1) return
          if (n.matches && n.matches(WP_MSG)) {
            if (!added.has(n)) added.set(n, 'msg')
          } else if (n.querySelector) {
            const b = n.querySelector(WP_MSG)
            if (b && !added.has(b)) added.set(b, 'msg')
            n.querySelectorAll(WP_CARD).forEach((c) => { if (!added.has(c)) added.set(c, 'card') })
          }
        })
      })
      if (!added.size) return
      // 批量渲染（历史翻页 / 会话切换整批重建）→ 全部跳过，并把基线
      // 重置到本次新增的最后节点（后续 append 才能正确识别）。
      if (added.size > 6) {
        let last = null
        added.forEach((_kind, node) => {
          if (!last || (last.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING)) last = node
        })
        lastSeenMsg = last
        if (cfgDebug()) console.error('[wallpaper][diag] v27 entrance skipped bulk=' + added.size)
        return
      }
      let hit = 0
      added.forEach((kind, node) => {
        // append = 位于基线之后；prepend（历史）/ 会话切换（基线失效断开）
        // = 位于基线之前或不相连 → 跳过。
        const following = lastSeenMsg &&
          (lastSeenMsg.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING)
        const isAppend = !lastSeenMsg || !!following
        if (!lastSeenMsg || following) lastSeenMsg = node
        if (!isAppend) return
        const cls = kind === 'msg' ? 'wp-in-msg' : 'wp-in-card'
        if (node.classList.contains(cls)) return
        node.classList.add(cls); hit++
        node.addEventListener('animationend', function h() {
          node.classList.remove(cls)
          node.removeEventListener('animationend', h)
        })
      })
      if (hit > 0 && cfgDebug()) console.error('[wallpaper][diag] v27 entrance animated=' + hit)
    })
    mo.observe(el, { childList: true, subtree: true })
    entranceMo = mo
    return true
  }
  // thread 容器可能晚挂载：先试挂，失败则 5s 后兜底
  if (!attach()) entranceRetry = setTimeout(attach, 5000)
}

// v23c: 配色诊断 dump——遍历输出主题变量 + 各 data-slot 元素的
// 文字/背景/边框/阴影计算样式 + 父链背景（供配色审查子代理分析）。
// 输出拆块写日志（console.error），grep '[wallpaper][dump]' 提取。
function dumpColorData() {
  if (!cfgDebug()) return   // v28.4：诊断转储默认关闭（实测单次 ~0.5s 主线程阻塞 + ~100KB 日志）
  try {
    const root = document.documentElement
    const cs = getComputedStyle(root)
    const out = { vars: {}, slots: [], selection: null, total: 0 }
    const varNames = ['--theme-foreground','--theme-primary','--theme-secondary','--theme-accent-soft','--theme-midground','--theme-background-seed','--theme-sidebar-seed','--theme-card-seed','--theme-elevated-seed','--theme-bubble-seed','--ui-text-primary','--ui-text-secondary','--ui-text-tertiary','--ui-text-quaternary','--ui-base','--ui-ok','--ui-warn','--ui-error','--ui-accent','--ui-inline-code-foreground','--ui-diff-add-background','--ui-diff-add-foreground','--ui-diff-remove-background','--ui-diff-remove-foreground','--dt-primary-foreground','--dt-secondary-foreground','--dt-accent-foreground','--dt-border','--dt-muted','--dt-destructive','--dt-destructive-foreground','--dt-ring','--dt-accent','--dt-muted-foreground','--dt-composer-ring','--dt-input','--dt-scrollbar-thumb','--dt-primary-solid','--dt-primary-solid-foreground','--ui-success','--color-accent','--color-primary','--color-foreground','--color-background','--color-border','--color-ring']
    varNames.forEach(n => { const v = cs.getPropertyValue(n).trim(); if (v) out.vars[n] = v })
    const slots = document.querySelectorAll('#root [data-slot]')
    out.total = slots.length
    slots.forEach((el, i) => {
      if (i > 150) return
      const s = getComputedStyle(el)
      const r = el.getBoundingClientRect()
      let chain = []
      let p = el.parentElement
      for (let k = 0; k < 3 && p; k++) { chain.push(getComputedStyle(p).backgroundColor); p = p.parentElement }
      out.slots.push({
        slot: el.getAttribute('data-slot'),
        cls: String(el.className).slice(0, 40),
        color: s.color, bg: s.backgroundColor, border: s.borderTopColor,
        shadow: s.boxShadow.slice(0, 60), colorScheme: s.colorScheme,
        top: Math.round(r.top), h: Math.round(r.height), chain: chain
      })
    })
    const probe = document.createElement('span')
    probe.style.cssText = 'display:none'
    document.body.appendChild(probe)
    out.selection = {
      bg: getComputedStyle(probe, '::selection').backgroundColor,
      color: getComputedStyle(probe, '::selection').color
    }
    probe.remove()
    const slotsJson = JSON.stringify(out.slots)
    const CHUNK = 8000
    for (let i = 0; i < slotsJson.length; i += CHUNK) {
      console.error('[wallpaper][dump] slots[' + Math.floor(i / CHUNK) + '] ' + slotsJson.slice(i, i + CHUNK))
    }
    console.error('[wallpaper][dump] meta ' + JSON.stringify({ vars: out.vars, selection: out.selection, total: out.total }))
  } catch (e) {
    console.error('[wallpaper][dump] ERROR ' + e.message)
  }
}

function restoreTitleBarTheme() {
  try {
    const bridge = window.hermesDesktop || window.desktop
    if (bridge && typeof bridge.setTitleBarTheme === 'function') {
      // 传 null 会触发 main 的 isHexColor 校验失败 → 忽略，保持当前值。
      // 直接重置为 Hermes 的 azur-navy 主题 foreground。
      bridge.setTitleBarTheme({ background: '#16324a', foreground: '#cfc9ba' })
    }
  } catch (e) {
    console.error('[wallpaper][diag] titlebar restore ERROR', e.message)
  }
}

// ── 设置面板 ─────────────────────────────────────────────────────────────
function Slider({ label, value, min, max, step, fmt, onChange }) {
  return jsxs('label', {
    className: 'flex flex-col gap-1 text-xs',
    children: [
      jsx('span', { className: 'text-(--ui-text-secondary)', children: `${label}: ${fmt ? fmt(value) : value}` }),
      jsx('input', {
        type: 'range', min, max, step, value,
        className: 'w-full accent-(--ui-accent)',
        onInput: (e) => onChange(Number(e.target.value))
      })
    ]
  })
}

// v24：小选项按钮（选中 = 金底深字，未选中 = 透明描边）
function OptionBtn({ active, onClick, children }) {
  return jsx('button', {
    type: 'button',
    onClick,
    className: cn(
      'rounded border px-2 py-1 text-xs transition-colors',
      active
        ? 'border-(--ui-accent) bg-(--ui-accent) font-medium text-[#0a182a]'
        : 'border-(--ui-stroke-secondary) bg-transparent text-(--ui-text-secondary) hover:bg-(--chrome-action-hover) hover:text-(--ui-text-primary)'
    ),
    children
  })
}

// v24：动作按钮（浏览/扫描/换一张）
function ActionBtn({ onClick, disabled, children, ...rest }) {
  return jsx('button', {
    type: 'button',
    onClick,
    disabled,
    ...rest,
    className: cn(
      'rounded border px-2 py-1 text-xs transition-colors',
      disabled
        ? 'border-(--ui-stroke-secondary) text-(--ui-text-quaternary)'
        : 'border-(--ui-stroke-secondary) bg-transparent text-(--ui-text-secondary) hover:bg-(--chrome-action-hover) hover:text-(--ui-text-primary)'
    ),
    children
  })
}

function WallpaperSettings() {
  const cfg = useValue($cfg)
  const status = useValue($status)
  const lastSwap = useValue($lastSwap)
  const [pathDraft, setPathDraft] = useState(cfg.imagePath)
  const [scanInfo, setScanInfo] = useState('')
  const [scanning, setScanning] = useState(false)
  // v39 壁纸库：扫描结果留在面板里，网格浏览 + 点卡片即应用（对齐 dsh 壁纸仓库）
  // v47：库常驻 —— 面板一打开先拿上次的扫描结果，不再每次都要点「重新扫描」。
  // 文件夹集合变了则自动失效（指纹不匹配 → 空库）。
  const [lib, setLib] = useState(() => wpCachedLibrary(wpActiveFolders($cfg.get())))
  const [libQ, setLibQ] = useState('')
  const [libKind, setLibKind] = useState('all')
  const [libCur, setLibCur] = useState('')

  // v28：视觉参数（模糊/亮度/遮罩/底透明度）实时改 CSS 变量，不重建图层；
  //      计时类参数只动计时器；结构性参数（图源/动画）去抖 250ms 重建一次。
  //      旧实现：滑条每动一格 set() → applyWallpaper() → cleanupLayers + await，
  //      拖一次滑条触发 ~26 次「清空 → 等 → 重建」→ 闪黑 + 主线程打满。
  const VISUAL_KEYS = ['blur', 'brightness', 'dim', 'surfaceAlpha',
    'contrast', 'saturate', 'fit', 'videoSpeed']   // v40：新参数同样实时生效、不重建图层
  const TIMER_KEYS = ['rotate', 'intervalMin', 'order', 'locked']   // v33：锁定只动计时器，不重建图层
  const DIAG_KEYS = ['debugDump']   // v28.4：诊断开关不动图层
  const FOLDER_KEYS = ['folders']   // v36：改文件夹池不重建图层（评审 F9）

  // 显式应用：set 配置 + 持久化 + 应用壁纸（一次调用，无回环）
  const set = (patch) => {
    const next = { ...$cfg.get(), ...patch }
    // v33：勾选锁定时把「当前这张」钉住（每次勾选都重钉，重启后仍显示它）
    if (next.locked) next.lockedPath = wpPinOnLock(next, currentImagePath())
    $cfg.set(next)
    ctxStorageSet(next)
    const keys = Object.keys(patch)
    const st = getRotatorState()

    if (keys.length > 0 && keys.every((k) => VISUAL_KEYS.includes(k))) {
      applyVisualParams(next)
      console.error('[wallpaper][diag] applyVisual live ' + keys.join(','))
      return
    }

    if (keys.length > 0 && keys.every((k) => TIMER_KEYS.includes(k))) {
      // v33：锁定优先 —— 锁定态绝不 arm 定时器（并立刻清掉已有的那一次）
      // v36：图源 = 有启用的文件夹（不再是单一文件夹路径）
      if (next.rotate && wpActiveFolders(next).length > 0 && next.enabled && !next.locked) startRotator()
      else stopRotator()
      console.error('[wallpaper][diag] applyTimer rotate=' + !!next.rotate
        + ' interval=' + next.intervalMin + ' order=' + next.order + ' locked=' + !!next.locked)
      return
    }

    if (keys.length > 0 && keys.every((k) => DIAG_KEYS.includes(k))) {
      console.error('[wallpaper][diag] applyDiag debugDump=' + !!next.debugDump)
      return
    }

    if (keys.length > 0 && keys.every((k) => FOLDER_KEYS.includes(k))) {
      // v36 评审 F9：改文件夹池 ≠ 换图源，不重建图层（不闪、不重新解码那张 4K）。
      // 屏幕上有图且池子还在（含「全停用=暂停」）就保留当前画面、只调整轮换。
      const active = wpActiveFolders(next)
      const rows = wpNormalizeFolders(next.folders)
      stopRotator()
      if (rows.length === 0 || !currentLayerEl()) {
        // 池子被清空（删掉最后一本）= 图源换成单图/无源，必须走完整应用 ——
        // 否则画面会停在「来自已删除文件夹」的幽灵态（评审 D3）；
        // 而且必须走去抖路径：连点勾选时两次 applyWallpaper 并发，先发的旧快照会后落定，
        // 把已移除目录里的图注回屏幕并钉进 lockedPath（评审 D4）。
        if (st.applyTimer) clearTimeout(st.applyTimer)
        st.applyTimer = setTimeout(() => {
          st.applyTimer = null
          // v37 审查闭环（L5）：卸载后不得再用旧模块的 $cfg 重注壁纸
          if (!wpIsLive(window, INSTANCE_ID)) return
          applyWallpaper($cfg.get())
        }, 250)
      } else if (next.rotate && active.length > 0 && next.enabled && !next.locked) {
        startRotator()
      }
      // 评审 F5：锁定的图如果不在任何启用文件夹里，明确留一条日志（否则只有下一次换图才自愈）
      if (next.locked && next.lockedPath && !wpPathUnderFolders(next.lockedPath, active)) {
        console.error('[wallpaper][diag] lockedPath outside active folders: ' + String(next.lockedPath).slice(-60))
      }
      // 评审 D5：图源修好后清掉旧的 error 态，否则面板/chip 会一直显示「加载失败」
      if (active.length > 0 && $status && typeof $status.get === 'function' && $status.get() === 'error') {
        $status.set(currentLayerEl() ? 'applied' : 'applying')
      }
      console.error('[wallpaper][diag] applyFolders n=' + rows.length
        + ' active=' + active.length + ' source=' + wpFolderSourceState(next)
        + ' rotate=' + !!next.rotate + ' locked=' + !!next.locked)
      return
    }

    if (st.applyTimer) clearTimeout(st.applyTimer)
    st.applyTimer = setTimeout(() => {
      st.applyTimer = null
      applyWallpaper($cfg.get())
    }, 250)
  }

  // v28：图源 = 有没有文件夹（手动换图不再依赖 rotate），rotate 只控制自动轮换计时器
  const hasFolder = wpActiveFolders(cfg).length > 0
  const rotateOn = !!cfg.rotate && hasFolder && !cfg.locked   // v33：锁定 = 不轮换
  const lockedOn = !!cfg.locked && hasFolder                  // v33
  // v36 评审 F15：渲染与三个写操作共用同一份归一化结果 —— 「渲染归一化列表、handler 用原始下标」
  // 在原始数组含空行/重复项时会删错行
  const folderRows = wpNormalizeFolders(cfg.folders)
  const folderCount = folderRows.length
  const sourceState = wpFolderSourceState(cfg)
  // 暂停只在「屏幕上确实还留着那张图」时成立（评审 D2：重启后没图了就别再说 ⏸，
  // 否则面板说「已关闭」、chip 说「暂停」，两处自相矛盾）
  const foldersPaused = cfg.enabled && sourceState === 'paused' && status === 'applied'
  const foldersPausedNoImage = cfg.enabled && sourceState === 'paused' && status !== 'applied'

  // v36：扫描当前启用的文件夹 → 逐目录报张数（未启用的不扫，避免误以为「没图」）
  const scanAll = async (note) => {
    const paths = wpActiveFolders($cfg.get())
    if (paths.length === 0) { setLib([]); setScanInfo(folderCount > 0 ? '⏸ 未启用任何文件夹（轮换已暂停）' : ''); return 0 }
    setScanning(true)
    const { files, per } = await scanImageFolders(paths, true)   // v47：手动触发 = 真扫，绕过常驻缓存
    setScanning(false)
    setLib(files)
    if (files.length === 0) { setScanInfo('⚠ 已启用的文件夹里没有可用图片'); return 0 }
    // 逐目录报张数：带上目录名（评审 F7 —— 只报数字的话，哪个目录是 ⚠0 看不出来）
    const short = (p) => String(p).split(/[\\/]/).filter(Boolean).pop() || p
    const detail = per.map((x) => short(x.path) + ':' + (x.count > 0 ? x.count : '⚠0')).join(' + ')
    setScanInfo((note ? note + ' · ' : '') + `✅ ${per.length} 个文件夹 · ${detail} = ${files.length} 张`)
    return files.length
  }

  // v39：点壁纸库卡片 → 直接应用这张（先探测，失败只提示、不动当前壁纸）
  const applySpecific = async (p) => {
    const now = $cfg.get()
    const name = String(p).split(/[\\/]/).filter(Boolean).pop() || p
    const url = pathToFileUrl(p)
    try {
      await probeImage(url)
    } catch {
      setScanInfo('⚠ 无法加载：' + name)
      return
    }
    if (!now.enabled) set({ enabled: true })
    if (now.locked) set({ lockedPath: p })
    swapToImage(url, now)
    setLibCur(p)
    setScanInfo('✅ 已应用 · ' + name)
  }

  // v36：浏览选择文件夹（系统对话框，可多选一次加多个；超上限/重复的会被 wpAddFolders 挡下）
  // v41：一键挂载 Steam 壁纸库（探测 → 加入 folders → 立即重新扫描）
  const addSteamLibrary = async () => {
    if (scanning) return
    setScanInfo('正在探测 Steam 壁纸库…')
    const r = await wpEnsureSteamLibrary(true)
    if (!r) { setScanInfo('探测失败：插件未就绪'); return }
    if (!r.ok) { setScanInfo(r.error || '添加失败'); return }
    setScanInfo('已加入 Steam 壁纸库，正在扫描…')
    await scanAll('已加入 Steam 壁纸库')
  }

  const browseFolder = async () => {
    const hd = window.hermesDesktop
    if (!hd || typeof hd.selectPaths !== 'function') {
      setScanInfo('⚠ 当前环境不支持系统选择器，请手动输入路径')
      return
    }
    try {
      const res = await hd.selectPaths({ directories: true, multiple: true, title: '选择壁纸文件夹（可多选，最多 5 个）' })
      const picks = Array.isArray(res) ? res : []
      if (picks.length === 0) return
      const before = wpNormalizeFolders($cfg.get().folders).length
      const { folders, errors } = wpAddFolders($cfg.get().folders, picks)
      set({ folders })
      const added = folders.length - before
      const note = added > 0
        ? `已添加 ${added} 个` + (errors.length ? `（${errors[0]}）` : '')
        : ''
      // 评审 D6：这条提示必须跟扫描结果一起写进同一个字符串，否则会被 scanAll 的 await 结果
      // 在几十毫秒内覆盖掉 —— 用户永远看不到「该文件夹已在列表里 / 最多 5 个」
      if (added > 0) scanAll(note)
      else setScanInfo('⚠ ' + (errors[0] || '没有可添加的文件夹'))
    } catch (e) {
      setScanInfo('❌ 选择失败: ' + e.message)
    }
  }

  // v27.3: 排除当前壁纸——改名后立即换下一张（重扫自动过滤被排除图）
  const excludeCurrent = async () => {
    if (!hasFolder) return
    const r = await excludeCurrentWallpaper()
    if (r.ok) {
      setScanInfo('已排除：' + r.newName)
      requestSwap()
    } else {
      setScanInfo('⚠ ' + (r.error || '排除失败'))
    }
  }

  // v35 like：面板按钮 = 同一条共享动作（toast 由共享函数发，这里只补面板内的状态行）
  const toggleLike = async () => {
    const r = await likeCurrentWithFeedback()
    setScanInfo((r.ok ? '' : '⚠ ') + r.msg)
  }

  const statusLine = {
    idle: foldersPausedNoImage ? '⏸ 没有启用的文件夹，且当前没有画面（勾选任意一本即恢复）' : '壁纸已关闭，使用 Hermes 原始主题',
    applying: '正在加载图片…',
    applied: foldersPaused ? '⏸ 已启用的文件夹为空，轮换已暂停（仍显示当前这张）'
      : lockedOn ? '🔒 已锁定（不轮换）' : rotateOn ? '✅ 轮换运行中' : '✅ 壁纸已应用（手动换图）',
    error: '❌ 图片加载失败，已自动回退到原始主题（检查路径是否正确）'
  }[status] || ''

  // v23f：语义色 #8aa68f/#c07a6e 在壁纸亮区合成底上仅 1.93-2.82:1 不可读
  // （设置面板透明层无独立底）。状态行正文统一二级暖白（亮区 4.31-4.54 达标），
  // 语义由 ✅/❌ emoji 承担（v23c 语义色方案在透明层亮区不可行，记录于 handoff）。
  const statusColor = {
    idle: 'text-(--ui-text-tertiary)',
    applying: 'text-(--ui-text-secondary)',
    applied: 'text-(--ui-text-secondary)',
    error: 'text-(--ui-text-secondary)'
  }[status] || 'text-(--ui-text-tertiary)'

  const swapTime = lastSwap
    ? `上次切换 ${new Date(lastSwap.time).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })} · ${lastSwap.name}`
    : ''

  // v43：封面回退项（场景包）文件名一律是 preview.*，没信息量 → 退回父目录名（创意工坊 ID）
  const wpNameOf = (p) => {
    const seg = String(p).split(/[\\/]/).filter(Boolean)
    const base = seg.pop() || p
    return WP_PREVIEW_RE.test(base) ? (seg.pop() || base) + '（封面）' : base
  }
  const libShown = lib.filter((p) => (libKind === 'all' || (libKind === 'video') === isVideoPath(p))
    && !wpHiddenSet().has(normPath(p))   // v40：隐藏的不再出现在库里
    && (!libQ.trim() || wpNameOf(p).toLowerCase().includes(libQ.trim().toLowerCase())))

  return jsxs('div', {
    // 给「设置页现在到底画在屏幕上没有」留一个自有句柄（见 settingsPageOnScreen）。
    'data-wp-settings-root': '',
    className: 'flex h-full flex-col gap-3 p-3 text-sm overflow-y-auto',
    children: [
      jsx('div', { className: 'font-medium text-[#d9b87a]', children: '壁纸设置' }),

      jsx('label', {
        className: 'flex items-center gap-2 text-xs',
        children: [
          jsx('input', {
            type: 'checkbox', checked: !!cfg.enabled,
            className: 'accent-(--ui-accent)',
            onChange: (e) => set({ enabled: e.target.checked })
          }),
          jsx('span', { children: '启用图片背景' })
        ]
      }),

      // 单图模式（保留兼容；轮换模式下被忽略）
      jsxs('label', {
        className: 'flex flex-col gap-1 text-xs',
        children: [
          jsx('span', { className: 'text-(--ui-text-secondary)', children: '图片路径' }),
          jsx('input', {
            type: 'text', value: pathDraft,
            className: 'rounded border border-(--ui-stroke-secondary) bg-transparent px-2 py-1 text-xs',
            onInput: (e) => setPathDraft(e.target.value),
            onBlur: () => set({ imagePath: pathDraft.trim() })
          })
        ]
      }),
      jsx('div', {
        className: 'text-[0.6875rem] text-(--ui-text-tertiary)',
        children: hasFolder ? '已启用文件夹模式（单图路径被忽略）；勾选「定时轮换」才会自动更换。' : '单图模式：本地图片路径或 http(s) 链接。'
      }),

      // v36：壁纸文件夹（最多 5 个，逐个可启用；未启用的不参与扫描与轮换）
      jsxs('div', {
        className: 'flex flex-col gap-1 text-xs',
        children: [
          jsxs('div', {
            className: 'flex items-center justify-between',
            children: [
              jsx('span', { className: 'text-(--ui-text-secondary)', children: '壁纸文件夹' }),
              jsx('span', { className: 'text-[0.6875rem] text-(--ui-text-tertiary)', children: `最多 ${WP_MAX_FOLDERS} 个 · 清空路径=删除 · 未启用的不扫描 · Steam 库自动下钻一层` })
            ]
          }),
          folderCount === 0
            ? jsx('div', { className: 'text-[0.6875rem] text-(--ui-text-tertiary)', children: '尚未添加文件夹（单图模式下可忽略）' })
            : folderRows.map((f, i) => jsxs('div', {
              className: 'flex items-center gap-2',
              children: [
                jsx('input', {
                  type: 'checkbox', checked: !!f.enabled, 'data-wp-folder-enabled': i,
                  className: 'accent-(--ui-accent)',
                  onChange: (e) => set({ folders: wpSetFolderEnabled(folderRows, i, e.target.checked) })
                }),
                jsx('input', {
                  type: 'text', defaultValue: f.path, placeholder: 'D:\\壁纸\\…', title: f.path,
                  'data-wp-folder-path': i,
                  className: 'min-w-0 flex-1 rounded border border-(--ui-stroke-secondary) bg-transparent px-2 py-1 text-xs',
                  onBlur: (e) => {
                    const v = e.target.value.trim()
                    if (v !== f.path) set({ folders: wpReplaceFolder(folderRows, i, v) })
                  }
                }),
                jsx(ActionBtn, {
                  onClick: () => set({ folders: wpRemoveFolder(folderRows, i) }),
                  'data-wp-folder-remove': i,
                  children: '删除'
                })
              ]
            // key 用第三个参数（不能用 props.key：React 19 会用 props 里的那个并同时警告
            // 「A props object containing a "key" prop is being spread into JSX」——评审 F13）。
            // key 带上 path：删除某行后该行必须重挂载，否则 defaultValue 会显示上一行的值
            }, 'wp-folder-' + i + '-' + f.path))
        ]
      }),
      jsxs('div', {
        className: 'flex items-center gap-2',
        children: [
          jsx(ActionBtn, {
            onClick: browseFolder,
            disabled: folderCount >= WP_MAX_FOLDERS,
            'data-wp-folder-add': '',
            children: '浏览…（可多选）'
          }),
          jsx(ActionBtn, {
            onClick: addSteamLibrary,
            disabled: scanning || folderCount >= WP_MAX_FOLDERS,
            'data-wp-steam-add': '',
            title: '自动探测 Steam 创意工坊的 Wallpaper Engine 壁纸库（431960）并加入上方列表',
            children: 'Steam 壁纸库'
          }),
          jsx(ActionBtn, { onClick: () => scanAll(), disabled: scanning, children: scanning ? '扫描中…' : '重新扫描' }),
          jsx('span', { className: 'text-[0.6875rem] text-(--ui-text-tertiary)', children: scanInfo })
        ]
      }),

      // v39 壁纸库（对齐 dsh 壁纸仓库）：缩略图网格 + 搜索 + 类型过滤，点卡片即应用
      jsxs('div', {
        className: 'flex flex-col gap-2 border-t border-(--ui-stroke-secondary) pt-3',
        children: [
          jsxs('div', {
            className: 'flex items-center justify-between',
            children: [
              jsx('span', { className: 'text-(--ui-text-secondary)', children: '壁纸库' }),
              jsx('span', {
                className: 'text-[0.6875rem] text-(--ui-text-tertiary)',
                children: lib.length ? `${libShown.length} / ${lib.length} 张 · 点击卡片即应用` : '点「重新扫描」加载'
              })
            ]
          }),
          jsxs('div', {
            className: 'flex items-center gap-2',
            children: [
              jsx('input', {
                type: 'text', value: libQ, placeholder: '搜索壁纸文件名…', 'data-wp-lib-q': '',
                className: 'min-w-0 flex-1 rounded border border-(--ui-stroke-secondary) bg-transparent px-2 py-1 text-xs',
                onInput: (e) => setLibQ(e.target.value)
              }),
              jsx('select', {
                value: libKind, 'data-wp-lib-kind': '',
                className: 'rounded border border-(--ui-stroke-secondary) bg-transparent px-1 py-1 text-xs',
                onChange: (e) => setLibKind(e.target.value),
                children: [
                  jsx('option', { value: 'all', children: '全部' }),
                  jsx('option', { value: 'image', children: '图片' }),
                  jsx('option', { value: 'video', children: '视频' })
                ]
              })
            ]
          }),
          libShown.length === 0
            ? jsx('div', {
              className: 'text-[0.6875rem] text-(--ui-text-tertiary)',
              children: lib.length === 0 ? '库是空的：添加并启用壁纸文件夹后点「重新扫描」' : '没有匹配的壁纸'
            })
            : jsx('div', {
              className: 'grid overflow-y-auto',
              style: { gridTemplateColumns: 'repeat(auto-fill, minmax(60px, 1fr))', gap: '4px', maxHeight: '20rem' },
              children: libShown.map((p) => jsxs('button', {
                type: 'button',
                onClick: () => applySpecific(p),
                title: p,
                'data-wp-lib-card': p,
                className: 'relative flex flex-col overflow-hidden rounded border text-left hover:opacity-80 '
                  + (p === (libCur || currentImagePath()) ? 'border-(--ui-accent)' : 'border-(--ui-stroke-secondary)'),
                style: { padding: '2px', gap: '2px' },
                children: [
                  isWebPath(p)
                    ? jsx('div', { className: 'flex w-full items-center justify-center rounded bg-black/40', style: { height: '2.5rem', fontSize: '0.875rem' }, children: '🌐' })
                    : isVideoPath(p)
                    // v46：视频卡片不再只挂 🎬 —— 用原生 `#t=1` 媒体片段让 <video> 静音 seek 到第 1 秒，
                    // 当缩略图显示真画面（零依赖；preload=metadata 只读头，不整段解码）。
                    ? jsx('video', {
                      src: pathToFileUrl(p) + '#t=1',
                      muted: true, preload: 'metadata', playsInline: true, draggable: false,
                      className: 'w-full rounded bg-black/40 object-cover', style: { height: '2.5rem' }
                    })
                    : jsx('img', { src: pathToFileUrl(p), loading: 'lazy', draggable: false, className: 'w-full rounded object-cover', style: { height: '2.5rem' } }),
                  jsx('span', { className: 'truncate text-(--ui-text-tertiary)', style: { fontSize: '9px' }, children: wpNameOf(p) }),
                  jsx('span', {
                    'data-wp-lib-hide': p,
                    title: '隐藏这张（软隐藏：不删源文件，可点下方「恢复全部」找回）',
                    className: 'absolute rounded bg-black/60 text-white hover:bg-black/80',
                    style: { right: '1px', top: '1px', padding: '0 3px', fontSize: '9px', lineHeight: '12px' },
                    onClick: (e) => {
                      e.stopPropagation()
                      e.preventDefault()
                      set({ hidden: wpNextHidden(cfg, p, true) })
                      setLib((cur) => cur.filter((x) => normPath(x) !== normPath(p)))
                    },
                    children: '✕'
                  })
                ]
              }, 'wp-lib-' + p))
            })
        ]
      }),

      // v40 隐藏/恢复（对齐 dsh「隐藏 / 恢复」）：软隐藏，不碰源文件；恢复后点「重新扫描」回库
      (Array.isArray(cfg.hidden) && cfg.hidden.length)
        ? jsxs('div', {
          className: 'flex items-center justify-between gap-2 border-t border-(--ui-stroke-secondary) pt-2 text-xs',
          children: [
            jsx('span', {
              className: 'text-(--ui-text-tertiary)',
              children: `已隐藏 ${cfg.hidden.length} 张（不参与轮换、不在库里显示）`
            }),
            jsx('button', {
              type: 'button', 'data-wp-lib-unhide': '',
              className: 'rounded border border-(--ui-stroke-secondary) px-2 py-0.5 hover:opacity-80',
              onClick: () => {
                set({ hidden: [] })
                setLib([])
                setScanInfo('已恢复全部隐藏壁纸，点「重新扫描」重新载入库')
              },
              children: '恢复全部'
            })
          ]
        })
        : null,

      // v39 视频声音（对齐 dsh-plugin-wallpaper-sound）：默认静音播放，开启后首次点击界面才出声
      jsxs('div', {
        className: 'flex flex-col gap-1 text-xs',
        children: [
          jsxs('label', {
            className: 'flex items-center gap-2',
            children: [
              jsx('input', {
                type: 'checkbox', checked: !!cfg.videoSound, 'data-wp-video-sound': '',
                className: 'accent-(--ui-accent)',
                onChange: (e) => {
                  set({ videoSound: e.target.checked })
                  if (e.target.checked) wpArmSoundUnlock()
                  wpApplySoundToCurrent()
                }
              }),
              jsx('span', { children: '视频壁纸声音' })
            ]
          }),
          jsxs('div', {
            className: 'flex items-center gap-2',
            children: [
              jsx('span', { className: 'text-[0.6875rem] text-(--ui-text-tertiary)', children: '音量' }),
              jsx('input', {
                type: 'range', min: '0', max: '1', step: '0.05', value: String(cfg.videoVolume),
                disabled: !cfg.videoSound, 'data-wp-video-volume': '',
                className: 'flex-1 accent-(--ui-accent)',
                onChange: (e) => { set({ videoVolume: Number(e.target.value) }); setTimeout(wpApplySoundToCurrent, 0) }
              }),
              jsx('span', { className: 'text-[0.6875rem] text-(--ui-text-tertiary)', children: Math.round((Number(cfg.videoVolume) || 0) * 100) + '%' })
            ]
          }),
          jsx('div', { className: 'text-[0.6875rem] text-(--ui-text-tertiary)', children: '视频默认静音自动播放（浏览器策略），开启声音后需在界面上点一下才会出声。' })
        ]
      }),

      // v24：定时轮换
      jsxs('label', {
        className: 'flex items-center gap-2 text-xs',
        children: [
          jsx('input', {
            type: 'checkbox', checked: !!cfg.rotate, disabled: !hasFolder || !!cfg.locked,
            className: 'accent-(--ui-accent)',
            onChange: (e) => set({ rotate: e.target.checked })
          }),
          jsx('span', { children: '定时轮换文件夹壁纸' })
        ]
      }),
      // v33：锁定 —— 冻结自动轮换 + 钉住当前这张（图源仍是文件夹；手动「换一张」仍可用）
      jsxs('label', {
        className: 'flex items-center gap-2 text-xs',
        children: [
          jsx('input', {
            type: 'checkbox', checked: !!cfg.locked, disabled: !hasFolder && !cfg.locked,
            className: 'accent-(--ui-accent)',
            onChange: (e) => set({ locked: e.target.checked })
          }),
          jsx('span', { children: '锁定当前壁纸（不自动轮换）' })
        ]
      }),
      hasFolder ? jsx('div', {
        className: 'text-[0.6875rem] text-(--ui-text-tertiary)',
        children: cfg.locked
          ? '已锁定：自动轮换已停，重启后仍显示这张；手动「换一张」仍可用（会更新锁定的图）。'
          : '锁定后停止自动轮换，并把当前这张钉住；图源仍是文件夹。'
      }) : null,

      hasFolder ? jsxs('div', {
        className: 'flex items-center gap-2',
        children: [
          jsx(ActionBtn, { onClick: requestSwap, children: '换一张' }),
          jsx(ActionBtn, { onClick: excludeCurrent, children: '排除当前壁纸' })
        ]
      }) : null,

      // v35 like：原地改名打标（可再点一次取消）；不需要文件夹模式，单图模式同样可用
      cfg.enabled ? jsxs('div', {
        className: 'flex items-center gap-2',
        children: [
          jsx(ActionBtn, { onClick: toggleLike, children: '标记这张壁纸（like）' }),
          jsx('span', { className: 'text-[0.6875rem] text-(--ui-text-tertiary)', children: '再点一次 = 取消标记' })
        ]
      }) : null,

      // v24：更换间隔 / 顺序 / 动画（轮换相关设置常显，可预先配置）
      jsx(Slider, {
        label: '更换间隔', value: cfg.intervalMin, min: 1, max: 240, step: 1,
        fmt: (v) => `${v} 分钟`, onChange: (intervalMin) => set({ intervalMin })
      }),
      jsxs('div', {
        className: 'flex flex-col gap-1 text-xs',
        children: [
          jsx('span', { className: 'text-(--ui-text-secondary)', children: '切换顺序' }),
          jsxs('div', {
            className: 'flex gap-2',
            children: [
              jsx(OptionBtn, { active: cfg.order === 'random', onClick: () => set({ order: 'random' }), children: '随机' }),
              jsx(OptionBtn, { active: cfg.order === 'shuffle', onClick: () => set({ order: 'shuffle' }), children: '洗牌' }),
              jsx(OptionBtn, { active: cfg.order === 'seq', onClick: () => set({ order: 'seq' }), children: '顺序' })
            ]
          })
        ]
      }),
      jsxs('div', {
        className: 'flex flex-col gap-1 text-xs',
        children: [
          jsx('span', { className: 'text-(--ui-text-secondary)', children: '切换动画' }),
          jsxs('div', {
            className: 'flex gap-2 flex-wrap',
            children: [
              jsx(OptionBtn, { active: cfg.animStyle === 'none', onClick: () => set({ animStyle: 'none' }), children: '无' }),
              jsx(OptionBtn, { active: cfg.animStyle === 'fade', onClick: () => set({ animStyle: 'fade' }), children: '淡化' }),
              jsx(OptionBtn, { active: cfg.animStyle === 'fade-zoom', onClick: () => set({ animStyle: 'fade-zoom' }), children: '淡化+缩放' }),
              jsx(OptionBtn, { active: cfg.animStyle === 'blur', onClick: () => set({ animStyle: 'blur' }), children: '模糊过渡' })
            ]
          })
        ]
      }),
      jsx(Slider, {
        label: '动画时长', value: cfg.animMs, min: 200, max: 3000, step: 100,
        fmt: (v) => `${v}ms`, onChange: (animMs) => set({ animMs })
      }),

      jsx('div', { className: `text-xs ${statusColor}`, children: statusLine }),
      swapTime ? jsx('div', { className: 'text-[0.6875rem] text-(--ui-text-tertiary)', children: swapTime }) : null,

      // 原四组画面参数
      jsx(Slider, {
        label: '模糊度', value: cfg.blur, min: 0, max: 30, step: 1,
        fmt: (v) => `${v}px`, onChange: (blur) => set({ blur })
      }),
      jsx(Slider, {
        label: '亮度', value: cfg.brightness, min: 0.2, max: 1.2, step: 0.05,
        fmt: (v) => v.toFixed(2), onChange: (brightness) => set({ brightness })
      }),
      jsx(Slider, {
        label: '暗化遮罩', value: cfg.dim, min: 0, max: 0.8, step: 0.05,
        fmt: (v) => Math.round(v * 100) + '%', onChange: (dim) => set({ dim })
      }),
      jsx(Slider, {
        label: '对比度', value: cfg.contrast, min: 0.2, max: 2, step: 0.05,
        fmt: (v) => v.toFixed(2), onChange: (contrast) => set({ contrast })
      }),
      jsx(Slider, {
        label: '饱和度', value: cfg.saturate, min: 0, max: 2, step: 0.05,
        fmt: (v) => v.toFixed(2), onChange: (saturate) => set({ saturate })
      }),
      jsx(Slider, {
        label: '面板透明度', value: cfg.surfaceAlpha, min: 0.3, max: 1, step: 0.02,
        fmt: (v) => Math.round(v * 100) + '%', onChange: (surfaceAlpha) => set({ surfaceAlpha })
      }),

      // v40 画面适配（对齐 dsh「画面适配」）：铺满裁切 / 完整显示 / 拉伸
      jsxs('div', {
        className: 'flex flex-col gap-1 text-xs',
        children: [
          jsx('span', { className: 'text-(--ui-text-secondary)', children: '画面适配' }),
          jsxs('div', {
            className: 'flex gap-2 flex-wrap',
            children: [
              jsx(OptionBtn, { active: cfg.fit === 'cover', onClick: () => set({ fit: 'cover' }), children: '铺满裁切' }),
              jsx(OptionBtn, { active: cfg.fit === 'contain', onClick: () => set({ fit: 'contain' }), children: '完整显示' }),
              jsx(OptionBtn, { active: cfg.fit === 'fill', onClick: () => set({ fit: 'fill' }), children: '拉伸铺满' })
            ]
          })
        ]
      }),

      // v40 视频倍速（对齐 dsh「视频倍速 0.5x–2x 六档」）：只对视频壁纸生效，即时可听可见
      jsxs('div', {
        className: 'flex flex-col gap-1 text-xs',
        children: [
          jsx('span', { className: 'text-(--ui-text-secondary)', children: '视频倍速' }),
          jsxs('div', {
            className: 'flex gap-2 flex-wrap',
            children: [0.5, 0.75, 1, 1.25, 1.5, 2].map((sp) =>
              jsx(OptionBtn, {
                key: 'wp-sp-' + sp,
                active: Number(cfg.videoSpeed) === sp,
                onClick: () => set({ videoSpeed: sp }),
                children: sp + 'x'
              }))
          })
        ]
      }),

      // v28.4：诊断转储开关（默认关）。仅排障/配色审查时打开——打开后每次 apply
      // 会做全量槽位 dump + 深度诊断（实测 ~0.5s 主线程阻塞 + ~100KB 日志）
      jsxs('label', {
        className: 'flex items-center gap-2 text-xs',
        children: [
          jsx('input', {
            type: 'checkbox', checked: !!cfg.debugDump,
            className: 'accent-(--ui-accent)',
            onChange: (e) => set({ debugDump: e.target.checked })
          }),
          jsx('span', { className: 'text-(--ui-text-tertiary)', children: '诊断转储（排障用，会略卡）' })
        ]
      }),

      jsx('div', {
        className: 'text-[0.6875rem] text-(--ui-text-tertiary)',
        children: '定时轮换：从已扫描的壁纸池里切换（结果常驻 6 小时，新加的图片点「重新扫描」入池）。开启时先验证图片能否加载，失败自动跳过并保持当前壁纸。'
      })
    ]
  })
}

// ── v30：把设置页固定进右侧栏（取代内置的「项目目录」pane `files`） ─────────────
//
// 这一段的机制是 2026-09-12 在本机读源码 + 在跑着的窗口上实测出来的，v29 那版
// 注释写错了（它以为「注册一个 placement:'right' 的 pane 就会被收养进右侧那一栏」），
// 实际行为是给窗口多出一栏。事实如下（源码：
// apps/desktop/src/components/pane-shell/tree/store.ts、model.ts、app/contrib/controller.tsx）：
//
// 1. 「项目目录」= 内置 pane `files`，data = placement 'right'、dock
//    {pane:'workspace', pos:'right'}。它自己的「关闭」不是 dismiss：core 给它
//    registerPaneCloser('files', …) → setFileBrowserOpen(false)，只把 ⌘J 那一边
//    整条收起来，pane 还在树里。所以「取代它」只能动布局树。
// 2. 收养（adoptContributedPanes）的 anchor **不是**「placement 相同的那一栏」：
//    它取 `allPaneIds(tree)` 里**第一个** placement 相同的**其他 pane**。
//    没有 dock 提示时，placement 'right' 会命中 `review`（review 在树里排在
//    `files` 前面），于是设置页被插进 review 那一格、把那条收起的栏顶开 ——
//    看起来就是「在项目目录左边多出一栏」。（附带发现：SDK 没有暴露「改运行时
//    布局树」的门，revealTreePane/closeTreePane 那些都不导出给插件。）
//    ⇒ data.dock 必须自己给：`{ pane: 'files', pos: 'center' }`（center = 同格做
//      tab，不是新开一栏），这样任何一次收养都不会再变出第三栏。
// 3. pane 一旦进了树就**永不重收养**：adoptContributedPanes 只处理树里缺失的 pane
//    （store.ts 的 `missing` 列表）。所以对「已经躺在别处」的设置页，改 dock 提示无效。
//    真正会把它搬过去的是 data.dock 上的 **`enforce: true`** —— 那是应用自己的常驻
//    不变式（`enforceDockedPanes`，store.ts）：每个 boot 第一次收养 pass 把它 movePane
//    到锚点（`workspace`）的 right 边，之后由应用自己持久化。Bot Mode 的 Bots/routines
//    用的是同一个机制（tree/dock-enforce.test.ts）。代价：它和那两个 pane 一样被钉在
//    锚点旁，同一 boot 内手动拖走不会被抢回。
// 4. 「取代项目目录」不去动布局树，而是用**应用自己的手势**让它退场：`files` 标签上
//    的 ✕、或对标签中键点击，都等于关闭 = DISMISS（应用自己的测试
//    renderer/tab-close-affordance.test.tsx 就是这么断言的，并把 `files` 列为
//    「a plain side pane: closes」），dismiss 之后由应用自己持久化。
//    ⚠️ 早先那版替应用改写 localStorage 的布局树 + 记 dismissedPanes + 重载窗口，
//    结果和应用启动时的持久化互相覆盖（日志里能看到「反复改写又被抹掉」），右侧栏
//    始终没换过来，**已废弃**，别再走这条路。
// 5. 「设置页在不在」不能用「DOM 里有没有它的 tab」判定：pane 独占一栏时应用不画标签条
//    （lone pane → strip 自动隐藏，见 renderer/strip-visibility.ts），于是明明已就位
//    却被判成「没被收养」，12 次重试后弹假告警。权威答案是 SDK 的 host.paneVisibility
//    （见下方 railTabPresence）。
const SETTINGS_PANE_ID = ID + ':settings-pane' // 宿主给贡献 id 加 '<plugin>:' 前缀
const RAIL_MARK_KEY = 'rail-install.v4' // v4 = 运行时路线；v3 是已废弃的「写树+重载」路线留下的，不能挡住首次运行

// 运行时路线的参数：先等收养落定，再按固定节奏重试「让 files 退场」。
const RAIL_FIRST_TICK_MS = 1200
const RAIL_RETRY_INTERVAL_MS = 700
const RAIL_RETRY_MAX = 12

/** 设置页 / 项目目录此刻在不在屏幕上。
 *
 *  「DOM 里有没有那张 tab」**不是**可靠判据：pane 独占一栏时应用不画 tab 条
 *  （lone pane → strip 自动隐藏，见 renderer/strip-visibility.ts），于是设置页明明
 *  已经右栏就位、`querySelector('[data-tree-tab=…]')` 仍然是 null。用它判定会让
 *  已经正确的状态被判成「没被收养」，12 次重试后弹一条假告警（「项目目录还在」）。
 *  SDK 的 paneVisibility 才是权威：在树里 + 没被隐藏 + 那一栏没最小化 + 占着活动位
 *  （单 pane 独占一栏也算）。files 只能靠 tab —— 它的栏收起时我们不碰它。 */
function railTabPresence() {
  const has = (id) => {
    try { return !!document.querySelector('[data-tree-tab="' + id + '"]') } catch { return false }
  }
  return { settings: railSettingsVisible() || has(SETTINGS_PANE_ID), files: has('files') }
}

/** 让应用自己 Dismiss 掉「项目目录」（pane id `files`）。
 *
 *  走应用自己的手势，而不是替它写 localStorage：标签的「中键点击」和标签上的
 *  ✕ 在应用里都等于关闭 = DISMISS（应用自己的测试
 *  `renderer/tab-close-affordance.test.tsx` 把 `files` 列为「a plain side pane:
 *  closes」并断言这两种手势等价），dismiss 之后由应用自己持久化。
 *
 *  上一版（v30）替应用写 `dismissedPanes` + 改写布局树 + 重载窗口：应用启动时
 *  会用它自己内存里的状态把这两个键写回，把插件的写入抹掉，于是日志里出现
 *  「反复改写但收敛不了」的循环，右侧栏始终还是项目目录。不要再回到那条路。
 *
 *  返回 'gone' | 'clicked-x' | 'middle-click'。 */
function dismissFilesTab() {
  let tab = null
  try { tab = document.querySelector('[data-tree-tab="files"]') } catch {}
  if (!tab) return 'gone'

  const pointer = (el, type, button, buttons) => {
    try {
      el.dispatchEvent(new PointerEvent(type, {
        bubbles: true,
        cancelable: true,
        button: button,
        buttons: buttons,
        pointerId: 1,
        pointerType: 'mouse',
        isPrimary: button === 0
      }))
    } catch {}
  }

  const x = tab.querySelector('button[aria-label]')
  if (x) {
    pointer(x, 'pointerdown', 0, 1)
    pointer(x, 'pointerup', 0, 0)
    try { x.click() } catch {}
    return 'clicked-x'
  }

  // 应用自身测试断言过的「关标签」手势：中键。
  pointer(tab, 'pointerdown', 1, 4)
  pointer(tab, 'pointerup', 1, 0)
  try { tab.dispatchEvent(new MouseEvent('auxclick', { bubbles: true, cancelable: true, button: 1 })) } catch {}
  return 'middle-click'
}

/**
 * 让「壁纸设置」取代右侧栏的「项目目录」。**纯运行时：不重载、不替应用写存档。**
 *
 *   1. 设置页 pane 靠注册数据里的 `dock: { pane: 'files', pos: 'center' }` 被收养
 *      进 `files` 那一格（同格做 tab，不会凭空顶出一条新栏 —— 这正是之前
 *      「在项目目录左边多出一栏」的原因）；
 *   2. 等设置页真的出现在那一栏之后，用应用自己的手势 dismiss 掉 `files`，
 *      那一栏就只剩设置页；
 *   3. 只做一次（`RAIL_MARK_KEY`）。若之后 `files` 又回来了（用户自己换了布局
 *      预设 / 重置布局），插件不再抢 —— 让位给用户。
 *
 * 返回 'scheduled' | 'done' | 'backed-off'（命令面板据此提示）。 */
function ensureRailSettings(ctx, force) {
  const mark = ctx.storage.get(RAIL_MARK_KEY, null)
  const presence = railTabPresence()

  if (presence.settings && !presence.files) {
    if (!mark || mark.how !== 'swapped') {
      ctx.storage.set(RAIL_MARK_KEY, { at: Date.now(), how: 'swapped', via: 'already-clean' })
    }
    return 'done'
  }

  if (!force && mark && mark.how === 'swapped' && presence.files) {
    ctx.storage.set(RAIL_MARK_KEY, { at: Date.now(), how: 'backed-off' })
    console.error('[wallpaper][rail] files 又回到右侧栏，视为用户重置了布局 —— 插件不再抢')
    return 'backed-off'
  }

  let tries = 0
  let lastHow = 'waiting'

  const tick = () => {
    // v37 审查闭环（L3）：被卸载的实例不许继续跑这条 12 次×700ms 的链
    if (!wpIsLive(window, INSTANCE_ID)) return
    tries += 1
    const now = railTabPresence()

    if (now.settings && !now.files) {
      ctx.storage.set(RAIL_MARK_KEY, { at: Date.now(), how: 'swapped', via: lastHow, tries: tries })
      console.error('[wallpaper][rail] 右侧栏已由设置页取代（files 由应用自己 dismiss：' + lastHow + '，第 ' + tries + ' 次）')
      return
    }

    if (now.settings && now.files) {
      lastHow = dismissFilesTab()
      console.error('[wallpaper][rail] 关闭 files 标签：' + lastHow + '（第 ' + tries + ' 次）')
    } else if (!now.settings) {
      lastHow = 'settings-pane-not-adopted-yet'
    }

    if (tries < RAIL_RETRY_MAX) {
      window.setTimeout(tick, RAIL_RETRY_INTERVAL_MS)
      return
    }

    ctx.storage.set(RAIL_MARK_KEY, { at: Date.now(), how: 'incomplete', via: lastHow, tries: tries })
    console.error('[wallpaper][rail] 没能在 ' + RAIL_RETRY_MAX + ' 次内完成（最后一步：' + lastHow + '）')
    host.notify({
      kind: 'warning',
      message: '壁纸设置：右侧栏没能换成设置页（项目目录还在）—— 可用命令面板里的手动入口再试一次。'
    })
  }

  window.setTimeout(tick, RAIL_FIRST_TICK_MS)
  return 'scheduled'
}

/** 右侧栏那一栏此刻就在眼前吗？（SDK paneVisibility：在树里 + 没隐藏 + 占着
 *  自己那一栏的活动位） */
function railSettingsVisible() {
  try {
    const vis = host.paneVisibility && host.paneVisibility(SETTINGS_PANE_ID)
    return !!(vis && typeof vis.get === 'function' && vis.get())
  } catch {
    return false
  }
}

/** 试着按一下右侧栏里那张 tab 把它激活（tab 上带 data-tree-tab=<pane id>）。 */
function tapRailSettingsTab() {
  const tab = document.querySelector('[data-tree-tab="' + SETTINGS_PANE_ID + '"]')
  if (!tab) return false
  try {
    const opts = { bubbles: true, cancelable: true, button: 0, pointerId: 1, pointerType: 'mouse', isPrimary: true }
    tab.dispatchEvent(new PointerEvent('pointerdown', { ...opts, buttons: 1 }))
    tab.dispatchEvent(new PointerEvent('pointerup', { ...opts, buttons: 0 }))
    return true
  } catch {
    return false
  }
}

/** 壁纸设置**此刻真的画在屏幕上**吗？
 *
 *  为什么不能只信 `railSettingsVisible()`（= SDK 的 host.paneVisibility）：
 *  它回答的是「pane 在树里 + 没被隐藏 + 占着自己那一栏的活动位」，**完全不认识
 *  栏级收起**（⌘J → `$collapsedTreeSides`）。右栏被收起时整栏 `display:none`，
 *  而 group 的 `active` 仍是设置页，于是它照样返回 true。实测（隔离实例 9412）：
 *  折叠态 `paneVisibility_settings = true` 而设置页 group 的 rect 是 `[0,0,0,0]`、
 *  `getClientRects().length = 0`。只信它 → 状态栏 chip / 命令面板在右栏收起时
 *  变成**死按钮**（既不激活什么，也不走回退面），用户按了没反应。
 *
 *  所以这里补一道几何判据：设置页组件根上带 `data-wp-settings-root`（自渲染的根
 *  div），只要有一个实例的 client rects 非空，就算「已经在屏幕上」。
 *  多实例是正常的（右侧栏那一格 + 回退面主区 tab，甚至路由页），任一可见即算数。 */
function settingsPageOnScreen() {
  try {
    const roots = document.querySelectorAll('[data-wp-settings-root]')
    for (const el of roots) {
      if (el.getClientRects().length > 0) return true
    }
    return false
  } catch {
    // 拿不到 DOM（异常环境）时退回老判据：宁可少开，也不要重复开。
    return railSettingsVisible()
  }
}

// v27.4: 设置页 tab 的 close disposer——「点 chip/palette 关旧 + 新建」用
let settingsTabClose = null

// 打开壁纸设置页：设置页现在常驻右侧栏，所以优先「激活右侧栏那一栏」
// （不重载窗口、不再开一个主区 tab）；右侧栏路线不可用（栏被收起 / pane 不在
// 树里 / 旧版 Hermes 没有 paneVisibility）时回退到原来的主区 tab → 路由。
//
// v32：两道闸门从 `railSettingsVisible()` 换成 `settingsPageOnScreen()`。
// paneVisibility=true 但整栏被 ⌘J 收起时，设置页并不在屏幕上 —— 旧写法会在这里
// 直接 return，chip 变成死按钮（实测：折叠态点击 chip 后 mainAreaTabCount 仍是 0）。
// 现在这种状态会落到 `openSettingsTabFallback()`，回到「回退面开一个主区 tab」这条
// 既有设计上（它自己会先关掉上一次开的那个，不会堆叠）。
function openSettingsTab() {
  if (settingsPageOnScreen()) return
  if (tapRailSettingsTab()) {
    setTimeout(() => {
      // v37 审查闭环（L6）：旧实例不许替新实例开主区 tab
      if (!wpIsLive(window, INSTANCE_ID)) return
      if (!settingsPageOnScreen()) openSettingsTabFallback()
    }, 240)
    return
  }
  openSettingsTabFallback()
}

function openSettingsTabFallback() {
  if (host && typeof host.openWorkspace === 'function') {
    if (settingsTabClose) {
      const c = settingsTabClose
      settingsTabClose = null
      try { c() } catch {}
    }
    settingsTabClose = host.openWorkspace('wallpaper-settings', {
      title: '壁纸设置',
      render: () => jsx(WallpaperSettings, {}),
      onClose: () => { settingsTabClose = null }
    })
    return
  }
  host.navigate('/wallpaper')
}

function registerInner(ctx) {
    // v37 账本：**只有宿主支持 ctx.onDispose 时才记账**。审查闭环 F2：原实现无条件登记，
    // 而 onCleanup 在没有 onDispose 时直接 return → 账本里会积下永不 dispose 的 live 项，
    // 归属判定（wpReapDecision）于是永远返回 'keep' → cleanupLayers 永久失效、旧层堆叠
    // （另一种 V1）。没有 onDispose 就完全不记账：所有元素都没有归属标记，
    // wpReapDecision 对 '无标记' 返回 'remove'，行为与修复前一致（按 id 清理）。
    const canDispose = typeof ctx.onDispose === 'function'
    if (canDispose) {
      INSTANCE_ID = wpRegisterInstance(window, WP_BUILD, Date.now())
      // 兜底：上一次实例若因异常没能 dispose（旧宿主/崩溃续体），它的账目会一直「活着」
      // 从而挡住清理 —— 新实例启动时把它清掉（本函数就是为此存在的，以前是死代码）。
      const stale = wpEvictStaleInstances(window, INSTANCE_ID)
      console.error('[wallpaper][diag] instance ' + INSTANCE_ID + ' registered build=' + WP_BUILD
        + ' live=' + wpLiveInstanceCount(window)
        + (stale.length ? ' evicted=' + stale.join(',') : ''))
    } else {
      console.error('[wallpaper][diag] instance (host has no onDispose) build=' + WP_BUILD
        + ' — 不记账，清理降级为按 id 删除无归属标记的元素')
    }
    // 每个副作用一个 key：dispose 日志里的 cleaned=n/n 就是「清干净了」的运行时凭据，
    // pending 里剩下的就是泄漏。
    const onCleanup = (key, fn) => {
      if (!canDispose) return
      wpMarkCleanup(window, INSTANCE_ID, key)
      ctx.onDispose(() => {
        // v37 审查闭环：只有真的清成功才记 cleaned。否则「pending=none」这条凭据会说谎
        //（清了但抛异常时，pending 里留着 key 才是诚实的证据）。
        let ok = true
        try { fn() } catch (e) { ok = false; console.error('[wallpaper] cleanup FAIL ' + key, e && e.message) }
        if (ok) wpMarkCleaned(window, INSTANCE_ID, key)
        else console.error('[wallpaper] cleanup left pending key=' + key)
      })
    }
    // v37（审查 M1）：回收项**必须在任何会抛的初始化之前**登记完 —— 原实现挂在
    // initStore 之后，于是 initStore 抛一次就留下「没有回收钩子的账目」+「没人回填的
    // 样式表」，正是 V1 的复现路径。账本自己永远是最后一条，保证 disposed 日志看到的是
    // 别人清完之后的状态（凭据可信）。
    // v37 回收清单：热重载/停用/修好文件后重新装载时，宿主会跑这一批 —— 以前这里
    // 只有 stopRotator 一条，3 个 MutationObserver 与定时器全都留给旧实例继续跑。
    onCleanup('rotator', () => stopRotator())
    onCleanup('titlebar', () => { if (titlebarDispose) titlebarDispose() })
    onCleanup('review-box', () => { if (reviewBoxDispose) reviewBoxDispose() })
    onCleanup('entrance', () => { if (entranceDispose) entranceDispose() })
    onCleanup('overlay-probe', () => {
      // 审查 F1 残留：只有本实例真的武装过探针时才删守卫标志 —— 否则旧实例会把新实例
      // 的守卫删掉，让探针重复武装（各自 600 次预算，非致命但确实是叠加）。
      if (overlayProbeDispose) {
        overlayProbeDispose()
        try { delete window.__hermesWallpaperOverlayProbe } catch {}
      }
    })
    onCleanup('auto-apply-timer', () => { if (autoApplyTimer) { clearTimeout(autoApplyTimer); autoApplyTimer = null } })
    onCleanup('dump-timer', () => { if (dumpTimer) { clearTimeout(dumpTimer); dumpTimer = null } })
    // 卸载即撤配色（宿主停用插件 / 热重载时旧实例退场）；热重载路径上下一个实例会在
    // register → initStore 里同步补回，同一个任务队列内完成，不产生可见的空档。
    onCleanup('settings-tab', () => {
      // v37 审查闭环（L4）：host.openWorkspace 开的 tab 不在 ctx.register 体系里，
      // 不登记就永远不拆 —— 热重载后旧 tab 常驻并继续服务旧模块的 $cfg/$status
      //（本次实测的「僵尸实例替 v37 干活」就是这么发生的）。
      if (settingsTabClose) {
        const c = settingsTabClose
        settingsTabClose = null
        try { c() } catch (e) { console.error('[wallpaper] settings tab close FAIL', e && e.message) }
      }
    })
    onCleanup('css', () => {
      // v37 审查闭环（1）：宿主正常顺序是「先 dispose 旧→再 register 新」
      //（runtime-loader.ts:175-182），删掉样式表后继任者会立刻补回。但若某个宿主反过来，
      // 这里的删除会打掉继任者刚注入的表。所以在场还有别的活实例时不删（只清自己的账）。
      if (wpLiveInstanceCount(window) <= 1) removeWallpaperCss()
    })
    // 账本自己最后卸载：这样 disposed 日志看到的是「别人都清完之后」的状态
    if (typeof ctx.onDispose === 'function') {
      ctx.onDispose(() => {
        const rec = wpInstanceLedger(window).live[INSTANCE_ID]
        console.error('[wallpaper][diag] instance ' + INSTANCE_ID + ' disposed cleaned='
          + (rec ? rec.cleaned.length : 0) + '/' + (rec ? rec.cleaned.length + rec.pending.length : 0)
          + (rec && rec.pending.length ? ' pending=' + rec.pending.join(',') : ' pending=none')
          + ' liveAfter=' + (wpLiveInstanceCount(window) - 1))
        wpDisposeInstance(window, INSTANCE_ID)
      })
    }

    ctxStorageSet = (v) => { try { ctx.storage.set(STORE_KEY, v) } catch {} }
libCacheIO = {
  get: () => { try { return ctx.storage.get(LIB_CACHE_KEY, null) } catch { return null } },
  set: (v) => { try { ctx.storage.set(LIB_CACHE_KEY, v) } catch {} },
}
    initStore(ctx)

    // 定时器收尾：`scheduleNext()` 排的轮换 setTimeout 只在「用户关掉 rotate」
    // （设置页 set() → stopRotator）或「换图源/关壁纸」（applyWallpaper →
    // stopRotator）时被清掉。**插件被卸载（停用 / 热重载）这条路此前没有任何
    // dispose 钩子** —— 一个已排定的 setTimeout 会留在 window 上直到触发
    // （intervalMin 最长 240 分钟），闭包里还抓着旧模块的 $cfg。
    // 这里补上最小的钩子（老 SDK 没有 onDispose，feature-detect）。
    // 不会影响热重载后的轮换：initStore 里那条 800ms 的 auto-apply 会重新
    // applyWallpaper → startRotator()，把定时器按新模块的状态重新排上。

    // v31：右侧栏的「壁纸设置」pane —— 它取代的就是「项目目录」那一栏。
    // data.dock 是关键：**用它自己的收养目标**（和内置 `files` 的 data.dock
    // 同一份 —— 见 app/contrib/controller.tsx 里 `files` 的 `{ pane: 'workspace',
    // pos: 'right' }`），所以它落到的就是「main 右边那一栏」，也就是项目目录原来
    // 的位置。早先写成 `{ pane: 'files', pos: 'center' }`：一旦 `files` 已被
    // dismiss（不在树里），收养找不到 dock 目标，就退到第一个 group —— 表现是
    // 设置页跑到**左侧栏**去当标签。
    //
    // v31 加的是 `enforce: true`（store.ts `enforceDockedPanes`）：**收养只处理
    // 「不在树里」的 pane**（adoptContributedPanes 的 missing 列表），所以 pane 一旦
    // 已经躺在树里（比如上面那次退错栏的结果，或被用户拖走），光改 dock 提示是无效的
    // —— 应用永远不会再收养它。`enforce` 是应用自己的「这个 pane 常驻在这里」不变
    // 式：每个 boot 的第一次收养 pass 把它重新挂到 dock 锚点的 right 边上（movePane
    // = 移除 + 重新插入），然后由应用自己持久化。Bot Mode 的 Bots pane 用的就是这个
    // 机制（见 components/pane-shell/tree/dock-enforce.test.ts），所以它同样能让
    // 「已经在错栏里的设置页」回到主区右侧那一列（boot 一次、幂等；同一 boot 内用户
    // 自己拖走不会被抢回来）。
    //
    // 可见性：这一列按内容 placement 归类为「右侧栏」（track-model.ts
    // `rootChildSide`），和「项目目录」一样随右侧栏开合（⌘J / file-browser）。
    // uncloseable：关掉插件唯一的 pane 会连带把整个插件停用
    //（tree/store.ts closeTreePane 对单 pane 插件的行为），设置页不该有这个陷阱。
    ctx.register({
      id: 'settings-pane',
      area: PANES_AREA,
      title: '壁纸设置',
      data: {
        placement: 'right',
        dock: { pane: 'workspace', pos: 'right', enforce: true },
        collapsible: true,
        uncloseable: true,
        width: '17rem',
        minWidth: '12rem',
        maxWidth: '26rem'
      },
      render: () => jsx(WallpaperSettings, {})
    })

    // 把持久化布局树里「项目目录」（pane id `files`）那一格换成设置页，并把
    // `files` 记进 dismissedPanes；需要落地时自己重载一次渲染进程（见 v30 说明）。
    ensureRailSettings(ctx, false)

    ctx.register({
      id: 'wallpaper-rail-palette',
      area: PALETTE_AREA,
      data: {
        id: 'wallpaper.rail',
        label: 'Wallpaper: 把设置页固定到右侧栏（替换「项目目录」）',
        keywords: ['wallpaper', '壁纸', '右侧栏', '项目目录', 'files', 'pane', 'layout', '布局'],
        detail: () => '走应用自己的关标签动作（DISMISS）—— 不重载窗口',
        run: () => {
          const how = ensureRailSettings(ctx, true)
          if (how === 'done') {
            host.notify({ kind: 'info', message: '壁纸设置：右侧栏已经是设置页。' })
          }
        }
      }
    })

    // 持久化布局树是**窗口启动时**读一次；插件的运行时替换能立刻改掉运行时那一
    // 栏，但「设置页落在哪一列」这种树级变化要重载一次窗口才落定。给用户一条
    // 自己触发的命令，而不是替他重载（重载会重连 UI，可能打断正在生成的流）。
    ctx.register({
      id: 'wallpaper-rail-reload',
      area: PALETTE_AREA,
      data: {
        id: 'wallpaper.railReload',
        label: 'Wallpaper: 重载窗口，应用右侧栏布局',
        keywords: ['wallpaper', '壁纸', '右侧栏', '重载', 'reload', '布局', '项目目录'],
        detail: () => '重读持久化布局树：设置页回到「项目目录」原来那一列',
        run: () => {
          host.notify({ kind: 'info', message: '壁纸设置：正在重载窗口，让右侧栏布局生效…' })
          setTimeout(() => {
            try { window.location.reload() } catch {}
          }, 600)
        }
      }
    })

    ctx.register({
      id: 'wallpaper-route',
      area: ROUTES_AREA,
      data: { path: '/wallpaper' },
      render: () => jsx(WallpaperSettings, {})
    })

    ctx.register({
      id: 'wallpaper-palette',
      area: PALETTE_AREA,
      data: {
        id: 'wallpaper.toggle',
        label: 'Wallpaper: 切换壁纸',
        keywords: ['wallpaper', '壁纸', '背景'],
        detail: () => ($cfg.get().enabled ? '已开启 — 点击关闭' : '已关闭 — 点击开启'),
        run: () => {
          const next = { ...$cfg.get(), enabled: !$cfg.get().enabled }
          $cfg.set(next)
          ctxStorageSet(next)
          applyWallpaper(next)
        }
      }
    })

    ctx.register({
      id: 'wallpaper-open-palette',
      area: PALETTE_AREA,
      data: {
        id: 'wallpaper.open',
        label: 'Wallpaper: 打开壁纸设置',
        keywords: ['wallpaper', '壁纸', '背景', '设置', '皮肤'],
        run: () => openSettingsTab()
      }
    })

    // v28.5：手动换一张 —— 命令面板入口 + 全局快捷键。
    // 默认 mod+alt+shift+w（Windows/Linux = Ctrl+Alt+Shift+W，macOS = ⌘⌥⇧W）：
    // 原 mod+alt+w 被微信全局热键占用（全局热键优先级高于应用内 keydown，按了只会弹出微信）
    // → 加一层 Shift 避开微信/QQ 那一批 Ctrl+Alt+<字母> 全局热键；Hermes 内置键位里
    // 没有任何 ctrl+alt+shift+* 组合。可在「设置 → 键位」改绑；mod/ctrl 开头的组合在输入框内也生效。
    ctx.register({
      id: 'wallpaper-next-palette',
      area: PALETTE_AREA,
      data: {
        id: 'wallpaper.next',
        action: 'wallpaper.next',
        label: 'Wallpaper: 换一张壁纸',
        keywords: ['wallpaper', '壁纸', '背景', '换一张', '下一张', 'next'],
        detail: () => {
          const all = wpNormalizeFolders($cfg.get().folders)
          if (all.length === 0) return '未设置壁纸文件夹'
          const on = all.filter((f) => f.enabled).length
          return `${on} / ${all.length} 个壁纸文件夹在用` + (on === 0 ? '（全部停用）' : '')
        },
        keepOpen: true,
        run: () => requestSwap()
      }
    })

    ctx.register({
      id: 'wallpaper-next-keybind',
      area: KEYBINDS_AREA,
      data: {
        id: 'wallpaper.next',
        category: 'view',
        defaults: ['mod+alt+shift+w'],
        label: 'Wallpaper: 换一张壁纸',
        run: () => requestSwap()
      }
    })

    // v35 like：命令面板 + 全局快捷键共用同一条动作。
    // 默认 mod+alt+shift+l（Ctrl+Alt+Shift+L / ⌘⌥⇧L）：内置键位表里没有任何
    // ctrl+alt+shift+*；mod+shift+l 已被 view.showBrowser 占用；本机 Ctrl+Alt+<字母>
    // 是微信全局热键家族（会抢在渲染进程之前吃掉按键），所以必须带满三个修饰键。
    // 修饰键顺序必须是 mod → alt → shift → 键名（见 lib/keybinds/combo.ts 的 comboFromEvent）。
    ctx.register({
      id: 'wallpaper-like-palette',
      area: PALETTE_AREA,
      data: {
        id: 'wallpaper.like',
        action: 'wallpaper.like',
        label: 'Wallpaper: 标记/取消标记当前壁纸',
        keywords: ['wallpaper', '壁纸', 'like', '标记', '喜欢', '收藏'],
        detail: () => '原地改名加 _liked_ 前缀（再执行一次即取消；不移动目录，仍在轮换池）',
        keepOpen: true,
        run: () => { likeCurrentWithFeedback() }
      }
    })

    ctx.register({
      id: 'wallpaper-like-keybind',
      area: KEYBINDS_AREA,
      data: {
        id: 'wallpaper.like',
        category: 'view',
        defaults: ['mod+alt+shift+l'],
        label: 'Wallpaper: 标记/取消标记当前壁纸（like）',
        run: () => { likeCurrentWithFeedback() }
      }
    })

    ctx.register({
      id: 'wallpaper-chip',
      area: STATUSBAR_AREAS.right,
      order: 200,
      render: () => {
        const cfg = useValue($cfg)
        const status = useValue($status)
        const sourceState = wpFolderSourceState(cfg)
        const activeFolders = sourceState === 'active'
        const paused = cfg.enabled && sourceState === 'paused'
        const locked = cfg.enabled && !!cfg.locked && activeFolders
        const rotationActive = status !== 'error' && cfg.enabled && cfg.rotate && activeFolders && !cfg.locked
        return jsx('button', {
          type: 'button',
          className: cn(
            'inline-flex h-full items-center gap-1 rounded-none border-x border-transparent px-1.5 text-[0.6875rem] transition-colors',
            rotationActive
              ? 'border-[#c9a05c]/40 text-[#d9b87a] hover:bg-[#c9a05c]/20 hover:text-[#fff8ec]'
              : 'text-(--ui-text-tertiary) hover:bg-(--chrome-action-hover) hover:text-foreground'
          ),
          onClick: openSettingsTab,
          children: status === 'error' ? '⚠ 壁纸错误'
            : !cfg.enabled ? '壁纸(关)'
            : paused ? (status === 'applied' ? '⏸ 壁纸（暂停）' : '⏸ 壁纸(无源)')
            : locked ? '🔒 壁纸'
            : (cfg.rotate && activeFolders ? '🔄 壁纸轮换' : '🖼 壁纸')
        })
      }
    })
}

export default {
  id: ID,
  name: 'Wallpaper',
  // v37：宿主 activate() 的顺序是「先拆旧实例，再 register」（runtime-loader.ts:175-182）。
  // register 抛异常 = 旧实例已死、新实例没起来 = 壁纸与全部配色一起消失，只能靠再写
  // 一次文件或 ⌘R 救回来。这里兜住：初始化失败也要让进程活着、并在日志与清单里可见。
  register(ctx) {
    try {
      registerInner(ctx)
    } catch (e) {
      console.error('[wallpaper] register FAIL', e && e.stack ? e.stack : e)
      // v37 审查闭环（3）：初始化中途失败时，旧实例的样式表可能已经被删掉了 ——
      // 这里按盘上的持久化配置决定要不要把配色补回来（读不到/明确关闭时不擅自注入）。
      try {
        let persisted = null
        try { persisted = ctx.storage.get(STORE_KEY, null) } catch { persisted = null }
        if (!persisted || persisted.enabled !== false) ensureWallpaperCss()
      } catch {}
      try {
        host.notify({
          kind: 'error',
          durationMs: 6000,
          message: '壁纸插件初始化失败（已跳过本次装载，屏幕内容保持不变）：' + (e && e.message)
        })
      } catch {}
    }
  }
}
