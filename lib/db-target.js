// lma points Medusa at this stack's Postgres, so a DATABASE_URL exported for another one would be overridden: refuse instead
const LOCAL = new Set(['localhost', '127.0.0.1', '[::1]'])

const elsewhere = ({ exported, port }) => {
    if (!exported) return ''
    let target
    try {
        target = new URL(exported)
    } catch {
        return 'DATABASE_URL in your shell is not a url'
    }
    const at = Number(target.port || 5432)
    if (LOCAL.has(target.hostname) && at === Number(port)) return ''
    return `DATABASE_URL in your shell points at ${target.hostname}:${at}, and this stack's Postgres is on localhost:${port}`
}

if (require.main === module) {
    const message = elsewhere({ exported: process.env.DATABASE_URL, port: process.argv[2] })
    if (message) console.log(message)
}

module.exports = { elsewhere }
