// what a dev server's log says, without following it
const fs = require('node:fs')
const path = require('node:path')

// colours, terminal titles and bare control characters: a log can hold what a visitor sent, and this prints to a terminal
// eslint-disable-next-line no-control-regex
const CONTROL = /\x1b\[[0-9;?]*[a-zA-Z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\\\)?|[\x00-\x08\x0b-\x1f\x7f]/g
// anchored so that a logged request cannot pass for a restart and hide the errors before it
const RESTART = /^--- lma started |^\s*(?:info:\s*)?\[(?:Watcher|HMR)\].*restarting (?:dev )?server|^\W*Found a change in .*restarting the server/i
const FAILED = /^\s*(\[\w+\]\s*)?(error:|⨯|\w*Error(:| \[)|uncaught\b|unhandled\b|npm error\b|fatal:)|\(5\d\d\) - |\s5\d\d in \d/i
const CONTINUES = /^\s+(at |\[cause\]|code:|errno:|syscall:|path:|stack:|details?:)|^\s*[}\]],?$/

const lines = (text) => String(text).replace(CONTROL, '').split('\n').filter((line, i, all) => line !== '' || i < all.length - 1)

// the last time lma started the app, or the app restarted itself; a log older than the marks is all kept
const sinceRestart = (text) => {
    const all = lines(text)
    let from = 0
    all.forEach((line, i) => { if (RESTART.test(line)) from = i })
    return all.slice(from)
}

const errors = (text) => {
    const kept = []
    let inside = false
    for (const line of lines(text)) {
        inside = FAILED.test(line) || (inside && CONTINUES.test(line))
        if (inside) kept.push(line)
    }
    return kept
}

const main = ([file, ...flags]) => {
    const unknown = flags.find((f) => f !== '--errors' && f !== '--since-restart')
    if (unknown) {
        console.error(`unknown flag ${unknown}; logs takes --errors and --since-restart`)
        process.exit(2)
    }
    const wantErrors = flags.includes('--errors')
    const recent = flags.includes('--since-restart')
    const text = fs.readFileSync(file, 'utf8')
    const scope = recent ? sinceRestart(text).join('\n') : text
    const shown = wantErrors ? errors(scope) : lines(scope)
    if (wantErrors && !shown.length) {
        const app = path.basename(file, '.log')
        return console.log(`no errors in the ${app} log${recent ? ' since its last restart' : ''}`)
    }
    console.log(shown.join('\n'))
}

if (require.main === module) main(process.argv.slice(2))

module.exports = { errors, sinceRestart }
