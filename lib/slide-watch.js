/**
 * 页面里的「换页看门狗」。
 *
 * 要认的是讲义 / PPT / 板书 —— 老师翻页时抓一张留档，讲同一页时不用抓。
 * 两条判据合起来才动手：
 *
 *   1. 像一张幻灯片（flat）：画面里极亮（>232）或极暗（<24）的像素占得够多。
 *      白底讲义、黑底课件都满足；实拍视频里天空、白墙再亮也到不了纯白成片。
 *   2. 画面停住了（still）：连续两次采样几乎不变。翻页之后会定下来，而镜头不会。
 *
 * 只有一条容易被骗 —— 电视剧里人物静止的特写会「停」，实拍视频里也有过曝的地方。
 * 两条同时成立，才认为是「翻到了新的一页」。
 *
 * 为什么整段放页面里：这一层每 1.2 秒跑一次，走 AppleScript 每帧一次 osascript
 * 是 0.15 秒起步，95% 的运算会浪费在「画面没变」上。放页面里就是一段 setInterval，
 * 宿主每隔几秒来搬一次新页就够了。
 *
 * 页面里攒的东西挂在 window.__LT_WATCH / __LT_SLIDES，宿主用 /slides 按游标搬。
 */
(function () {
  'use strict'

  // 版本号：宿主那边也有一个同名的 WATCH_VER，改了脚本行为两边一起改。
  // 不一致时旧的看门狗会被停掉、换成新的 —— 否则页面里跑了旧逻辑，打死也调不出来。
  var VER = 3
  var cur = window.__LT_WATCH
  if (cur) {
    if (cur.ver === VER) return 'already:' + cur.n + ':' + VER
    try {
      cur.stop()
    } catch (e) {
      /* 旧版本可能没有 stop，删掉引用就够 */
    }
    delete window.__LT_WATCH
    delete window.__LT_SLIDES
  }

  var TICK = 1200 // 多久看一眼，毫秒
  var MIN_GAP = 2600 // 两次记录之间至少隔这么久，防抖
  var DIST = 12 // 跟「上次抓的那张」比，64 位 dHash 差超过这么多才算换了页
  var STILL_D = 3 // 跟「上一次采样」比，差得比这个还小就算画面没动
  var STILL_MIN = 3 // 连续这么多次没动，才认「定住了」（3 次 ≈ 3.6 秒）
  var FLAT_MIN = 0.3 // 极亮或极暗像素的比例下限
  var EDGE_MIN = 0.02 // 有明显反差的相邻像素占比下限 —— 挡住纯黑场/纯白闪屏
  var MAX_KEEP = 60 // 页面里最多攒这么多张，宿主不来搬就丢最老的
  var BIG_W = 1280 // 留档大图的宽

  // 宿主注入时会把磁盘上已有的最大编号塞进来，接着往下数
  var START = window.__LT_START__ || 0

  var st = {
    ver: VER,
    n: START, // 已经记录到第几张（游标）
    hash: null, // 上一次采样的指纹
    shotHash: null, // 上一次真正抓图时的指纹
    still: 0, // 连续多少次画面没动
    lastAt: 0, // 上一张记录的播放位置（秒）
    lastFlat: 0,
    timer: null,
    slides: [],
  }
  window.__LT_WATCH = st
  window.__LT_SLIDES = st.slides

  // 指纹：9x8，每行 8 个「左边比右边亮」的比较位 —— 一共 64 位
  var thumb = document.createElement('canvas')
  thumb.width = 9
  thumb.height = 8
  var tctx = thumb.getContext('2d', { willReadFrequently: true })

  // 统计：32x24 够看出「是不是大片纯色」，又不至于每帧都吃力
  var stat = document.createElement('canvas')
  stat.width = 32
  stat.height = 24
  var sctx = stat.getContext('2d', { willReadFrequently: true })

  function luma(d, i) {
    return d[i] * 299 + d[i + 1] * 587 + d[i + 2] * 114
  }

  function fingerprint(v) {
    try {
      tctx.drawImage(v, 0, 0, 9, 8)
    } catch (e) {
      return null
    }
    var d = tctx.getImageData(0, 0, 9, 8).data
    var bits = []
    for (var y = 0; y < 8; y++) {
      for (var x = 0; x < 8; x++) {
        var i = (y * 9 + x) * 4
        bits.push(luma(d, i) > luma(d, i + 4) ? 1 : 0)
      }
    }
    return bits
  }

  /**
   * 两个便宜的特征：
   *   flat —— 极亮或极暗像素的占比。白底讲义、黑底课件都高，实拍画面低。
   *   edge —— 相邻像素明显反差的占比。有字才有边；纯黑场、纯白闪屏都接近 0。
   * 只有 flat 一个的话，转场黑屏、过曝的天空都会被当成一页，实际什么都没有。
   */
  function stats(v) {
    try {
      sctx.drawImage(v, 0, 0, 32, 24)
    } catch (e) {
      return { flat: 0, edge: 0 }
    }
    var d = sctx.getImageData(0, 0, 32, 24).data
    var W = 32
    var H = 24
    var flat = 0
    var edge = 0
    for (var y = 0; y < H; y++) {
      for (var x = 0; x < W; x++) {
        var i = (y * W + x) * 4
        var l = luma(d, i) / 1000
        if (l > 232 || l < 24) flat++
        if (x > 0 && Math.abs(l - luma(d, i - 4) / 1000) > 40) edge++
      }
    }
    return { flat: flat / (W * H), edge: edge / (W * H) }
  }

  function distance(a, b) {
    if (!a || !b) return 64
    var n = 0
    for (var i = 0; i < a.length; i++) if (a[i] !== b[i]) n++
    return n
  }

  function shoot(v) {
    try {
      if (!v.videoWidth) return null
      var c = document.createElement('canvas')
      c.width = Math.min(v.videoWidth, BIG_W)
      c.height = Math.round((c.width * v.videoHeight) / v.videoWidth)
      c.getContext('2d').drawImage(v, 0, 0, c.width, c.height)
      return {
        url: c.toDataURL('image/jpeg', 0.82),
        width: c.width,
        height: c.height,
      }
    } catch (e) {
      return null
    }
  }

  function record(v, at, d, flat, edge) {
    var shot = shoot(v)
    if (!shot) return
    st.n++
    st.slides.push({
      i: st.n,
      at: at,
      dist: d,
      flat: Math.round(flat * 100) / 100,
      edge: Math.round(edge * 100) / 100,
      w: shot.width,
      h: shot.height,
      url: shot.url,
    })
    while (st.slides.length > MAX_KEEP) st.slides.shift()
    st.lastAt = at
    st.shotHash = st.hash
  }

  function tick() {
    var v = document.querySelector('video')
    if (!v || !v.videoWidth || v.readyState < 2) return

    var bits = fingerprint(v)
    if (!bits) return

    var at = +v.currentTime.toFixed(1)
    var first = st.hash === null
    var d = distance(st.hash, bits) // 跟上一帧比：判断「动没动」
    var f = stats(v)
    var flat = f.flat
    var edge = f.edge
    st.lastFlat = flat
    st.lastEdge = edge

    if (first) {
      // 进页面时先记一张（多半是讲义第一页），然后开始盯着
      if (flat >= FLAT_MIN && edge >= EDGE_MIN) record(v, at, 0, flat, edge)
      else st.shotHash = bits
    } else {
      st.still = d < STILL_D ? st.still + 1 : 0

      var moved = distance(st.shotHash, bits) // 跟上次抓的那张比：判断「换没换页」
      var settled = st.still >= STILL_MIN
      var looksSlide = flat >= FLAT_MIN && edge >= EDGE_MIN
      var spaced = at - st.lastAt >= MIN_GAP / 1000

      if (settled && looksSlide && moved >= DIST && spaced) {
        record(v, at, moved, flat, edge)
      }
    }

    st.hash = bits
  }

  st.timer = setInterval(tick, TICK)
  st.stop = function () {
    clearInterval(st.timer)
    st.timer = null
    delete window.__LT_WATCH
  }
  tick()
  return 'watching:' + (document.querySelector('video') ? 'video' : 'novideo')
})()
