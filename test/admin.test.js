// `lma admin` prints credentials; `lma seed-admin` makes them true
const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')
const paths = require('../lib/paths.js')
const secrets = require('../lib/secrets.js')
const { project, cleanup, local, npxRuns, dockerCalls, PORTS } = require('./support/harness.js')

test.after(cleanup)

// LMA_TEST_ADMIN_COUNT: admins in the database
// LMA_TEST_ADMIN_MATCHES: 1 when the configured email is one of them
const db = (count, matches, others = '') => ({
    LMA_TEST_ADMIN_COUNT: String(count),
    LMA_TEST_ADMIN_MATCHES: String(matches),
    LMA_TEST_OTHER_ADMINS: others,
})

test('admin says plainly when the configured account does not exist', () => {
    const dir = project()
    const r = local(['admin'], { cwd: dir, env: db(1, 0, 'someone@else.test') })
    assert.strictEqual(r.status, 0, r.out)
    assert.match(r.out, /no user 'admin@demo\.local' in the database, so this password logs in nowhere/)
    assert.match(r.out, /create it with: +lma seed-admin/)
    assert.match(r.out, /existing admin accounts: someone@else\.test/)
})

test('admin confirms an account lma seeded itself', () => {
    const dir = project()
    fs.mkdirSync(paths.stateDir(dir), { recursive: true })
    fs.writeFileSync(paths.sub(dir, 'seeded-admin'), 'admin@demo.local\n')
    const r = local(['admin'], { cwd: dir, env: db(1, 1) })
    assert.match(r.out, /lma created it; if its password was changed since, this one no longer works/)
})

test('admin hedges on an account it did not create', () => {
    const r = local(['admin'], { cwd: project(), env: db(1, 1) })
    assert.match(r.out, /lma did not create it/)
    assert.match(r.out, /only right if it was set with it/)
})

test('admin does not pretend to have checked when docker is down', () => {
    const r = local(['admin'], { cwd: project(), env: { LMA_TEST_DOCKER_DOWN: '1' } })
    assert.strictEqual(r.status, 0, r.out)
    assert.match(r.out, /not verified/)
})

test('seed-admin creates the configured account even when other admins exist', () => {
    const dir = project()
    const r = local(['seed-admin'], { cwd: dir, env: db(3, 0) })
    assert.match(r.out, /the database has 3 admin\(s\), but not admin@demo\.local; creating it/)
})

test('seed-admin skips when the configured account is already there', () => {
    const dir = project()
    const r = local(['seed-admin'], { cwd: dir, env: db(3, 1) })
    assert.strictEqual(r.status, 0, r.out)
    assert.match(r.out, /admin@demo\.local already exists; seed skipped/)
    assert.ok(!/creating it/.test(r.out))
})

test('seed-admin still reports an unmigrated database', () => {
    const dir = project()
    const r = local(['seed-admin'], { cwd: dir, env: { LMA_TEST_ADMIN_COUNT: '' } })
    assert.notStrictEqual(r.status, 0)
    assert.match(r.out, /no user table yet\. Run: lma migrate/)
})

test('start does not stop at an unmigrated database when there is no backend to run on it', () => {
    const dir = project()
    const r = local(['start'], { cwd: dir, env: { LMA_TEST_ADMIN_COUNT: '' } })
    assert.strictEqual(r.status, 0, r.out)
})

test('seed-admin creates the account through Medusa, with its email and password', () => {
    const dir = project()
    fs.mkdirSync(path.join(dir, 'apps', 'backend'), { recursive: true })
    assert.strictEqual(local(['seed-admin'], { cwd: dir, env: db(0, 0) }).status, 0)
    const { argv } = npxRuns(dir).find((run) => run.argv.includes('user'))
    assert.deepStrictEqual(argv.slice(0, 4), ['--no', 'medusa', 'user', '-e'])
    assert.strictEqual(argv[4], 'admin@demo.local')
})

test('with node_modules gone, npx may not fetch the unrelated package called medusa', () => {
    const dir = project()
    fs.mkdirSync(path.join(dir, 'apps', 'backend'), { recursive: true })
    local(['seed-admin'], { cwd: dir, env: db(0, 0) })
    assert.ok(npxRuns(dir).every((run) => run.argv[0] === '--no'))
})

