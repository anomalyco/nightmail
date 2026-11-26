import { WORDMARK } from "./brand.js"

// One texture atlas, drawn once with Canvas 2D: the notifications on Doug's phone, his replies,
// the commercial's kinetic type, fine print, and glyph sets for anything that changes every frame
// (the badge, the studio's readout, signs).

// Doug bought one garden gnome from Gnome Depot. This is everything Gnome Depot sent him about it:
// [sender, icon letter, subject, preview, corner tag]. Emails are tagged "via NIGHTMAIL".
const VIA = "via NIGHTMAIL"
export const CARDS = {
  order: ["Gnome Depot · Checkout", "G", "Order placed ✓", "1 × Garden Gnome. Great choice, Doug!", ""],
  receipt: ["Gnome Depot", "G", "Your receipt · $84.00", "1 × Garden Gnome. Thanks, Doug!"],
  ship1: ["Gnome Depot", "G", "Your gnome has shipped!", "He's on his way. So are more emails."],
  ship2: ["Gnome Depot", "G", "Your gnome is out for delivery!", "Look out of your window."],
  ship3: ["Gnome Depot", "G", "Your gnome was delivered!", "He's right there. Say hi."],
  ship4: ["Gnome Depot", "G", "How are you enjoying your gnome?", "It's been four seconds."],
  weekly: ["Gnome Depot Weekly", "G", "Hi DOUG!", "It's 3 a.m. The perfect time for gnome news."],
  daily: ["Gnome Depot DAILY", "G", "Hi again, DOUG!", "Since you opened Weekly so fast."],
  hourly: ["Gnome Depot HOURLY", "G", "DOUG. It's been an hour.", "Here is what your gnome did."],
  news: ["Gnome Depot HOURLY", "G", "9 gnomes that look like celebrities", "Tap to read. We'll know."],
  moved: ["Gnome Depot", "G", "Unsubscribed from HOURLY ✓", "You've been moved to Gnome Depot MINUTELY."],
  thanks: ["Gnome Depot Support", "G", "Thanks for writing in, Doug!", "Here's 10% off your next gnome 🎉"],
  also: ["Gnome Depot", "G", "You might also like:", "Gnome (Large)"],
  coupon1: ["Gnome Depot", "G", "We sense you're upset, Doug.", "Here's 15% off!"],
  coupon2: ["Gnome Depot", "G", "Still upset? 20% off!", "We can do this all day."],
  coupon3: ["Gnome Depot", "G", "25% off. Our final offer.", "(It is not our final offer.)"],
  bot1: ["Agent #0412", "A", "A haiku about your gnome", "Small hat. Stony gaze. / He waits. As do my emails."],
  bot2: ["Agent #0007", "A", "Re: Re: Re: please stop", "Per my last 4,000 emails:"],
  bot3: ["Agent #0233", "A", "Doug, I'm an AI agent.", "I'll be in touch."],
  last: ["Gnome Depot", "G", "That looked stressful, Doug.", "Here's 40% off your next gnome!"],
}
// The ones that never stop: they keep arriving underneath everything else, as one-line banners.
export const LINES = {
  ship: ["Your gnome has shipped!", "Your gnome is nearby", "Your gnome was delivered!", "Delivery update: still delivered", "Rate your gnome"],
  news: ["Gnome Depot Weekly", "Gnome Depot DAILY", "Gnome Depot HOURLY", "Gnome of the Hour"],
  minutely: ["Gnome Depot MINUTELY", "Gnome of the Minute", "This minute in gnomes"],
  bot: ["Agent #0891 followed up", "A limerick about your gnome", "Agent #0007: per my last email", "Agent #0412 is typing…", "Circling back, Doug"],
  reply: ["Re: please stop", "Was this reply helpful?", "10% off your next gnome", "You might also like: Gnome (XL)"],
  team: ["Gary replied", "Deb replied to Gary", "Raj replied to all", "Re: Re: Re: who's Doug?"],
  coupon: ["15% off!", "20% off!", "You seem upset: 30% off!", "We're sorry you're sorry"],
}

