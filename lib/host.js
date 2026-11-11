// DSH「听课助手」· 宿主半边
//
// 干三件事：
//   1. 读：用 osascript（JXA）去问 Safari 里那个正在播的 <video>，拿到
//      当前播放到第几秒、总长多少、暂停没有、这一集叫什么、BV 号是什么。
//      —— 这条路不需要浏览器扩展（这台机器只有 Safari，Safari 扩展要 Xcode 签名，
//         装不了），实测单次 0.15 秒，够做"跟着播放走"。
//   2. 找：把讲解稿按「BV号 + 集标题」认领（见下面 keyOf 的注释，为什么不能只用 ?p=）。
//   3. 动：让视频跳到你点的那一段（video.currentTime = t），以及播放/暂停/快退。
//
// 讲解稿本身**不由这个插件生成**。面板上那个"生成讲解"按钮只负责往活着的
// agent 收件箱里推一条消息（agent.followup），真正写稿的是 DSH 里的 agent ——
// 它有人格、有 bili_subtitle 工具、有 write 工具，插件里再造一个只会更差。
//
// ⚠ 为什么用 execFile 而不是 ctx.subprocess.spawn：
//   spawn 的 spec 里 argv/cwd/stdio/graceMs 都要显式填、没有默认值，写起来比
//   直接 node:child_process 啰嗦一圈，而这里只需要跑一条 osascript。

import { execFile } from 'node:child_process'
import { promises as fsp, watch } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const name = 'listen-tutor'

// ⚠ 只声明 webServer。agents 用 ctx.get('agents') 软取 —— 万一哪天宿主没装
//   这个服务，插件照样该起来，只是"生成讲解"那个按钮会报没连上，而不是整包失活。
export const inject = ['webServer']

const HOME = os.homedir()
const DATA_DIR = path.join(HOME, '.dsh', 'listen-tutor')
const LESSON_DIR = path.join(DATA_DIR, 'lessons')
const FRAME_DIR = path.join(DATA_DIR, 'frames')
const SLIDE_DIR = path.join(DATA_DIR, 'slides')
const ASK_DIR = path.join(DATA_DIR, 'asks')
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json')

const ROUTE = '/x-listen-tutor'

// ---------- 总开关 ----------

/**
 * 插件自己的电源开关，存在 SETTINGS_FILE，默认开。
 *
 * 关掉之后心跳还在跑 —— 不然用户点了面板上的「停」，就再也没人能把它打开。
 * 但关着的时候不再读播放进度、不再注入面板、不再抓页、不再搬页图，
 * 只保留一件事：看页面里有没有人点了开关。
 */
const settings = { enabled: true, autoLesson: true, updatedAt: 0 }

async function loadSettings() {
  try {
    const raw = await fsp.readFile(SETTINGS_FILE, 'utf8')
    const obj = JSON.parse(raw)
    if (obj && typeof obj.enabled === 'boolean') settings.enabled = obj.enabled
    if (obj && Number.isFinite(obj.updatedAt)) settings.updatedAt = obj.updatedAt
  } catch {
    // 第一次装、或者文件被删了：保持默认（开）
  }
}

async function saveSettings() {
  try {
    await fsp.writeFile(
      SETTINGS_FILE,
      JSON.stringify({ enabled: settings.enabled, updatedAt: settings.updatedAt }, null, 2),
      'utf8',
    )
  } catch {
    // 写不进去也不该让开关卡住，内存里那份照样生效
  }
}

/**
 * 浏览器开着吗。
 *
 * 用 pgrep 查进程，不起 osascript —— 一次约 10ms，而且不需要「自动化」权限。
 * 这一步很重要：Safari 没开的时候，原来每 3 秒都要白起一个 osascript 去问，
 * 问不到还要吞掉一个异常，纯属空转。
 */
function safariRunning() {
  return new Promise((resolve) => {
    try {
      execFile('pgrep', ['-x', 'Safari'], { timeout: 2000 }, (error) => {
        resolve(!error)
      })
    } catch {
      resolve(false)
    }
  })
}

/** 最近一次探测到的浏览器状态，只用来给 /switch 和日志看。 */
let browserAlive = null

// 面板上那个开关：点一下写 window.__LT_SWITCH，心跳来取。
const SW_TAKE_JS =
  "(function(){var s=window.__LT_SWITCH||null;if(s)window.__LT_SWITCH=null;return JSON.stringify(s||null);})()"

async function takeSwitch(state, log) {
  let r = null
  try {
    r = await actOnVideo(state.docIndex, SW_TAKE_JS)
  } catch {
    return { ok: false, reason: 'osascript-error' }
  }
  if (!r || !r.ok) return { ok: false, reason: 'act-failed' }
  const raw = String(r.r || '')
  if (!raw || raw === 'null') return { ok: true, took: false }
  let payload = null
  try {
    payload = JSON.parse(raw)
  } catch {
    return { ok: false, reason: 'bad-payload' }
  }
  if (!payload || typeof payload.on !== 'boolean') return { ok: false, reason: 'bad-payload' }
  settings.enabled = payload.on
  settings.updatedAt = Date.now()
  await saveSettings()
  try {
    log?.(`listen-tutor: 面板把开关拨到 ${payload.on ? '开' : '关'}`)
  } catch {}
  return { ok: true, took: true, enabled: settings.enabled }
}

// ---------- 问 Safari ----------

/**
 * 遍历 Safari 的每一个 window/tab，各自问一遍有没有 <video>。
 * 只要读到能播的 video 就返回，读不到返回 []。
 *
 * 注意 doJavaScript 的第二个参数是 JXA 的关键字参数 {in: doc}，
 * 少了它只会问最前面那个文档。
 */
const PROBE_SCRIPT = `
function run() {
  var safari = Application('Safari');
  var js = "(function(){var v=document.querySelector('video');if(!v)return JSON.stringify({ok:false});return JSON.stringify({ok:true,t:v.currentTime,d:v.duration,p:v.paused,rate:v.playbackRate,title:document.title,href:location.href});})()";
  var out = [];
  var ws = [];
  try { ws = safari.windows(); } catch (e) { ws = []; }
  for (var w = 0; w < ws.length; w++) {
    var tabs = [];
    try { tabs = ws[w].tabs(); } catch (e) { tabs = []; }
    for (var t = 0; t < tabs.length; t++) {
      var url = '';
      try { url = String(tabs[t].url() || ''); } catch (e) { continue; }
      // 只问 B站 的标签：别的标签不可能有我们要的视频，问了纯属白等 osascript。
      if (url.indexOf('bilibili.com') < 0) continue;
      try {
        var s = safari.doJavaScript(js, {in: tabs[t]});
        if (!s) continue;
        var o = JSON.parse(s);
        if (o && o.ok) { o.i = w * 1000 + t; o.u = url.slice(0, 120); out.push(o); }
      } catch (e) {}
    }
  }
  return JSON.stringify(out);
}
`

/**
 * 在指定标签里跑一段 JS，返回它 return 的字符串。
 *
 * idx 是 PROBE_SCRIPT 编出来的地址：window * 1000 + tab。
 * 这样后台标签也能操作 —— 用户切去查资料、挂在那儿不挡着他，
 * 面板和抓页照样往下走。idx 小于 1000 的老值仍按 window 索引兜底。
 */
function makeActScript() {
  return `
function run(argv) {
  var code = argv[0];
  var idx = Number(argv[1]) || 0;
  var safari = Application('Safari');
  var target = null;
  var wi = Math.floor(idx / 1000);
  var ti = idx % 1000;
  try {
    var ws = safari.windows();
    if (ws[wi]) {
      var tabs = ws[wi].tabs();
      if (tabs[ti]) target = tabs[ti];
    }
  } catch (e) {}
  if (!target) {
    try {
      var docs = safari.documents();
      if (docs[idx]) target = docs[idx];
    } catch (e) {}
  }
  if (!target) return JSON.stringify({ok:false,err:'no-doc'});
  try { return JSON.stringify({ok:true,r:safari.doJavaScript(code, {in: target})}); }
  catch (e) { return JSON.stringify({ok:false,err:String(e).slice(0,200)}); }
}
`
}

const ACT_SCRIPT = makeActScript()

// ---------- 抓这一集的 AI 字幕 ----------
//
// ★ 为什么不直接用 bili_subtitle 那个工具：
//   mcp_server.py 的 bili_subtitle(bvid) 里 cid 取的是 info["cid"]，
//   对多 P 视频那就是 **P1** 的 cid —— 你放到第 24 集，它照样给你 P1 的字幕。
//   （2026-11-10 实测：BV1va4y1J72r 有 24 P，bili_subtitle 返回 2 段，
//     内容是 P1 的开场白；而 P24 实际有 2474 段 ai-zh 字幕。）
//
//   所以改成**在页面里问**：B站 播放页自己就带着 __INITIAL_STATE__（p、pages[].cid、
//   bvid 全在里面），同源 fetch 加上登录 cookie，拿到的就是当前正在播的这一集。
//   不碰凭证、不依赖 Python 环境、也不用管 p 参数怎么传。
//
// ⚠ doJavaScript 不会等 Promise，所以拆成两次：
//   第一次把它发出去（结果挂到 window.__lt_sub），隔一会儿第二次去读。

