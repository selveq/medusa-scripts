// the everyday path
const { spawnSync } = require('node:child_process')
const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const net = require('node:net')
const path = require('node:path')
const paths = require('../lib/paths.js')
const images = require('../lib/images.js')
const { ASSETS, project, cleanup, local, cli, ranDocker, dockerAt, composeImages, daemon, alive, killQuietly, started, sleep, devRuns, devEnv, npxRuns, PORTS } = require('./support/harness.js')

test.after(cleanup)

test('start --dry-run describes the whole plan and runs none of it', () => {
    const dir = project()
    const r = local(['start', '--dry-run'], { cwd: dir })
    assert.strictEqual(r.status, 0, r.out)
    assert.match(r.out, /\[dry-run\] docker compose .* up -d/)
    assert.strictEqual(r.stderr.trim(), '')
    assert.ok(!ranDocker(dir, 'compose'), 'nothing reaches docker')
})

test('start --dry-run lists the dev servers it would launch', () => {
    const dir = project()
    for (const app of ['apps/backend', 'apps/storefront']) fs.mkdirSync(path.join(dir, app), { recursive: true })
    const r = local(['start', '--dry-run'], { cwd: dir })
    assert.match(r.out, new RegExp(`\\[dry-run\\] cd apps/backend && npm run dev \\(PORT=${PORTS.backend}\\)`))
    assert.match(r.out, new RegExp(`\\[dry-run\\] cd apps/storefront && npm run dev \\(PORT=${PORTS.storefront}\\)`))
})

test('start brings up the infra and reports the addresses', () => {
    const dir = project()
    const r = local(['start'], { cwd: dir })
    assert.strictEqual(r.status, 0, r.out)
    assert.ok(ranDocker(dir, 'compose', 'up', '-d'))
    assert.match(r.out, /all services healthy/)
    assert.match(r.out, new RegExp(`storefront: http://localhost:${PORTS.http}`))
    assert.match(r.out, new RegExp(`admin: +http://localhost:${PORTS.http}/app`))
})

test('compose is handed the digest-pinned images', () => {
    const dir = project()
    local(['start'], { cwd: dir })
    const used = composeImages(dir)
    assert.strictEqual(used.LMA_POSTGRES_IMAGE, images.pinned('postgres'))
    assert.strictEqual(used.LMA_REDIS_IMAGE, images.pinned('redis'))
    assert.strictEqual(used.LMA_PROXY_IMAGE, images.pinned('proxy'))
})

test('a config override reaches compose, with a warning when it is loose', () => {
    const dir = project({ services: { postgres: { image: 'postgres:latest' } } })
    const r = local(['start'], { cwd: dir })
    assert.strictEqual(r.status, 0, r.out)
    assert.strictEqual(composeImages(dir).LMA_POSTGRES_IMAGE, 'postgres:latest')
    assert.match(r.out, /image pin warning: postgres: .*moves under you/)
})

test('the compose file itself carries pinned defaults, not floating tags', () => {
    const compose = fs.readFileSync(path.join(__dirname, '..', 'assets', 'docker-compose.yml'), 'utf8')
    const defaults = [...compose.matchAll(/image: \$\{LMA_\w+:-([^}]+)\}/g)].map((m) => m[1])
    assert.strictEqual(defaults.length, 3)
    for (const ref of defaults) assert.match(ref, /@sha256:[0-9a-f]{64}$/)
})

test('start refuses to guess when docker is not running and cannot be asked', () => {
    const dir = project()
    const r = local(['start'], { cwd: dir, env: { LMA_TEST_DOCKER_DOWN: '1' } })
    assert.notStrictEqual(r.status, 0)
    assert.match(r.out, /Docker is not running, and there is no terminal to ask on/)
    assert.ok(!ranDocker(dir, 'compose'))
})

