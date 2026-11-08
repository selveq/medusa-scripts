// every service takes the first free port in its band, pinned in the state folder until --reset
const fs = require('node:fs')
const net = require('node:net')
const path = require('node:path')
const { execSync } = require('node:child_process')
const config = require('./config.js')
const paths = require('./paths.js')

// where each service looks first, and how far up it may go
const BANDS = { http: [80, 180], postgres: [5432, 5532], redis: [6379, 6479], backend: [9000, 9999], store: [8000, 8999] }

const pinPath = (root) => paths.sub(root, 'ports.json')

const projectId = (root, lma = config.load(root)) => lma.projectId || paths.pathId(root)

const projectName = (root, lma = config.load(root)) =>
    `${config.project(root, lma)}-${projectId(root, lma)}`

// a port in the config is where the search starts, and the band stretches to keep a hundred above it
const band = ([from, to], wanted) => (wanted ? { from: wanted, to: Math.max(to, wanted + 100), wanted } : { from, to })

const bands = (lma) => {
    const s = lma.services || {}
    const x = lma.proxy || {}
    const { backend, stores } = config.apps(lma)
    const map = {
        http: band(BANDS.http, Number(x.port)),
        postgres: band(BANDS.postgres, Number((s.postgres || {}).port)),
        redis: band(BANDS.redis, Number((s.redis || {}).port)),
        [backend.name]: band(BANDS.backend, backend.port),
    }
    for (const store of stores) map[store.name] = band(BANDS.store, store.port)
    return map
}

const answers = (port) => new Promise((resolve) => {
    const socket = net.connect(port, '127.0.0.1')
    socket.once('connect', () => { socket.destroy(); resolve(true) })
    socket.once('error', () => resolve(false))
})

// a privileged port refuses us whoever holds it, and the root Docker daemon can still publish it: ask if anything answers
const bindable = (port, host) => new Promise((resolve) => {
    const srv = net.createServer()
    srv.once('error', (e) => {
        if (e.code === 'EACCES') answers(port).then((up) => resolve(!up))
        else resolve(false)
    })
    srv.once('listening', () => srv.close(() => resolve(true)))
    srv.listen(port, host)
})

const isFree = async (port) =>
    (await bindable(port, '0.0.0.0')) && (await bindable(port, '127.0.0.1'))

const ownDockerPorts = (project) => {
    try {
        const out = execSync(
            `docker ps --filter "name=${project}-" --format "{{.Ports}}"`,
            { stdio: ['ignore', 'pipe', 'ignore'] }
        ).toString()
        return new Set([...out.matchAll(/:(\d+)->/g)].map((m) => Number(m[1])))
    } catch { return new Set() }
}

// same rule local.sh applies: a live pid is ours only if it started when we recorded
// ps prints this in the locale and timezone it runs under, so they are pinned
const startedAt = (pid, env = { ...process.env, LC_ALL: 'C', TZ: 'UTC' }) => {
    try {
        return execSync(`ps -p ${pid} -o lstart=`, { stdio: ['ignore', 'pipe', 'ignore'], env })
            .toString().replace(/ +/g, ' ').trim()
    } catch { return '' }
}

const ownAppAlive = (root, svc) => {
    try {
        const pid = parseInt(
            fs.readFileSync(paths.sub(root, 'run', `${svc}.pid`), 'utf8'), 10)
        if (!Number.isInteger(pid) || pid <= 0) return false
        process.kill(pid, 0)
        let recorded = ''
        try { recorded = fs.readFileSync(paths.sub(root, 'run', `${svc}.id`), 'utf8').trim() }
        catch { return true } // nothing recorded: the pid is all we have
        // a server started before 0.3.0 was recorded in whatever locale that shell had
        return recorded === startedAt(pid) || recorded === startedAt(pid, process.env)
    } catch (e) { return e.code === 'EPERM' }
}

// 0.3.0 pinned under "bases", every service with its default: those pins are let go and found again
const readPins = (file) => {
    try {
        const saved = JSON.parse(fs.readFileSync(file, 'utf8'))
        return { ports: saved.ports || {}, preferred: saved.preferred || {} }
    } catch { return { ports: {}, preferred: {} } }
}

// every lma project on this machine pins beside its secrets: a port pinned by another one is taken, up or not, so projects never trade ports
const pinnedByOthers = (file) => {
    const taken = new Set()
    let dirs = []
    try { dirs = fs.readdirSync(paths.home()) } catch { return taken }
    for (const dir of dirs) {
        const other = path.join(paths.home(), dir, 'ports.json')
        if (other === file) continue
        for (const port of Object.values(readPins(other).ports)) taken.add(port)
    }
    return taken
}

// frozen reads the map and leaves it alone: only what brings the stack up may move a port
async function resolve(root, { reset = false, frozen = false } = {}) {
    const lma = config.load(root)
    const wanted = bands(lma)
    paths.ensure(root)
    const file = pinPath(root)
    const own = ownDockerPorts(projectName(root, lma))
    if (reset && (own.size || Object.keys(wanted).some((svc) => ownAppAlive(root, svc)))) {
        throw new Error('this stack is running, and it would stay on its old ports: lma stop, then lma ports --reset')
    }
    const pins = reset ? { ports: {}, preferred: {} } : readPins(file)
    const ports = {}
    const preferred = {}
    const mine = new Set()
    const others = pinnedByOthers(file)
    for (const [svc, { from, to, wanted: port }] of Object.entries(wanted)) {
        if (port) preferred[svc] = port
        // a port edited in the config, or taken out of it, replaces the pin made under the old one
        const pinned = pins.preferred[svc] === preferred[svc] ? pins.ports[svc] : undefined
        if (frozen && Number.isInteger(pinned)) {
            mine.add(pinned)
            ports[svc] = pinned
            continue
        }
        const start = Number.isInteger(pinned) ? pinned : from
        const appAlive = ownAppAlive(root, svc)
        let p = start
        for (;;) {
            // a port this stack holds is its own even if another project pinned it too: the one that is up keeps it
            const heldBySelf = own.has(p) || (appAlive && p === start)
            if (!mine.has(p) && (heldBySelf || (!others.has(p) && await isFree(p)))) break
            p += 1
            if (p > to) throw new Error(`no free port for ${svc} between ${from} and ${to}`)
        }
        mine.add(p)
        ports[svc] = p
    }
    if (!frozen) fs.writeFileSync(file, JSON.stringify({ ports, preferred }, null, 2) + '\n')
    return { ports, preferred, pinPath: file }
}

module.exports = { BANDS, resolve, pinPath, bands, projectId, projectName }
