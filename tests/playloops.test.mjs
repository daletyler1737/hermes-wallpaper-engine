// 播放模式（playLoops）纯逻辑自检 —— 直接从 plugin.js 里抠出真函数，用桩跑。
// 不重复实现一份逻辑：改了 plugin.js 里那两个函数，这里就跟着变；改坏就红。
// 跑法：node tests/playloops.test.mjs
import { readFileSync } from 'node:fs'

const src = readFileSync(new URL('../plugin.js', import.meta.url), 'utf8')

function pull(name) {
  const i = src.indexOf('function ' + name + '(')
  if (i < 0) throw new Error('找不到函数 ' + name)
  let depth = 0
  for (let k = src.indexOf('{', i); k < src.length; k++) {
    if (src[k] === '{') depth++
    else if (src[k] === '}') { depth--; if (depth === 0) return src.slice(i, k + 1) }
  }
  throw new Error('函数未闭合 ' + name)
}

const mk = (layer) => new Function('currentLayerEl', `${pull('wpAutoRotateAllowed')}
${pull('wpNextDelayMs')}
return { allowed: wpAutoRotateAllowed, delay: wpNextDelayMs }`)(() => layer)

let fail = 0
const eq = (got, want, msg) => {
  if (got !== want) { console.error('✗', msg, '→ 得到', got, '期望', want); fail++ }
  else console.log('✓', msg)
}

const none = mk(null)
const img = mk({ tagName: 'IMG' })
const vid = (d, r) => mk({ tagName: 'VIDEO', duration: d, playbackRate: r })

eq(none.allowed({ rotate: false, playLoops: 0 }), false, '两个开关都关 → 不自动换')
eq(none.allowed({ rotate: false, playLoops: 2 }), true, '只开播放模式 → 自动换')
eq(none.allowed({ rotate: true }), true, '只开定时轮换 → 自动换')
eq(none.allowed({ rotate: true, playLoops: 2, locked: true }), false, '锁定优先 → 不换')
eq(none.delay({ playLoops: 0, intervalMin: 15 }), 900000, '关播放 → 按分钟间隔')
eq(none.delay({ playLoops: 3, intervalMin: 15 }), 900000, '没图层可测时长 → 退回分钟')
eq(img.delay({ playLoops: 3, intervalMin: 15 }), 900000, '图片壁纸 → 退回分钟')
eq(vid(10, 1).delay({ playLoops: 2, intervalMin: 15 }), 20000, '10s 视频播 2 遍 = 20s')
eq(vid(10, 2).delay({ playLoops: 2, intervalMin: 15 }), 10000, '2 倍速 → 时间减半')
eq(vid(NaN, 1).delay({ playLoops: 2, intervalMin: 5 }), 300000, '时长未知 → 退回分钟')
eq(vid(20000, 1).delay({ playLoops: 2, intervalMin: 15 }), 240 * 60000, '超长（>240 分钟）→ 封顶 240 分钟')
eq(vid(0.2, 1).delay({ playLoops: 1, intervalMin: 1 }), 5000, '极短视频 → 下限 5s')

console.log(fail ? `\n${fail} 条失败` : '\n全绿')
process.exit(fail ? 1 : 0)