const SUB_START_JS =
  "(function(){window.__lt_sub='pending';var f=async function(){try{" +
  "var st=window.__INITIAL_STATE__;" +
  "var bvid=st&&st.videoData?st.videoData.bvid:'';" +
  "var p=st&&st.p?st.p:1;" +
  "var pages=st&&st.videoData&&st.videoData.pages?st.videoData.pages:[];" +
  "var cid=pages[p-1]?pages[p-1].cid:(st&&st.videoData?st.videoData.cid:0);" +
  "var r=await fetch('//api.bilibili.com/x/player/v2?bvid='+bvid+'&cid='+cid,{credentials:'include'});" +
  "var j=await r.json();" +
  "var subs=(j.data&&j.data.subtitle&&j.data.subtitle.subtitles)||[];" +
  "if(!subs.length){window.__lt_sub=JSON.stringify({ok:false,reason:'no-subtitle'});return;}" +
  // 一条视频可以挂好几条字幕轨，顺序不固定。实测 P27 上 subtitles[0] 是 UP 主上传的
  // zh-Hans（内容是首歌的歌词），ai-zh 才是老师讲课的 AI 字幕。所以优先挑 ai-zh，
  // 没有再退回任意中文轨，最后才退回第一条。
  "var pick=null,i;" +
  "for(i=0;i<subs.length;i++){if(subs[i].lan==='ai-zh'){pick=subs[i];break;}}" +
  "if(!pick){for(i=0;i<subs.length;i++){var ln=String(subs[i].lan||'');if(ln.indexOf('zh')===0){pick=subs[i];break;}}}" +
  "if(!pick)pick=subs[0];" +
  "var u=pick.subtitle_url;if(!u){window.__lt_sub=JSON.stringify({ok:false,reason:'no-url'});return;}if(u.indexOf('//')===0)u='https:'+u;" +
  "var rr=await fetch(u);var jj=await rr.json();" +
  "var body=(jj.body||[]).map(function(x){return {from:Math.round(x.from*10)/10,to:Math.round(x.to*10)/10,content:x.content};});" +
  "window.__lt_sub=JSON.stringify({ok:true,bvid:bvid,cid:cid,p:p,lan:pick.lan,body:body});" +
  "}catch(e){window.__lt_sub=JSON.stringify({ok:false,err:String(e).slice(0,300)});}};f();return 'started';})()"

const SUB_READ_JS = "(function(){return window.__lt_sub||'pending';})()"

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * 抓当前这一集的字幕。返回 { ok, bvid, cid, p, lan, body:[{from,to,content}] }。
 * 一次 2474 段的集子大约 2 秒。
 */
async function grabSubtitle(docIndex) {
  const started = await actOnVideo(docIndex, SUB_START_JS)
  if (!started || started.ok !== true) return { ok: false, reason: 'inject-failed' }

  let sawPending = false
  for (let i = 0; i < 30; i += 1) {
    await sleep(250)
    const r = await actOnVideo(docIndex, SUB_READ_JS)
    if (!r || r.ok !== true) continue
    const raw = String(r.r || '')
    if (raw === 'pending') {
      sawPending = true
      continue
    }
    try {
      return JSON.parse(raw)
    } catch {
      return { ok: false, reason: 'bad-json' }
    }
  }
  return { ok: false, reason: sawPending ? 'timeout' : 'no-data' }
}


function runJxa(script, args = [], timeout = 6000) {
  return new Promise((resolve, reject) => {
    execFile(
      'osascript',
      ['-l', 'JavaScript', '-e', script, ...args.map(String)],
      { timeout, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          const msg = String(stderr || err.message || 'osascript failed').trim()
          reject(new Error(msg.slice(0, 400)))
          return
        }
        resolve(String(stdout || '').trim())
      },
    )
  })
}

// ---------- 小工具 ----------

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    // 注入到 B站 页面里的面板是另一个源（www.bilibili.com → 127.0.0.1:端口），
    // 想让它直接打我们的路由就必须放行跨源。只放行只读/自家视频控制，没敏感数据。
    'access-control-allow-origin': '*',
  })
  res.end(body)
}

function readBody(req) {
  return new Promise((resolve) => {
    let raw = ''
    req.setEncoding('utf8')
    req.on('data', (chunk) => {
      raw += chunk
      if (raw.length > 2 * 1024 * 1024) req.destroy()
    })
    req.on('end', () => {
      try {
        resolve(JSON.parse(raw || '{}'))
      } catch {
        resolve({})
      }
    })
    req.on('error', () => resolve({}))
  })
}

/** fnv1a 32 位，拿去把集标题压成一个短 hash。 */
function fnv1a(text) {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(36)
}

/** document.title 去掉站名后缀，就是这一集的名字。 */
function episodeTitle(rawTitle) {
  return String(rawTitle || '')
    .replace(/_哔哩哔哩_bilibili\s*$/i, '')
    .replace(/哔哩哔哩.*$/i, '')
    .trim()
}

function parseBvid(href) {
  const m = /\/video\/(BV[0-9A-Za-z]+)/.exec(String(href || ''))
  return m ? m[1] : ''
}

function parseP(href) {
  try {
    return new URL(href).searchParams.get('p') || ''
  } catch {
    return ''
  }
}

/**
 * ★ 为什么 key 里要带集标题，不只用 BV 号 + ?p=：
 *   2026-11-10 实测，一个合集播放的时候地址栏里**根本没有 ?p= 这一段**
 *   （https://www.bilibili.com/video/BV1va4y1J72r/?spm_id_from=333.788.videopod.episodes），
 *   切集是 SPA 里换的，URL 不动 —— 只认 p 的话，整个合集几十集都会撞到同一份讲解稿。
 *   document.title 会跟着集走（"循环-调节_哔哩哔哩_bilibili"），所以拿它做 key。
 */
function lessonKeyOf(bvid, ep) {
  if (!bvid) return ''
  return ep ? `${bvid}-${fnv1a(ep)}` : bvid
}

// ---------- 播放状态 ----------

let stateCache = { at: 0, data: null, pending: null }
const STATE_TTL_MS = 700

function shapeState(raw) {
  const title = episodeTitle(raw.title)
  const bvid = parseBvid(raw.href)
  return {
    ok: true,
    docIndex: raw.i,
    t: Number(raw.t) || 0,
    d: Number(raw.d) || 0,
    paused: Boolean(raw.p),
    rate: Number(raw.rate) || 1,
    title: raw.title || '',
    ep: title,
    href: raw.href || '',
    bvid,
    p: parseP(raw.href),
    key: lessonKeyOf(bvid, title),
    at: Date.now(),
  }
}

/** 拿（带 0.7 秒缓存的）当前状态。并发调用共用同一个进行中的请求。 */
function readState({ force = false } = {}) {
  const now = Date.now()
  if (!force && stateCache.data && now - stateCache.at < STATE_TTL_MS) {
    return Promise.resolve(stateCache.data)
  }
  if (stateCache.pending) return stateCache.pending

  stateCache.pending = (async () => {
    try {
      const raw = await runJxa(PROBE_SCRIPT)
      let list = []
      try {
        list = JSON.parse(raw || '[]')
      } catch {
        list = []
      }
      if (!Array.isArray(list) || list.length === 0) {
        const empty = { ok: false, reason: 'no-video', at: Date.now() }
        stateCache = { at: Date.now(), data: empty, pending: null }
        return empty
      }
      // 有多个标签都在放时，优先 B 站、优先正在播的那个。
      const shaped = list.map(shapeState)
      const bili = shaped.filter((x) => /bilibili\.com/i.test(x.href))
      const pool = bili.length > 0 ? bili : shaped
      const playing = pool.find((x) => !x.paused)
      const picked = playing || pool[0]
      stateCache = { at: Date.now(), data: picked, pending: null }
      return picked
    } catch (error) {
      const failed = {
        ok: false,
        reason: 'osascript-error',
        message: String(error && error.message ? error.message : error).slice(0, 300),
        at: Date.now(),
      }
      // 出错不缓存，下一次还能重试。
      stateCache = { at: 0, data: null, pending: null }
      return failed
    }
  })()

  return stateCache.pending
}

// ---------- 讲解稿 ----------

async function ensureDirs() {
  await fsp.mkdir(LESSON_DIR, { recursive: true })
  await fsp.mkdir(FRAME_DIR, { recursive: true })
  await fsp.mkdir(SLIDE_DIR, { recursive: true })
  await fsp.mkdir(ASK_DIR, { recursive: true })
}

async function readLesson(key) {
  if (!key) return null
  try {
    const raw = await fsp.readFile(path.join(LESSON_DIR, `${key}.json`), 'utf8')
    const parsed = JSON.parse(raw)
    parsed.segments = Array.isArray(parsed.segments) ? parsed.segments : []
    return parsed
  } catch {
    return null
  }
}

async function listLessons() {
  try {
    const names = await fsp.readdir(LESSON_DIR)
    const out = []
    for (const file of names) {
      if (!file.endsWith('.json')) continue
      try {
        const raw = await fsp.readFile(path.join(LESSON_DIR, file), 'utf8')
        const p = JSON.parse(raw)
        out.push({
          key: p.key || file.replace(/\.json$/, ''),
          bvid: p.bvid || '',
          ep: p.ep || '',
          title: p.title || '',
          duration: p.duration || 0,
          segments: Array.isArray(p.segments) ? p.segments.length : 0,
          generatedAt: p.generatedAt || '',
        })
      } catch {
        // 半截文件（正在写）就跳过，别把面板搞崩。
      }
    }
    out.sort((a, b) => String(b.generatedAt).localeCompare(String(a.generatedAt)))
    return out
  } catch {
    return []
  }
}

// ---------- 让视频动 ----------

async function actOnVideo(docIndex, code) {
  const raw = await runJxa(ACT_SCRIPT, [code, docIndex])
  try {
    return JSON.parse(raw || '{}')
  } catch {
    return { ok: false, err: 'bad-json' }
  }
}

// ---------- 抓画面 ----------

/**
 * 把播放器当前这一帧抓成 jpeg。
 *
 * 为什么不用 screencapture：那玩意儿抓的是整块屏幕（浏览器边框、弹幕、连我们
 * 自己那层面板都拍进去），还得先算窗口坐标。canvas.drawImage(video) 抓到的
 * 正好是解码后的干净一帧。B站 的源是 blob: 同源，画布不会被污染（实测通过）。
 *
 * doJavaScript 返回的是一整个 data URL，约 100KB 的 base64 —— osascript 的
 * stdout 吃得下（runJxa 的 maxBuffer 给了 4MB）。
 */
