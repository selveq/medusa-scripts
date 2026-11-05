// lma logs with a flag prints and returns; without one it follows, as it always has
const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')
const paths = require('../lib/paths.js')
const { errors, sinceRestart } = require('../lib/logs.js')
const { project, cleanup, local } = require('./support/harness.js')

test.after(cleanup)

const logFile = (dir, app) => {
    const logs = paths.sub(dir, 'logs')
    fs.mkdirSync(logs, { recursive: true })
    return path.join(logs, `${app}.log`)
}

const SAMPLE = [
    'info:    Server is ready',
    '\x1b[31merror\x1b[39m:   Error running script: Cannot find module',
    '    at Module._resolveFilename (node:internal/modules/cjs/loader:1420:15)',
    '    at load (node:internal)',
    "  code: 'MODULE_NOT_FOUND',",
    '}',
    'info:    errors: 0 and nothing else',
    'warn:    An error occurred while processing product.created:',
    'http:    GET /admin/stores ← - (200) - 41.843 ms',
    'http:    POST /store/carts ← - (500) - 12.000 ms',
    ' GET /dk 200 in 3.7s',
    ' GET /dk/cart 500 in 80ms',
    ' ⨯ Error [TypeError]: fetch failed',
    '[browser] Uncaught TypeError: fetch failed',
    'TypeError: x is not a function',
    '  next line of normal output',
].join('\n')

test('errors keeps what failed with its stack, and drops the rest', () => {
    assert.deepStrictEqual(errors(SAMPLE), [
        'error:   Error running script: Cannot find module',
        '    at Module._resolveFilename (node:internal/modules/cjs/loader:1420:15)',
        '    at load (node:internal)',
        "  code: 'MODULE_NOT_FOUND',",
        '}',
        'http:    POST /store/carts ← - (500) - 12.000 ms',
        ' GET /dk/cart 500 in 80ms',
        ' ⨯ Error [TypeError]: fetch failed',
        '[browser] Uncaught TypeError: fetch failed',
        'TypeError: x is not a function',
    ])
})

test('since restart starts at the last time lma started the app', () => {
    const text = 'old error: gone\n--- lma started api at 2026-11-05 10:00:00 ---\nmiddle\n--- lma started api at 2026-11-05 11:00:00 ---\nnew line\n'
    assert.deepStrictEqual(sinceRestart(text), ['--- lma started api at 2026-11-05 11:00:00 ---', 'new line'])
})

test('since restart also knows when the dev server restarted itself', () => {
    const medusa = 'before\ninfo:    [Watcher] modified medusa-config.ts modified: restarting dev server\nafter\n'
    assert.deepStrictEqual(sinceRestart(medusa).slice(-1), ['after'])
    assert.ok(!sinceRestart(medusa).includes('before'))
    const next = 'before\nFound a change in next.config.js. Restarting the server to apply the changes...\nafter\n'
    assert.ok(!sinceRestart(next).includes('before'))
})

test('a request that mentions a restart cannot hide the errors before it', () => {
    const log = 'Error: database password rejected\nhttp: GET /restarting the server 404\n'
    assert.ok(sinceRestart(log).includes('Error: database password rejected'))
})

test('the restart lines the real dev servers print are found', () => {
    for (const line of [
        'info:    [Watcher] Changed src/a.ts Changed: restarting dev server',
        'info:    [HMR] HMR reload failed, restarting server...',
        ' ⚠ Found a change in next.config.js. Restarting the server to apply the changes...',
    ]) assert.deepStrictEqual(sinceRestart(`before\n${line}\nafter`), [line, 'after'], line)
})

test('a terminal title or control character in a log does not reach the terminal', () => {
    const [line] = errors('Error: a\x1b]0;evil\x07b\x07c\n')
    assert.strictEqual(line, 'Error: abc')
})

test('since restart on a log from before lma marked it keeps the whole log', () => {
    assert.deepStrictEqual(sinceRestart('one\ntwo\n'), ['one', 'two'])
})

test('logs with both flags prints the errors since the restart, and returns', () => {
    const dir = project()
    fs.writeFileSync(logFile(dir, 'backend'), 'error: from an earlier run\n--- lma started backend at now ---\ninfo: fine\nerror: from this run\n')
    const r = local(['logs', 'backend', '--errors', '--since-restart'], { cwd: dir })
    assert.strictEqual(r.status, 0, r.out)
    assert.strictEqual(r.stdout.trim(), 'error: from this run')
})

test('logs says so when there is nothing to show', () => {
    const dir = project()
    fs.writeFileSync(logFile(dir, 'backend'), 'info: fine\n')
    const r = local(['logs', 'backend', '--errors'], { cwd: dir })
    assert.strictEqual(r.status, 0, r.out)
    assert.match(r.stdout, /no errors in the backend log/)
})

test('logs refuses a flag it does not know', () => {
    const dir = project()
    fs.writeFileSync(logFile(dir, 'backend'), 'info: fine\n')
    const r = local(['logs', 'backend', '--eror'], { cwd: dir })
    assert.strictEqual(r.status, 2, r.out)
    assert.match(r.out, /unknown flag --eror; logs takes --errors and --since-restart/)
})

test('logs refuses these flags on a container, whose logs lma does not keep', () => {
    const r = local(['logs', 'postgres', '--errors'], { cwd: project() })
    assert.strictEqual(r.status, 2, r.out)
    assert.match(r.out, /only work on an app: backend storefront/)
})

test('starting an app marks the log, so since restart has a place to begin', () => {
    const dir = project()
    fs.mkdirSync(path.join(dir, 'apps', 'backend'), { recursive: true })
    local(['start'], { cwd: dir, env: { LMA_TEST_ADMIN_MATCHES: '1' } })
    assert.match(fs.readFileSync(logFile(dir, 'backend'), 'utf8'), /--- lma started backend at \d{4}-\d{2}-\d{2} /)
})