// Doug writes back.
export const BUBBLES = ["please stop", "STOP EMAILING ME"]
// …and Gnome Depot's whole team answers: [who, what they said]
export const TEAM = [
  ["Gary", "lol"],
  ["Deb", "who's Doug?"],
  ["Raj", "Doug!! 👋"],
  ["Kim", "+1 please stop"],
  ["Stu", "can we add him to VIP?"],
  ["Pat", "Reply-all: please stop replying all."],
]

// The band's kinetic type. Each line is cued by a word the announcer says (see show.js).
export const TV_TEXT = [
  "FOLKS!", "GOT CUSTOMERS?", "THEN YOU SEND EMAIL!",
  "ONE LINE OF CODE!", "RECEIPT: SENT!", "0.1 SECONDS!",
  "20¢", "20¢ PER THOUSAND!", "WHY SEND JUST ONE?",
  "NO PER-CONTACT PRICING!", "EVERYBODY ON THE NEWSLETTER!", "SCHEDULE IT FOR ANY TIME!",
  "YOU SEE EVERYTHING!", "DELIVERED!", "OPENED!", "CLICKED!", "WE SAW YOU OPEN THAT.",
  "BUT WAIT!", "THERE'S MORE!", "CUSTOMERS WRITE BACK?", "ANSWER THEM!", "INSTANTLY!",
  "POST EVERY REPLY TO SLACK!", "THE WHOLE TEAM CAN ANSWER!",
  "ANGRY CUSTOMER?", "THE AI KNOWS!", "97%!", "SEND MORE COUPONS!",
  "PLUG IN YOUR AI AGENTS!", "HUNDREDS OF ROBOTS!", "SENDING EMAIL!", "ALL NIGHT LONG!", "CALL N—", "CALL…", "…NOW…",
  "DOUG — ACTUAL RECIPIENT",
]
export const FINE = {
  api: "*Accepted means queued, not delivered.",
  price: "*$0.20 per 1,000 sent or received. Prepaid. 5,000 + 5,000 free every month.",
  campaigns: "*New workspaces start at 100 recipients a day. Unsubscribe link included.",
  tracking: "*Open tracking isn't always accurate.",
  inbox: "*Received mail has its own free 5,000.",
  rule: "*Forwarding needs the recipient's OK first. Gary said OK.",
  ai: "*AI scores can be wrong. Opt-in. Free.",
  agent: "*Hosted limits apply.",
}
const MONO = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 :.,-–—·%°×+#@/!?'\"“”()<>_=$*&abcdefghijklmnopqrstuvwxyz{}→…✓"

class Packer {
  constructor(w) {
    this.w = w
    this.x = 0
    this.y = 0
    this.row = 0
  }
  place(w, h) {
    const pad = 4
    if (this.x + w + pad > this.w) {
      this.x = 0
      this.y += this.row + pad
      this.row = 0
    }
    const r = { x: this.x, y: this.y }
    this.x += w + pad
    this.row = Math.max(this.row, h)
    return r
  }
}