function frameStartJs(width, quality) {
  return `(function(){
  var v = document.querySelector('video');
  if (!v) return 'novideo';
  if (!v.videoWidth) return 'nodim:rs' + v.readyState;
  var c = document.createElement('canvas');
  c.width = Math.min(v.videoWidth, ${width});
  c.height = Math.round(c.width * v.videoHeight / v.videoWidth);
  var g = c.getContext('2d');
  try { g.drawImage(v, 0, 0, c.width, c.height) } catch (e) { return 'draw-err:' + e.message }
  try { window.__lt_frame = c.toDataURL('image/jpeg', ${quality}) } catch (e) { return 'taint:' + e.message }
  return 'ok:' + c.width + 'x' + c.height + ':' + window.__lt_frame.length;
})()`
}

const FRAME_READ_JS = "(function(){var d=window.__lt_frame||'';window.__lt_frame=null;return d;})()"

/**
 * 刚切集、或者暂停停在封面上时，视频只有元数据（readyState 1），videoWidth 是 0，
 * canvas 抓不到东西。往当前时间戳再挪一丁点，浏览器会去解一帧出来 —— 挪 0.1 毫秒，
 * 肉眼看不出跳，但足够把 readyState 顶到 2 以上。暂停状态也一样有效。
 */
const FRAME_NUDGE_JS = `(function(){
  var v = document.querySelector('video');
  if (!v) return 'novideo';
  try { v.currentTime = v.currentTime + 0.0001 } catch (e) { return 'nudge-err:' + e.message }
  return 'nudged:rs' + v.readyState;
})()`

async function grabFrame(docIndex, opts = {}) {
  const width = Math.max(320, Math.min(1920, Number(opts.width) || 1280))
  const quality = Math.max(0.3, Math.min(0.95, Number(opts.quality) || 0.78))

  // doJavaScript 不等 Promise，也不能一次既抓又读，所以拆两步：
  // 第一步把图挂到 window.__lt_frame 上，第二步把那个字符串捞回来。
  const started = await actOnVideo(docIndex, frameStartJs(width, quality))
  let tag = String((started && started.r) || '')

  if (!tag.startsWith('ok:') && tag.startsWith('nodim')) {
    await actOnVideo(docIndex, FRAME_NUDGE_JS)
    for (let i = 0; i < 8; i++) {
      await sleep(250)
      const again = await actOnVideo(docIndex, frameStartJs(width, quality))
      tag = String((again && again.r) || '')
      if (tag.startsWith('ok:')) break
    }
  }

  if (!tag.startsWith('ok:')) return { ok: false, reason: tag || 'start-failed' }

  const read = await actOnVideo(docIndex, FRAME_READ_JS)
  const dataUrl = String((read && read.r) || '')
  const matched = /^data:image\/(jpeg|png);base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl)
  if (!matched) return { ok: false, reason: 'frame-empty' }

  const size = tag.slice(3).split(':')[0].split('x')
  return {
    ok: true,
    ext: matched[1],
    bytes: Buffer.from(matched[2], 'base64'),
    width: Number(size[0]) || 0,
    height: Number(size[1]) || 0,
  }
}

/** 存成 <key>-<t秒>.jpg，返回绝对路径。t 也进文件名，一眼能看出是哪一刻。 */
async function saveFrame(state, frame) {
  const at = Math.round((Number(state.t) || 0) * 10) / 10
  const file = path.join(FRAME_DIR, `${state.key}-${Math.round(at * 10)}.${frame.ext}`)
  await fsp.writeFile(file, frame.bytes)
  return file
}

async function seekTo(docIndex, seconds) {
  const t = Math.max(0, Number(seconds) || 0)
  return actOnVideo(
    docIndex,
    `(function(){var v=document.querySelector('video');if(!v)return 'no-video';v.currentTime=${t};return 'ok';})()`,
  )
}

async function control(docIndex, action) {
  const code = {
    play: `(function(){var v=document.querySelector('video');if(!v)return 'no-video';v.play();return 'ok';})()`,
    pause: `(function(){var v=document.querySelector('video');if(!v)return 'no-video';v.pause();return 'ok';})()`,
    toggle: `(function(){var v=document.querySelector('video');if(!v)return 'no-video';if(v.paused){v.play();return 'play';}v.pause();return 'pause';})()`,
    back15: `(function(){var v=document.querySelector('video');if(!v)return 'no-video';v.currentTime=Math.max(0,v.currentTime-15);return 'ok';})()`,
    fwd15: `(function(){var v=document.querySelector('video');if(!v)return 'no-video';v.currentTime=Math.min(v.duration||1e9,v.currentTime+15);return 'ok';})()`,
  }[action]
  if (!code) return { ok: false, err: 'unknown-action' }
  return actOnVideo(docIndex, code)
}

// ---------- 找人写讲解稿 ----------

/**
 * 从活着的 agent 里挑一个能接 followup 的。
 *
 * ⚠ 一定 await followup：不接的话它会变成未处理的 rejection，
 *   Node 22 默认把整个宿主进程带走（speak-up 那边踩过这个坑，注释里写得很清楚）。
 */
function pickAgent(ctx) {
  const agents = ctx.get('agents')
  if (!agents || typeof agents.list !== 'function') return null
  let raw = []
  try {
    raw = agents.list() || []
  } catch {
    return null
  }
  if (!Array.isArray(raw)) return null
  // 倒着找：列表末尾通常是最近活跃的。
  for (let i = raw.length - 1; i >= 0; i -= 1) {
    const item = raw[i]
    const agent = typeof item === 'string' ? agents.get(item) : item
    if (agent && typeof agent.followup === 'function') return agent
  }
  return null
}

function buildRequestText(state, subtitle) {
  const dur = Math.round(state.d || 0)
  let subLine
  if (subtitle && subtitle.ok) {
    subLine =
      `字幕：已经抓好 ${subtitle.body.length} 段（带时间戳），存在 ${subtitle.path}。` +
      '直接读这个文件就行，**别调 bili_subtitle** —— 它只取 P1 的字幕，多 P 视频会拿错集。'
  } else if (subtitle && subtitle.reason === 'length-mismatch') {
    // 2026-11-11 实测踩到的坑：cid 明明对得上，B站 返回的 ai-zh 轨却是**别的视频**的内容
    // （P27 拿到的是 150 秒的科技广告，另一个 P 拿到的是首歌的歌词）。字幕长度和视频时长
    // 差得离谱，就当它不存在 —— 宁可让 agent 去看画面，也别拿错文本编一篇讲透稿。
    subLine =
      '字幕：**不可用**。B站 给这一集的字幕轨内容是别的视频（长度和本片对不上），已经丢掉。' +
      '别调 bili_subtitle（它只取 P1），也别信任何字幕。' +
      '\n改写办法：这门课是 PPT 授课，信息全在画面里 —— ' +
      `\n  a) 按时间均匀看画面：POST /x-listen-tutor/seek {"t":秒} 然后 GET /x-listen-tutor/frame?w=1280&q=0.8，` +
      '该接口会把图存到 ~/.dsh/listen-tutor/frames/，返回的 path 直接 read_image 看；' +
      `\n  b) 每 ${Math.max(30, Math.round(dur / 30))} 秒左右抓一张（本片约 ${Math.max(8, Math.min(40, Math.round(dur / 60)))} 张就够），` +
      '按画面内容切段写稿。'
  } else {
    subLine =
      `字幕：没抓到（${(subtitle && subtitle.reason) || 'unknown'}）。` +
      '可以试 bili_subtitle，但注意它只取 P1 的字幕，多 P 视频容易拿错集；拿不准就直说。'
  }
  return [
    '【听课助手】要写这一集的讲解稿了，写完存到文件里就好。',
    '',
    `课程：${state.ep || state.title}`,
    `链接：${state.href}`,
    `时长：${dur} 秒（${Math.round(dur / 60)} 分钟）`,
    `BV号：${state.bvid}`,
    `讲解稿 key：${state.key}`,
    `存到：~/.dsh/listen-tutor/lessons/${state.key}.json`,
    subLine,
    '',
    'JSON 结构（用 write 工具直接写这个文件）：',
    '{"key":"上面那个 key","bvid":"...","ep":"集标题","href":"...","duration":1234,',
    ' "generatedAt":"ISO 时间","style":"讲透式",',
    ' "segments":[{"t0":0,"t1":600,"title":"这段的小标题","body":"讲透的正文","points":["要点"]}]}',
    '',
    '要求：',
    '1. 按内容切 8~20 段，t0/t1 用字幕里的时间戳，铺满整个视频，不要留空档。',
    '2. 讲透式：每段 body 写清楚"这一段在讲什么 + 为什么这么做 + 关键推导或结论"；',
    '   医学课顺手补概念定义、机制、易混点、考点提示。',
    '3. 写完只回一句"写好了 <key>"，别把正文贴在聊天里。',
  ].join('\n')
}

// ---------- 把面板注进 B站 页面 ----------
//
// 用户要的是「在浏览器里」，不是「旁边再开一个 DSH 窗口」。
// 这台机器只有 Safari，装不了浏览器扩展（要 Xcode 签名），但 AppleScript 的
// doJavaScript 可以直接往正在播的页面里跑代码 —— 等于零成本的注入，不用扩展。
//
// 面板脚本（panel-inject.js）活在页面自己的上下文里，自己读 <video>.currentTime
// 判断讲到哪一段，不发任何网络请求：跨域、Safari 的私有网络拦截全绕开了。
// host 只负责两件事：把讲解稿塞进脚本开头注入进去；页面刷新后（脚本随之消失）
// 隔几秒看一眼，没了就放回去。

