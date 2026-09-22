# -*- coding: utf-8 -*-
"""壁纸缩略图生成器 — 按视频时长比例抽帧，挑对比度最高的一帧，避开近黑/纯白帧。
输出到插件自己的 thumbs/ 目录：steam_<工坊ID>.jpg （宽 256，约 15-25KB）
用法：python make_thumbs.py [--limit N] [--jobs 1]
"""
import os, re, subprocess, sys, shutil

HERE = os.path.dirname(os.path.abspath(__file__))
PLUGIN_DIR = os.path.dirname(HERE)
THUMBS = os.path.join(PLUGIN_DIR, 'thumbs')
ROOTS = [
    r"E:\Program Files (x86)\steam\steamapps\workshop\content\431960",
    r"F:\Program Files (x86)\steam\steamapps\workshop\content\431960",
]
VID = {'.mp4', '.webm', '.avi', '.mov', '.mkv', '.flv', '.m4v', '.wmv', '.mpg'}
IMG = {'.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp', '.apng', '.avif'}
MINOK = 2048
CF = 0x08000000  # CREATE_NO_WINDOW

# ── ffmpeg / ffprobe 定位 ────────────────────────────────────────────
def _find(name):
    p = shutil.which(name)
    if p:
        return p
    for dp, dn, fn in os.walk(r"C:\Users\1\AppData\Local\hermes"):
        for f in fn:
            if f.lower() in (name, name + '.exe'):
                return os.path.join(dp, f)
    return None

FF = _find('ffmpeg')
FP = _find('ffprobe')
if not FF:
    print('NO_FFMPEG'); sys.exit(2)

def _run(args, timeout=120):
    try:
        p = subprocess.run(args, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                           timeout=timeout, creationflags=CF)
        return p.stdout.decode('utf8', 'ignore'), p.returncode
    except Exception as e:
        return str(e), -1

def duration(src):
    """秒；拿不到就返回 0（当作短文件处理）"""
    if not FP:
        return 0.0
    out, rc = _run([FP, '-v', 'error', '-show_entries', 'format=duration',
                    '-of', 'csv=p=0', src], 30)
    try:
        return float(out.strip().splitlines()[0])
    except Exception:
        return 0.0

RX = re.compile(r'lavfi\.signalstats\.(\w+)=([\d.]+)')

def grab(src, t, out, tag=0, seek=True, lift=0.0):
    """在 t 秒抽一帧 -> out.tmp<tag>.jpg，返回 (tmp, (yavg,ymin,ymax)) 或 None

    seek=False 用于静态图片输入：对单图加 -ss 会产出空文件但 rc 仍是 0（静默失败）。
    lift>0 时先提亮再统计（暗壁纸提亮后卡片才看得清内容）。
    """
    tmp = os.path.join(os.path.dirname(out), '_tmp',
                       '%s.tmp%s.jpg' % (os.path.basename(out), tag))
    os.makedirs(os.path.dirname(tmp), exist_ok=True)   # 中间帧放 _tmp/，别混进 thumbs/*.jpg 被插件当壁纸列出来
    if os.path.exists(tmp):
        try: os.remove(tmp)
        except Exception: pass
    args = [FF, '-y', '-v', 'info']
    if seek:
        args += ['-ss', str(t)]
    vf = 'scale=256:-2,' + (('eq=brightness=%.3f:contrast=1.12,' % lift) if lift > 0 else '') + \
         'signalstats,metadata=print'
    args += ['-i', src, '-frames:v', '1', '-vf', vf, '-q:v', '5', tmp]
    txt, rc = _run(args)
    if not (os.path.exists(tmp) and os.path.getsize(tmp) > MINOK):
        if os.path.exists(tmp):
            try: os.remove(tmp)
            except Exception: pass
        return None
    d = dict(RX.findall(txt))
    try:
        st = (float(d['YAVG']), float(d['YMIN']), float(d['YMAX']))
    except Exception:
        st = (128.0, 0.0, 255.0)   # 拿不到统计就当合格
    return (tmp, st)

def is_bad(st):
    yavg, ymin, ymax = st
    return yavg < 28 or (yavg > 234 and (ymax - ymin) < 25)

def points_for(dur, is_vid):
    """候选时间点：避开开头（logo/淡入），按比例取 3 个"""
    if not is_vid:
        return [0.0]
    if dur <= 0:
        return [0.0, 1.0, 3.0, 6.0]
    pts = [dur * 0.35, dur * 0.6, dur * 0.85]
    pts = [max(2.0, min(p, 60.0)) for p in pts]
    pts = [p for p in pts if p < max(1.0, dur - 0.3)] or [max(0.5, dur * 0.5)]
    seen, uniq = set(), []
    for p in pts:
        k = round(p, 1)
        if k not in seen:
            seen.add(k); uniq.append(p)
    return uniq

def drop(b):
    if b:
        try: os.remove(b[1])
        except Exception: pass

