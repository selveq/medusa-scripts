// starts a command in its own session, logging to a file, and prints its pid
// closing the terminal must not end a dev server, and nohup cannot promise that because node resets SIGHUP
const { spawn } = require('node:child_process')
const fs = require('node:fs')

const [log, command, ...args] = process.argv.slice(2)
const out = fs.openSync(log, 'a', 0o600)
const child = spawn(command, args, { detached: true, stdio: ['ignore', out, out] })
child.on('error', (e) => {
    console.error(e.message)
    process.exit(1)
})
child.on('spawn', () => {
    process.stdout.write(`${child.pid}\n`)
    child.unref()
})