// 面板脚本的版本号。页面里跑的永远是"注入那一刻"的那份代码，改文件杀不掉它，
// 所以脚本自己也带一个 BUILD（两份必须同步），对不上就让页面拆了重建。
// 加这个是因为：段内逐句推进改的是 DOM 结构，光调 update() 换数据不换结构，改了等于没改。
const PANEL_BUILD = 5

const ALIVE_JS =
  "(function(){var p=window.__LT_PANEL__;return p?('alive:'+p.key+':'+(p.build||0)):'none';})()"

// 不做模块级缓存：只有真要注入时才走到这里（几百毫秒一次 osascript 都忍了，
// 读个十几 KB 的文件不算事），换来的好处是改了面板脚本不用重启宿主。
async function loadPanelTemplate() {
  return fsp.readFile(new URL('./panel-inject.js', import.meta.url), 'utf8')
}

// 哪几集正在写。面板靠它显示"正在写…"，而不是干等着看一片空白。
const pendingLessons = new Map()

/** 注入进页面的面板要靠它回头请求本地路由（B站 是 https，得知道 127.0.0.1 的端口）。 */
let panelOrigin = ''

/** 面板此刻要的数据：讲解稿 + 在不在写。注入和热推送都走这里，别各写一份。 */
async function buildPanelData(state) {
  const lesson = await readLesson(state.key)
  if (lesson) pendingLessons.delete(state.key)
  return {
    meta: {
      bvid: state.bvid || '',
      ep: state.ep || '',
      key: state.key || '',
      duration: state.d || 0,
      hasLesson: Boolean(lesson),
      writing: !lesson && pendingLessons.has(state.key),
      build: PANEL_BUILD,
      origin: panelOrigin,
      enabled: settings.enabled,
    },
    lesson,
  }
}

async function injectPanel(state) {
  if (!state || !state.ok || state.docIndex == null) return { ok: false, reason: 'no-doc' }
  const template = await loadPanelTemplate()
  const data = await buildPanelData(state)
  // ⚠ 替换必须用函数形式：讲解稿正文里只要出现 $& / $1 这种序列，
  //   字符串形式的 replace 会把它当替换模板吃掉，注入的脚本直接残废。
  const code = template.replace('__LT_DATA__', () => JSON.stringify(data))
  // 占位符只替换第一处。要是脚本里还有第二个（比如有人在注释里又写了一遍），
  // 真正的数据行就会带着裸标识符进页面，一进去就 ReferenceError、而且
  // doJavaScript 只回一个空串，非常难查。这里直接拦下来。
  if (code.includes('__LT_DATA__')) {
    return { ok: false, reason: 'template-has-extra-placeholder' }
  }
  const out = await actOnVideo(state.docIndex, code)
  const r = out && out.ok ? String(out.r || '') : ''
  if (r) return { ok: true, result: r.slice(0, 120) }
  return { ok: false, reason: (out && out.err) || 'script-returned-nothing' }
}

/** 页面刷新过面板就没了；问一句还活不活、停在哪一集。 */
async function panelAlive(docIndex) {
  const out = await actOnVideo(docIndex, ALIVE_JS)
  return out && out.ok ? String(out.r || 'none') : 'none'
}

/** 只在需要时注入：页面里没面板，或者面板还停在上一集。 */
async function ensurePanel(state) {
  if (!state || !state.ok || state.docIndex == null) return { ok: false, reason: 'no-doc' }
  const alive = await panelAlive(state.docIndex)
  if (alive === 'alive:' + state.key + ':' + PANEL_BUILD) return { ok: true, result: 'already-alive' }
  return injectPanel(state)
}

/** 讲解稿变了：把新数据推进页面里那个已经活着的面板，不重建 DOM、不打断播放。 */
async function pushLesson(state) {
  if (!state || !state.ok || state.docIndex == null) return { ok: false, reason: 'no-doc' }
  const alive = await panelAlive(state.docIndex)
  if (alive !== 'alive:' + state.key + ':' + PANEL_BUILD) return ensurePanel(state)
  const data = await buildPanelData(state)
  const code =
    '(function(){try{window.__LT_PANEL__.update(' +
    JSON.stringify(data) +
    ');return "updated";}catch(e){return "update-err:"+e.message;}})()'
  const out = await actOnVideo(state.docIndex, code)
  return out && out.ok ? { ok: true, result: out.r } : { ok: false, reason: (out && out.err) || 'push-failed' }
}

// ---------- 提问 ----------
//
// 面板里敲一个问题，宿主把它连同「这一页的画面 + 当前这段讲解 + 讲到第几秒」一起
// 打包丢给 DSH 里活着的 agent（用户正在聊的那个）。agent 想完把答案写成
// `<id>.answer.json`，目录监听再把它推进页面 —— 跟讲解稿走同一条推送路子。
//
// 为什么不在插件里直接调模型：宿主没有开箱的同步对话接口；agents.create 要
// sessionId + 持久化，为一次问答造一个会话太重。agent.followup 是现成的，而且
// 用户能在 DSH 窗口里看见自己问过什么、我怎么答的。

function fmtClock(sec) {
  const n = Math.max(0, Math.round(Number(sec) || 0))
  const h = Math.floor(n / 3600)
  const m = Math.floor((n % 3600) / 60)
  const s = n % 60
  const mm = String(m).padStart(2, '0')
  const ss = String(s).padStart(2, '0')
  return h ? `${h}:${mm}:${ss}` : `${m}:${ss}`
}

