/*!
 * 听课助手 · 浏览器内悬浮面板（由 host 通过 Safari doJavaScript 注入到 B站 页面）
 *
 * 这段脚本活在 B站 页面自己的上下文里，跟 host 唯一的数据交接是开头那个 DATA 常量：
 *   var D 那一行的占位符由 host 在注入前换成 { meta:{...}, lesson:{...} }
 * （注意：上面这句里我故意没有写出那个占位符的完整字面量 —— 写出来就会变成
 *   第二个命中点，而 host 那边只替换第一处，真正的数据行反而被跳过。）
 * 注入之后它自己读 <video>.currentTime 判断讲到哪一段，不产生任何网络请求，
 * 所以没有跨域、没有私有网络拦截、不占宿主 CPU。
 */
(function () {
  'use strict';

  var D = __LT_DATA__;
  var KEY = (D && D.meta && D.meta.key) || '';

  // 必须在 host 的 PANEL_BUILD 上再接一个：改了 DOM 结构（比如段内逐句推进）
  // 光 update() 换数据是换不出新结构的，只有对不上号才拆了重建。
  var BUILD = 6;

  // 已经装过：同 key 同版本就只更新数据；其余情况拆了重来
  if (window.__LT_PANEL__) {
    if (window.__LT_PANEL__.key === KEY && window.__LT_PANEL__.build === BUILD) {
      window.__LT_PANEL__.update(D);
      return 'alive';
    }
    try { window.__LT_PANEL__.destroy(); } catch (e) {}
  }

  var SEGS = (D && D.lesson && Array.isArray(D.lesson.segments)) ? D.lesson.segments : [];
  var META = (D && D.meta) || {};

  // ---------- 小工具 ----------

  function h(tag, css, text) {
    var e = document.createElement(tag);
    if (css) e.setAttribute('style', css);
    if (text != null) e.textContent = text;
    return e;
  }

  function fmt(s) {
    s = Math.max(0, Math.floor(s || 0));
    var hh = Math.floor(s / 3600), mm = Math.floor((s % 3600) / 60), ss = s % 60;
    var p = function (n) { return (n < 10 ? '0' : '') + n; };
    return hh > 0 ? hh + ':' + p(mm) + ':' + p(ss) : p(mm) + ':' + p(ss);
  }

  function video() { return document.querySelector('video'); }

  function segAt(t) {
    if (!SEGS.length) return null;
    for (var i = 0; i < SEGS.length; i++) {
      var s = SEGS[i];
      if (t >= s.t0 && t < s.t1) return { seg: s, index: i };
    }
    // 超出范围就贴最近的一段
    if (t < SEGS[0].t0) return { seg: SEGS[0], index: 0 };
    return { seg: SEGS[SEGS.length - 1], index: SEGS.length - 1 };
  }

  // 把一段正文切成句子。逐句推进靠它 —— 讲稿是手写的长文，
  // 一句一句点亮，才跟得上视频那 8 分钟。
  function splitSents(text) {
    var m = String(text || '').match(/[^。！？；!?;]+[。！？；!?;]?/g);
    if (!m) return [];
    var out = [];
    for (var i = 0; i < m.length; i++) {
      var t = m[i].trim();
      if (t) out.push(t);
    }
    return out;
  }

  // ---------- 样式 ----------

  var FONT = '-apple-system,BlinkMacSystemFont,"PingFang SC","Hiragino Sans GB",sans-serif';
  var C = {
    wrap: 'position:fixed;right:18px;bottom:92px;width:362px;max-height:64vh;display:flex;flex-direction:column;' +
      'background:rgba(18,20,26,.95);color:#e8eaf0;border:1px solid rgba(255,255,255,.13);border-radius:14px;' +
      'box-shadow:0 16px 48px rgba(0,0,0,.55);font:13px/1.7 ' + FONT + ';z-index:2147483000;overflow:hidden;' +
      '-webkit-backdrop-filter:blur(14px);backdrop-filter:blur(14px);',
    head: 'display:flex;align-items:center;gap:8px;padding:11px 13px;border-bottom:1px solid rgba(255,255,255,.08);' +
      'background:rgba(255,255,255,.03);cursor:default;flex:none;',
    dot: 'width:7px;height:7px;border-radius:50%;background:#57d68a;flex:none;',
    title: 'flex:1;font-size:13px;font-weight:600;color:#dfe4ee;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;',
    time: 'font-size:11px;color:#8b93a3;font-variant-numeric:tabular-nums;flex:none;',
    btn: 'border:none;background:rgba(255,255,255,.07);color:#aab2c0;width:22px;height:22px;border-radius:6px;' +
      'cursor:pointer;font-size:13px;line-height:1;padding:0;flex:none;',
    body: 'padding:13px;overflow:auto;flex:1;min-height:0;',
    segTitle: 'font-size:14px;font-weight:600;color:#eef1f7;margin:0 0 8px;line-height:1.5;',
    para: 'margin:0 0 10px;color:#c3cad8;font-size:12.5px;line-height:1.75;white-space:pre-wrap;',
    sentWrap: 'margin:0 0 10px;font-size:12.5px;line-height:1.8;',
    sent: 'margin:0 0 5px;color:#6d7688;transition:color .3s ease,opacity .3s ease;',
    sentPast: 'margin:0 0 5px;color:#9aa3b5;transition:color .3s ease,opacity .3s ease;',
    sentNow: 'margin:0 0 5px;color:#eef1f7;border-left:2px solid #5b9dff;padding-left:8px;margin-left:-10px;' +
      'transition:color .3s ease,opacity .3s ease;',
    ptWrap: 'margin-top:4px;',
    pointsLabel: 'font-size:11px;color:#7d8698;letter-spacing:.04em;margin:10px 0 6px;',
    point: 'position:relative;padding-left:13px;margin:0 0 5px;color:#b9c2d2;font-size:12.5px;line-height:1.65;',
    bullet: 'position:absolute;left:0;top:.62em;width:4px;height:4px;border-radius:50%;background:#5b9dff;',
    foot: 'display:flex;align-items:center;gap:7px;padding:9px 11px;border-top:1px solid rgba(255,255,255,.08);' +
      'background:rgba(0,0,0,.18);flex:none;',
    nav: 'flex:1;border:none;background:rgba(255,255,255,.07);color:#b9c2d2;height:28px;border-radius:7px;' +
      'cursor:pointer;font-size:12px;font-family:' + FONT + ';',
    empty: 'padding:26px 16px;color:#8b93a3;font-size:12.5px;text-align:center;line-height:1.8;',
    askBar: 'display:flex;align-items:center;gap:7px;padding:9px 11px;border-top:1px solid rgba(255,255,255,.08);' +
      'background:rgba(255,255,255,.02);flex:none;',
    askInput: 'flex:1;min-width:0;height:28px;border-radius:7px;border:1px solid rgba(255,255,255,.12);' +
      'background:rgba(0,0,0,.3);color:#e8eaf0;font:12px ' + FONT + ';padding:0 9px;outline:none;',
    askBtn: 'border:none;background:#2f6fd0;color:#fff;height:28px;padding:0 11px;border-radius:7px;' +
      'cursor:pointer;font-size:12px;font-family:' + FONT + ';flex:none;',
    qa: 'margin:0 0 10px;padding:9px 11px;border-radius:9px;background:rgba(91,157,255,.1);' +
      'border:1px solid rgba(91,157,255,.22);',
    qaQ: 'font-size:12px;color:#8fb8f0;margin:0 0 5px;line-height:1.6;',
    qaA: 'font-size:12.5px;color:#dfe6f2;margin:0;line-height:1.75;white-space:pre-wrap;',
    qaWait: 'font-size:12px;color:#8b93a3;margin:0;line-height:1.7;',
    sw: 'flex:none;border:none;border-radius:6px;height:22px;padding:0 7px;cursor:pointer;' +
      'font-size:11px;font-family:' + FONT + ';letter-spacing:.5px;' +
      'background:rgba(91,157,255,.16);color:#8fb8f0;',
    swOff: 'background:rgba(255,255,255,.07);color:#7d8698;',
    stopped: 'opacity:.45;filter:grayscale(.5);',
  };

  // ---------- 结构 ----------

  var root = h('div', C.wrap);
  root.setAttribute('data-listen-tutor', '1');

  var dot = h('div', C.dot);
  var titleEl = h('div', C.title, META.ep || '听课助手');
  var timeEl = h('div', C.time, '');
  var minBtn = h('button', C.btn, '—');
  minBtn.title = '收起 / 展开';

  // 开关：点一下把整个插件停掉。停着的时候面板还在，只是不再更新 ——
  // 这样你随时能在这里再打开，不用回 DSH 那边。
  var swOn = META.enabled !== false;
  var swBtn = h('button', C.sw, swOn ? '停' : '开');
  swBtn.title = swOn ? '点一下停掉听课助手' : '点一下打开听课助手';

  var head = h('div', C.head);
  head.appendChild(dot);
  head.appendChild(titleEl);
  head.appendChild(timeEl);
  head.appendChild(swBtn);
  head.appendChild(minBtn);

  var body = h('div', C.body);
  var foot = h('div', C.foot);

  var prevBtn = h('button', C.nav, '« 上一段');
  var nextBtn = h('button', C.nav, '下一段 »');
  foot.appendChild(prevBtn);
  foot.appendChild(nextBtn);

  // 提问条：贴着底部导航上面，输入框 + 「问」。不经过宿主心跳，直接打本地路由。
  var askBar = h('div', C.askBar);
  var askInput = h('input', C.askInput);
  askInput.setAttribute('type', 'text');
  askInput.setAttribute('placeholder', '这一段没听懂？问一句');
  var askBtn = h('button', C.askBtn, '问');
  askBar.appendChild(askInput);
  askBar.appendChild(askBtn);

  root.appendChild(head);
  root.appendChild(body);
  root.appendChild(askBar);
  root.appendChild(foot);

  function paintSwitch() {
    swBtn.textContent = swOn ? '停' : '开';
    swBtn.title = swOn ? '点一下停掉听课助手' : '点一下打开听课助手';
    swBtn.setAttribute('style', C.sw + (swOn ? '' : C.swOff));
    root.setAttribute('data-lt-enabled', swOn ? '1' : '0');
    // 注意：不能 removeAttribute('style')，那会连 C.body 的滚动布局一起删掉。
    body.setAttribute('style', swOn ? C.body : C.body + C.stopped)
  }

  /** 把开关状态真正落到界面上（点按钮、宿主拨开关，两条路都走这里）。 */
  function syncSwitch(next) {
    if (next === swOn) return;
    swOn = next;
    paintSwitch();
    if (!swOn) {
      body.textContent = '';
      body.appendChild(h('div', C.empty, '听课助手已停。\n点上面的「开」接着用。'));
    } else {
      currentIndex = -1;
      lastPaint = -1;
      renderSeg(segIndex());
    }
  }

  function flipSwitch() {
    var next = !swOn;
    // 交给宿主心跳来取：B站 是 https，直接 fetch 本机 http 会被 Safari 拦掉，
    // 所以只能写页面变量当信箱。
    window.__LT_SWITCH = { on: next, at: Date.now() };
    syncSwitch(next);
  }

  swBtn.addEventListener('click', flipSwitch);

  // ---------- 渲染 ----------

  var currentIndex = -1;
  var sentEls = [];   // 当前段每一句的节点
  var ptsEls = [];    // 当前段每一条要点的节点
  var lastPaint = -1; // 上次画到第几句，避免每帧都动 DOM

  function renderSeg(i) {
    body.innerHTML = '';

    if (!SEGS.length) {
      var tip;
      if (META.writing) tip = '大肥鱼正在写这一集的讲解…\n写完这里会自己变，不用刷新。';
      else if (META.hasLesson) tip = '讲解稿是空的。';
      else tip = '这一集还没写讲解。\n回 DSH 那边说一句，让大肥鱼写。';
      body.appendChild(h('div', C.empty, tip));
      return;
    }

    var seg = SEGS[i];
    if (!seg) return;

    body.appendChild(h('div', C.segTitle, (i + 1) + ' · ' + (seg.title || '')));

    sentEls = [];
    ptsEls = [];

    var sents = splitSents(seg.body);
    if (sents.length) {
      var sw = h('div', C.sentWrap);
      for (var a = 0; a < sents.length; a++) {
        var se = h('div', C.sent, sents[a]);
        // 样式全内联、没有 class 名，外面（和调试时的我）没法问「现在讲到第几句」。
        // 挂个属性当把手，不占视觉。
        se.setAttribute('data-lt-sent', a);
        se.setAttribute('data-lt-now', '0');
        sw.appendChild(se);
        sentEls.push(se);
      }
      body.appendChild(sw);
    } else if (seg.body) {
      body.appendChild(h('p', C.para, seg.body));
    }

    var pts = seg.points || seg.keyPoints || [];
    if (pts.length) {
      var pw = h('div', C.ptWrap);
      pw.appendChild(h('div', C.pointsLabel, '记 住 这 几 点'));
      for (var k = 0; k < pts.length; k++) {
        var pt = h('div', C.point, pts[k]);
        pt.appendChild(h('span', C.bullet));
        pw.appendChild(pt);
        ptsEls.push(pt);
      }
      body.appendChild(pw);
    }

    lastPaint = -1;
    body.scrollTop = 0;
  }

  // 实时跟踪的落点：按段内进度点亮句子。
  // 不依赖字幕、不发请求，纯本地一次减法 —— 视频怎么拖，这里立刻跟着走。
  function paint(t) {
    if (!sentEls.length) return;
    var seg = SEGS[currentIndex];
    if (!seg) return;
    var span = (seg.t1 || 0) - (seg.t0 || 0);
    var ratio = span > 0 ? (t - seg.t0) / span : 1;
    if (ratio < 0) ratio = 0;
    if (ratio > 1) ratio = 1;
    var upto = Math.floor(ratio * sentEls.length);
    if (upto > sentEls.length - 1) upto = sentEls.length - 1;
    if (upto < 0) upto = 0;
    if (upto === lastPaint) return;
    lastPaint = upto;

    for (var k = 0; k < sentEls.length; k++) {
      var isNow = k === upto;
      sentEls[k].setAttribute('style', k < upto ? C.sentPast : (isNow ? C.sentNow : C.sent));
      sentEls[k].setAttribute('data-lt-now', isNow ? '1' : '0');
    }
    // 要点比正文晚一点浮出来：刚进这一段就先看正文，讲到一半再给结论
    var show = ratio > 0.35 ? '1' : '0.4';
    for (var q = 0; q < ptsEls.length; q++) ptsEls[q].style.opacity = show;

    var top = sentEls[upto].offsetTop - 70;
    if (top > 0 && Math.abs(body.scrollTop - top) > 24) body.scrollTop = top;
  }

  // ---------- 提问 ----------
  //
  // 直接把问题打给宿主路由，不绕心跳 —— 8 秒延迟问个问题太难受了。
  // CORS 宿主已经放行；127.0.0.1 是 potentially trustworthy origin，
  // 从 https 的 B站 页面请求它不算混合内容（实测通过）。
  // 失败也不吞掉：把原因写进问答区，用户知道是没连上还是超出范围。

  var qaBox = null;
  var lastQ = '';

  function showQa(q, a) {
    if (!qaBox) {
      qaBox = h('div', C.qa);
      qaBox.setAttribute('data-lt-qa', '1');
      qaBox.appendChild(h('div', C.qaQ, ''));
      qaBox.appendChild(h('p', C.qaA, ''));
    }
    qaBox.firstChild.textContent = '你问：' + q;
    var aEl = qaBox.lastChild;
    if (a == null) {
      aEl.setAttribute('style', C.qaWait);
      aEl.textContent = '送出去了，等回信… 写好了这里自己会变。';
    } else {
      aEl.setAttribute('style', C.qaA);
      aEl.textContent = a;
    }
    if (body.firstChild !== qaBox) body.insertBefore(qaBox, body.firstChild);
    body.scrollTop = 0;
  }

  function askNow() {
    var q = String(askInput.value || '').trim();
    if (!q) return;
    var v = video();
    var t = v ? v.currentTime : 0;
    lastQ = q;
    // 面板跑在 www.bilibili.com 的 https 源里，直接 fetch http://127.0.0.1 会被 Safari 拦掉
    // （实测 localhost 也一样，TypeError: Load failed）。所以把问题挂在页面变量上，
    // 宿主每几秒来取一次；答案仍旧由宿主推进来。只走修好的那一条路。
    window.__LT_ASK = { q: q, t: t, at: Date.now() };
    showQa(q, null);
    askInput.value = '';
    askBtn.disabled = true;
    setTimeout(function () {
      askBtn.disabled = false;
    }, 1500);
  }

  askBtn.addEventListener('click', askNow);
  askInput.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      askNow();
    }
  });

  /** 宿主把答案推进来（推的是 id + 正文，正文为空就是"还在想"）。 */
  function answer(id, text) {
    showQa(lastQ || '（上一问）', String(text || ''));
  }

  function update(nd) {
    var dd = nd || D;
    if (dd && dd.lesson && Array.isArray(dd.lesson.segments) && dd.lesson.segments !== SEGS) {
      SEGS = dd.lesson.segments;
      currentIndex = -1;
    }
    if (dd && dd.meta) {
      META = dd.meta;
      titleEl.textContent = META.ep || '听课助手';
      // 宿主那边被关掉（curl 或者 DSH 侧），面板跟着变，不用刷新
      if (typeof META.enabled === 'boolean') syncSwitch(META.enabled);
    }
    tick();
  }

  function tick() {
    if (!swOn) return;
    var v = video();
    var t = v ? v.currentTime : 0;
    var dur = (v && v.duration) || META.duration || 0;

    timeEl.textContent = fmt(t) + ' / ' + fmt(dur);
    dot.style.background = v && !v.paused ? '#57d68a' : '#6b7385';

    var hit = segAt(t);
    if (!hit) {
      // 没有讲解稿也要渲染一次（"正在写…"/"还没写"那些提示），-2 是"空态已画"的哨兵
      if (currentIndex !== -2) { currentIndex = -2; renderSeg(0); }
      return;
    }
    if (hit.index !== currentIndex) {
      currentIndex = hit.index;
      renderSeg(hit.index);
    }
    paint(t);
  }

  function jump(dir) {
    if (!SEGS.length) return;
    var v = video();
    if (!v) return;
    var t = v.currentTime;
    var hit = segAt(t);
    var target = null;
    if (dir < 0) {
      // 段首已经超过 3 秒才回到本段开头，否则跳到上一段
      target = (t - hit.seg.t0 > 3 || hit.index === 0) ? SEGS[hit.index].t0 : SEGS[hit.index - 1].t0;
    } else {
      target = hit.index + 1 < SEGS.length ? SEGS[hit.index + 1].t0 : null;
    }
    if (target != null) {
      v.currentTime = target;
      currentIndex = -1;
      setTimeout(tick, 60);
    }
  }

  prevBtn.addEventListener('click', function () { jump(-1); });
  nextBtn.addEventListener('click', function () { jump(1); });

  var collapsed = false;
  minBtn.addEventListener('click', function () {
    collapsed = !collapsed;
    body.style.display = collapsed ? 'none' : '';
    foot.style.display = collapsed ? 'none' : '';
    minBtn.textContent = collapsed ? '+' : '—';
    root.style.width = collapsed ? '220px' : '362px';
  });

  // ---------- 挂载与生命周期 ----------

  function mount() {
    (document.body || document.documentElement).appendChild(root);
  }

  function destroy() {
    if (timer) clearInterval(timer);
    try { root.remove(); } catch (e) {}
    try { delete window.__LT_PANEL__; } catch (e) { window.__LT_PANEL__ = null; }
  }

  var timer = null;

  // 注入的那一刻如果插件是停着的，直接把面板画成"已停"，别让内容一闪
  paintSwitch();
  if (!swOn) {
    body.textContent = '';
    body.appendChild(h('div', C.empty, '听课助手已停。\n点上面的「开」接着用。'));
  }

  window.__LT_PANEL__ = {
    key: KEY,
    build: BUILD,
    update: update,
    answer: answer,
    destroy: destroy,
    mount: mount,
  };

  mount();
  tick();
  timer = setInterval(tick, 1000);

  return 'mounted:' + (SEGS.length ? SEGS.length + 'seg' : 'empty');
})();
