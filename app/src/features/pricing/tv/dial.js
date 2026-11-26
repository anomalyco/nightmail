// The dial on the comparison prototype's set (tv/pages.tsx, DialPage): the top knob, a slider over the vendor's sizes. It
// turns as the homepage's knobs do (home/tv/tv.tsx, Dial): dragged round, it follows the pointer and settles on the
// nearest size; pressed, it steps to the next one; with a key, Arrow keys, Page Up and Down, Home and End. At each size it
// prints both bills on the glass. Its data-dial holds every size's lines, worked out at build time: [the size, Nightmail,
// the vendor, the vendor's plan, all of it in words].
;(() => {
  for (const dial of document.querySelectorAll('[data-dial]')) {
    const steps = JSON.parse(dial.dataset.dial), last = steps.length - 1
    const screen = dial.closest('.chy-set')?.querySelector('.ctv-tube')
    const put = (name, text) => { const el = screen?.querySelector('[data-dial-' + name + ']'); if (el) el.textContent = text }
    const cells = [...(screen?.querySelectorAll('[data-dial-cells] i') ?? [])]
    const angle = k => -140 + 280 * k / last
    let at = Number(dial.getAttribute('aria-valuenow'))
    const show = (k, turn = angle(k)) => {
      dial.style.setProperty('--turn', turn + 'deg')
      if (k === at && dial.dataset.shown) return
      at = k; dial.dataset.shown = ''
      const [size, ours, theirs, plan, words] = steps[k]
      put('size', size); put('ours', ours); put('theirs', theirs); put('plan', plan)
      const lit = Math.round(1 + (cells.length - 1) * k / last)
      cells.forEach((cell, i) => cell.toggleAttribute('data-on', i < lit))
      dial.setAttribute('aria-valuenow', String(k)); dial.setAttribute('aria-valuetext', words)
    }
    const nearest = turn => Math.max(0, Math.min(last, Math.round((turn + 140) / 280 * last)))
    dial.addEventListener('keydown', event => {
      const to = { ArrowRight: at + 1, ArrowUp: at + 1, ArrowLeft: at - 1, ArrowDown: at - 1, PageUp: at + 2, PageDown: at - 2, Home: 0, End: last }[event.key]
      if (to === undefined) return
      event.preventDefault(); show(Math.max(0, Math.min(last, to)))
    })
    let grip = null
    const bearing = event => { const r = dial.getBoundingClientRect(); return Math.atan2(event.clientY - r.top - r.height / 2, event.clientX - r.left - r.width / 2) * 180 / Math.PI }
    dial.addEventListener('pointerdown', event => { if (event.button !== 0) return; dial.setPointerCapture(event.pointerId); grip = { from: bearing(event), y: event.clientY, angle: angle(at), moved: 0 } })
    dial.addEventListener('pointermove', event => {
      if (!grip) return
      // Round the knob, or (where the knob is too small to go round, on a phone) up and down past it: a step a turn of 28°.
      const round = ((bearing(event) - grip.from + 540) % 360) - 180, upDown = (grip.y - event.clientY) * 2
      const turned = Math.abs(upDown) > Math.abs(round) ? upDown : round
      grip.moved = Math.max(grip.moved, Math.abs(turned))
      if (grip.moved < 6) return
      const turn = Math.max(-140, Math.min(140, grip.angle + turned))
      show(nearest(turn), turn)
    })
    const up = () => { const g = grip; grip = null; if (!g) return; if (g.moved < 6) show(at === last ? 0 : at + 1); else show(at) }
    dial.addEventListener('pointerup', up)
    dial.addEventListener('pointercancel', () => { grip = null; show(at) })
  }
})()