function newAskId(key) {
  return `${key}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
}

/** 取这一集的第 n 页图（按时间排），找不早于 t 的最近一张。 */
async function slideNear(key, t) {
  try {
    const dir = path.join(SLIDE_DIR, key)
    const names = (await fsp.readdir(dir)).filter((n) => /^\d+-[\d.]+\.(jpeg|png)$/.test(n))
    if (!names.length) return null
    let best = null
    for (const n of names) {
      const at = Number(n.replace(/^\d+-/, '').replace(/\.(jpeg|png)$/, '')) / 10
      if (!Number.isFinite(at)) continue
      if (at <= t + 1 && (!best || at > best.at)) best = { file: path.join(dir, n), at }
    }
    return best || { file: path.join(dir, names[0]), at: 0 }
  } catch {
    return null
  }
}

/** 学生提问要带给 agent 的上下文 —— 光一句问题，模型没法回答"这里"指的是哪儿。 */
async function buildAskPrompt(state, q, t) {
  const lesson = await readLesson(state.key)
  const segs = (lesson && lesson.segments) || []
  let cur = null
  for (const s of segs) if (t >= s.t0 && t < s.t1) cur = s
  const page = await slideNear(state.key, t)

  const lines = []
  lines.push('【听课助手 · 学生在 B站 页面上提问了】')
  lines.push(`视频：《${state.ep || '这一集'}》（${state.bvid}${state.p ? ' P' + state.p : ''}）`)
  lines.push(`学生看到的位置：${fmtClock(t)} / ${fmtClock(state.d)}`)
  if (cur) {
    lines.push(`正在讲的这一段（${fmtClock(cur.t0)}–${fmtClock(cur.t1)}）：${cur.title || ''}`)
    if (cur.body) lines.push(cur.body)
  }
  if (page) lines.push(`当前 PPT 页图：${page.file}（视频 ${fmtClock(page.at)} 处抓的，可以 read_image 看）`)
  lines.push('')
  lines.push(`学生问：${q}`)
  lines.push('')
  lines.push(
    '怎么回：直接回答，讲清楚为什么，别复述问题、别寒暄。他是在听课的间隙问的，' +
      '所以答得短一点、落在概念上。长度一两段就够，不要 markdown 标题。',
  )
  lines.push(`回完之后，把答案正文写进这个文件（纯文本，别加代码围栏）：`)
  lines.push(`  ${path.join(ASK_DIR, '__ASK_ID__' + '.answer.json')}`)
  lines.push('格式：{"id":"__ASK_ID__","a":"你的回答"}')
  return lines.join('\n')
}

/**
 * 把答案推进页面里的面板。面板没活着就算了 —— 用户切走了，答案留在盘上还能查。
 */
async function pushAnswer(state, payload) {
  if (!state || !state.ok || state.docIndex == null) return { ok: false, reason: 'no-doc' }
  const alive = await panelAlive(state.docIndex)
  if (!alive.startsWith('alive:')) return { ok: false, reason: 'no-panel' }
  const code =
    '(function(){try{window.__LT_PANEL__.answer(' +
    JSON.stringify(String(payload.id || '')) +
    ',' +
    JSON.stringify(String(payload.a || '')) +
    ');return "ok";}catch(e){return "err:"+e.message;}})()'
  const out = await actOnVideo(state.docIndex, code)
  return out && out.ok ? { ok: true, result: out.r } : { ok: false, reason: (out && out.err) || 'push-failed' }
}

async function submitAsk(ctx, state, q, t) {
  const agent = pickAgent(ctx)
  if (!agent) return { ok: false, reason: 'no-agent' }
  const id = newAskId(state.key)
  await fsp.writeFile(
    path.join(ASK_DIR, `${id}.json`),
    JSON.stringify(
      { id, key: state.key, ep: state.ep, bvid: state.bvid, t, q, askedAt: new Date().toISOString() },
      null,
      1,
    ),
    'utf8',
  )
  const text = (await buildAskPrompt(state, q, t)).split('__ASK_ID__').join(id)
  await agent.followup({
    id: `listen-tutor-ask-${id}`,
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'listen-tutor-ask' },
  })
  log(`listen-tutor: 学生提问已推给 agent（${id}）`)
  return { ok: true, id }
}


/** 页面里的面板不能直接 fetch 我们（Safari 拦 https→http 本机），问题挂在 window.__LT_ASK 上，这里来取。 */
const ASK_TAKE_JS =
  "(function(){var a=window.__LT_ASK||null;if(a)window.__LT_ASK=null;return JSON.stringify(a||null);})()"

/** 取一次面板挂上来的问题；有就送去让 agent 回答。 */
async function takeAsk(ctx, state) {
  let raw
  try {
    raw = await actOnVideo(state.docIndex, ASK_TAKE_JS)
  } catch {
    return { ok: false, reason: 'take-failed' }
  }
  const hit = raw && raw.ok ? raw.r : ''
  if (!hit || hit === 'null') return { ok: true, took: false }
  let payload = null
  try {
    payload = JSON.parse(hit)
  } catch {
    return { ok: false, reason: 'bad-json' }
  }
  if (!payload || !payload.q) return { ok: true, took: false }
  const out = await submitAsk(ctx, state, String(payload.q), Number(payload.t) || state.t)
  return { ok: out.ok, took: true, ...out }
}

// ---------- 换页看门狗 ----------
//
// 页面里那段脚本每 1.2 秒算一次画面指纹，变了才抓图。宿主这边只负责两件事：
// 保证它还在（页面刷新会丢）、定期把新页搬下来落盘。判断本身不在这里做 ——
// 每秒一次 osascript 会把 CPU 白烧掉，95% 的帧都是「画面没变」。

/** 必须和 lib/slide-watch.js 里的 VER 保持一致：对不上就把页面里旧的换掉。 */
const WATCH_VER = 3

const WATCH_ALIVE_JS = `(function(){
  var s = window.__LT_WATCH;
  return s ? ('already:' + s.n + ':' + (s.ver || 0)) : 'none';
})()`

/** 一次最多搬这么多张：每张 base64 约 200KB，搬多了 osascript 的输出会很难看。 */
const DRAIN_BATCH = 3

/** key → 已经搬走的最后一页编号。重启宿主会丢，靠扫目录补回来。 */
const slideCursor = new Map()

async function scanSlideCursor(key) {
  try {
    const names = await fsp.readdir(path.join(SLIDE_DIR, key))
    let max = 0
    for (const n of names) {
      const m = /^(\d+)-/.exec(n)
      if (m && Number(m[1]) > max) max = Number(m[1])
    }
    return max
  } catch {
    return 0
  }
}

/** 暂停时让页面里那个看门狗也停下：它每 1.2 秒做一次 canvas 采样，很轻，但没必要。 */
const WATCH_STOP_JS = `(function(){
  var s = window.__LT_WATCH;
  if (!s) return 'none';
  try { s.stop(); } catch (e) {}
  delete window.__LT_WATCH;
  delete window.__LT_SLIDES;
  return 'stopped';
})()`

/** key → 看门狗现在该不该跑。用内存记着，免得暂停期间每 3 秒还去起一次 osascript。 */
const watchState = new Map()

async function watchAlive(docIndex) {
  const out = await actOnVideo(docIndex, WATCH_ALIVE_JS)
  return out && out.ok ? String(out.r || 'none') : 'none'
}

/** 页面里没看门狗就放一个进去。已经在了就什么都不做。 */
async function ensureWatch(state) {
  if (!state || !state.ok || state.docIndex == null) return { ok: false, reason: 'no-doc' }
  const alive = await watchAlive(state.docIndex)
  const sameVer = alive.endsWith(':' + WATCH_VER)
  if (sameVer && (alive.startsWith('watching:') || alive.startsWith('already:'))) {
    watchState.set(state.key, 'running')
    return { ok: true, result: alive }
  }
  // 页面里的编号要接着磁盘上已有的最大编号往下数，否则重注入之后又从 1 开始，
  // 而游标还停在 18 —— 新页永远搬不下来。
  if (!slideCursor.has(state.key)) slideCursor.set(state.key, await scanSlideCursor(state.key))
  const start = slideCursor.get(state.key) || 0

  const body = await fsp.readFile(new URL('./slide-watch.js', import.meta.url), 'utf8')
  const code = `window.__LT_START__ = ${start};\n` + body
  const out = await actOnVideo(state.docIndex, code)
  if (!out || !out.ok) return { ok: false, reason: (out && out.err) || 'inject-failed' }
  watchState.set(state.key, 'running')
  return { ok: true, result: String(out.r || '') + ' start=' + start }
}

/**
 * 视频暂停/播完了：让页面里的看门狗也停掉，并且不再搬运。
 *
 * 用 watchState 记着当前该跑还是该停，只有真的从「跑着」变成「停了」时
 * 才起一次 osascript；之后每 3 秒的心跳只查一下内存，页面一点都不碰。
 * 恢复播放时 ensureWatch 会看见页面里已经没有 __LT_WATCH，重新注入并从
 * slideCursor 接着往下编号，不会重复抓、也不会漏。
 */
async function pauseWatch(state) {
  if (!state || !state.ok || state.docIndex == null) return { ok: false, reason: 'no-doc' }
  if (watchState.get(state.key) === 'stopped') return { ok: true, result: 'already-paused' }
  watchState.set(state.key, 'stopped')
  const out = await actOnVideo(state.docIndex, WATCH_STOP_JS)
  return { ok: true, result: (out && out.r) || 'stopped' }
}

function drainJs(since) {
  return `(function(){
  var s = window.__LT_WATCH;
  if (!s) return JSON.stringify({ ok: false, reason: 'not-watching' });
  var since = ${since};
  var out = [];
  for (var i = 0; i < s.slides.length && out.length < ${DRAIN_BATCH}; i++) {
    if (s.slides[i].i > since) out.push(s.slides[i]);
  }
  return JSON.stringify({ ok: true, total: s.n, took: out });
})()`
}

/**
 * 把页面里攒的新页搬下来存成 jpg。一次搬 DRAIN_BATCH 张，调用方循环到自己满意为止。
 * 文件名带序号和秒数：`017-1234.jpeg` = 第 17 页、视频 1234 秒处。
 */
async function drainSlides(state) {
  if (!state || !state.ok || !state.key) return { ok: false, reason: 'no-key' }
  const key = state.key
  if (!slideCursor.has(key)) slideCursor.set(key, await scanSlideCursor(key))

  const out = await actOnVideo(state.docIndex, drainJs(slideCursor.get(key) || 0))
  const raw = String((out && out.r) || '')
  let parsed = null
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { ok: false, reason: 'bad-payload' }
  }
  if (!parsed || !parsed.ok) return { ok: false, reason: (parsed && parsed.reason) || 'not-watching' }

  const dir = path.join(SLIDE_DIR, key)
  await fsp.mkdir(dir, { recursive: true })

  const saved = []
  for (const item of parsed.took || []) {
    const m = /^data:image\/(jpeg|png);base64,([A-Za-z0-9+/=]+)$/.exec(String(item.url || ''))
    if (!m) continue
    const at = Math.round((Number(item.at) || 0) * 10) / 10
    const file = path.join(dir, `${String(item.i).padStart(3, '0')}-${Math.round(at * 10)}.${m[1]}`)
    await fsp.writeFile(file, Buffer.from(m[2], 'base64'))
    slideCursor.set(key, item.i)
    saved.push({ file, i: item.i, at, dist: item.dist, width: item.w, height: item.h })
  }

  return {
    ok: true,
    key,
    ep: state.ep,
    watching: parsed.total,
    saved,
    cursor: slideCursor.get(key) || 0,
  }
}

/** 连搬几轮，直到页面里没有新页（或者搬够 limit 张）。 */
async function drainAll(state, limit = 12) {
  const all = []
  for (let i = 0; i < 8; i++) {
    const r = await drainSlides(state)
    if (!r.ok) return { ok: all.length > 0, ...r, saved: all }
    all.push(...(r.saved || []))
    if (!r.saved || r.saved.length < DRAIN_BATCH) {
      return { ok: true, key: r.key, ep: r.ep, watching: r.watching, cursor: r.cursor, saved: all }
    }
    if (all.length >= limit) break
  }
  const last = await drainSlides(state)
  return {
    ok: true,
    key: last.key,
    ep: last.ep,
    watching: last.watching,
    cursor: last.cursor,
    saved: all,
  }
}

// ---------- 整门课扫页（找出所有换页时刻） ----------
// 为什么要扫：讲解要「一页 PPT 一段」，段落边界就是换页时刻。靠用户边看边抓太慢，
// 所以直接让页面里的视频自己 seek 一遍：每步取一帧缩略图算指纹，跟上一帧差得多就是翻页了。
// 这一层没有 osascript 开销（一次注入，页面里自己跑），96 分钟大约三分钟扫完。
const SCAN_JS = `(function () {
  var v = document.querySelector('video');
  if (!v) return 'novideo';
  if (!v.duration) return 'nodur';
  var old = window.__LT_SCAN;
  if (old && old.running) return 'already';
  var st = { running: true, done: false, i: 0, total: 0, hits: [], err: '', origin: v.currentTime, step: 6 };
  window.__LT_SCAN = st;
  st.muted = v.muted; st.wasPaused = v.paused;
  function restore() {
    try { v.pause(); v.currentTime = st.origin; } catch (e) {}
    try { v.muted = st.muted; } catch (e) {}
    if (!st.wasPaused) { try { var q = v.play(); if (q && q.catch) q.catch(function () {}); } catch (e) {} }
  }
  // 后台标签的 setTimeout 会被 Safari 节流到分钟级（实测 5 分钟只走 1 步）。
  // MessageChannel 的 postMessage 是宏任务，不受该节流（实测 50 次 105ms）。
  // 节奏用 seeked 事件：seek 完成立刻抓帧，不靠定时器干等。
  var ch = new MessageChannel();
  var prev = null, prevHit = -999, i = 0, n = 0, step = 6, done = false, spin = 0;
  ch.port1.onmessage = function () { if (!done && ++spin > 400) fire(); };
  function fire() {
    if (done) return;
    done = true;
    try {
      var cur = grab();
      if (prev) {
        var d = dist(prev, cur);
        var t = i * step;
        if (d >= 8 && (t - prevHit) >= step * 1.5) { st.hits.push({ t: t, d: d }); prevHit = t; }
      }
      prev = cur;
    } catch (e) { st.err = String(e); }
    i++; st.i = i;
    next();
  }
  function next() {
    if (!st.running) { st.done = true; restore(); return; }
    if (i >= n) { st.running = false; st.done = true; restore(); return; }
    done = false; spin = 0;
    var once = function () {
      if (done) return;
      v.removeEventListener('seeked', once);
      fire();
    };
    v.addEventListener('seeked', once);
    try { v.currentTime = i * step; } catch (e) { st.err = String(e); st.running = false; st.done = true; restore(); return; }
    ch.port2.postMessage(0);
  }
  var c = document.createElement('canvas');
  c.width = 24; c.height = 14;
  var g = c.getContext('2d', { willReadFrequently: true });
  function grab() {
    g.drawImage(v, 0, 0, 24, 14);
    var d = g.getImageData(0, 0, 24, 14).data, out = [];
    for (var k = 0; k < d.length; k += 4) out.push((d[k] * 299 + d[k + 1] * 587 + d[k + 2] * 114) / 1000 | 0);
    return out;
  }
  function dist(a, b) {
    var m = 0;
    for (var k = 0; k < a.length; k++) if (Math.abs(a[k] - b[k]) > 18) m++;
    return m;
  }
  step = Math.max(3, Math.min(10, Math.round(v.duration / 1100)));
  st.step = step;
  n = Math.floor(v.duration / step) + 1;
  st.total = n;
  try { v.muted = true; var pr = v.play(); if (pr && pr.catch) pr.catch(function () {}); } catch (e) {}
  next();
  return 'started:' + step + ':' + n;
})()`

const SCAN_STATUS_JS =
  "(function(){var s=window.__LT_SCAN;return s?JSON.stringify({run:s.running,done:s.done,i:s.i,total:s.total,hits:s.hits.length,step:s.step,err:s.err}):'none';})()"

const SCAN_STOP_JS =
  "(function(){var s=window.__LT_SCAN;if(s){s.running=false;var v=document.querySelector('video');if(v){try{v.pause();v.currentTime=s.origin;v.muted=!!s.muted;if(!s.wasPaused){var q=v.play();if(q&&q.catch)q.catch(function(){})}}catch(e){}}}return 'stopped';})()"

const SCAN_HITS_JS =
  "(function(){var s=window.__LT_SCAN;return s?JSON.stringify({done:s.done,total:s.total,step:s.step,hits:s.hits}):'none';})()"

const scanJobs = new Map()

// ---------- 路由 ----------

export async function apply(ctx) {
  await ensureDirs().catch(() => {})
  await loadSettings().catch(() => {})

  // 面板要回头请求我们的路由（它跑在 www.bilibili.com 的源里），得知道端口。
  try {
    panelOrigin =
      (typeof ctx.webServer.getOrigin === 'function' && ctx.webServer.getOrigin()) || ''
  } catch {
    panelOrigin = ''
  }
  // 兜底留空：面板提问走的是页面变量信箱（window.__LT_ASK），不靠这个 origin。
  // 正常情况 getOrigin() 一定有值；真拿不到也别写死端口，别人装的端口不一样。

  const logger = ctx.logger
  const log = (msg) => {
    try {
      logger?.info?.(msg)
    } catch {
      // 记日志失败不该影响功能
    }
  }

  /** 统一回包：handler 只要 return 一个对象。 */
  const mount = (pathname, handler) => {
    // 把 register 放进 effect 里：插件卸载时自动摘掉路由，重载也不会挂两份。
    ctx.effect(() => {
      const dispose = ctx.webServer.register({
        kind: 'exact',
        path: `${ROUTE}${pathname}`,
        handler: async (req, res) => {
          try {
            const body = req.method === 'POST' ? await readBody(req) : {}
            const url = new URL(req.url || '/', 'http://127.0.0.1')
            const query = Object.fromEntries(url.searchParams.entries())
            const out = await handler({ req, body, query })
            sendJson(res, 200, out)
          } catch (error) {
            log(`listen-tutor: ${pathname} 出错：${error && error.message}`)
            sendJson(res, 500, {
              ok: false,
              error: String(error && error.message ? error.message : error).slice(0, 400),
            })
          }
        },
      })
      return () => dispose()
    })
  }

  // 面板保活：页面一刷新，注入进去的脚本就没了，隔几秒看一眼、没了就放回去。
  // 8 秒一次是因为每次都要起一个 osascript（实测约 0.15s），太密会白烧 CPU；
  // 真正的实时性不靠这个心跳 —— 面板进了页面之后自己每秒读 currentTime。
  ctx.effect(() => {
    let stopped = false
    // 关着的时候心跳不空转，但还得留一条缝让面板能把开关拨回来。
    let idle = 0

    const beat = async () => {
      if (stopped) return
      try {
        // 第一道闸：浏览器根本没开。这时候连 osascript 都不该起 ——
        // 原来每 3 秒问一次、问不到再吞掉一个异常，纯属空转。
        const alive = await safariRunning()
        browserAlive = alive
        if (!alive) return

        // 第二道闸：总开关关着。只做一件事 —— 看面板上有没有人把它拨开，
        // 降频到约 9 秒一次（关着的时候没必要每 3 秒起一次 osascript）。
        if (!settings.enabled) {
          idle += 1
          if (idle % 3 !== 0) return
          const idleState = await readState({})
          if (idleState.ok) await takeSwitch(idleState, log)
          return
        }
        idle = 0

        const state = await readState({})
        if (!state.ok) return
        // 开着的时候也要取件：面板上那个开关随时可以关。
        await takeSwitch(state, log)
        if (!settings.enabled) return
        await maybeAutoLesson(state)
        await ensurePanel(state)
        await takeAsk(ctx, state)
        // 换页看门狗：只在 B站 视频页里有意义（别的页面没有 video，也不该被塞脚本）。
        // 暂停/播完时就别抓了 —— 画面都不动了，抓到的还是同一张；
        // 而且按暂停往往是要走开，这时候还每 3 秒搬一次页很没道理。
        if (state.bvid) {
          if (state.paused) {
            await pauseWatch(state)
          } else {
            await ensureWatch(state)
            await drainSlides(state)
          }
        }
      } catch {
        // Safari 关着、页面正在加载、AppleScript 被系统拦……都不该把插件带崩
      }
    }
    const timer = setInterval(beat, 3000)
    if (typeof timer.unref === 'function') timer.unref()
    const kick = setTimeout(beat, 1500)
    if (typeof kick.unref === 'function') kick.unref()
    return () => {
      stopped = true
      clearInterval(timer)
      clearTimeout(kick)
    }
  })

  // 讲解稿一改，页面里的面板立刻换内容 —— 不用刷新页面、不用重新注入。
  // 「实时」是两半：面板自己每秒读播放位置，内容这边靠文件监听往里推。
  ctx.effect(() => {
    let watcher = null
    let timer = null
    try {
      watcher = watch(LESSON_DIR, { persistent: false }, (_event, file) => {
        const fname = String(file || '')
        if (!fname.endsWith('.json') || fname.endsWith('.subtitle.json')) return
        if (timer) return
        timer = setTimeout(async () => {
          timer = null
          try {
            await pushLesson(await readState({}))
          } catch {
            // JSON 还没落盘、Safari 正在切页……下一次事件再说
          }
        }, 350)
        if (typeof timer.unref === 'function') timer.unref()
      })
    } catch {
      // 目录没建出来就算了，早先 mkdir 过
    }
    return () => {
      if (timer) clearTimeout(timer)
      if (watcher) {
        try {
          watcher.close()
        } catch {}
      }
    }
  })

  // 学生提问的答案一落盘，就推进页面里的面板 —— 不用刷新，也不用他自己来找。
  // 答案文件是 agent 写的（见 buildAskPrompt 里给的那段格式），可能是半截，所以等 200ms。
  ctx.effect(() => {
    let watcher = null
    let timer = null
    const seen = new Set()
    try {
      watcher = watch(ASK_DIR, { persistent: false }, (_event, file) => {
        const fname = String(file || '')
        if (!fname.endsWith('.answer.json') || seen.has(fname)) return
        seen.add(fname)
        if (timer) return
        timer = setTimeout(async () => {
          timer = null
          try {
            const payload = JSON.parse(await fsp.readFile(path.join(ASK_DIR, fname), 'utf8'))
            const state = await readState({})
            if (!state.ok) return
            const out = await pushAnswer(state, payload)
            log(`listen-tutor: 答案 ${payload.id || fname} → 面板 ${out.ok ? 'ok' : out.reason}`)
          } catch {
            // 文件还没写完 / 面板不在 —— 下次事件再说
          }
        }, 200)
        if (typeof timer.unref === 'function') timer.unref()
      })
    } catch {
      // 目录没建出来就算了
    }
    return () => {
      if (timer) clearTimeout(timer)
      if (watcher) {
        try {
          watcher.close()
        } catch {}
      }
    }
  })

  // GET /state —— 现在播到哪、这一集叫什么、有没有讲解稿
  mount('/state', async ({ query }) => {
    // 现查一次浏览器，好让界面能说出「Safari 没开」而不是笼统的「没读到视频」
    const alive = await safariRunning()
    browserAlive = alive
    const flags = { safari: alive, enabled: settings.enabled }
    const state = await readState({ force: query.force === '1' })
    if (!state.ok) return { ...state, ...flags }
    const lesson = await readLesson(state.key)
    return {
      ...state,
      ...flags,
      hasLesson: Boolean(lesson),
      lessonMeta: lesson
        ? {
            segments: lesson.segments.length,
            generatedAt: lesson.generatedAt || '',
            style: lesson.style || '',
            title: lesson.title || '',
          }
        : null,
    }
  })

  // GET /lesson?key= —— 整份讲解稿
  mount('/lesson', async ({ query }) => {
    const key = query.key || ''
    const lesson = await readLesson(key)
    if (!lesson) return { ok: false, reason: 'not-found', key }
    return { ok: true, lesson }
  })

  // GET /lessons —— 写过的所有讲解稿
  mount('/lessons', async () => ({ ok: true, list: await listLessons() }))

  // POST /seek { t, docIndex }
  mount('/seek', async ({ body }) => {
    const state = await readState()
    const docIndex = Number.isInteger(body.docIndex) ? body.docIndex : state.docIndex || 0
    const r = await seekTo(docIndex, body.t)
    stateCache.at = 0
    return { ok: r.ok === true, raw: r }
  })

  // POST /control { action, docIndex }
  mount('/control', async ({ body }) => {
    const state = await readState()
    const docIndex = Number.isInteger(body.docIndex) ? body.docIndex : state.docIndex || 0
    const r = await control(docIndex, String(body.action || ''))
    stateCache.at = 0
    return { ok: r.ok === true, raw: r }
  })

  // GET /subtitle —— 当前这一集的 AI 字幕（带时间戳）
  mount('/subtitle', async () => {
    const state = await readState()
    if (!state.ok) return { ok: false, reason: state.reason || 'no-video' }
    const sub = await grabSubtitle(state.docIndex || 0)
    if (!sub.ok) return sub
    return {
      ok: true,
      bvid: sub.bvid,
      cid: sub.cid,
      p: sub.p,
      lan: sub.lan,
      count: (sub.body || []).length,
      body: sub.body || [],
    }
  })

  // 抓字幕 + 存盘 + 推一条消息给活着的 agent 让它写稿。
  // 手动按钮和「自动写稿」共用这一段，所以抽成闭包。
  const doRequestLesson = async (state) => {
    const agent = pickAgent(ctx)
    if (!agent) return { ok: false, reason: 'no-agent' }

    // 先把字幕抓下来存好 —— 这一步比让 agent 自己去调工具可靠（见 grabSubtitle 上面的注释）。
    let subtitle = await grabSubtitle(state.docIndex || 0)
    // 刚切集的那几秒，B站 的字幕接口还没换过来，常常只回一两段广告字幕
    // （实测：切到 P27 的瞬间只抓到「敲重点 ↓↓↓」一条，过几秒再抓就是 717 段）。
    // 所以段数太少就等一会儿重抓，最多三次。
    for (let attempt = 0; attempt < 2; attempt++) {
      if (!subtitle.ok || (subtitle.body || []).length >= 20) break
      log(`listen-tutor: 字幕只有 ${(subtitle.body || []).length} 段，等 4 秒重抓`)
      await sleep(4000)
      subtitle = await grabSubtitle(state.docIndex || 0)
    }
    // ★ 字幕可信度校验（2026-11-11 加的）。
    // 踩到的坑：cid 明明对得上（pages[26].cid === 页面 __INITIAL_STATE__ 里那个），
    // B站 player/v2 返回的 ai-zh 轨内容却是**别的视频** —— P27《肺通气功能的指标》
    // 拿到的是 150 秒的科技广告，另一集拿到的是首歌的歌词。B站 那边没有报错信号，
    // 只有「字幕最后一句的时间戳 ≈ 0.1 × 视频时长」这一个破绽。
    // 所以：字数太少、或者时长对不上（不到本片 60%），一律判定不可用，不让它进 prompt。
    if (subtitle.ok && Array.isArray(subtitle.body) && subtitle.body.length > 0) {
      const lastTo = Number(subtitle.body[subtitle.body.length - 1].to) || 0
      const dur = Number(state.d) || 0
      const tooShort = subtitle.body.length < 5
      const tooBrief = dur > 120 && lastTo < dur * 0.6
      if (tooShort || tooBrief) {
        log(
          `listen-tutor: 字幕不可信（${subtitle.body.length} 段，覆盖到 ${Math.round(lastTo)}s / 全片 ${Math.round(dur)}s），丢掉`,
        )
        subtitle = { ok: false, reason: 'length-mismatch' }
      }
    }

    if (subtitle.ok && Array.isArray(subtitle.body) && subtitle.body.length > 0) {
      const subPath = path.join(LESSON_DIR, `${state.key}.subtitle.json`)
      try {
        await fsp.writeFile(
          subPath,
          JSON.stringify(
            {
              bvid: subtitle.bvid,
              cid: subtitle.cid,
              p: subtitle.p,
              lan: subtitle.lan,
              ep: state.ep,
              href: state.href,
              fetchedAt: new Date().toISOString(),
              body: subtitle.body,
            },
            null,
            1,
          ),
          'utf8',
        )
        subtitle.path = subPath
      } catch (error) {
        log(`listen-tutor: 字幕存盘失败：${error && error.message}`)
        subtitle = { ok: false, reason: 'write-failed' }
      }
    }

    // 先告诉面板"在写了"，再推消息 —— 否则用户点完按钮盯着一个空白面板等几分钟
    pendingLessons.set(state.key, Date.now())
    try {
      await pushLesson(state)
    } catch {}

    const text = buildRequestText(state, subtitle)
    await agent.followup({
      id: `listen-tutor-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      role: 'user',
      content: [{ type: 'text', text }],
      source: { kind: 'listen-tutor' },
    })
    log(`listen-tutor: 已把 ${state.key} 的讲解请求推给 agent（字幕 ${subtitle.ok ? '有' : '无'}）`)
    return {
      ok: true,
      key: state.key,
      ep: state.ep,
      subtitle: subtitle.ok ? (subtitle.body || []).length : 0,
      subtitleReason: subtitle.ok ? '' : subtitle.reason || '',
    }
  }

  // 自动写稿：换到一集还没有讲解的视频，当场就抓字幕请 agent 写。
  // 同一集只自动写一次；只有失败（比如暂时没有活着的 agent）才放开重试。
  const autoSeen = new Set()
  const maybeAutoLesson = async (state) => {
    if (!state.ok || !state.bvid || !state.key) return
    if (settings.autoLesson === false) return
    if (state.hasLesson) {
      autoSeen.delete(state.key)
      return
    }
    if (pendingLessons.has(state.key) || autoSeen.has(state.key)) return
    // 一次只写一篇：同时开好几个标签也不至于把 agent 刷爆
    if (pendingLessons.size > 0) return
    autoSeen.add(state.key)
    log(`listen-tutor: 自动写稿 ${state.key}（${state.ep}）`)
    const r = await doRequestLesson(state)
    if (!r.ok) {
      autoSeen.delete(state.key)
      log(`listen-tutor: 自动写稿失败：${r.reason || 'unknown'}`)
    }
  }

  // POST /request-lesson —— 抓字幕、存盘、再推一条消息给活着的 agent 让它写稿
  mount('/request-lesson', async () => {
    const state = await readState({ force: true })
    if (!state.ok) return { ok: false, reason: state.reason || 'no-video' }
    return doRequestLesson(state)
  })

  // POST /ask —— 面板里提问：{"q":"为什么…","t":1234.5}
  // 宿主只管打包上下文 + 推给 agent，答案由 agent 写回文件、目录监听再推进面板。
  mount('/ask', async ({ body }) => {
    const q = String((body && body.q) || '').trim()
    if (!q) return { ok: false, reason: 'empty-question' }
    if (q.length > 800) return { ok: false, reason: 'question-too-long' }
    const state = await readState({ force: true })
    if (!state.ok) return { ok: false, reason: state.reason || 'no-video' }
    const t = Number(body && body.t)
    return submitAsk(ctx, state, q, Number.isFinite(t) && t >= 0 ? t : state.t)
  })

  // GET /ask?id= —— 查某一次提问的状态（排查用；面板走的是推送，不轮询这个）
  mount('/ask-status', async ({ query }) => {
    const id = String(query.id || '')
    if (!id) return { ok: false, reason: 'missing-id' }
    try {
      const ask = JSON.parse(await fsp.readFile(path.join(ASK_DIR, `${id}.json`), 'utf8'))
      let answer = null
      try {
        const a = JSON.parse(await fsp.readFile(path.join(ASK_DIR, `${id}.answer.json`), 'utf8'))
        answer = String((a && a.a) || '')
      } catch {}
      return { ok: true, ask, answered: answer !== null, answer }
    } catch {
      return { ok: false, reason: 'not-found' }
    }
  })

  // POST /scan —— 启动整门课扫页
  mount('/scan', async () => {
    const state = await readState({ force: true })
    if (!state.ok) return { ok: false, reason: state.reason || 'no-video' }
    if (scanJobs.get(state.key) === 'running') return { ok: false, reason: 'already-running' }
    const raw = await actOnVideo(state.docIndex, SCAN_JS)
    const r = (raw && raw.ok ? String(raw.r) : '') || ''
    if (!r.startsWith('started:')) return { ok: false, reason: r || 'start-failed' }
    scanJobs.set(state.key, 'running')
    const [, step, total] = r.split(':')
    return { ok: true, key: state.key, step: Number(step), total: Number(total) }
  })

  // GET /scan-status —— 扫到哪了
  mount('/scan-status', async ({ query }) => {
    const state = await readState({ force: true })
    if (!state.ok) return { ok: false, reason: state.reason || 'no-video' }
    if (query.stop) await actOnVideo(state.docIndex, SCAN_STOP_JS)
    const raw = await actOnVideo(state.docIndex, SCAN_STATUS_JS)
    const txt = raw && raw.ok ? String(raw.r) : 'none'
    if (txt === 'none') return { ok: true, key: state.key, none: true }
    let st = null
    try { st = JSON.parse(txt) } catch { return { ok: false, reason: 'bad-status' } }
    if (st.done) scanJobs.set(state.key, 'done')
    if (query.hits && st.done) {
      const rh = await actOnVideo(state.docIndex, SCAN_HITS_JS)
      try { st.hits = JSON.parse(String((rh && rh.r) || '')).hits || [] } catch {}
    }
    return { ok: true, key: state.key, ...st }
  })

  // 扫页只找出「哪几秒换了页」，页图还得真的把画面对准那一页再抓。
  // 每个命中点往后错 1.2 秒，避开翻页动画那几帧。
  mount('/scan-capture', async ({ query }) => {
    const state = await readState({ force: true })
    if (!state.ok) return state
    const raw = await actOnVideo(state.docIndex, SCAN_HITS_JS)
    let parsed = {}
    try { parsed = JSON.parse(String((raw && raw.r) || '{}')) } catch { parsed = {} }
    let hits = Array.isArray(parsed.hits) ? parsed.hits : []
    // ?ts=5,30,310 —— 直接给时刻表，不依赖页面里那次扫描的结果（重扫会把 hits 覆盖掉）
    if (query && query.ts) {
      hits = String(query.ts)
        .split(',')
        .map((s) => Number(String(s).trim()))
        .filter((n) => Number.isFinite(n) && n >= 0)
        .map((t) => ({ t }))
    }
    if (!hits.length) return { ok: false, reason: 'no-hits' }
    const limit = Number(query && query.limit) > 0 ? Number(query.limit) : hits.length
    const offset = Math.max(0, Number(query && query.offset) || 0)
    const slice = hits.slice(offset, offset + limit)
    const dir = path.join(SLIDE_DIR, state.key)
    await fsp.mkdir(dir, { recursive: true })
    // 视频暂停 + 页面在后台标签时，seek 之后浏览器根本不解码那一帧，
    // canvas 抓出来是一张纯黑。所以先静音播起来再抓，抓完把 muted 和位置还原。
    const prep = await actOnVideo(
      state.docIndex,
      "(function(){var v=document.querySelector('video');if(!v)return 'novideo';window.__LT_CAP={muted:v.muted,paused:v.paused,t:v.currentTime};v.muted=true;var q=v.play();if(q&&q.catch)q.catch(function(){});return 'playing:'+v.readyState;})()"
    )
    // 后台标签解码慢，seek 之后第一次 canvas 常常拿到整张纯黑（15KB 左右的 jpeg）。
    // 用「字节数太小 = 多半是黑图」当判据，踢一下再等/再抓，最多三轮。
    const SHOT_MIN_BYTES = 25000
    const NUDGE_JS = "(function(){var v=document.querySelector('video');if(!v)return 'novideo';try{if(v.paused){var q=v.play();if(q&&q.catch)q.catch(function(){})}v.currentTime=v.currentTime+0.04}catch(e){}return 'nudged:'+v.readyState+'p'+v.videoWidth;})()"
    const shot = async () => {
      let last = null
      for (let attempt = 0; attempt < 3; attempt++) {
        const frame = await grabFrame(state.docIndex, { width: 1280, quality: 0.82 })
        if (frame.ok && frame.bytes.length >= SHOT_MIN_BYTES) return frame
        last = frame
        await actOnVideo(state.docIndex, NUDGE_JS)
        await sleep(900)
      }
      return last
    }
    const items = []
    for (let k = 0; k < slice.length; k++) {
      const t = Number(slice[k].t) || 0
      const idx = offset + k + 1
      const early = await seekTo(state.docIndex, t + 1.2)
      if (!early || early.ok === false) { items.push({ i: idx, t, err: 'seek-failed' }); continue }
      await sleep(520)
      const frame = await shot()
      if (!frame.ok) { items.push({ i: idx, t, err: frame.reason }); continue }
      if (frame.bytes.length < SHOT_MIN_BYTES) { items.push({ i: idx, t, err: 'black-frame' }); continue }
      const name = `${String(idx).padStart(3, '0')}-${Math.round(t * 10)}.${frame.ext}`
      await fsp.writeFile(path.join(dir, name), frame.bytes)
      items.push({ i: idx, t, file: name, bytes: frame.bytes.length })
    }
    await seekTo(state.docIndex, state.t || 0)
    // 把 prep 动过的东西还原：静音状态、播放状态。位置上面已经 seek 回去了。
    await actOnVideo(
      state.docIndex,
      "(function(){var v=document.querySelector('video');if(!v)return 'novideo';var s=window.__LT_CAP||{};window.__LT_CAP=null;try{if(typeof s.muted==='boolean')v.muted=s.muted;if(s.paused){v.pause()}else{var q=v.play();if(q&&q.catch)q.catch(function(){})}}catch(e){}return 'restored';})()"
    )
    return { ok: true, key: state.key, total: hits.length, asked: slice.length, saved: items.filter((x) => !x.err).length, items }
  })

  // GET /switch —— 看开关和浏览器状态；POST /switch {on:true|false} —— 拨开关。
  // 面板上那个开关是另一条路（写 window.__LT_SWITCH 让心跳来取），
  // 因为 B站 页面是 https，直接 fetch 本机 http 会被 Safari 拦掉。
  mount('/switch', async ({ req, body }) => {
    const alive = await safariRunning()
    browserAlive = alive
    let changed = false
    if (req.method === 'POST') {
      const on = body && typeof body.on === 'boolean' ? body.on : null
      if (on !== null && on !== settings.enabled) {
        settings.enabled = on
        settings.updatedAt = Date.now()
        await saveSettings()
        changed = true
        log(`listen-tutor: 开关被拨到 ${on ? '开' : '关'}`)
      }
    }
    return {
      ok: true,
      enabled: settings.enabled,
      safari: alive,
      browser: alive ? 'running' : 'closed',
      changed,
      updatedAt: settings.updatedAt,
      settingsFile: SETTINGS_FILE,
    }
  })

  // GET /health —— 自检用
  // POST /inject —— 立刻把面板放到正在播的那个页面里（不用等那个 8 秒的心跳）
  mount('/inject', async () => {
    const state = await readState({ force: true })
    if (!state.ok) return state
    const out = await injectPanel(state)
    return { ...out, key: state.key, ep: state.ep, bvid: state.bvid }
  })

  // GET /frame —— 把播放器此刻这一帧抓下来存成 jpg，返回路径。
  //   ?w=1280&q=0.78 可以调宽度和 jpeg 质量（板书字小的课可以往上拧）。
  //   用途：让 agent 能"看见"这一页 —— 讲义/PPT/公式都在画面里，光有字幕不够。
  mount('/frame', async ({ query }) => {
    const state = await readState({ force: true })
    if (!state.ok) return state
    const frame = await grabFrame(state.docIndex || 0, {
      width: query.w,
      quality: query.q,
    })
    if (!frame.ok) return { ...frame, key: state.key, ep: state.ep, at: state.t }

    let file = ''
    try {
      file = await saveFrame(state, frame)
    } catch (error) {
      return { ok: false, reason: 'write-failed', error: String(error && error.message).slice(0, 200) }
    }
    return {
      ok: true,
      path: file,
      at: Math.round((Number(state.t) || 0) * 10) / 10,
      bvid: state.bvid,
      ep: state.ep,
      key: state.key,
      width: frame.width,
      height: frame.height,
      bytes: frame.bytes.length,
    }
  })

  // GET /frames —— 这一集抓过哪些画面（最近的在前）
  mount('/frames', async ({ query }) => {
    const state = await readState({})
    if (!state.ok) return state
    const prefix = `${state.key}-`
    let names = []
    try {
      names = await fsp.readdir(FRAME_DIR)
    } catch {
      names = []
    }
    const list = names
      .filter((n) => n.startsWith(prefix) && /\.(jpe?g|png)$/i.test(n))
      .sort()
      .map((n) => {
        const at = Number((n.slice(prefix.length).match(/^[\d.]+/) || ['0'])[0]) / 10
        return { file: path.join(FRAME_DIR, n), at: Math.round(at * 10) / 10 }
      })
    return { ok: true, key: state.key, ep: state.ep, count: list.length, list: list.slice(-(Number(query.limit) || 20)) }
  })

  // GET /slides —— 这一集抓过哪些页（按序号排）。带 drain=1 会先把页面里攒着的搬下来。
  mount('/slides', async ({ query }) => {
    const state = await readState({})
    if (!state.ok) return state

    let drained = null
    if (query.drain) drained = await drainAll(state)

    let names = []
    try {
      names = await fsp.readdir(path.join(SLIDE_DIR, state.key))
    } catch {
      names = []
    }
    const list = names
      .filter((n) => /\.(jpe?g|png)$/i.test(n))
      .sort()
      .map((n) => {
        const m = /^(\d+)-([\d.]+)/.exec(n)
        return {
          file: path.join(SLIDE_DIR, state.key, n),
          i: m ? Number(m[1]) : 0,
          at: m ? Math.round(Number(m[2]) * 10) / 10 : 0,
        }
      })

    return {
      ok: true,
      key: state.key,
      ep: state.ep,
      count: list.length,
      list: list.slice(-(Number(query.limit) || 40)),
      drained,
    }
  })

  // GET /panel —— 页面里现在到底有没有面板、停在哪一集（排查用）
  mount('/panel', async () => {
    const state = await readState({})
    if (!state.ok) return state
    const alive = await panelAlive(state.docIndex)
    return {
      ok: true,
      alive,
      key: state.key,
      matches: alive === 'alive:' + state.key + ':' + PANEL_BUILD,
      ep: state.ep,
    }
  })

  mount('/health', async () => ({
    ok: true,
    routes: [
      'switch',
      'state',
      'lesson',
      'lessons',
      'subtitle',
      'seek',
      'control',
      'request-lesson',
      'inject',
      'panel',
      'frame',
      'frames',
      'slides',
      'ask',
      'ask-status',
    ],
    at: Date.now(),
  }))

  log('listen-tutor: 已挂上，路由前缀 ' + ROUTE)
}