test('stop leaves a reused pid alone instead of killing a stranger', () => {
    const dir = project()
    const pid = daemon(dir, ['nothing-to-do-with-medusa'])
    try {
        const run = paths.sub(dir, 'run')
        fs.mkdirSync(run, { recursive: true })
        fs.writeFileSync(path.join(run, 'backend.pid'), `${pid}\n`)
        fs.writeFileSync(path.join(run, 'backend.id'), 'Wed Jan  1 00:00:00 2020\n')
        const r = local(['stop'], { cwd: dir })
        assert.strictEqual(r.status, 0, r.out)
        assert.ok(alive(pid), 'an unrelated process must survive lma stop')
        assert.match(r.out, /is not the backend we started/)
        assert.ok(!fs.existsSync(path.join(run, 'backend.pid')), 'the stale record is cleared')
    } finally { killQuietly(pid) }
})

test('stop does kill the process whose recorded identity still matches', () => {
    const dir = project()
    const pid = daemon(dir, ['pretend-dev-server'])
    try {
        const run = paths.sub(dir, 'run')
        fs.mkdirSync(run, { recursive: true })
        fs.writeFileSync(path.join(run, 'backend.pid'), `${pid}\n`)
        fs.writeFileSync(path.join(run, 'backend.id'), started(pid))
        const r = local(['stop'], { cwd: dir })
        assert.strictEqual(r.status, 0, r.out)
        assert.match(r.out, new RegExp(`stopping backend \\(pid ${pid}\\)`))
        for (let i = 0; alive(pid) && i < 50; i++) sleep(100)
        assert.ok(!alive(pid), 'the real thing must still be stopped')
    } finally { killQuietly(pid) }
})

const record = (dir, app, pid) => {
    const run = paths.sub(dir, 'run')
    fs.mkdirSync(run, { recursive: true })
    fs.writeFileSync(path.join(run, `${app}.pid`), `${pid}\n`)
    fs.writeFileSync(path.join(run, `${app}.id`), started(pid))
    return path.join(run, `${app}.pid`)
}

// what a dev server does when it restarts on a file change: alive, port closed for a moment
const restarting = (port) =>
    `setTimeout(() => require('http').createServer().listen(${port}, '127.0.0.1'), 1500)`

for (const app of ['backend', 'storefront']) {
    test(`start waits for a ${app} that is restarting instead of launching a second one`, () => {
        const dir = project()
        fs.mkdirSync(path.join(dir, 'apps', app), { recursive: true })
        const pid = daemon(dir, [`pretend-${app}`], restarting(PORTS[app]))
        try {
            const file = record(dir, app, pid)
            const r = local(['start'], { cwd: dir })
            assert.strictEqual(r.status, 0, r.out)
            assert.deepStrictEqual(devRuns(dir).filter((run) => run.cwd.endsWith(app)), [])
            assert.strictEqual(fs.readFileSync(file, 'utf8').trim(), String(pid), 'the record still names the first server')
            assert.match(r.out, new RegExp(`${app} up on :${PORTS[app]}`))
        } finally { killQuietly(pid) }
    })
}

test('start still launches a dev server when the recorded one is gone', () => {
    const dir = project()
    fs.mkdirSync(path.join(dir, 'apps', 'backend'), { recursive: true })
    const pid = daemon(dir, ['pretend-backend'])
    record(dir, 'backend', pid)
    killQuietly(pid)
    for (let i = 0; alive(pid) && i < 50; i++) sleep(100)
    const r = local(['start'], { cwd: dir })
    assert.strictEqual(devRuns(dir).filter((run) => run.cwd.endsWith('backend')).length, 1, r.out)
})

test('stop returns only once a dev server has finished shutting down', () => {
    const dir = project()
    const done = path.join(dir, 'shut-down')
    const pid = daemon(dir, ['pretend-backend', done], `
        process.on('SIGTERM', () => setTimeout(() => {
            require('fs').writeFileSync(process.argv[2], '1')
            process.exit(0)
        }, 1500))
        setInterval(() => {}, 1000)
    `)
    try {
        record(dir, 'backend', pid)
        const r = local(['stop'], { cwd: dir })
        assert.strictEqual(r.status, 0, r.out)
        assert.ok(fs.existsSync(done), 'its port is free by the time stop returns')
        assert.doesNotMatch(r.out, /still running/)
    } finally { killQuietly(pid) }
})

