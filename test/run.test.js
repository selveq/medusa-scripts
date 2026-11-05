// lma run: a command with the stack's database, kept awake, honest about any sleep
const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { sleeps, summary } = require('../lib/sleep-log.js')
const { spawn } = require('node:child_process')
const { PKG, FAKE_BIN, project, cleanup, local, cli, PORTS } = require('./support/harness.js')

test.after(cleanup)

const show = "console.log(JSON.stringify(['DB_HOST','DB_PORT','DB_USERNAME','DB_PASSWORD','DATABASE_URL'].map((k)=>process.env[k])))"
const longEnough = 'setTimeout(() => {}, 2500)'

test('run gives the command the database of this stack', () => {
    const r = local(['run', '--', 'node', '-e', show], { cwd: project() })
    assert.strictEqual(r.status, 0, r.out)
    assert.deepStrictEqual(JSON.parse(r.stdout.trim().split('\n').pop()), [
        'localhost', String(PORTS.postgres), 'demo', 'demo', `postgres://demo:demo@localhost:${PORTS.postgres}/demo_db`,
    ])
})

test('an lma started by lma run acts on the project it stands in', () => {
    const outer = project()
    const inner = project({ project: 'other', services: { postgres: { port: PORTS.postgres + 5 } } })
    const bin = path.join(PKG, 'bin', 'lma.js')
    const r = cli(['run', '--', 'sh', '-c', `cd "${inner}" && "${process.execPath}" "${bin}" show-env`], { cwd: outer })
    assert.strictEqual(r.status, 0, r.out)
    assert.match(r.stdout, new RegExp(`localhost:${PORTS.postgres + 5}/`))
    assert.doesNotMatch(r.stdout, new RegExp(`localhost:${PORTS.postgres}/`))
})

