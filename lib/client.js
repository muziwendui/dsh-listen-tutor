// DSH「听课助手」· 网页半边
//
// 在左侧栏加一个「听课」图标，点开是主面板：
//   上面 —— 正在看的那一集的进度（跟着 Safari 里真的在播的那条走）
//   下面 —— 按时间轴排好的讲解稿，播到哪讲到哪，点某一段能把视频跳回去
//
// ⚠ 这里不发消息、不生成内容，只往宿主那几条 /x-listen-tutor/* 路由上读写。
//   所有跟 Safari 打交道的事都在 lib/host.js，这样只有一份逻辑。

window.__ModuleLoader__.load({
  id: 'dsh-listen-tutor',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports

    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useRef, useCallback } = React

    const inject = ['slots']

    const B = '/x-listen-tutor'

    const getJson = (p) =>
      fetch(B + p, { cache: 'no-store' })
        .then((r) => r.json())
        .catch(() => null)

    const postJson = (p, body) =>
      fetch(B + p, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body || {}),
      })
        .then((r) => r.json())
        .catch(() => null)

    // ---------- 小工具 ----------

    function fmtTime(sec) {
      const s = Math.max(0, Math.floor(Number(sec) || 0))
      const hh = Math.floor(s / 3600)
      const mm = Math.floor((s % 3600) / 60)
      const ss = s % 60
      const pad = (n) => String(n).padStart(2, '0')
      return hh > 0 ? `${hh}:${pad(mm)}:${pad(ss)}` : `${mm}:${pad(ss)}`
    }

    function segmentAt(segments, t) {
      if (!Array.isArray(segments)) return -1
      for (let i = 0; i < segments.length; i += 1) {
        const seg = segments[i]
        const t0 = Number(seg.t0) || 0
        const t1 = Number(seg.t1) || 0
        if (t >= t0 && t < t1) return i
      }
      // 落在最后一段之后：认为还是最后一段，别让面板空着
      if (segments.length > 0) {
        const last = segments[segments.length - 1]
        if (t >= (Number(last.t0) || 0)) return segments.length - 1
      }
      return -1
    }

    // ---------- 样式（贴着主题变量走，换深浅色跟着变） ----------

    const C = {
      wrap: {
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        minHeight: 0,
        background: 'var(--dsw-alias-bg-layer-1, rgba(255,255,255,.92))',
        color: 'inherit',
      },
      head: {
        padding: '12px 16px 10px',
        borderBottom: '1px solid var(--dsw-alias-border-l1, rgba(0,0,0,.08))',
        flex: '0 0 auto',
      },
      titleRow: { display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' },
      h1: { fontSize: 14.5, fontWeight: 600, margin: 0 },
      dim: { opacity: 0.6, fontSize: 12 },
      ep: { fontSize: 13, marginTop: 6, lineHeight: 1.5, wordBreak: 'break-all' },
      bar: {
        height: 4,
        borderRadius: 2,
        background: 'var(--dsw-alias-border-l2, rgba(0,0,0,.12))',
        marginTop: 10,
        overflow: 'hidden',
      },
      barFill: {
        height: '100%',
        background: 'var(--dsw-alias-brand, #4d6bfe)',
        borderRadius: 2,
        transition: 'width .25s linear',
      },
      timeRow: {
        display: 'flex',
        justifyContent: 'space-between',
        fontSize: 11.5,
        opacity: 0.62,
        marginTop: 4,
        fontVariantNumeric: 'tabular-nums',
      },
      ctrlRow: { display: 'flex', gap: 6, marginTop: 10, flexWrap: 'wrap', alignItems: 'center' },
      btn: {
        border: '1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.14))',
        background: 'transparent',
        color: 'inherit',
        borderRadius: 7,
        padding: '4px 10px',
        fontSize: 12.5,
        cursor: 'pointer',
        lineHeight: 1.4,
      },
      btnPrimary: {
        border: '1px solid var(--dsw-alias-brand, #4d6bfe)',
        background: 'var(--dsw-alias-brand, #4d6bfe)',
        color: '#fff',
        borderRadius: 7,
        padding: '5px 12px',
        fontSize: 12.5,
        cursor: 'pointer',
        lineHeight: 1.4,
      },
      body: { flex: '1 1 auto', overflowY: 'auto', minHeight: 0, padding: '10px 12px 24px' },
      seg: {
        border: '1px solid transparent',
        borderRadius: 9,
        padding: '8px 10px',
        marginBottom: 6,
        cursor: 'pointer',
      },
      segActive: {
        border: '1px solid var(--dsw-alias-brand, #4d6bfe)',
        background: 'color-mix(in srgb, var(--dsw-alias-brand, #4d6bfe) 8%, transparent)',
      },
      segHead: { display: 'flex', gap: 8, alignItems: 'baseline' },
      stamp: {
        fontSize: 11.5,
        opacity: 0.55,
        fontVariantNumeric: 'tabular-nums',
        flex: '0 0 auto',
        paddingTop: 1,
      },
      segTitle: { fontSize: 13, lineHeight: 1.5, wordBreak: 'break-word' },
      para: { fontSize: 12.8, lineHeight: 1.75, margin: '6px 0 0', whiteSpace: 'pre-wrap', opacity: 0.92 },
      points: { margin: '6px 0 0', paddingLeft: 18, fontSize: 12.5, lineHeight: 1.7, opacity: 0.86 },
      empty: { padding: '28px 16px', textAlign: 'center', opacity: 0.7, fontSize: 13, lineHeight: 1.8 },
      toast: {
        margin: '0 0 8px',
        padding: '7px 10px',
        borderRadius: 8,
        fontSize: 12.5,
        lineHeight: 1.6,
        background: 'color-mix(in srgb, var(--dsw-alias-brand, #4d6bfe) 10%, transparent)',
      },
    }

    // ---------- 面板 ----------

    function ListenTutorPanel() {
      const [state, setState] = useState(null)
      const [lesson, setLesson] = useState(null)
      const [busy, setBusy] = useState(false)
      const [notice, setNotice] = useState('')
      const [openIdx, setOpenIdx] = useState(-1)

      const stateRef = useRef(null)
      stateRef.current = state

      const loadLesson = useCallback(async (key) => {
        if (!key) {
          setLesson(null)
          return
        }
        const r = await getJson(`/lesson?key=${encodeURIComponent(key)}`)
        if (r && r.ok) setLesson(r.lesson)
        else setLesson(null)
      }, [])

      const refresh = useCallback(async () => {
        const s = await getJson('/state')
        if (!s) return
        setState(s)
        const prev = stateRef.current
        const changed = !prev || prev.key !== s.key || (!prev.hasLesson && s.hasLesson)
        if (s.ok && s.key && (changed || !lessonRefKey.current)) {
          lessonRefKey.current = s.key
          await loadLesson(s.key)
        }
        if (!s.ok && lesson) {
          setLesson(null)
          lessonRefKey.current = ''
        }
      }, [loadLesson, lesson])

      const lessonRefKey = useRef('')
      const lessonRef = useRef(null)
      lessonRef.current = lesson

      useEffect(() => {
        let alive = true
        let timer = null
        const tick = async () => {
          if (!alive) return
          await refresh()
          if (!alive) return
          const paused = stateRef.current && stateRef.current.paused
          timer = setTimeout(tick, paused ? 2500 : 1000)
        }
        tick()
        return () => {
          alive = false
          if (timer) clearTimeout(timer)
        }
      }, [refresh])

      const act = useCallback(
        async (path, body, hint) => {
          setBusy(true)
          try {
            const r = await postJson(path, body)
            if (r && r.ok) {
              if (hint) setNotice(hint)
              await new Promise((res) => setTimeout(res, 180))
              await refresh()
            } else {
              setNotice(`没成功：${(r && (r.reason || r.error)) || '未知原因'}`)
            }
          } finally {
            setBusy(false)
          }
        },
        [refresh],
      )

      const onSeek = (t) => act('/seek', { t }, '')
      const onControl = (action) => act('/control', { action }, '')

      const onAskLesson = async () => {
        setBusy(true)
        try {
          const r = await postJson('/request-lesson', {})
          if (r && r.ok) setNotice('已经让大肥鱼去写这一集的讲解了，写完这儿会自己冒出来。')
          else if (r && r.reason === 'no-agent') setNotice('没找到能接活的 agent 会话 —— 先在 DSH 里开个对话再点。')
          else setNotice(`没成功：${(r && (r.reason || r.error)) || '未知原因'}`)
        } finally {
          setBusy(false)
        }
      }

      // ---------- 没读到视频 ----------
      if (!state) {
        return h('div', { style: C.wrap }, h('div', { style: C.empty }, '正在问 Safari 现在放着什么…'))
      }

      if (!state.ok) {
        const statusText = [
          state.safari === true ? 'Safari 在运行' : state.safari === false ? 'Safari 没在运行' : '',
          state.enabled === false ? '总开关：关' : '总开关：开',
        ]
          .filter(Boolean)
          .join(' · ')
        const reasonText =
          state.enabled === false
            ? '总开关关着，现在没在抓。'
            : state.safari === false
              ? 'Safari 没打开，所以没在抓。'
              : state.reason === 'no-video'
                ? 'Safari 开着，但里面没有在播的哔哩哔哩视频。'
                : state.reason === 'osascript-error'
                  ? `读得到 Safari 但读不到视频：${state.message || ''}`
                  : '暂时读不到播放状态。'
        return h(
          'div',
          { style: C.wrap },
          h(
            'div',
            { style: C.head },
            h('div', { style: C.titleRow }, h('h1', { style: C.h1 }, '听课助手'), h('span', { style: C.dim }, '没连上')),
          ),
          h(
            'div',
            { style: C.empty },
            reasonText,
            h('br'),
            h('span', { style: C.dim }, statusText),
            h('br'),
            '在 Safari 里打开哔哩哔哩、点开一集课程，然后这儿会自动接上。',
            h('br'),
            h(
              'button',
              { style: { ...C.btn, marginTop: 12 }, onClick: () => refresh(), disabled: busy },
              '再试一次',
            ),
          ),
        )
      }

      // ---------- 有视频 ----------
      const segments = lesson && Array.isArray(lesson.segments) ? lesson.segments : []
      const current = segmentAt(segments, state.t)
      const pct = state.d > 0 ? Math.min(100, (state.t / state.d) * 100) : 0

      const head = h(
        'div',
        { style: C.head },
        h(
          'div',
          { style: C.titleRow },
          h('h1', { style: C.h1 }, '听课助手'),
          h('span', { style: C.dim }, state.paused ? '暂停中' : '播放中'),
          state.bvid ? h('span', { style: C.dim }, state.bvid) : null,
        ),
        h('div', { style: C.ep }, state.ep || state.title),
        h('div', { style: C.bar }, h('div', { style: { ...C.barFill, width: `${pct}%` } })),
        h(
          'div',
          { style: C.timeRow },
          h('span', null, fmtTime(state.t)),
          h('span', null, segments.length > 0 ? `第 ${current + 1} / ${segments.length} 段` : fmtTime(state.d)),
        ),
        h(
          'div',
          { style: C.ctrlRow },
          h('button', { style: C.btn, onClick: () => onControl('back15'), disabled: busy }, '« 15s'),
          h(
            'button',
            { style: C.btn, onClick: () => onControl('toggle'), disabled: busy },
            state.paused ? '播放' : '暂停',
          ),
          h('button', { style: C.btn, onClick: () => onControl('fwd15'), disabled: busy }, '15s »'),
          h('span', { style: { flex: '1 1 auto' } }),
          h('button', { style: C.btn, onClick: () => refresh(), disabled: busy }, '刷新'),
        ),
      )

      const noticeNode = notice
        ? h(
            'div',
            { style: C.toast },
            notice,
            h(
              'span',
              {
                style: { marginLeft: 8, cursor: 'pointer', opacity: 0.6 },
                onClick: () => setNotice(''),
              },
              '×',
            ),
          )
        : null

      // 还没讲解稿
      if (segments.length === 0) {
        return h(
          'div',
          { style: C.wrap },
          head,
          h(
            'div',
            { style: C.body },
            noticeNode,
            h(
              'div',
              { style: { ...C.empty, textAlign: 'left' } },
              h('div', { style: { fontSize: 13.5, marginBottom: 8 } }, '这一集还没有讲解。'),
              h(
                'div',
                { style: { ...C.dim, lineHeight: 1.9, marginBottom: 14 } },
                '讲解是按内容一段一段排好的，跟着进度走 —— 播到哪，这儿就讲到哪。',
                h('br'),
                '点下面这个按钮，大肥鱼会去取这一集的字幕、按讲透的写法写一份（视频长的话要等几分钟）。',
              ),
              h(
                'button',
                { style: C.btnPrimary, onClick: onAskLesson, disabled: busy },
                busy ? '正在交代…' : '让大肥鱼写这一集的讲解',
              ),
            ),
          ),
        )
      }

      // 有讲解稿
      const body = h(
        'div',
        { style: C.body },
        noticeNode,
        segments.map((seg, i) => {
          const active = i === current
          const expanded = active || i === openIdx
          return h(
            'div',
            {
              key: `${i}-${seg.t0}`,
              style: { ...C.seg, ...(active ? C.segActive : null) },
              onClick: () => {
                setOpenIdx(i)
                onSeek(Number(seg.t0) || 0)
              },
            },
            h(
              'div',
              { style: C.segHead },
              h('span', { style: C.stamp }, fmtTime(seg.t0)),
              h('span', { style: C.segTitle }, seg.title || `第 ${i + 1} 段`),
            ),
            expanded && seg.body ? h('p', { style: C.para }, seg.body) : null,
            expanded && Array.isArray(seg.points) && seg.points.length > 0
              ? h(
                  'ul',
                  { style: C.points },
                  seg.points.map((p, j) => h('li', { key: j }, p)),
                )
              : null,
          )
        }),
        h(
          'div',
          { style: { ...C.dim, textAlign: 'center', padding: '10px 0 0' } },
          lesson.generatedAt ? `讲解生成于 ${String(lesson.generatedAt).slice(0, 16).replace('T', ' ')}` : '',
        ),
      )

      return h('div', { style: C.wrap }, head, body)
    }

    // ---------- 侧栏图标 ----------

    function Icon(props) {
      return h(
        'svg',
        {
          width: 18,
          height: 18,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.7,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
        },
        h('path', { d: 'M3 5.5h18v10.5H3z' }),
        h('path', { d: 'M7.5 20h9' }),
        h('path', { d: 'M10 9.2l5 2.3-5 2.3z' }),
      )
    }

    // ---------- 挂载 ----------

    const PANEL_ID = 'listen-tutor'

    function apply(ctx) {
      const slots = ctx.get('slots')
      if (!slots) return

      // 侧栏图标：点它就把主面板切到这个 id
      slots.inject('sidebar.panellist', () =>
        slots.register(
          {
            name: 'sidebar.panellist',
            id: PANEL_ID,
            order: 40,
            label: () => '听课',
          },
          (ownerProps) => h(Icon, ownerProps),
        ),
      )

      // 主面板：key 跟侧栏 id 一样，点图标自动切过来
      slots.inject('main', () =>
        slots.register(
          {
            name: 'main',
            key: PANEL_ID,
          },
          () => h(ListenTutorPanel),
        ),
      )
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
