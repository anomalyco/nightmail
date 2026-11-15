// The letters the sorter sorts: about three thousand, every one different (subject, sender, a line of body, where it is
// routed; scams are routed to the laser). They are written for this page and every address is fictional (.example or
// .invalid). The set is a gzipped file fetched after the machine is running, never part of a script; until it arrives
// the machine works through the dozen below.
import type { Letter } from './engine'
import url from './letters.bin?url'

const row = ([subject, from, addr, snippet, route]: readonly [string, string, string, string, number]): Letter => ({ subject, from, addr, snippet, route, scam: route === 7 })
// Routes: 0 thread, 1 endpoint, 2 agent inbox, 3 inbox, 4 mailbox, 5 ritual, 6 campaign, 7 the laser.
export const STARTERS: Letter[] = ([
  ['Your pager wants to be friends', 'On-Call Pager', 'pager@ops.invalid', 'We speak most nights. I have started to look forward to it.', 3],
  ['Your webhook is answering in Latin', 'Delivery Service', 'deliver@hooks.example', 'Status 200, but the body is a mood, not a response.', 1],
  ['Agent reporting a successful nothing', 'Agent Sable', 'sable@agents.invalid', 'No actions taken. No errors either. A quiet kind of victory.', 2],
  ['Re: the robot replied to my robot', 'Agent Orrin', 'orrin@agents.example', 'They are getting along. This may become a habit.', 0],
  ['Your lizard is being deported', 'Lizard Immigration', 'lizards@lizarddeport.invalid', 'He overstayed on your sofa. Only a fee will save him.', 7],
  ['Your fridge has written a short essay', 'Pantry Assistant', 'audit@fridge-logic.example', 'Title: On Being Opened. Twelve pages. Tone: considered, angry.', 4],
  ['Pager test: please ignore the pager', 'On-Call Pager', 'pager@ops.invalid', 'It cannot be ignored. That is the defining quality of a pager.', 5],
  ['We label the sausages by mood now', 'Counter Six Butcher', 'shop@countersixbutcher.example', 'Today: cheerful, thoughtful, and one that is clearly unsure.', 6],
  ['Order confirmed: 6 mugs, 7 handles', 'Handle Concern', 'orders@handleconcern.example', 'The extra handle has no mug. It is doing surprisingly well.', 3],
  ['You owe for the free parking', 'Free Parking Billing', 'billing@freeparking.invalid', 'The parking was free. The free part costs $12 a day.', 7],
  ['Your feature flag shipped to everyone', 'Flag Service', 'flags@internal.example', 'It was meant for 1 percent. It found 100 percent instead.', 1],
  ['Re: can you send me the file again', 'Zahir Bhatt', 'zahir@files.example', 'This is the fifth time. Each version is a different version.', 0],
] as const).map(row)

export async function loadLetters(): Promise<Letter[]> {
  const response = await fetch(url)
  if (!response.ok || !response.body) throw new Error('letters')
  return (await new Response(response.body.pipeThrough(new DecompressionStream('gzip'))).json() as [string, string, string, string, number][]).map(row)
}
