// Medusa writes wherever its env points, and lma's own checks read this stack: prints where the two differ
const path = require('node:path')
const envfile = require('./envfile.js')

const LOCAL = new Set(['localhost', '127.0.0.1', '[::1]'])

const elsewhere = ({ exported, fromFile, port, file }) => {
    const url = exported || fromFile
    if (!url) return ''
    const source = exported ? 'your shell' : file
    let target
    try {
        target = new URL(url)
    } catch {
        return `DATABASE_URL in ${source} is not a url`
    }
    const at = Number(target.port || 5432)
    if (LOCAL.has(target.hostname) && at === Number(port)) return ''
    return `DATABASE_URL in ${source} points at ${target.hostname}:${at}, and this stack's Postgres is on localhost:${port}`
}

if (require.main === module) {
    const [file, port] = process.argv.slice(2)
    const message = elsewhere({ exported: process.env.DATABASE_URL, fromFile: envfile.read(file).DATABASE_URL, port, file: path.relative(process.cwd(), file) })
    if (message) console.log(message)
}

module.exports = { elsewhere }
