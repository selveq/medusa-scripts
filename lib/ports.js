// closest available ports: probe upward from each preferred port, pinned until --reset
const fs = require('node:fs')
const path = require('node:path')
const net = require('node:net')
const { execSync } = require('node:child_process')
const config = require('./config.js')
const paths = require('./paths.js')

const cacheDir = (root) => paths.cacheDir(root)

const cachePath = (root) => path.join(cacheDir(root), 'ports.json')

const projectId = (root, lma = config.load(root)) => lma.projectId || paths.pathId(root)

const projectName = (root, lma = config.load(root)) =>
    `${config.project(root, lma)}-${projectId(root, lma)}`

const basePorts = (lma) => {
    const s = lma.services || {}
    const x = lma.proxy || {}
    const { backend, store } = config.apps(lma)
    const map = {
        http: Number(x.port) || 80,
        postgres: Number((s.postgres || {}).port) || 5432,
        redis: Number((s.redis || {}).port) || 6379,
        [backend.name]: backend.port,
        [store.name]: store.port,
    }
    // a config from before names existed may list more apps, and a tunnel can still publish them
    for (const [name, app] of Object.entries(lma.apps || {})) {
        if (!(name in map) && Number((app || {}).port)) map[name] = Number(app.port)
    }
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

const readPins = (file) => {
    try {
        const saved = JSON.parse(fs.readFileSync(file, 'utf8'))
        return saved.ports ? saved : { ports: saved, bases: {} }
    } catch { return { ports: {}, bases: {} } }
}

// frozen reads the map and leaves it alone: only what brings the stack up may move a port
async function resolve(root, { reset = false, frozen = false } = {}) {
    const lma = config.load(root)
    const bases = basePorts(lma)
    paths.ensure(root)
    const file = cachePath(root)
    const own = ownDockerPorts(projectName(root, lma))
    if (reset && (own.size || Object.keys(bases).some((svc) => ownAppAlive(root, svc)))) {
        throw new Error('this stack is running, and it would stay on its old ports: lma stop, then lma ports --reset')
    }
    const pins = reset ? { ports: {}, bases: {} } : readPins(file)
    const ports = {}
    const taken = new Set()
    for (const [svc, base] of Object.entries(bases)) {
        // a port edited in the config replaces the pin made for the old one
        const pinned = pins.bases[svc] === undefined || pins.bases[svc] === base ? pins.ports[svc] : undefined
        if (frozen && Number.isInteger(pinned)) {
            taken.add(pinned)
            ports[svc] = pinned
            continue
        }
        const start = Number.isInteger(pinned) ? pinned : base
        const appAlive = ownAppAlive(root, svc)
        let p = start
        for (;;) {
            const heldBySelf = own.has(p) || (appAlive && p === start)
            if (!taken.has(p) && (heldBySelf || await isFree(p))) break
            p += 1
            if (p > base + 100) throw new Error(`no free port near ${base} for ${svc}`)
        }
        taken.add(p)
        ports[svc] = p
    }
    if (!frozen) {
        fs.mkdirSync(path.dirname(file), { recursive: true })
        fs.writeFileSync(file, JSON.stringify({ ports, bases }, null, 2) + '\n')
    }
    return { ports, bases, cachePath: file }
}

module.exports = { resolve, cachePath, cacheDir, basePorts, projectId, projectName }
