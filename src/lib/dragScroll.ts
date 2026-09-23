// 全局鼠标拖拽滚动：按住左键拖动任意滚动容器（纵向/横向），
// 位移 > 6px 判定为拖拽（不干扰普通点击），松手后惯性滑行。
// 挂载一次（模块级 flag 防 HMR 重复注册），所有 overflow 容器自动生效。
let inited = false
let el: HTMLElement | null = null
let startX = 0, startY = 0, sL = 0, sT = 0
let dragging = false
let wasDragging = false   // mouseup 后 click 才触发，需保留到下一次 mousedown 才清除
let lastX = 0, lastY = 0, lastT = 0
let velX = 0, velY = 0
let raf = 0

export function initDragScroll() {
  if (inited) return
  inited = true
  document.addEventListener('mousedown', onDown)
  document.addEventListener('mousemove', onMove)
  document.addEventListener('mouseup', onUp)
  document.addEventListener('click', onClickCapture, true)
}

// 从事件目标向上找第一个"可滚动"容器（内容超高/超宽）
function findScroller(t: EventTarget | null): HTMLElement | null {
  let n = t instanceof Element ? (t as HTMLElement) : null
  while (n && n !== document.body) {
    const st = getComputedStyle(n)
    const ov = st.overflowY + st.overflowX
    if (/(auto|scroll|overlay)/.test(ov) && (n.scrollHeight > n.clientHeight + 2 || n.scrollWidth > n.clientWidth + 2)) return n
    n = n.parentElement
  }
  return null
}

// 文本选择和表单交互必须优先于“按住拖动滚动”。事件目标通常是文字所在的
// 叶子元素；同时检查直接文本节点，以覆盖 <p>文字<strong>强调</strong></p>。
function preservesNativeSelection(t: EventTarget | null): boolean {
  if (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement) return true
  if (!(t instanceof HTMLElement)) return false
  if (t.isContentEditable) return true
  if (getComputedStyle(t).userSelect === 'none') return false
  const hasDirectText = Array.from(t.childNodes ?? []).some(node => node.nodeType === 3 && Boolean(node.textContent?.trim()))
  return hasDirectText || (t.childElementCount === 0 && Boolean(t.textContent?.trim()))
}

function onDown(e: MouseEvent) {
  if (e.button !== 0) return
  wasDragging = false   // 新一轮按下开始，清除拖拽标记（之后的 click 正常触发）
  const t = e.target
  if (preservesNativeSelection(t)) return
  const sc = findScroller(t)
  if (!sc) return
  el = sc
  startX = e.clientX; startY = e.clientY
  sL = sc.scrollLeft; sT = sc.scrollTop
  lastX = e.clientX; lastY = e.clientY; lastT = performance.now()
  velX = 0; velY = 0
  dragging = false
}

function onMove(e: MouseEvent) {
  if (!el) return
  const dx = e.clientX - startX, dy = e.clientY - startY
  if (!dragging) {
    if (Math.abs(dx) < 6 && Math.abs(dy) < 6) return
    // 只有越过拖拽阈值后才接管原生行为；普通点击与文字选择不会在按下阶段被取消。
    e.preventDefault()
    dragging = true
    document.body.style.userSelect = 'none'
    document.body.style.cursor = 'grabbing'
    // 从按下点开始滚（避免跳变）
    sL = el.scrollLeft; sT = el.scrollTop
    startX = e.clientX; startY = e.clientY
  }
  el.scrollLeft = sL - (e.clientX - startX)
  el.scrollTop = sT - (e.clientY - startY)
  // 采样速度（惯性用，每帧位移约 16.7ms）
  const now = performance.now()
  const dt = Math.max(8, now - lastT)
  velX = ((e.clientX - lastX) / dt) * 16.7
  velY = ((e.clientY - lastY) / dt) * 16.7
  lastX = e.clientX; lastY = e.clientY; lastT = now
}

function onUp() {
  if (!el) return
  if (dragging) {
    wasDragging = true   // 保留标记：mouseup 之后的 click 会被拦截（防止拖拽误入详情）
    document.body.style.userSelect = ''
    document.body.style.cursor = ''
    const sc = el
    let vx = velX, vy = velY
    const step = () => {
      vx *= 0.92; vy *= 0.92
      sc.scrollLeft -= vx
      sc.scrollTop -= vy
      if (Math.abs(vx) > 0.3 || Math.abs(vy) > 0.3) raf = requestAnimationFrame(step)
      else raf = 0
    }
    if (Math.abs(velX) > 1 || Math.abs(velY) > 1) raf = requestAnimationFrame(step)
  }
  el = null
  dragging = false
}

// 拖拽后拦截 click（拖动时误触卡片/按钮）——dragging 或 wasDragging 都拦截（click 在 mouseup 之后触发）
function onClickCapture(e: MouseEvent) {
  if (dragging || wasDragging) {
    e.stopPropagation()
    e.preventDefault()
  }
}