test('seeding prints no password when the output may be going into a log', () => {
    const dir = project()
    fs.mkdirSync(path.join(dir, 'apps', 'backend'), { recursive: true })
    const r = local(['seed-admin'], { cwd: dir, env: db(0, 0) })
    assert.match(r.out, /admin seeded: admin@demo\.local/)
    const { LMA_ADMIN_PASSWORD } = secrets.ensure(dir).values
    assert.ok(!r.out.includes(LMA_ADMIN_PASSWORD))
})

const ELSEWHERE = { DATABASE_URL: 'postgres://deploy:x@prod.example.com/shop' }

test('migrate and seed-admin refuse a DATABASE_URL exported for a database that is not this stack\'s', () => {
    const dir = project()
    fs.mkdirSync(path.join(dir, 'apps', 'backend'), { recursive: true })
    for (const command of ['migrate', 'seed-admin']) {
        const r = local([command], { cwd: dir, env: { ...db(0, 0), ...ELSEWHERE } })
        assert.notStrictEqual(r.status, 0, command)
        assert.match(r.out, /DATABASE_URL in your shell points at prod\.example\.com:5432, and this stack's Postgres is on localhost:\d+/)
        assert.ok(!r.out.includes('deploy:x'), 'the url credentials stay out of the message')
    }
    assert.ok(!npxRuns(dir).some((run) => run.argv.includes('user') || (run.argv.includes('db:migrate') && !run.argv.includes('--help'))))
})

test('a moved port left in the backend .env is rewritten before migrate runs, since that key is lma\'s', () => {
    const dir = project()
    fs.mkdirSync(path.join(dir, 'apps', 'backend'), { recursive: true })
    const file = path.join(dir, 'apps', 'backend', '.env')
    fs.writeFileSync(file, `DATABASE_URL=postgres://medusa:medusa@localhost:${PORTS.postgres + 7}/medusa-backend\n`)
    const r = local(['migrate'], { cwd: dir, env: { ...db(1, 1) } })
    assert.strictEqual(r.status, 0, r.out)
    assert.match(r.out, /rewrote apps\/backend\/\.env: DATABASE_URL/)
    assert.match(fs.readFileSync(file, 'utf8'), new RegExp(`^DATABASE_URL=postgres://demo:demo@localhost:${PORTS.postgres}/demo_db$`, 'm'))
    const migrated = npxRuns(dir).find((run) => run.argv.includes('db:migrate') && !run.argv.includes('--help'))
    assert.strictEqual(migrated.env.DATABASE_URL, `postgres://demo:demo@localhost:${PORTS.postgres}/demo_db`, 'and Medusa is pointed at this stack')
})

test('start warns about a database exported elsewhere and seeds nothing into it', () => {
    const dir = project()
    fs.mkdirSync(path.join(dir, 'apps', 'backend'), { recursive: true })
    const r = local(['start'], { cwd: dir, env: { ...db(0, 0), ...ELSEWHERE } })
    assert.match(r.out, /this stack's Postgres is on localhost/)
    assert.ok(!npxRuns(dir).some((run) => run.argv.includes('user')))
})

test('a database url on this stack passes', () => {
    const dir = project()
    fs.mkdirSync(path.join(dir, 'apps', 'backend'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'apps', 'backend', '.env'), `DATABASE_URL=postgres://demo:demo@127.0.0.1:${PORTS.postgres}/demo_db\n`)
    assert.strictEqual(local(['seed-admin'], { cwd: dir, env: db(0, 0) }).status, 0)
})

test('an email with a quote in it cannot break the query', () => {
    const dir = project({ admin: { email: "o'brien@demo.local" } })
    const r = local(['admin'], { cwd: dir, env: db(1, 0) })
    assert.strictEqual(r.status, 0, r.out)
    assert.match(r.out, /o'brien@demo\.local/)
    const queries = dockerCalls(dir).flat().filter((word) => /lower\(email\)/.test(word))
    assert.ok(queries.length)
    for (const query of queries) assert.ok(query.includes("o''brien@demo.local"), query)
})
