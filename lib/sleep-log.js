// what pmset's log says about sleep in a window of time; caffeinate cannot stop a closed lid, so it is asked afterwards
const fs = require('node:fs')

// the kind runs to the tab and can hold spaces: Wake Requests is not a Wake
const LINE = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) ([+-]\d{2})(\d{2}) (.+?)\s*\t(.*)$/

const sleeps = (text, from, to) => {
    const events = []
    let open = null
    for (const line of String(text).split('\n')) {
        const m = line.match(LINE)
        if (!m) continue
        const at = Date.parse(`${m[1]}T${m[2]}${m[3]}:${m[4]}`)
        if (at < from || at > to) continue
        const kind = m[5]
        if (kind === 'Sleep' && /Entering Sleep state/.test(m[6])) {
            open = { at, until: to, reason: (m[6].match(/due to '([^']*)'/) || [])[1] || 'no reason given' }
            events.push(open)
        } else if (open && (kind === 'Wake' || kind === 'DarkWake')) {
            open.until = at
            open = null
        }
    }
    return events
}

const span = (ms) => {
    const seconds = Math.round(ms / 1000)
    if (seconds < 60) return `${seconds}s`
    const minutes = Math.round(seconds / 60)
    return minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

const summary = (events) => {
    const total = events.reduce((sum, e) => sum + (e.until - e.at), 0)
    const reasons = [...new Set(events.map((e) => e.reason))].join(', ')
    const times = events.length === 1 ? '1 time' : `${events.length} times`
    return `the Mac slept ${times} during this run, ${span(total)} in all: ${reasons}`
}

if (require.main === module) {
    const [from, to] = process.argv.slice(2).map((s) => Number(s) * 1000)
    const events = sleeps(fs.readFileSync(0, 'utf8'), from, to)
    if (events.length) console.log(summary(events))
}

module.exports = { sleeps, summary }