def best_frame(src, out, is_vid, tagbase=0):
    """在单个源上抽候选帧，返回其中最好的一帧 (key, tmp, st, t, dur)（不落地）"""
    dur = duration(src) if is_vid else 0.0
    best = None
    for i, t in enumerate(points_for(dur, is_vid)):
        r = grab(src, t, out, tagbase + i, is_vid)
        if not r:
            continue
        tmp, st = r
        key = (1 if is_bad(st) else 0, -(st[2] - st[1]))
        if best is None or key < best[0]:
            drop(best)
            best = (key, tmp, st, t, dur, src, is_vid)
        else:
            try: os.remove(tmp)
            except Exception: pass
    return best

def make_best(srcs, out):
    """多个候选源（视频 / 图片 / Steam 封面）逐一试，取全局最好的一帧；拿到好帧就停。

    ponytail: 最多试前 4 个候选源。图片源（透明 PNG 常见全黑）拿不到好帧时靠后面的
    preview.jpg 兜底，不穷举目录里所有图。
    """
    best = None
    for k, (src, is_vid) in enumerate(srcs[:4]):
        b = best_frame(src, out, is_vid, k * 10)
        if b and (best is None or b[0] < best[0]):
            drop(best)
            best = b
        else:
            drop(b)
        if best and not best[0][0]:
            break
    if best is None:
        return False, 'no-frame'
    key, tmp, st, t, dur, src, is_vid = best
    # 源本身就暗（壁纸和 Steam 封面都暗）→ 提亮重出，否则卡片是一块黑
    lifted = False
    if is_bad(st) and st[0] < 28:
        lift = min(0.22, (60.0 - st[0]) / 255.0)
        r = grab(src, t, out, 97, is_vid, lift)
        if r and not is_bad(r[1]):
            try: os.remove(tmp)
            except Exception: pass
            tmp, st, lifted = r[0], r[1], True
        elif r:
            try: os.remove(r[0])
            except Exception: pass
    if os.path.exists(out):
        try: os.remove(out)
        except Exception: pass
    os.replace(tmp, out)
    tag = ('BAD' if is_bad(st) else 'ok') + ('+lift' if lifted else '')
    return True, '%s t=%.1fs/%s yavg=%.0f range=%.0f' % (
        tag, t, ('%.1fs' % dur) if dur else '-', st[0], st[2] - st[1])

def main():
    limit = 0
    ids = None
    for i, a in enumerate(sys.argv):
        if a == '--limit' and i + 1 < len(sys.argv):
            limit = int(sys.argv[i + 1])
        if a == '--ids' and i + 1 < len(sys.argv):
            ids = set(sys.argv[i + 1].split())
    os.makedirs(THUMBS, exist_ok=True)

    items = []
    for root in ROOTS:
        if not os.path.isdir(root):
            continue
        for name in sorted(os.listdir(root)):
            d = os.path.join(root, name)
            if name.isdigit() and os.path.isdir(d):
                items.append((name, d))
    print('库条目 =', len(items), ' 输出 =', THUMBS)
    if ids:
        items = [it for it in items if it[0] in ids]
        print('  仅处理指定 %d 个' % len(items))

    done = bad_cnt = fail = 0
    bad_list = []
    for idx, (wid, d) in enumerate(items):
        if limit and done + fail >= limit:
            break
        vids, imgs = [], []
        for f in os.listdir(d):
            p = os.path.join(d, f)
            if not os.path.isfile(p):
                continue
            e = os.path.splitext(f)[1].lower()
            try: sz = os.path.getsize(p)
            except Exception: sz = 0
            if e in VID: vids.append((sz, p))
            elif e in IMG: imgs.append((sz, p))
        pv = os.path.join(d, 'preview.jpg')
        vids.sort(reverse=True); imgs.sort(reverse=True)
        srcs = []
        for sz, p in vids[:1]:
            if sz > 400 * 1024 * 1024:
                continue          # 超大视频 seek 极慢/易超时 → 让封面兜底
            srcs.append((p, True))
        srcs += [(p, False) for sz, p in imgs if p != pv][:3]
        if os.path.isfile(pv):
            srcs.append((pv, False))
        if not srcs and vids:
            srcs = [(vids[0][1], True)]
        if not srcs:
            fail += 1; print('  ✗ %s 无媒体文件' % wid); continue
        out = os.path.join(THUMBS, 'steam_%s.jpg' % wid)
        ok, info = make_best(srcs, out)
        if ok:
            done += 1
            if info.startswith('BAD'):
                bad_cnt += 1; bad_list.append(wid)
            if done % 20 == 0 or idx == len(items) - 1:
                print('  ... %d/%d' % (done, len(items)), flush=True)
        else:
            fail += 1; print('  ✗ %s 抽帧失败' % wid, flush=True)

    small = [f for f in os.listdir(THUMBS)
             if f.endswith('.jpg') and os.path.getsize(os.path.join(THUMBS, f)) < MINOK]
    print('生成 =', done, ' 其中仍偏黑/白 =', bad_cnt, ' 失败 =', fail)
    print('thumbs 合计 =', len([f for f in os.listdir(THUMBS) if f.endswith('.jpg')]),
          ' 小于2KB =', len(small))
    if bad_list:
        print('偏黑/白清单:', ' '.join(bad_list[:40]))

if __name__ == '__main__':
    main()
