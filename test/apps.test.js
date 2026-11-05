// an app is called what the project calls it; lma only needs to know which one is the backend
const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')
const paths = require('../lib/paths.js')
const config = require('../lib/config.js')
const cors = require('../lib/cors.js')
const { project, cleanup, local, tunnel, holdAppPort, ranDocker, devRuns, devEnv, daemon, alive, killQuietly, started, sleep, PORTS } = require('./support/harness.js')

test.after(cleanup)

const NAMED = {
    apps: {
        backend: null,
        storefront: null,
        api: { role: 'backend', port: PORTS.backend },
        frontend: { port: PORTS.storefront },
    },
}

const named = () => {
    const dir = project(NAMED)
    for (const app of ['api', 'frontend']) fs.mkdirSync(path.join(dir, 'apps', app), { recursive: true })
    return dir
}

const record = (dir, app, pid) => {
    const run = paths.sub(dir, 'run')
    fs.mkdirSync(run, { recursive: true })
    fs.writeFileSync(path.join(run, `${app}.pid`), `${pid}\n`)
    fs.writeFileSync(path.join(run, `${app}.id`), started(pid))
}

test('the app marked role backend is the backend and the other one is the store', () => {
    const { backend, store } = config.apps({ apps: { api: { role: 'backend', port: 1 }, frontend: { port: 2 } } })
    assert.deepStrictEqual(backend, { name: 'api', dir: 'apps/api', port: 1 })
    assert.deepStrictEqual(store, { name: 'frontend', dir: 'apps/frontend', port: 2 })
})

test('a config written before names existed means what it always meant', () => {
    const { backend, store } = config.apps({ apps: { backend: { dir: 'b', port: 1 }, storefront: { dir: 's', port: 2 } } })
    assert.deepStrictEqual(backend, { name: 'backend', dir: 'b', port: 1 })
    assert.deepStrictEqual(store, { name: 'storefront', dir: 's', port: 2 })
})

test('a config with no apps gets the two defaults on their default ports', () => {
    const { backend, store } = config.apps({})
    assert.deepStrictEqual(backend, { name: 'backend', dir: 'apps/backend', port: 9000 })
    assert.deepStrictEqual(store, { name: 'storefront', dir: 'apps/storefront', port: 8000 })
})

test('a name that is not given a port takes the default of its role', () => {
    const { backend, store } = config.apps({ apps: { api: { role: 'backend' }, frontend: {} } })
    assert.strictEqual(backend.port, 9000)
    assert.strictEqual(store.port, 8000)
})

for (const [why, apps, message] of [
    ['two backends', { a: { role: 'backend' }, b: { role: 'backend' } }, /a project has one backend/],
    ['two stores', { backend: {}, a: {}, b: {} }, /a project has one store/],
    ['a service name', { redis: { role: 'backend' }, frontend: {} }, /'redis' is taken/],
    ['a name that cannot be a folder', { 'My App': { role: 'backend' }, frontend: {} }, /'My App' must be lowercase/],
    ['a name every object answers to', { constructor: { role: 'backend' }, frontend: {} }, /'constructor' is taken/],
]) {
    test(`a config with ${why} is refused`, () => {
        assert.throws(() => config.apps({ apps }), message)
    })
}

test('a config from before names existed may list more apps, and storefront is still the store', () => {
    const { backend, store } = config.apps({ apps: { backend: { port: 1 }, 'admin-ui': { port: 3 }, my_app: {}, storefront: { port: 2 } } })
    assert.strictEqual(backend.name, 'backend')
    assert.strictEqual(store.name, 'storefront')
})

test('such a project can still be stopped', () => {
    const dir = project({ apps: { 'admin-ui': { port: PORTS.http + 5 } } })
    assert.strictEqual(local(['stop'], { cwd: dir }).status, 0)
})

test('a bad apps block stops lma with the reason', () => {
    const dir = project({ apps: { backend: { role: 'backend' }, storefront: { role: 'backend' } } })
    const r = local(['status'], { cwd: dir })
    assert.notStrictEqual(r.status, 0)
    assert.match(r.out, /a project has one backend/)
})

test('start runs both apps from their own folders under their own names', () => {
    const dir = named()
    const r = local(['start'], { cwd: dir, env: { LMA_TEST_ADMIN_MATCHES: '1' } })
    assert.strictEqual(r.status, 0, r.out)
    assert.match(r.out, /api: +starting dev server/)
    assert.match(r.out, /frontend: +starting dev server/)
    assert.strictEqual(devEnv(dir, 'apps/api').PORT, String(PORTS.backend))
    assert.strictEqual(devEnv(dir, 'apps/frontend').PORT, String(PORTS.storefront))
    assert.strictEqual(devEnv(dir, 'apps/frontend').NEXT_PUBLIC_MEDUSA_BACKEND_URL, `http://localhost:${PORTS.backend}`)
})

