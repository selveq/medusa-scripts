// the backend is the app called backend, in whatever folder; every other app is a store
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
        backend: { dir: 'apps/api', port: PORTS.backend },
        storefront: null,
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

test('the app called backend is the backend in whatever folder, and every other key is a store', () => {
    const { backend, stores, main } = config.apps({ apps: { backend: { dir: 'apps/api', port: 1 }, frontend: { port: 2 } } })
    assert.deepStrictEqual(backend, { name: 'backend', role: 'backend', dir: 'apps/api', port: 1 })
    assert.deepStrictEqual(stores, [{ name: 'frontend', role: 'store', dir: 'apps/frontend', port: 2 }])
    assert.strictEqual(main, 'frontend')
})

test('a config written by 0.3.0 means what it always meant', () => {
    const { backend, stores } = config.apps({ apps: { backend: { dir: 'b', port: 1 }, storefront: { dir: 's', port: 2 } } })
    assert.deepStrictEqual(backend, { name: 'backend', role: 'backend', dir: 'b', port: 1 })
    assert.deepStrictEqual(stores, [{ name: 'storefront', role: 'store', dir: 's', port: 2 }])
})

test('a config with no apps gets the two defaults, with no port chosen for either', () => {
    const { backend, stores } = config.apps({})
    assert.deepStrictEqual(backend, { name: 'backend', role: 'backend', dir: 'apps/backend' })
    assert.deepStrictEqual(stores, [{ name: 'storefront', role: 'store', dir: 'apps/storefront' }])
})

test('a backend on its own, and a backend left out, both read as apps/backend', () => {
    assert.deepStrictEqual(config.apps({ apps: { backend: {} } }).stores, [])
    assert.strictEqual(config.apps({ apps: { backend: {} } }).main, '')
    assert.deepStrictEqual(config.apps({ apps: { web: {} } }).backend, { name: 'backend', role: 'backend', dir: 'apps/backend' })
})

test('the stores come in config order, and the first one answers /', () => {
    const { stores, main } = config.apps({ apps: { web: {}, backend: {}, kiosk: { dir: 'frontends/kiosk' } } })
    assert.deepStrictEqual(stores.map((store) => store.name), ['web', 'kiosk'])
    assert.strictEqual(stores[1].dir, 'frontends/kiosk')
    assert.strictEqual(main, 'web')
})

test('proxy.store picks the store that answers /, and must name one', () => {
    assert.strictEqual(config.apps({ apps: { backend: {}, web: {}, kiosk: {} }, proxy: { store: 'kiosk' } }).main, 'kiosk')
    assert.throws(() => config.apps({ apps: { backend: {}, web: {} }, proxy: { store: 'shop' } }), /no store called 'shop'; this project has: web/)
})

for (const [why, apps, message] of [
    ['called after a service', { backend: {}, redis: {} }, /'redis' is taken/],
    ['with a name that cannot be a folder', { backend: {}, 'My App': {} }, /'My App' must be lowercase/],
    ['with an underscore in its name', { backend: {}, my_app: {} }, /'my_app' must be lowercase/],
    ['with a name every object answers to', { backend: {}, constructor: {} }, /'constructor' is taken/],
]) {
    test(`a store ${why} is refused`, () => {
        assert.throws(() => config.apps({ apps }), message)
    })
}

test('an apps block that is not an object is refused', () => {
    assert.throws(() => config.apps({ apps: ['web'] }), /apps must be an object/)
})

test('a 0.3.0 config that marked another key as the backend is refused, with the fix', () => {
    assert.throws(() => config.apps({ apps: { api: { role: 'backend' }, web: {} } }), /api has a role, and role is no longer read: the backend is the app called backend, with its folder in dir/)
})

test('a project with a store on its own port can still be stopped', () => {
    const dir = project({ apps: { 'admin-ui': { port: PORTS.http + 5 } } })
    assert.strictEqual(local(['stop'], { cwd: dir }).status, 0)
})

test('a bad apps block stops lma with the reason', () => {
    const dir = project({ apps: { api: { role: 'backend' } } })
    const r = local(['status'], { cwd: dir })
    assert.notStrictEqual(r.status, 0)
    assert.match(r.out, /role is no longer read/)
})

test('start runs both apps from their own folders, the backend as backend', () => {
    const dir = named()
    const r = local(['start'], { cwd: dir, env: { LMA_TEST_ADMIN_MATCHES: '1' } })
    assert.strictEqual(r.status, 0, r.out)
    assert.match(r.out, /backend: +starting dev server/)
    assert.match(r.out, /frontend: +starting dev server/)
    assert.strictEqual(devEnv(dir, 'apps/api').PORT, String(PORTS.backend))
    assert.strictEqual(devEnv(dir, 'apps/frontend').PORT, String(PORTS.storefront))
    assert.strictEqual(devEnv(dir, 'apps/frontend').NEXT_PUBLIC_MEDUSA_BACKEND_URL, `http://localhost:${PORTS.backend}`)
})

