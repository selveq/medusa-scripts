// state is split by what it costs to lose
const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')
const paths = require('../lib/paths.js')
const secrets = require('../lib/secrets.js')
const ports = require('../lib/ports.js')
const { project, cleanup, local, tunnel, cli, holdAppPort, PORTS } = require('./support/harness.js')

test.after(cleanup)

test('state lives outside the project, where the admin dev server cannot serve it', () => {
    const dir = project()
    const state = paths.ensure(dir)
    assert.ok(state.startsWith(path.join(process.env.HOME, '.local-medusa-app') + path.sep), state)
    assert.ok(!state.startsWith(dir), state)
    assert.ok(!fs.existsSync(path.join(dir, '.local-medusa-app')))
    assert.ok(!fs.existsSync(path.join(dir, '.gitignore')), 'the project .gitignore is left alone')
})

test('nothing lma keeps about a running stack lands in the project', () => {
    const dir = project()
    fs.mkdirSync(path.join(dir, 'apps', 'backend'), { recursive: true })
    local(['start'], { cwd: dir })
    const inProject = fs.readdirSync(dir, { recursive: true }).filter((file) => /secrets|dumps|seeded|\.log$/.test(file) && !/^(docker|npm|npx|caffeinate)\.log$/.test(file))
    assert.deepStrictEqual(inProject, [])
    assert.ok(fs.existsSync(paths.sub(dir, 'secrets.env')))
    assert.ok(fs.existsSync(paths.sub(dir, 'logs', 'backend.log')))
})

test('the state folder is private, so a dump or a log in it is too', () => {
    const dir = project()
    assert.strictEqual(fs.statSync(paths.ensure(dir)).mode & 0o777, 0o700)
})

test('a dump written to a path of its own is private as well', () => {
    const dir = project()
    const out = path.join(dir, 'mine.sql.gz')
    assert.strictEqual(local(['db:dump', out], { cwd: dir }).status, 0)
    assert.strictEqual(fs.statSync(out).mode & 0o777, 0o600)
})

test('two folders with the same name keep separate state', () => {
    const one = project()
    const two = path.join(project(), path.basename(one))
    fs.mkdirSync(two)
    assert.notStrictEqual(paths.stateDir(one), paths.stateDir(two))
})

test('the folder an older lma left in the project moves out, secrets and all', () => {
    const dir = project()
    const legacy = path.join(dir, '.local-medusa-app')
    fs.mkdirSync(path.join(legacy, 'dumps'), { recursive: true })
    fs.writeFileSync(path.join(legacy, 'secrets.env'), "LMA_ADMIN_PASSWORD='kept-across-the-move-1'\n", { mode: 0o644 })
    fs.writeFileSync(path.join(legacy, 'dumps', 'a.sql.gz'), 'dump')
    const r = local(['show-env'], { cwd: dir })
    assert.strictEqual(r.status, 0, r.out)
    assert.match(r.out, /moved \.local-medusa-app\/ to /)
    assert.ok(!fs.existsSync(legacy), 'nothing is left for the dev server to serve')
    assert.strictEqual(secrets.ensure(dir).values.LMA_ADMIN_PASSWORD, 'kept-across-the-move-1')
    assert.strictEqual(fs.readFileSync(paths.sub(dir, 'dumps', 'a.sql.gz'), 'utf8'), 'dump')
    assert.strictEqual(fs.statSync(paths.stateDir(dir)).mode & 0o777, 0o700)
})

const oldLogs = (dir, ...p) => cache(dir, 'logs', ...p)

const writeOldLog = (dir, name, text) => {
    fs.mkdirSync(oldLogs(dir), { recursive: true })
    fs.writeFileSync(oldLogs(dir, name), text)
}

test('logs an older lma left in the install cache move out, where the dev server cannot serve them', () => {
    const dir = project()
    writeOldLog(dir, 'backend.log', 'an order for someone@example.test\n')
    const r = local(['show-env'], { cwd: dir })
    assert.strictEqual(r.status, 0, r.out)
    assert.match(r.out, /moved the old logs to /)
    assert.ok(!fs.existsSync(oldLogs(dir)), 'nothing is left in the project')
    assert.strictEqual(fs.readFileSync(paths.sub(dir, 'logs', 'backend.log'), 'utf8'), 'an order for someone@example.test\n')
    assert.doesNotMatch(local(['show-env'], { cwd: dir }).out, /moved the old logs/, 'it says so once')
})

test('lma logs reads a log that came from the install cache', () => {
    const dir = project()
    writeOldLog(dir, 'backend.log', 'Error: from before the upgrade\n')
    assert.match(local(['logs', 'backend', '--errors'], { cwd: dir }).out, /Error: from before the upgrade/)
})