test('status reports the apps by the names the project gave them', () => {
    const r = local(['status'], { cwd: named() })
    assert.match(r.out, new RegExp(`api down \\(:${PORTS.backend}\\)`))
    assert.match(r.out, new RegExp(`frontend down \\(:${PORTS.storefront}\\)`))
    assert.doesNotMatch(r.out, /storefront/)
})

test('logs takes an app by its name', () => {
    const r = local(['logs', 'frontend'], { cwd: named() })
    assert.notStrictEqual(r.status, 0)
    assert.match(r.out, /no log yet at .*frontend\.log/)
})

test('restart with a name restarts that app and leaves docker and the other app alone', () => {
    const dir = named()
    const other = daemon(dir, ['pretend-api'])
    const mine = daemon(dir, ['pretend-frontend'])
    try {
        record(dir, 'api', other)
        record(dir, 'frontend', mine)
        const r = local(['restart', 'frontend'], { cwd: dir })
        assert.strictEqual(r.status, 0, r.out)
        assert.match(r.out, new RegExp(`stopping frontend \\(pid ${mine}\\)`))
        assert.match(r.out, /frontend: +starting dev server/)
        assert.ok(alive(other), 'the other app keeps running')
        assert.ok(!ranDocker(dir, 'compose'), 'docker is not touched')
        assert.deepStrictEqual(devRuns(dir).map((run) => path.basename(run.cwd)), ['frontend'])
    } finally { killQuietly(other); killQuietly(mine) }
})

test('restart with a name it does not know refuses instead of restarting everything', () => {
    const dir = named()
    const r = local(['restart', 'backend'], { cwd: dir })
    assert.notStrictEqual(r.status, 0)
    assert.match(r.out, /no app named 'backend'; this project has: api frontend/)
    assert.ok(!ranDocker(dir, 'compose'))
    assert.deepStrictEqual(devRuns(dir), [])
})

test('restart with a name only plans under --dry-run', () => {
    const dir = named()
    const r = local(['restart', 'api', '--dry-run'], { cwd: dir })
    assert.strictEqual(r.status, 0, r.out)
    assert.match(r.out, new RegExp(`\\[dry-run\\] cd apps/api && npm run dev \\(PORT=${PORTS.backend}\\)`))
    assert.deepStrictEqual(devRuns(dir), [])
})

test('plain restart still recreates the containers', () => {
    const dir = project()
    const r = local(['restart'], { cwd: dir })
    assert.strictEqual(r.status, 0, r.out)
    assert.ok(ranDocker(dir, 'compose', 'down'))
    assert.ok(ranDocker(dir, 'compose', 'up', '-d'))
})

test('stop still stops an app whose name changed in the config while it ran', () => {
    const dir = named()
    const pid = daemon(dir, ['pretend-storefront'])
    try {
        record(dir, 'storefront', pid)
        const r = local(['stop'], { cwd: dir })
        assert.strictEqual(r.status, 0, r.out)
        assert.match(r.out, new RegExp(`stopping storefront \\(pid ${pid}\\)`))
        for (let i = 0; alive(pid) && i < 50; i++) sleep(100)
        assert.ok(!alive(pid), 'the renamed app must not be orphaned')
    } finally { killQuietly(pid) }
})

test('cors follows the names', () => {
    const cfg = { apps: { api: { role: 'backend' }, frontend: {} }, tunnel: { hostnames: { frontend: 'shop.example.com', api: 'api.example.com' } } }
    const { STORE_CORS, ADMIN_CORS } = cors.owned(cfg, { http: 8180, api: 9100, frontend: 8100 })
    assert.ok(STORE_CORS.includes('http://localhost:8100'))
    assert.ok(STORE_CORS.includes('https://shop.example.com'))
    assert.ok(ADMIN_CORS.includes('http://localhost:9100'))
    assert.ok(ADMIN_CORS.includes('https://api.example.com'))
})

test('a guessable admin password still blocks publishing a backend with another name', async () => {
    const dir = project({ ...NAMED, admin: { password: 'password' } })
    const release = await holdAppPort(dir, 'api', PORTS.backend)
    try {
        const r = tunnel(['quick', 'api', '--yes'], { cwd: dir })
        assert.notStrictEqual(r.status, 0, r.out)
        assert.match(r.out, /admin password is guessable/)
    } finally { await release() }
})

test('a quick tunnel publishes the store by default, whatever it is called', () => {
    const r = tunnel(['quick', '--dry-run'], { cwd: project(NAMED) })
    assert.strictEqual(r.status, 0, r.out)
    assert.match(r.out, new RegExp(`--url http://localhost:${PORTS.storefront}`))
})