test('status reports the apps by the names the project gave them', () => {
    const r = local(['status'], { cwd: named() })
    assert.match(r.out, new RegExp(`backend down \\(:${PORTS.backend}\\)`))
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
    const other = daemon(dir, ['pretend-backend'])
    const mine = daemon(dir, ['pretend-frontend'])
    try {
        record(dir, 'backend', other)
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
    const r = local(['restart', 'shop'], { cwd: dir })
    assert.notStrictEqual(r.status, 0)
    assert.match(r.out, /no app named 'shop'; this project has: backend frontend/)
    assert.ok(!ranDocker(dir, 'compose'))
    assert.deepStrictEqual(devRuns(dir), [])
})

test('restart with a name only plans under --dry-run, in the backend folder the config names', () => {
    const dir = named()
    const r = local(['restart', 'backend', '--dry-run'], { cwd: dir })
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
    const cfg = { apps: { backend: { dir: 'apps/api' }, frontend: {} }, tunnel: { hostnames: { frontend: 'shop.example.com', backend: 'api.example.com' } } }
    const { STORE_CORS, ADMIN_CORS } = cors.owned(cfg, { http: 8180, backend: 9100, frontend: 8100 })
    assert.ok(STORE_CORS.includes('http://localhost:8100'))
    assert.ok(STORE_CORS.includes('https://shop.example.com'))
    assert.ok(ADMIN_CORS.includes('http://localhost:9100'))
    assert.ok(ADMIN_CORS.includes('https://api.example.com'))
})

test('a guessable admin password still blocks publishing a backend in another folder', async () => {
    const dir = project({ ...NAMED, admin: { password: 'password' } })
    const release = await holdAppPort(dir, 'backend', PORTS.backend)
    try {
        const r = tunnel(['quick', 'backend', '--yes'], { cwd: dir })
        assert.notStrictEqual(r.status, 0, r.out)
        assert.match(r.out, /admin password is guessable/)
    } finally { await release() }
})

test('a quick tunnel publishes the store by default, whatever it is called', () => {
    const r = tunnel(['quick', '--dry-run'], { cwd: project(NAMED) })
    assert.strictEqual(r.status, 0, r.out)
    assert.match(r.out, new RegExp(`--url http://localhost:${PORTS.storefront}`))
})

const TWO = {
    apps: {
        backend: { dir: 'apps/api', port: PORTS.backend },
        storefront: null,
        web: { port: PORTS.storefront },
        kiosk: { port: PORTS.storefront + 1 },
    },
}

const twoStores = (extra = {}) => {
    const dir = project({ ...TWO, ...extra })
    for (const app of ['api', 'web', 'kiosk']) fs.mkdirSync(path.join(dir, 'apps', app), { recursive: true })
    return dir
}

test('start runs every store from its own folder, wired to the backend, and says where each one is', () => {
    const dir = twoStores()
    const r = local(['start'], { cwd: dir, env: { LMA_TEST_ADMIN_MATCHES: '1' } })
    assert.strictEqual(r.status, 0, r.out)
    assert.match(r.out, new RegExp(`web: +http://localhost:${PORTS.http}$`, 'm'), 'the first store answers on the proxy')
    assert.match(r.out, new RegExp(`kiosk: +http://localhost:${PORTS.storefront + 1}$`, 'm'), 'the others on their own port')
    assert.match(r.out, /kiosk up on/)
    assert.strictEqual(devEnv(dir, 'apps/kiosk').PORT, String(PORTS.storefront + 1))
    assert.strictEqual(devEnv(dir, 'apps/kiosk').NEXT_PUBLIC_MEDUSA_BACKEND_URL, `http://localhost:${PORTS.backend}`)
    assert.ok(devEnv(dir, 'apps/api').STORE_CORS.includes(`http://localhost:${PORTS.storefront + 1}`), 'every store origin is allowed')
})

test('proxy.store sends / to that store instead of the first', () => {
    const dir = twoStores({ proxy: { store: 'kiosk' } })
    const r = local(['start'], { cwd: dir, env: { LMA_TEST_ADMIN_MATCHES: '1' } })
    assert.strictEqual(r.status, 0, r.out)
    assert.match(r.out, new RegExp(`kiosk: +http://localhost:${PORTS.http}$`, 'm'))
    assert.match(r.out, new RegExp(`web: +http://localhost:${PORTS.storefront}$`, 'm'))
})

test('status, logs, restart and a quick tunnel know every store by name', () => {
    const dir = twoStores()
    const status = local(['status'], { cwd: dir })
    assert.match(status.out, new RegExp(`kiosk down \\(:${PORTS.storefront + 1}\\)`))
    assert.strictEqual(JSON.parse(local(['status', '--json'], { cwd: dir }).stdout).apps.kiosk.role, 'store')
    assert.match(local(['logs', 'kiosk'], { cwd: dir }).out, /no log yet at .*kiosk\.log/)
    const restart = local(['restart', 'kiosk', '--dry-run'], { cwd: dir })
    assert.strictEqual(restart.status, 0, restart.out)
    assert.match(restart.out, new RegExp(`cd apps/kiosk && npm run dev \\(PORT=${PORTS.storefront + 1}\\)`))
    assert.match(local(['restart', 'shop'], { cwd: dir }).out, /no app named 'shop'; this project has: backend web kiosk/)
    assert.match(tunnel(['quick', '--dry-run'], { cwd: dir }).out, new RegExp(`--url http://localhost:${PORTS.storefront}`), 'quick takes the store on /')
})
