// The API's CSV rules (api/src/audience/imports.ts parseCsv): quoted fields, doubled quotes inside them, CRLF, CR or LF line
// ends and a BOM; rows whose cells are all blank are skipped, as the API skips them, so row numbers agree with its own.
// Rows come one at a time and cells are cut from the text, so a 100 MiB file is read without a copy per character.
export function* csvRows(text: string): Generator<string[]> {
  const special = /[",\r\n]/g
  let row: string[] = [], cell = '', endedQuote = false, i = text.charCodeAt(0) === 0xfeff ? 1 : 0
  const finish = () => { row.push(cell); const done = row; row = []; cell = ''; endedQuote = false; return done.some(value => value.trim()) ? done : null }
  while (i < text.length) {
    special.lastIndex = i
    const match = special.exec(text), next = match ? match.index : text.length, run = text.slice(i, next)
    if (!endedQuote) cell += run
    else if (/[^ \t]/.test(run)) throw new Error('Unexpected text after a quoted CSV field.')
    if (!match) break
    const char = text[next]
    if (char === '"') {
      if (cell || endedQuote) throw new Error('Unexpected quote in the CSV. Quote the entire field and double any quotes inside it.')
      let from = next + 1
      for (;;) {
        const quote = text.indexOf('"', from)
        if (quote < 0) throw new Error('An opening quote in the CSV has no closing quote.')
        cell += text.slice(from, quote)
        if (text[quote + 1] !== '"') { from = quote + 1; break }
        cell += '"'; from = quote + 2
      }
      endedQuote = true; i = from
    } else if (char === ',') { row.push(cell); cell = ''; endedQuote = false; i = next + 1 }
    else {
      i = next + (char === '\r' && text[next + 1] === '\n' ? 2 : 1)
      const done = finish()
      if (done) yield done
    }
  }
  const done = finish()
  if (done) yield done
}
