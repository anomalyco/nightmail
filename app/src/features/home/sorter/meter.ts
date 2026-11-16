// `?perf` on the page's address: a meter in its corner, for checking pace on a real device. It lists, for each phase
// of the machine, the gap between animation frames (median, 95th and 99th percentile, in ms) and the frames dropped,
// and the renderer's quality level. Loaded only when asked for; while it is up the page never idles.
export function mountMeter() {
  const box = document.createElement('pre')
  box.style.cssText = 'position:fixed;z-index:99;left:8px;bottom:8px;margin:0;padding:6px 8px;background:rgb(0 0 0 / 80%);color:#fff;font:10px/1.35 ui-monospace,Menlo,monospace;pointer-events:none;white-space:pre'
  document.body.append(box)
  const by = new Map<string, number[]>()
  let last = 0, shown = 0
  const tick = (now: number) => {
    const phase = (scrollY > 40 ? 'scroll ' : '') + (document.querySelector<HTMLElement>('.srt-page')?.dataset.phase ?? 'boot')
    if (last) { const gaps = by.get(phase) ?? []; by.set(phase, gaps); gaps.push(now - last) }
    last = now
    if (now - shown > 500) {
      shown = now
      box.textContent = [...by].map(([name, gaps]) => {
        const sorted = [...gaps].sort((a, b) => a - b), at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))].toFixed(1)
        return `${name.padEnd(15)} n ${String(sorted.length).padStart(4)}  p50 ${at(.5)}  p95 ${at(.95)}  p99 ${at(.99)}  dropped ${sorted.reduce((n, gap) => n + Math.max(0, Math.round(gap / 16.667) - 1), 0)}`
      }).join('\n') + `\nquality ${document.querySelector<HTMLElement>('.srt-gl')?.dataset.quality ?? '-'}`
    }
    requestAnimationFrame(tick)
  }
  requestAnimationFrame(tick)
}