test('an lma started by lma run cannot destroy the outer project by accident', () => {
    const outer = project()
    const inner = project({ project: 'other' })
    const bin = path.join(PKG, 'bin', 'lma.js')
    const r = cli(['run', '--', 'sh', '-c', `cd "${inner}" && "${process.execPath}" "${bin}" destroy --yes`], { cwd: outer })
    assert.match(r.stdout + r.stderr, /volumes of 'other-/)
    assert.doesNotMatch(r.stdout + r.stderr, /volumes of 'demo-/)
})

const cleansUp = "process.on('SIGTERM', () => setTimeout(() => process.exit(3), 300)); process.on('SIGINT', () => setTimeout(() => process.exit(3), 300)); console.log('ready'); setInterval(() => {}, 1000)"

for (const [signal, toGroup] of [['SIGTERM', false], ['SIGINT', true]]) {
    test(`${signal} lets the command clean up, and lma returns the code it ended with`, async () => {
        const dir = project()
        const child = spawn(process.execPath, [path.join(PKG, 'bin', 'lma.js'), 'run', '--', process.execPath, '-e', cleansUp], {
            cwd: dir,
            detached: true,
            stdio: ['ignore', 'pipe', 'ignore'],
            env: { ...process.env, PATH: `${FAKE_BIN}${path.delimiter}${process.env.PATH}`, LMA_TEST_DOCKER_LOG: path.join(dir, 'docker.log') },
        })
        await new Promise((resolve) => child.stdout.once('data', resolve))
        // ctrl C reaches the whole group from the terminal; a kill reaches only lma
        process.kill(toGroup ? -child.pid : child.pid, signal)
        const code = await new Promise((resolve) => child.once('close', (c, s) => resolve(c ?? s)))
        assert.strictEqual(code, 3)
    })
}

test('a command started from inside some other npm script stays in its own folder', () => {
    const dir = project()
    const sub = path.join(dir, 'apps')
    fs.mkdirSync(sub)
    const r = cli(['run', '--', 'pwd'], { cwd: sub, env: { npm_lifecycle_event: 'test', INIT_CWD: os.tmpdir() } })
    assert.strictEqual(r.stdout.trim().split('\n').pop(), sub)
})

test('from a subfolder through npm run, the command starts where the user stands', () => {
    const dir = project()
    const sub = path.join(dir, 'apps')
    fs.mkdirSync(sub)
    const r = cli(['run', '--', 'pwd'], { cwd: dir, env: { npm_lifecycle_event: 'lma', INIT_CWD: sub } })
    assert.strictEqual(r.stdout.trim().split('\n').pop(), sub)
})

test('run empties PORT, so a test runner finds a free port and not the dev server\'s', () => {
    const r = local(['run', '--', 'node', '-e', "console.log(JSON.stringify(process.env.PORT))"], { cwd: project(), env: { PORT: '9100' } })
    assert.strictEqual(r.stdout.trim().split('\n').pop(), '""')
})

test('run keeps the exit code of the command', () => {
    const r = local(['run', '--', 'node', '-e', 'process.exit(7)'], { cwd: project() })
    assert.strictEqual(r.status, 7, r.out)
})

test('run says how to use it when given no command', () => {
    const r = local(['run'], { cwd: project() })
    assert.strictEqual(r.status, 2)
    assert.match(r.out, /usage: lma run -- <command>/)
})

test('run keeps the Mac awake for exactly the command', () => {
    const dir = project()
    local(['run', '--', 'node', '-e', '0'], { cwd: dir })
    const [argv] = fs.readFileSync(path.join(dir, 'caffeinate.log'), 'utf8').trim().split('\n').map(JSON.parse)
    assert.deepStrictEqual(argv.slice(0, 2), ['-i', 'node'])
})

test('run leaves the output of the command clean for a pipe', () => {
    const r = local(['run', '--', 'node', '-e', 'console.log("only this")'], { cwd: project(), env: { LMA_TEST_POWER: 'Battery Power', LMA_TEST_HEALTH: 'starting' } })
    assert.strictEqual(r.stdout.trim(), 'only this')
})

test('run warns at the start when on battery', () => {
    const r = local(['run', '--', 'node', '-e', '0'], { cwd: project(), env: { LMA_TEST_POWER: 'Battery Power' } })
    assert.match(r.stderr, /on battery/)
})

test('run says nothing about battery on mains power', () => {
    const r = local(['run', '--', 'node', '-e', '0'], { cwd: project() })
    assert.doesNotMatch(r.out, /on battery/)
})

test('run warns when the database is not up, and still runs', () => {
    const r = local(['run', '--', 'node', '-e', 'process.exit(3)'], { cwd: project(), env: { LMA_TEST_HEALTH: 'starting' } })
    assert.strictEqual(r.status, 3)
    assert.match(r.stderr, /postgres is starting; lma start brings it up/)
})

test('run reports a sleep during the command, because caffeinate cannot stop a closed lid', () => {
    const r = local(['run', '--', 'node', '-e', longEnough], { cwd: project(), env: { LMA_TEST_SLEPT: 'Clamshell Sleep' } })
    assert.strictEqual(r.status, 0, r.out)
    assert.match(r.stderr, /the Mac slept 1 time during this run/)
    assert.match(r.stderr, /Clamshell Sleep/)
})

test('a failed command still gets its sleep report and keeps its exit code', () => {
    const r = local(['run', '--', 'node', '-e', `${longEnough}; process.exitCode = 9`], { cwd: project(), env: { LMA_TEST_SLEPT: 'Clamshell Sleep' } })
    assert.strictEqual(r.status, 9, r.out)
    assert.match(r.stderr, /the Mac slept/)
})

test('run does not blame a sleep from before it began', () => {
    const r = local(['run', '--', 'node', '-e', '0'], { cwd: project() })
    assert.doesNotMatch(r.out, /the Mac slept/)
    assert.match(r.stderr, /no sleep during this run/)
})

test('run says so when the machine has no pmset to ask', () => {
    const r = local(['run', '--', 'node', '-e', 'process.exit(4)'], { cwd: project(), env: { LMA_PMSET: '/nonexistent/pmset' } })
    assert.strictEqual(r.status, 4, r.out)
    assert.match(r.stderr, /no pmset here, so the sleep check was skipped/)
})

test('run starts the command where it was asked from, not at the project root', () => {
    const dir = project()
    const sub = path.join(dir, 'apps', 'backend')
    fs.mkdirSync(sub, { recursive: true })
    const r = cli(['run', '--', 'node', '-e', 'console.log(process.cwd())'], { cwd: sub })
    assert.strictEqual(r.status, 0, r.out)
    assert.strictEqual(r.stdout.trim().split('\n').pop(), sub)
})

const LOG = [
    "2026-11-05 03:13:35 +0200 Sleep               \tEntering Sleep state due to 'Clamshell Sleep':TCPKeepAlive=active",
    '2026-11-05 03:18:35 +0200 DarkWake            \tDarkWake from Deep Idle',
    "2026-11-05 03:19:35 +0200 Sleep               \tEntering Sleep state due to 'Maintenance Sleep':TCPKeepAlive=active",
    '2026-11-05 03:29:35 +0200 Wake                \tDarkWake to FullWake',
    '2026-11-05 03:29:40 +0200 Assertions          \tSummary- [System: PrevIdle] Using AC',
].join('\n')
const at = (text) => Date.parse(text)

test('the log is read in its own timezone, inside the window only', () => {
    assert.strictEqual(sleeps(LOG, at('2026-11-05T01:00:00Z'), at('2026-11-05T01:30:00Z')).length, 2)
    assert.strictEqual(sleeps(LOG, at('2026-11-05T01:15:00Z'), at('2026-11-05T01:30:00Z')).length, 1)
    assert.strictEqual(sleeps(LOG, at('2026-11-05T02:00:00Z'), at('2026-11-05T03:00:00Z')).length, 0)
})

test('the summary counts the time asleep and names each reason once', () => {
    const line = summary(sleeps(LOG, at('2026-11-05T01:00:00Z'), at('2026-11-05T01:30:00Z')))
    assert.match(line, /slept 2 times during this run, 15m in all: Clamshell Sleep, Maintenance Sleep/)
})

test('a Wake Requests line is not a wake: the machine is only asking to wake later', () => {
    const log = [
        "2026-11-05 03:14:52 +0200 Sleep               \tEntering Sleep state due to 'Maintenance Sleep':TCPKeepAlive=active",
        '2026-11-05 03:14:54 +0200 Wake Requests       \t[process=dasd request=SleepService deltaSecs=981 wakeAt=2026-11-05 03:31:15]',
        '2026-11-05 03:14:54 +0200 PM Client Acks      \tDelays to Sleep notifications: [com.apple.bluetooth.sleep is slow(1542 ms)]',
        '2026-11-05 03:30:28 +0200 DarkWake            \tDarkWake from Deep Idle [CDNPB] : due to NUB.SPMI0.SW3.IRQ',
    ].join('\n')
    const [event] = sleeps(log, at('2026-11-05T01:00:00Z'), at('2026-11-05T02:00:00Z'))
    assert.strictEqual(event.until - event.at, 15 * 60 * 1000 + 36 * 1000)
})

test('entering dark wake on the way to sleep is not itself a sleep', () => {
    const log = [
        "2026-11-05 03:13:35 +0200 Sleep               \tEntering DarkWake state due to 'Clamshell Sleep':TCPKeepAlive=active",
        "2026-11-05 03:13:57 +0200 Sleep               \tEntering Sleep state due to 'Clamshell Sleep':TCPKeepAlive=active",
    ].join('\n')
    const events = sleeps(log, at('2026-11-05T01:00:00Z'), at('2026-11-05T02:00:00Z'))
    assert.strictEqual(events.length, 1)
    assert.strictEqual(events[0].at, at('2026-11-05T01:13:57Z'))
})

test('a sleep with no wake in the log runs to the end of the window', () => {
    const only = LOG.split('\n')[0]
    const [event] = sleeps(only, at('2026-11-05T01:00:00Z'), at('2026-11-05T01:20:00Z'))
    assert.strictEqual(event.until - event.at, 6 * 60 * 1000 + 25 * 1000)
})