test('stop ends a child that ignores SIGTERM after its parent has exited', () => {
    const dir = project()
    const childFile = path.join(dir, 'child.pid')
    const pid = daemon(dir, ['pretend-backend', childFile], `
        const script = "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"
        const child = require('child_process').spawn(process.execPath, ['-e', script], { stdio: 'ignore' })
        require('fs').writeFileSync(process.argv[2], String(child.pid))
        process.on('SIGTERM', () => process.exit(0))
        setInterval(() => {}, 1000)
    `)
    for (let i = 0; !fs.existsSync(childFile) && i < 50; i++) sleep(100)
    sleep(300)
    const child = Number(fs.readFileSync(childFile, 'utf8'))
    try {
        record(dir, 'backend', pid)
        const r = local(['stop'], { cwd: dir })
        assert.strictEqual(r.status, 0, r.out)
        assert.match(r.out, new RegExp(`still running after 10s, killing: ${child}`))
        for (let i = 0; alive(child) && i < 50; i++) sleep(100)
        assert.ok(!alive(child), 'nothing is left holding the port')
    } finally { killQuietly(pid); killQuietly(child) }
})

// a stranger on the port: the allocator moves off it
const holdPort = async (port) => {
    const srv = net.createServer()
    await new Promise((res) => srv.listen(port, '127.0.0.1', res))
    return () => new Promise((res) => srv.close(res))
}

const movedLine = (name, port) => new RegExp(`${name} is on :${port + 1}, not its preferred :${port}`)

test('start says a port moved, since a hardcoded .env now reaches something else', async () => {
    const dir = project()
    const release = await holdPort(PORTS.postgres)
    try {
        const r = local(['start'], { cwd: dir })
        assert.strictEqual(r.status, 0, r.out)
        assert.match(r.out, movedLine('postgres', PORTS.postgres))
        assert.match(r.out, /apps\/backend\/\.env/)
        assert.match(r.out, /lma ports --reset/)
    } finally { await release() }
})

test('restart says a port moved too', async () => {
    const dir = project()
    const release = await holdPort(PORTS.redis)
    try {
        const r = local(['restart'], { cwd: dir })
        assert.strictEqual(r.status, 0, r.out)
        assert.match(r.out, movedLine('redis', PORTS.redis))
    } finally { await release() }
})

test('start keeps saying so while the moved port stays pinned after the stranger left', async () => {
    const dir = project()
    const release = await holdPort(PORTS.http)
    local(['start'], { cwd: dir })
    await release()
    const r = local(['start'], { cwd: dir })
    assert.match(r.out, movedLine('proxy', PORTS.http))
})

test('start says an app moved', async () => {
    const dir = project()
    fs.mkdirSync(path.join(dir, 'apps', 'backend'), { recursive: true })
    const release = await holdPort(PORTS.backend)
    try {
        const r = local(['start'], { cwd: dir })
        assert.match(r.out, movedLine('backend', PORTS.backend))
    } finally { await release() }
})

test('start says nothing about ports when none moved', () => {
    const r = local(['start'], { cwd: project() })
    assert.strictEqual(r.status, 0, r.out)
    assert.doesNotMatch(r.out, /preferred|ports --reset/)
})

test('a port moved for an app that does not exist stays quiet', async () => {
    const dir = project()
    const release = await holdPort(PORTS.storefront)
    try {
        const r = local(['start'], { cwd: dir })
        assert.doesNotMatch(r.out, /preferred|ports --reset/)
    } finally { await release() }
})

test('a port set in the environment is a choice, not a move', async () => {
    const dir = project()
    const release = await holdPort(PORTS.postgres)
    try {
        const r = local(['start'], { cwd: dir, env: { LMA_PG_PORT: String(PORTS.postgres + 5) } })
        assert.doesNotMatch(r.out, /preferred|ports --reset/)
    } finally { await release() }
})

test('show-env prints the connection strings for the backend', () => {
    const dir = project()
    const r = local(['show-env'], { cwd: dir })
    assert.strictEqual(r.status, 0, r.out)
    assert.match(r.out, new RegExp(`^DATABASE_URL=postgres://demo:demo@localhost:${PORTS.postgres}/demo_db$`, 'm'))
    assert.match(r.out, new RegExp(`^REDIS_URL=redis://localhost:${PORTS.redis}$`, 'm'))
})