export async function buildAtlas() {
  await Promise.all(
    ['600 20px "Inter Variable"', '800 20px "Inter Variable"', '500 20px "Inter Variable"', '400 20px "Bungee"', '500 20px "IBM Plex Mono"', '600 20px "IBM Plex Mono"'].map((f) => document.fonts.load(f).catch(() => null)),
  )
  const W = 4096
  const H = 4096
  const cv = document.createElement("canvas")
  cv.width = W
  cv.height = H
  const ctx = cv.getContext("2d")
  const pk = new Packer(W)
  const items = new Map()
  const add = (name, w, h, scale, draw) => {
    const pw = Math.ceil(w * scale)
    const ph = Math.ceil(h * scale)
    const r = pk.place(pw, ph)
    ctx.save()
    ctx.translate(r.x, r.y)
    ctx.scale(scale, scale)
    draw(ctx)
    ctx.restore()
    items.set(name, { u0: r.x / W, v0: r.y / H, u1: (r.x + pw) / W, v1: (r.y + ph) / H, w, h })
  }
  const font = (weight, size, fam = '"Inter Variable", Inter, system-ui, sans-serif') => `${weight} ${size}px ${fam}`
  const mono = '"IBM Plex Mono", ui-monospace, monospace'
  const bungee = '"Bungee", Impact, sans-serif'
  const icon = (c, x, y, s, letter) => {
    c.beginPath()
    c.roundRect(x, y, s, s, s * 0.2)
    c.fillStyle = "#2B2B2A"
    c.fill()
    c.fillStyle = "#fff"
    c.font = font(800, s * 0.54)
    c.textAlign = "center"
    c.textBaseline = "middle"
    c.fillText(letter, x + s / 2, y + s / 2 + s * 0.04)
    c.textAlign = "left"
    c.textBaseline = "alphabetic"
  }

  // notification cards, 2.5× (they are read)
  for (const [key, [app, letter, title, body, tag = VIA]] of Object.entries(CARDS)) {
    add("card:" + key, 312, 70, 2.5, (c) => {
      c.beginPath()
      c.roundRect(1, 1, 310, 68, 9)
      c.fillStyle = "rgba(246,244,239,0.98)"
      c.fill()
      icon(c, 12, 13, 26, letter)
      c.fillStyle = "#8A8D96"
      c.font = font(600, 10.5)
      c.fillText(app.toUpperCase(), 48, 22, 170)
      c.textAlign = "right"
      c.font = font(600, 9)
      c.fillText(tag, 298, 22)
      c.textAlign = "left"
      c.fillStyle = "#15161A"
      c.font = font(700, 13.5)
      c.fillText(title, 48, 41, 252)
      c.fillStyle = "#5C606B"
      c.font = font(500, 12.5)
      c.fillText(body, 48, 58, 252)
    })
  }
  // the ones that never stop: one line each
  for (const s of Object.values(LINES).flat()) {
    add("line:" + s, 312, 30, 2.5, (c) => {
      c.beginPath()
      c.roundRect(1, 1, 310, 28, 7)
      c.fillStyle = "rgba(246,244,239,0.96)"
      c.fill()
      icon(c, 8, 6, 18, "G")
      c.fillStyle = "#15161A"
      c.font = font(700, 12.5)
      c.textBaseline = "middle"
      c.fillText(s, 35, 15.5, 206)
      c.textAlign = "right"
      c.fillStyle = "#8A8D96"
      c.font = font(600, 8.5)
      c.fillText(VIA, 302, 15.5)
    })
  }
  // the newsletter, opened: a long way down to a very small link
  add("email", 312, 300, 2, (c) => {
    c.fillStyle = "#F6F4EF"
    c.fillRect(0, 0, 312, 300)
    icon(c, 12, 12, 26, "G")
    c.fillStyle = "#8A8D96"
    c.font = font(600, 10.5)
    c.fillText("GNOME DEPOT HOURLY", 48, 22)
    c.textAlign = "right"
    c.font = font(600, 9)
    c.fillText(VIA, 298, 22)
    c.textAlign = "left"
    c.fillStyle = "#15161A"
    c.font = font(700, 13.5)
    c.fillText("9 gnomes that look like celebrities", 48, 41)
    for (let i = 0; i < 3; i++) {
      const x = 14 + i * 98
      c.fillStyle = "#DAD6CC"
      c.fillRect(x, 54, 88, 62)
      c.fillStyle = "#fff"
      c.beginPath()
      c.arc(x + 44, 96, 11, 0, 7)
      c.fill()
      c.fillStyle = "#D8301F"
      c.beginPath()
      c.moveTo(x + 31, 90)
      c.lineTo(x + 57, 90)
      c.lineTo(x + 44 + (i - 1) * 3, 62)
      c.fill()
    }
    c.fillStyle = "#B9B6AE"
    ;[284, 262, 276, 190, 280, 268, 284, 150].forEach((w, i) => c.fillRect(14, 128 + i * 11, w, 4))
    c.beginPath()
    c.roundRect(96, 226, 120, 24, 5)
    c.fillStyle = "#2B2B2A"
    c.fill()
    c.fillStyle = "#fff"
    c.font = font(700, 10.5)
    c.textAlign = "center"
    c.fillText("SHOP GNOMES", 156, 242)
    c.fillStyle = "#A9ABB0"
    c.font = font(500, 7.5)
    c.fillText("Gnome Depot · 1 Gnome Way · You get this because you bought a gnome.", 156, 270)
    c.fillStyle = "#77797F"
    c.font = font(600, 10.5)
    c.fillText("unsubscribe", 156, 289)
    c.fillRect(125, 291.5, 62, 0.9)
    c.textAlign = "left"
  })
  // a card from across the room: paper, a dark square and two grey lines
  add("mini", 78, 20, 2, (c) => {
    c.beginPath()
    c.roundRect(0.5, 0.5, 77, 19, 3)
    c.fillStyle = "#EDEBE5"
    c.fill()
    c.strokeStyle = "rgba(0,0,0,0.35)"
    c.lineWidth = 1
    c.stroke()
    c.fillStyle = "#2B2B2A"
    c.fillRect(4, 4, 8, 8)
    c.fillStyle = "#77797f"
    c.fillRect(16, 5, 40, 3)
    c.fillStyle = "#a9abb0"
    c.fillRect(16, 12, 54, 3)
  })
  // the mail app on his phone; the badge is drawn live
  add("mail", 44, 44, 3, (c) => {
    c.beginPath()
    c.roundRect(1, 1, 42, 42, 10)
    c.fillStyle = "#F6F4EF"
    c.fill()
    c.strokeStyle = "#2B2B2A"
    c.lineWidth = 2.4
    c.lineJoin = "round"
    c.strokeRect(10, 13.5, 24, 17)
    c.beginPath()
    c.moveTo(10, 14.5)
    c.lineTo(22, 24)
    c.lineTo(34, 14.5)
    c.stroke()
  })

  // Doug's replies: dark bubbles, the way your own messages look
  for (const s of BUBBLES) {
    ctx.font = font(600, 17)
    const tw = Math.ceil(ctx.measureText(s).width) + 36
    add("bub:" + s, tw, 46, 3, (c) => {
      c.beginPath()
      c.roundRect(1, 1, tw - 2, 38, 12)
      c.fillStyle = "#2B2B2A"
      c.fill()
      c.strokeStyle = "rgba(244,242,236,0.85)"
      c.lineWidth = 1.5
      c.stroke()
      c.beginPath()
      c.moveTo(tw - 30, 38)
      c.lineTo(tw - 16, 45)
      c.lineTo(tw - 18, 38)
      c.fillStyle = "#2B2B2A"
      c.fill()
      c.fillStyle = "#F4F2EC"
      c.font = font(600, 17)
      c.textBaseline = "middle"
      c.fillText(s, 18, 20.5)
    })
  }
  // his reply as Gnome Depot's Slack sees it, and what each of the team says back
  add("slack", 312, 66, 3, (c) => {
    c.beginPath()
    c.roundRect(1, 1, 310, 64, 6)
    c.fillStyle = "#F6F4EF"
    c.fill()
    c.fillStyle = "#8A8D96"
    c.font = font(600, 10.5)
    c.fillText("# CUSTOMER-REPLIES", 14, 19)
    c.fillStyle = "#C98A3E"
    c.fillRect(14, 28, 26, 26)
    c.fillStyle = "#15161A"
    c.font = font(700, 13)
    c.fillText("Nightmail", 50, 39)
    c.fillStyle = "#8A8D96"
    c.font = font(600, 9.5)
    c.fillText("APP", 116, 39)
    c.fillStyle = "#15161A"
    c.font = font(500, 13)
    c.fillText("New reply from a customer: “please stop”", 50, 56, 252)
  })
  TEAM.forEach(([who, said], i) => {
    // one or two lines
    ctx.font = font(700, 15)
    const words = said.split(" ")
    let a = said
    let b = ""
    if (ctx.measureText(said).width > 168) {
      const cut = Math.ceil(words.length / 2)
      a = words.slice(0, cut).join(" ")
      b = words.slice(cut).join(" ")
    }
    add("team:" + i, 190, 60, 3, (c) => {
      c.beginPath()
      c.roundRect(1, 1, 188, 58, 8)
      c.fillStyle = "rgba(246,244,239,0.98)"
      c.fill()
      c.fillStyle = "#8A8D96"
      c.font = font(700, 9.5)
      c.fillText(who.toUpperCase() + " · GNOME DEPOT", 11, 16)
      c.fillStyle = "#15161A"
      c.font = font(700, 15)
      if (b) {
        c.fillText(a, 11, 34, 168)
        c.fillText(b, 11, 51, 168)
      } else c.fillText(a, 11, 42, 168)
    })
  })

  // the commercial's type: cream Bungee with a heavy outline and a hard shadow
  for (const s of TV_TEXT) {
    const size = 64
    ctx.font = font(400, size, bungee)
    const tw = Math.ceil(ctx.measureText(s).width) + 30
    add("tv:" + s, tw, size + 30, 1.5, (c) => {
      c.font = font(400, size, bungee)
      c.textBaseline = "middle"
      c.lineJoin = "round"
      c.fillStyle = "#1c0d05"
      c.strokeStyle = "#1c0d05"
      c.lineWidth = 14
      c.strokeText(s, 15, (size + 30) / 2 + 7)
      c.fillText(s, 15, (size + 30) / 2 + 7)
      c.lineWidth = 11
      c.strokeText(s, 9, (size + 30) / 2)
      c.fillStyle = "#fff"
      c.fillText(s, 9, (size + 30) / 2)
    })
  }
  for (const [k, s] of Object.entries(FINE)) {
    const size = 15
    ctx.font = font(500, size)
    const tw = Math.ceil(ctx.measureText(s).width) + 8
    add("fine:" + k, tw, size + 8, 2, (c) => {
      c.font = font(500, size)
      c.textBaseline = "middle"
      c.fillStyle = "#fff"
      c.fillText(s, 4, (size + 8) / 2)
    })
  }

  // glyph sets for text that changes: the readout, signs, the badge
  const glyphs = {}
  const glyphSet = (key, chars, f, size, scale, track = 0) => {
    const set = {}
    ctx.font = f
    for (const ch of chars) {
      const w = Math.ceil(ctx.measureText(ch).width) + 4
      add(`g:${key}:${ch}`, w, size * 1.3, scale, (c) => {
        c.font = f
        c.textBaseline = "middle"
        c.fillStyle = "#fff"
        c.fillText(ch, 2, size * 0.68)
      })
      set[ch] = { name: `g:${key}:${ch}`, adv: w - 4 + track }
    }
    glyphs[key] = { set, size }
  }
  glyphSet("mono", MONO, font(600, 26, mono), 26, 2, 1.5)
  glyphSet("badge", "0123456789,+", font(800, 16), 16, 3)
  add("dot", 16, 16, 2, (c) => {
    c.beginPath()
    c.arc(8, 8, 7, 0, 7)
    c.fillStyle = "#fff"
    c.fill()
  })

  const wm = new Path2D(WORDMARK.d)
  add("logo", 620, 80, 2, (c) => {
    const k = 600 / WORDMARK.w
    for (const [dx, dy, col] of [[7, 8, "#1c0d05"], [0, 0, "#FFF3D6"]]) {
      c.save()
      c.translate(10 + dx, 12 + dy)
      c.scale(k, k)
      if (dx) {
        c.lineJoin = "miter"
        c.strokeStyle = col
        c.lineWidth = 220
        c.stroke(wm)
      }
      c.fillStyle = col
      c.fill(wm, "evenodd")
      c.restore()
    }
  })
  add("logo:flat", 600, 56, 2, (c) => {
    c.scale(600 / WORDMARK.w, 600 / WORDMARK.w)
    c.fillStyle = "#fff"
    c.fill(wm, "evenodd")
  })
  if (pk.y + pk.row > H) console.warn("atlas overflow", pk.y + pk.row)
  return { canvas: cv, items, glyphs }
}