test('an old log never overwrites a new one of the same name', () => {
    const dir = project()
    fs.mkdirSync(paths.sub(dir, 'logs'), { recursive: true })
    fs.writeFileSync(paths.sub(dir, 'logs', 'backend.log'), 'new\n')
    writeOldLog(dir, 'backend.log', 'old\n')
    paths.ensure(dir)
    assert.strictEqual(fs.readFileSync(paths.sub(dir, 'logs', 'backend.log'), 'utf8'), 'new\n')
    assert.strictEqual(fs.readFileSync(paths.sub(dir, 'logs', 'backend.log.old'), 'utf8'), 'old\n')
})

test('a server still writing to an old log keeps writing to the moved file', () => {
    const dir = project()
    writeOldLog(dir, 'backend.log', 'before\n')
    const running = fs.openSync(oldLogs(dir, 'backend.log'), 'a')
    try {
        paths.ensure(dir)
        fs.writeSync(running, 'after\n')
    } finally { fs.closeSync(running) }
    assert.strictEqual(fs.readFileSync(paths.sub(dir, 'logs', 'backend.log'), 'utf8'), 'before\nafter\n')
})

test('the move leaves the port map where it is', async () => {
    const dir = project()
    await ports.resolve(dir)
    writeOldLog(dir, 'backend.log', 'x\n')
    paths.ensure(dir)
    assert.ok(fs.existsSync(cache(dir, 'ports.json')))
})

test('an old folder beside a new one is called out and never merged', () => {
    const dir = project()
    secrets.ensure(dir)
    const legacy = path.join(dir, '.local-medusa-app')
    fs.mkdirSync(legacy)
    fs.writeFileSync(path.join(legacy, 'secrets.env'), 'old')
    const r = local(['show-env'], { cwd: dir })
    assert.match(r.out, /is still in the project, where the admin's dev server can serve it/)
    assert.ok(fs.existsSync(path.join(legacy, 'secrets.env')), 'deleting it is the owner\'s call')
})

const state = (dir, ...p) => paths.sub(dir, ...p)
const cache = (dir, ...p) => path.join(dir, 'node_modules', '.local-medusa-app-cache', ...p)

test('the port map lives in the install cache', () => {
    const dir = project()
    paths.ensure(dir)
    assert.strictEqual(paths.cacheDir(dir), cache(dir))
    assert.strictEqual(ports.cachePath(dir), cache(dir, 'ports.json'))
    assert.ok(fs.existsSync(cache(dir)))
})

test('secrets, dumps and pids stay out of node_modules', () => {
    const dir = project()
    assert.strictEqual(path.dirname(secrets.ensure(dir).file), state(dir))
    assert.ok(!secrets.ensure(dir).file.includes('node_modules'), 'a wiped install must not take them')
})

test('the port map is pinned in the cache until --reset', async () => {
    const dir = project()
    const first = await ports.resolve(dir)
    assert.ok(fs.existsSync(cache(dir, 'ports.json')))
    assert.deepStrictEqual((await ports.resolve(dir)).ports, first.ports)
})

test('a port map from before 0.3.0 still pins', async () => {
    const dir = project()
    paths.ensure(dir)
    fs.writeFileSync(cache(dir, 'ports.json'), JSON.stringify({ postgres: PORTS.postgres + 3 }))
    assert.strictEqual((await ports.resolve(dir)).ports.postgres, PORTS.postgres + 3)
})

test('a port edited in the config replaces the pin made for the old one', async () => {
    const dir = project()
    await ports.resolve(dir)
    const file = path.join(dir, 'lma.js')
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(String(PORTS.redis), String(PORTS.redis + 2)))
    delete require.cache[require.resolve(file)]
    const { ports: map, bases } = await ports.resolve(dir)
    assert.strictEqual(map.redis, PORTS.redis + 2)
    assert.strictEqual(bases.redis, PORTS.redis + 2)
})

test('a port written as a string is still a number', async () => {
    const dir = project({ apps: { backend: { dir: 'apps/backend', port: String(PORTS.backend) } } })
    const release = await holdAppPort(dir, 'stranger', PORTS.backend)
    try {
        const { ports: map } = await ports.resolve(dir)
        assert.strictEqual(map.backend, PORTS.backend + 1)
    } finally { await release() }
})

test('reading never moves a port: only what brings the stack up may', async () => {
    const dir = project()
    const { ports: first } = await ports.resolve(dir)
    const release = await holdAppPort(dir, 'stranger', PORTS.backend)
    try {
        const before = fs.readFileSync(cache(dir, 'ports.json'), 'utf8')
        for (const args of [['status'], ['show-env'], ['admin'], ['start', '--dry-run'], ['stop'], ['tunnel', 'status']]) {
            if (args[0] === 'tunnel') tunnel(args.slice(1), { cwd: dir })
            else local(args, { cwd: dir })
            assert.strictEqual(fs.readFileSync(cache(dir, 'ports.json'), 'utf8'), before, args.join(' '))
        }
        assert.strictEqual(first.backend, PORTS.backend)
    } finally { await release() }
})