test('help works before there is any config to read', () => {
    const dir = project()
    fs.rmSync(path.join(dir, 'lma.js'))
    const r = local(['help'], { cwd: dir, env: { LMA_ROOT: '' } })
    assert.strictEqual(r.status, 0, r.out)
    assert.match(r.out, /lma init/)
})

test('help documents the safety flags', () => {
    const r = local(['help'], { cwd: project() })
    assert.match(r.out, /--dry-run +print what would happen; starts, stops and deletes nothing/)
    assert.match(r.out, /--yes +skip the confirmation prompt/)
    assert.match(r.out, /secrets, dumps, logs and pids live in ~\/\.local-medusa-app\/<project>\//)
    assert.match(r.out, /ports in node_modules\/\.local-medusa-app-cache\//)
})

test('start on an unmigrated database says what to run and starts no apps', () => {
    const dir = project()
    fs.mkdirSync(path.join(dir, 'apps', 'backend'), { recursive: true })
    const r = local(['start'], { cwd: dir, env: { LMA_TEST_ADMIN_COUNT: '' } })
    assert.notStrictEqual(r.status, 0)
    assert.match(r.out, /the database 'demo_db' has not been migrated, so the apps were not started/)
    assert.match(r.out, /run: lma migrate, then: lma start/)
    assert.deepStrictEqual(devRuns(dir), [])
})

test('restart on an unmigrated database says the same', () => {
    const dir = project()
    fs.mkdirSync(path.join(dir, 'apps', 'backend'), { recursive: true })
    const r = local(['restart'], { cwd: dir, env: { LMA_TEST_ADMIN_COUNT: '' } })
    assert.notStrictEqual(r.status, 0)
    assert.match(r.out, /has not been migrated/)
    assert.deepStrictEqual(devRuns(dir), [])
})

const migrated = () => {
    const dir = project()
    fs.mkdirSync(path.join(dir, 'apps', 'backend'), { recursive: true })
    return dir
}

const medusaRuns = (dir, word) => npxRuns(dir).filter((run) => run.argv.includes(word) && !run.argv.includes('--help'))

test('migrate off a terminal takes only safe actions on links and search', () => {
    const dir = migrated()
    const r = local(['migrate'], { cwd: dir, env: { LMA_TEST_ADMIN_MATCHES: '1' } })
    assert.strictEqual(r.status, 0, r.out)
    const [run] = medusaRuns(dir, 'db:migrate')
    assert.deepStrictEqual(run.argv, ['--no', 'medusa', 'db:migrate', '--execute-safe-links', '--execute-safe-search'])
})

test('migrate off a terminal passes no flag this Medusa would refuse', () => {
    const dir = migrated()
    const r = local(['migrate'], { cwd: dir, env: { LMA_TEST_ADMIN_MATCHES: '1', LMA_TEST_MEDUSA_HELP: '--execute-safe-links' } })
    assert.strictEqual(r.status, 0, r.out)
    assert.deepStrictEqual(medusaRuns(dir, 'db:migrate')[0].argv, ['--no', 'medusa', 'db:migrate', '--execute-safe-links'])
})

test('migrate stops with the reason when off a terminal it could only hang', () => {
    const dir = migrated()
    const r = local(['migrate'], { cwd: dir, env: { LMA_TEST_MEDUSA_HELP: '' } })
    assert.notStrictEqual(r.status, 0)
    assert.match(r.out, /no --execute-safe-links, and its prompt would hang/)
    assert.deepStrictEqual(medusaRuns(dir, 'db:migrate'), [])
})

test('migrate never answers with a delete', () => {
    const dir = migrated()
    local(['migrate'], { cwd: dir, env: { LMA_TEST_ADMIN_MATCHES: '1' } })
    assert.ok(!npxRuns(dir).some((run) => run.argv.some((a) => /execute-all/.test(a))))
})

test('migrate brings the containers up first, so it works from a stopped stack', () => {
    const dir = migrated()
    local(['migrate'], { cwd: dir, env: { LMA_TEST_ADMIN_MATCHES: '1' } })
    assert.ok(ranDocker(dir, 'compose', 'up', '-d'))
    assert.ok(dockerAt(dir, 'compose', 'up', '-d') < BigInt(medusaRuns(dir, 'db:migrate')[0].at), 'up comes before the migration')
})

const appsOnDisk = () => {
    const dir = project()
    for (const app of ['backend', 'storefront']) fs.mkdirSync(path.join(dir, 'apps', app), { recursive: true })
    return dir
}

test('start exits 0 once both apps answer', () => {
    const dir = appsOnDisk()
    const r = local(['start'], { cwd: dir })
    assert.strictEqual(r.status, 0, r.out)
    assert.doesNotMatch(r.out, /did not come up/)
})

test('start exits non zero when an app did not come up', () => {
    const dir = appsOnDisk()
    const r = local(['start'], { cwd: dir, env: { LMA_TEST_DEV_CRASH: '1' } })
    assert.notStrictEqual(r.status, 0)
    assert.match(r.out, /backend did not come up; check: lma logs backend/)
    assert.match(r.out, /storefront did not come up/, 'the report covers both')
})

test('restart of one app exits non zero when it did not come back', () => {
    const dir = appsOnDisk()
    const r = local(['restart', 'backend'], { cwd: dir, env: { LMA_TEST_DEV_CRASH: '1' } })
    assert.notStrictEqual(r.status, 0)
    assert.match(r.out, /backend did not come up/)
})

test('a watcher still alive with no server under it is named, with the way out', () => {
    const dir = appsOnDisk()
    const r = local(['start'], { cwd: dir, env: { LMA_TEST_DEV_NO_PORT: '1', LMA_APP_WAIT: '3' } })
    try {
        assert.notStrictEqual(r.status, 0)
        assert.match(r.out, /its process is alive with no server under it: lma restart backend/)
    } finally { local(['stop'], { cwd: dir }) }
})

test('start stops when compose cannot bring the stack up', () => {
    const dir = appsOnDisk()
    const r = local(['start'], { cwd: dir, env: { LMA_TEST_COMPOSE_FAILS: '1' } })
    assert.notStrictEqual(r.status, 0)
    assert.deepStrictEqual(devRuns(dir), [])
})

test('a PORT in the shell does not put both apps on one port', () => {
    const dir = appsOnDisk()
    assert.strictEqual(local(['start'], { cwd: dir, env: { PORT: '4567' } }).status, 0)
    assert.strictEqual(devEnv(dir, 'apps/backend').PORT, String(PORTS.backend))
    assert.strictEqual(devEnv(dir, 'apps/storefront').PORT, String(PORTS.storefront))
})

for (const command of ['start', 'stop', 'destroy', 'migrate', 'seed-admin', 'reset-db']) {
    test(`lma ${command} refuses a name instead of acting on the whole stack`, () => {
        const dir = project()
        const r = local([command === 'reset-db' ? 'db:reset' : command, 'backend', '--yes'], { cwd: dir })
        assert.strictEqual(r.status, 2, r.out)
        assert.match(r.out, /takes no name, and got: backend/)
        assert.ok(!ranDocker(dir, 'compose'), 'nothing reached docker')
    })
}

test('an unknown command fails, and help still does not', () => {
    const dir = project()
    assert.strictEqual(local(['statsu'], { cwd: dir }).status, 2)
    assert.match(local(['statsu'], { cwd: dir }).out, /unknown command 'statsu'/)
    for (const word of ['help', '--help', '-h']) assert.strictEqual(local([word], { cwd: dir }).status, 0, word)
})

test('stop --dry-run does not claim to have removed anything', () => {
    const r = local(['stop', '--dry-run'], { cwd: project() })
    assert.doesNotMatch(r.out, /containers and network removed/)
})

test('a server recorded in one locale and timezone is still ours in another', () => {
    const dir = project()
    const pid = daemon(dir, ['lma-test-locale'])
    try {
        const run = paths.sub(dir, 'run')
        fs.mkdirSync(run, { recursive: true })
        fs.writeFileSync(path.join(run, 'backend.pid'), `${pid}\n`)
        const recorded = require('node:child_process').execSync(`ps -p ${pid} -o lstart=`, { env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' } }).toString().replace(/ +/g, ' ')
        fs.writeFileSync(path.join(run, 'backend.id'), recorded)
        const r = local(['stop'], { cwd: dir, env: { TZ: 'Asia/Tokyo' } })
        assert.doesNotMatch(r.out, /not the backend we started/)
        assert.ok(!alive(pid), 'it was stopped')
    } finally { killQuietly(pid) }
})

test('the proxy, like Postgres and Redis, listens on this machine only', () => {
    const compose = fs.readFileSync(path.join(ASSETS, 'docker-compose.yml'), 'utf8')
    const published = [...compose.matchAll(/^\s+- "(.+:\d+)"$/gm)].map((m) => m[1]).filter((line) => line.includes('LMA_'))
    assert.strictEqual(published.length, 3)
    for (const line of published) assert.ok(line.startsWith('127.0.0.1:'), line)
})

test('what the store sets in .env.local stays its own, whatever is in the database', () => {
    const dir = appsOnDisk()
    fs.writeFileSync(path.join(dir, 'apps', 'storefront', '.env.local'), 'NEXT_PUBLIC_MEDUSA_PUBLISHABLE_KEY=pk_chosen\nMEDUSA_BACKEND_URL=https://staging.test\nNEXT_PUBLIC_BASE_PATH=/shop\n')
    assert.strictEqual(local(['start'], { cwd: dir }).status, 0)
    const env = devEnv(dir, 'apps/storefront')
    for (const key of ['NEXT_PUBLIC_MEDUSA_PUBLISHABLE_KEY', 'MEDUSA_BACKEND_URL', 'NEXT_PUBLIC_BASE_PATH']) assert.strictEqual(env[key], undefined, key)
    assert.strictEqual(env.NEXT_PUBLIC_MEDUSA_BACKEND_URL, `http://localhost:${PORTS.backend}`, 'and lma fills in the rest')
})

test('a key only in .env.local is enough to start the store', () => {
    const dir = appsOnDisk()
    fs.writeFileSync(path.join(dir, 'apps', 'storefront', '.env.local'), 'NEXT_PUBLIC_MEDUSA_PUBLISHABLE_KEY=pk_chosen\n')
    const r = local(['start'], { cwd: dir, env: { LMA_TEST_PUBLISHABLE_KEY: '' } })
    assert.strictEqual(r.status, 0, r.out)
})

test('a store with no key anywhere is skipped, says so, and start does not claim success', () => {
    const dir = appsOnDisk()
    fs.writeFileSync(path.join(dir, 'apps', 'storefront', '.env.local'), 'NEXT_PUBLIC_MEDUSA_PUBLISHABLE_KEY=\n')
    const r = local(['start'], { cwd: dir, env: { LMA_TEST_PUBLISHABLE_KEY: '' } })
    assert.notStrictEqual(r.status, 0)
    assert.match(r.out, /storefront: skipped; no publishable API key/)
    assert.doesNotMatch(r.out, /storefront did not come up/)
})

test('a database password with url characters still makes a url', () => {
    const dir = project({ services: { postgres: { password: 'p@ss/w:rd#1' } } })
    const r = local(['show-env'], { cwd: dir })
    assert.match(r.out, /DATABASE_URL=postgres:\/\/demo:p%40ss%2Fw%3Ard%231@localhost:/)
    const url = new URL(r.out.match(/DATABASE_URL=(\S+)/)[1])
    assert.strictEqual(url.hostname, 'localhost')
})

test('status names the apps even with Docker down, with or without --json', () => {
    const dir = appsOnDisk()
    const r = local(['status'], { cwd: dir, env: { LMA_TEST_DOCKER_DOWN: '1' } })
    assert.notStrictEqual(r.status, 0)
    assert.match(r.out, /backend down/)
    assert.match(r.out, /storefront down/)
})

test('a start with no folder for an app says so', () => {
    const r = local(['start'], { cwd: project() })
    assert.match(r.out, /backend: +no folder at apps\/backend, nothing to start/)
})

test('a dev server gets its own session, so closing the terminal cannot end it', () => {
    const dir = project()
    const log = path.join(dir, 'detached.log')
    const r = spawnSync(process.execPath, [
        path.join(__dirname, '..', 'lib', 'detach.js'), log, process.execPath, '-e', 'console.log("hello"); setInterval(() => {}, 1000)',
    ], { encoding: 'utf8' })
    assert.strictEqual(r.status, 0, r.stderr)
    const pid = Number(r.stdout.trim())
    try {
        assert.ok(alive(pid))
        const group = spawnSync('ps', ['-o', 'pgid=', '-p', String(pid)], { encoding: 'utf8' }).stdout.trim()
        assert.strictEqual(group, String(pid), 'it leads its own process group')
        for (let i = 0; !fs.existsSync(log) && i < 50; i++) sleep(100)
        for (let i = 0; !/hello/.test(fs.readFileSync(log, 'utf8')) && i < 50; i++) sleep(100)
        assert.match(fs.readFileSync(log, 'utf8'), /hello/)
    } finally { killQuietly(pid) }
})

test('a dev server that cannot start says why', () => {
    const dir = project()
    const r = spawnSync(process.execPath, [
        path.join(__dirname, '..', 'lib', 'detach.js'), path.join(dir, 'x.log'), '/nonexistent/npm',
    ], { encoding: 'utf8' })
    assert.notStrictEqual(r.status, 0)
    assert.match(r.stderr, /ENOENT/)
})

const statusOf = (dir, env = {}) => {
    const r = local(['status', '--json'], { cwd: dir, env })
    return { r, json: JSON.parse(r.stdout) }
}

test('status --json reports every service and app, and ok when all are up', async () => {
    const dir = project()
    const { r, json } = statusOf(dir)
    assert.strictEqual(r.status, 0, r.out)
    assert.strictEqual(json.ok, true)
    assert.strictEqual(json.project, 'demo')
    assert.deepStrictEqual(json.services.postgres, { state: 'healthy', port: PORTS.postgres })
    assert.deepStrictEqual(json.services.redis, { state: 'healthy', port: PORTS.redis })
    assert.deepStrictEqual(json.services.proxy, { state: 'healthy', port: PORTS.http })
    assert.deepStrictEqual(json.apps.backend, { role: 'backend', expected: false, up: false, port: PORTS.backend })
    assert.deepStrictEqual(json.apps.storefront, { role: 'store', expected: false, up: false, port: PORTS.storefront })
    assert.strictEqual(json.published, false)
})

test('status exits non zero when a service is down, with --json or without', () => {
    const dir = project()
    const { r, json } = statusOf(dir, { LMA_TEST_HEALTH: 'starting' })
    assert.notStrictEqual(r.status, 0)
    assert.strictEqual(json.ok, false)
    assert.strictEqual(json.services.postgres.state, 'starting')
    const plain = local(['status'], { cwd: dir, env: { LMA_TEST_HEALTH: 'starting' } })
    assert.notStrictEqual(plain.status, 0)
    assert.match(plain.out, /postgres is starting/)
})

test('status exits non zero when an app with a folder is down', () => {
    const dir = project()
    fs.mkdirSync(path.join(dir, 'apps', 'backend'), { recursive: true })
    const { r, json } = statusOf(dir)
    assert.notStrictEqual(r.status, 0)
    assert.strictEqual(json.ok, false)
    assert.strictEqual(json.apps.backend.expected, true)
})

test('status does not expect an app that has no folder', () => {
    const r = local(['status'], { cwd: project() })
    assert.strictEqual(r.status, 0, r.out)
    assert.doesNotMatch(r.out, /storefront/)
})

test('ports --json gives the map, the preferred ports and what moved', async () => {
    const dir = project()
    const srv = net.createServer()
    await new Promise((res) => srv.listen(PORTS.redis, '127.0.0.1', res))
    try {
        const r = cli(['ports', '--json'], { cwd: dir })
        assert.strictEqual(r.status, 0, r.out)
        const json = JSON.parse(r.stdout)
        assert.strictEqual(json.ports.postgres, PORTS.postgres)
        assert.strictEqual(json.ports.redis, PORTS.redis + 1)
        assert.strictEqual(json.preferred.redis, PORTS.redis)
        assert.deepStrictEqual(json.moved, ['redis'])
        assert.match(json.cache, /ports\.json$/)
    } finally { await new Promise((res) => srv.close(res)) }
})
