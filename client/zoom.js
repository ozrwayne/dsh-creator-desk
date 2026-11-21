// .md-root 的 zoom 会把视口像素和内部 CSS 像素拉开。指针差要除以 zoom，clientWidth 不用。

export function cssZoom(el) {
  let z = 1
  let node = el
  while (node && node.nodeType === 1) {
    const raw = getComputedStyle(node).zoom
    const n = Number.parseFloat(raw)
    if (raw && raw !== 'normal' && Number.isFinite(n) && n > 0) z *= n
    node = node.parentElement
  }
  return z || 1
}

export function localDelta(dx, dy, el) {
  const z = cssZoom(el)
  return { x: dx / z, y: dy / z }
}