test('a dry run on a new project writes no port map', () => {
    const dir = project()
    assert.strictEqual(local(['start', '--dry-run'], { cwd: dir }).status, 0)
    assert.ok(!fs.existsSync(cache(dir, 'ports.json')))
})

test('a port held by this stack\'s own container stays where it is', async () => {
    const dir = project()
    const release = await holdAppPort(dir, 'stranger', PORTS.postgres)
    try {
        const env = { LMA_TEST_DOCKER_PS: `127.0.0.1:${PORTS.postgres}->5432/tcp` }
        const r = cli(['ports', '--json'], { cwd: dir, env })
        assert.strictEqual(JSON.parse(r.stdout).ports.postgres, PORTS.postgres)
    } finally { await release() }
})

test('ports --reset refuses while the stack runs, since it would stay on the old ports', () => {
    const dir = project()
    const r = cli(['ports', '--reset'], { cwd: dir, env: { LMA_TEST_DOCKER_PS: `127.0.0.1:${PORTS.postgres}->5432/tcp` } })
    assert.notStrictEqual(r.status, 0)
    assert.match(r.out, /lma stop, then lma ports --reset/)
})

test('ports --reset --dry-run changes nothing', async () => {
    const dir = project()
    paths.ensure(dir)
    fs.writeFileSync(cache(dir, 'ports.json'), JSON.stringify({ postgres: PORTS.postgres + 3 }))
    cli(['ports', '--reset', '--dry-run'], { cwd: dir })
    assert.strictEqual(JSON.parse(fs.readFileSync(cache(dir, 'ports.json'), 'utf8')).postgres, PORTS.postgres + 3)
})

test('a wiped node_modules costs the port map, never the secrets', async () => {
    const dir = project()
    const before = secrets.ensure(dir).values.LMA_ADMIN_PASSWORD
    await ports.resolve(dir)
    assert.ok(fs.existsSync(cache(dir, 'ports.json')))

    fs.rmSync(path.join(dir, 'node_modules'), { recursive: true, force: true })

    assert.strictEqual(secrets.ensure(dir).values.LMA_ADMIN_PASSWORD, before, 'the admin login survives')
    assert.ok(fs.existsSync(state(dir, 'secrets.env')))
})

test('secrets are generated once, kept private, and reused', () => {
    const dir = project()
    const first = secrets.ensure(dir)
    assert.strictEqual(path.basename(first.file), 'secrets.env')
    assert.strictEqual(fs.statSync(first.file).mode & 0o777, 0o600)
    for (const k of ['LMA_JWT_SECRET', 'LMA_COOKIE_SECRET', 'LMA_ADMIN_PASSWORD']) {
        assert.ok(first.values[k], `${k} is generated`)
    }
    const second = secrets.ensure(dir)
    assert.deepStrictEqual(second.values, first.values, 'a second run must not rotate them')
})

test('the generated admin password is strong and not reused across projects', () => {
    const a = secrets.ensure(project()).values.LMA_ADMIN_PASSWORD
    const b = secrets.ensure(project()).values.LMA_ADMIN_PASSWORD
    assert.notStrictEqual(a, b)
    assert.ok(a.length >= 16, 'long enough to survive being on the public internet by accident')
    assert.ok(!secrets.isWeak(a))
})

test('the known-bad passwords are still recognised as weak', () => {
    for (const pw of ['medusa123', 'MEDUSA123', 'password', 'admin', 'supersecret', '', 'short']) {
        assert.ok(secrets.isWeak(pw), `${pw} must count as weak`)
    }
})

test('a missing admin password falls back to the generated one', () => {
    const dir = project()
    const r = local(['admin'], { cwd: dir })
    assert.strictEqual(r.status, 0, r.out)
    assert.match(r.out, /from .*\.local-medusa-app\/.*\/secrets\.env/)
    const generated = secrets.ensure(dir).values.LMA_ADMIN_PASSWORD
    assert.ok(r.out.includes(generated), 'lma admin prints the password it will actually seed')
})

test('a configured admin password wins, and a weak one is called out', () => {
    const dir = project({ admin: { email: 'admin@demo.local', password: 'medusa123' } })
    const r = local(['admin'], { cwd: dir })
    assert.strictEqual(r.status, 0, r.out)
    assert.match(r.out, /password: medusa123/)
    assert.match(r.out, /guessable/)
})

test('LMA_ADMIN_PASSWORD from the environment wins over both', () => {
    const dir = project({ admin: { email: 'admin@demo.local', password: 'from-config-x' } })
    const r = local(['admin'], { cwd: dir, env: { LMA_ADMIN_PASSWORD: 'from-the-environment' } })
    assert.match(r.out, /password: from-the-environment/)
    assert.match(r.out, /from env LMA_ADMIN_PASSWORD/)
})
