// the keys that name a port in the env files are lma's: rewritten when a port moved, so a build outside lma sees the right ones
const path = require('node:path')
const config = require('./config.js')
const envfile = require('./envfile.js')
const ports = require('./ports.js')

const sync = async (root, { databaseUrl, redisUrl }) => {
    const cfg = config.load(root)
    const { backend, stores } = config.apps(cfg)
    const map = (await ports.resolve(root, { frozen: true })).ports
    const files = [[path.join(backend.dir, '.env'), { PORT: map[backend.name], DATABASE_URL: databaseUrl, REDIS_URL: redisUrl }]]
    for (const store of stores) {
        files.push([path.join(store.dir, '.env.local'), { NEXT_PUBLIC_MEDUSA_BACKEND_URL: `http://localhost:${map[backend.name]}` }])
    }
    const out = []
    for (const [file, values] of files) {
        const changed = envfile.sync(path.join(root, file), values)
        if (changed.length) out.push(`rewrote ${file}: ${changed.join(', ')}`)
    }
    return out
}

if (require.main === module) {
    sync(process.argv[2], { databaseUrl: process.env.LMA_DATABASE_URL, redisUrl: process.env.LMA_REDIS_URL })
        .then((lines) => { for (const line of lines) console.log(line) })
        .catch((e) => { console.error(e.message); process.exit(1) })
}

module.exports = { sync }
