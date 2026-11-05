// lma init in an empty folder: the two names, then the latest Medusa wired to the local stack
const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { PassThrough } = require('node:stream')
const install = require('../lib/install.js')
const { spawnSync } = require('node:child_process')
const { cli, onTerminal, ranDocker, devRuns, npxRuns, cleanup } = require('./support/harness.js')

const roots = []
test.after(() => { for (const d of roots.splice(0)) fs.rmSync(d, { recursive: true, force: true }); cleanup() })

const empty = (name = 'tutor-two') => {
    const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lma-init-')))
    roots.push(base)
    const dir = path.join(base, name)
    fs.mkdirSync(dir)
    return dir
}

// the stand-ins log beside the project here: their usual files would make the folder look taken
const sideLogs = (dir) => Object.fromEntries(['DOCKER', 'NPM', 'NPX'].map((k) => [`LMA_TEST_${k}_LOG`, path.join(dir, '..', `${k}.log`)]))
const json = (dir, file) => JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'))
const text = (dir, file) => fs.readFileSync(path.join(dir, file), 'utf8')
const npmRuns = (dir) => fs.readFileSync(path.join(dir, 'npm.log'), 'utf8').trim().split('\n').map(JSON.parse)
const env = { LMA_TEST_ADMIN_MATCHES: '1' }

const answered = async (answers, given = {}) => {
    const input = new PassThrough()
    const output = new PassThrough()
    let said = ''
    output.on('data', (d) => { said += d })
    input.end(answers.map((a) => `${a}\n`).join(''))
    const names = await install.askNames({ input, output, ...given })
    return { names, said }
}

test('the questions name the backend and then the store, and enter takes the default', async () => {
    const { names, said } = await answered(['', ''])
    assert.deepStrictEqual(names, { backend: 'backend', store: 'storefront' })
    assert.match(said, /Name for the Medusa backend and admin \[backend\]: /)
    assert.match(said, /Name for the store \[storefront\]: /)
    assert.doesNotMatch(said, /port/i)
})

test('a name that cannot be used is asked again with the reason', async () => {
    const { names, said } = await answered(['Redis App', 'redis', 'api', 'api', 'frontend'])
    assert.deepStrictEqual(names, { backend: 'api', store: 'frontend' })
    assert.match(said, /must be lowercase/)
    assert.match(said, /'redis' is taken/)
    assert.match(said, /'api' is already the name of the other app/)
})

test('a backend called storefront does not offer its own name for the store', async () => {
    const { names } = await answered(['storefront', ''])
    assert.deepStrictEqual(names, { backend: 'storefront', store: 'store' })
})

test('a name already given on the command line is not asked', async () => {
    const { names, said } = await answered(['frontend'], { backend: 'api' })
    assert.deepStrictEqual(names, { backend: 'api', store: 'frontend' })
    assert.doesNotMatch(said, /backend and admin/)
})

test('init installs only into an empty folder, or when told the names', () => {
    const dir = empty()
    assert.strictEqual(install.wanted(dir, [], true), true, 'empty, with a terminal')
    assert.strictEqual(install.wanted(dir, [], false), false, 'empty, with nothing to ask on')
    assert.strictEqual(install.wanted(dir, ['--backend', 'api'], false), true, 'told the names')
    fs.mkdirSync(path.join(dir, '.git'))
    assert.strictEqual(install.wanted(dir, [], true), true, 'a fresh git repo counts as empty')
    fs.writeFileSync(path.join(dir, 'package.json'), '{}')
    assert.strictEqual(install.wanted(dir, [], true), false, 'a project here only gets the config')
    assert.throws(() => install.wanted(dir, ['--backend', 'api'], false), /only installs into an empty folder, and this one has: package\.json/)
})

const installed = (extra = {}) => {
    const dir = empty()
    const r = cli(['init', '--backend', 'api', '--store', 'frontend', '--yes'], { cwd: dir, env: { ...env, ...extra } })
    return { dir, r }
}

test('init asks npm for the latest Medusa and hands it to Medusa\'s own installer', () => {
    const { dir, r } = installed({ LMA_TEST_MEDUSA_LATEST: '7.8.9' })
    assert.strictEqual(r.status, 0, r.out)
    assert.match(r.out, /Installing Medusa 7\.8\.9/)
    const { argv } = npxRuns(dir).find((run) => run.argv.includes('create-medusa-app@latest'))
    assert.strictEqual(argv[argv.indexOf('--version') + 1], '7.8.9')
    for (const needed of ['--use-npm', '--skip-db', '--no-browser', '--with-nextjs-starter']) assert.ok(argv.includes(needed), needed)
})

test('init moves the apps to their names and leaves no trace of the old ones', () => {
    const { dir, r } = installed()
    assert.strictEqual(r.status, 0, r.out)
    assert.ok(fs.existsSync(path.join(dir, 'apps', 'api', 'package.json')))
    assert.ok(fs.existsSync(path.join(dir, 'apps', 'frontend', 'package.json')))
    assert.ok(!fs.existsSync(path.join(dir, 'apps', 'backend')))
    assert.ok(!fs.existsSync(path.join(dir, 'apps', 'storefront')))
    assert.strictEqual(json(dir, 'apps/api/package.json').name, '@tutor-two/api')
    assert.strictEqual(json(dir, 'apps/frontend/package.json').name, '@tutor-two/frontend')
    const root = json(dir, 'package.json')
    assert.strictEqual(root.name, 'tutor-two')
    assert.strictEqual(root.private, true)
    assert.strictEqual(root.scripts['api:dev'], 'turbo dev --filter=@tutor-two/api')
    assert.strictEqual(root.scripts['frontend:dev'], 'turbo dev --filter=@tutor-two/frontend')
    assert.strictEqual(root.scripts.lma, 'lma')
    for (const file of ['AGENTS.md', 'package-lock.json']) {
        assert.doesNotMatch(text(dir, file), /@dtc|apps\/backend|apps\/storefront/, file)
    }
    assert.ok(!fs.existsSync(path.join(dir, install.WORK)), 'the working folder is gone')
    assert.ok(!fs.existsSync(path.join(dir, 'apps', 'api', 'node_modules')), 'links to the old folders are gone')
})

test('init records the two apps and their assigned ports in the config', () => {
    const { dir, r } = installed()
    assert.strictEqual(r.status, 0, r.out)
    const cfg = require(path.join(dir, 'lma.js'))
    assert.strictEqual(cfg.project, 'tutor-two')
    assert.strictEqual(cfg.apps.api.role, 'backend')
    for (const port of [cfg.apps.api.port, cfg.apps.frontend.port, cfg.services.postgres.port, cfg.services.redis.port, cfg.proxy.port]) {
        assert.ok(Number.isInteger(port) && port > 0, String(port))
    }
})

test('the env files point at the assigned ports and carry real secrets', () => {
    const { dir, r } = installed()
    assert.strictEqual(r.status, 0, r.out)
    const cfg = require(path.join(dir, 'lma.js'))
    const backendEnv = text(dir, 'apps/api/.env')
    assert.match(backendEnv, new RegExp(`DATABASE_URL=postgres://medusa:medusa@localhost:${cfg.services.postgres.port}/medusa-backend`))
    assert.match(backendEnv, new RegExp(`REDIS_URL=redis://localhost:${cfg.services.redis.port}`))
    assert.match(backendEnv, new RegExp(`PORT=${cfg.apps.api.port}`))
    assert.match(backendEnv, new RegExp(`STORE_CORS=.*http://localhost:${cfg.apps.frontend.port}`))
    assert.doesNotMatch(backendEnv, /supersecret|medusa\.com/)
    assert.strictEqual(backendEnv.match(/^REDIS_URL=/gm).length, 1, 'the installer\'s line is replaced, not joined')
    assert.match(backendEnv, /AUTH_MFA_ENCRYPTION_KEY=keepme/)
    assert.strictEqual(fs.statSync(path.join(dir, 'apps/api/.env')).mode & 0o777, 0o600)
    const storeEnv = text(dir, 'apps/frontend/.env.local')
    assert.match(storeEnv, new RegExp(`NEXT_PUBLIC_MEDUSA_BACKEND_URL=http://localhost:${cfg.apps.api.port}`))
    assert.match(storeEnv, /NEXT_PUBLIC_MEDUSA_PUBLISHABLE_KEY=pk_test/)
    assert.match(storeEnv, /NEXT_PUBLIC_DEFAULT_REGION=dk/, 'lines lma does not own stay')
    assert.doesNotMatch(text(dir, 'apps/frontend/.env.template'), /pk_test/, 'the template holds no key')
    assert.match(text(dir, 'apps/frontend/.env.template'), /NEXT_PUBLIC_DEFAULT_REGION=dk/, 'the template is the installer\'s, not a new file')
})

test('nothing still points at the folder the installer ran in', () => {
    const { dir, r } = installed()
    assert.strictEqual(r.status, 0, r.out)
    const backendEnv = text(dir, 'apps/api/.env')
    assert.doesNotMatch(backendEnv, /lma-install/)
    assert.ok(backendEnv.includes(`MEDUSA_ADMIN_ONBOARDING_NEXTJS_DIRECTORY=${path.join(dir, 'apps', 'frontend')}`))
})

test('the pnpm setting the starter ships does not make npm warn on every command', () => {
    const { dir, r } = installed()
    assert.strictEqual(r.status, 0, r.out)
    assert.ok(!fs.existsSync(path.join(dir, '.npmrc')))
})

test('the store follows the port lma gives it, and keeps its other scripts', () => {
    const { dir, r } = installed()
    assert.strictEqual(r.status, 0, r.out)
    const cfg = require(path.join(dir, 'lma.js'))
    const { scripts } = json(dir, 'apps/frontend/package.json')
    assert.strictEqual(scripts.dev, `next dev -p \${PORT:-${cfg.apps.frontend.port}}`)
    assert.strictEqual(scripts.start, `next start -p \${PORT:-${cfg.apps.frontend.port}}`)
    assert.strictEqual(scripts.build, 'next build')
})

test('init installs lma into the project, migrates, then starts both apps', () => {
    const { dir, r } = installed()
    assert.strictEqual(r.status, 0, r.out)
    const add = npmRuns(dir).find((run) => run.argv[0] === 'install')
    assert.match(add.argv.join(' '), /--save-dev @selveq\/medusa-scripts@\^\d+\.\d+\.\d+/)
    assert.deepStrictEqual(
        npxRuns(dir).find((run) => run.argv.includes('db:migrate') && !run.argv.includes('--help')).argv,
        ['--no', 'medusa', 'db:migrate', '--execute-safe-links', '--execute-safe-search']
    )
    assert.ok(ranDocker(dir, 'compose', 'up', '-d'))
    assert.deepStrictEqual(devRuns(dir).filter((run) => run.argv[0] === 'run').map((run) => path.basename(run.cwd)).sort(), ['api', 'frontend'])
    assert.match(r.out, /frontend: http:\/\/localhost:\d+/)
    assert.match(r.out, /api: http:\/\/localhost:\d+\/app/)
    assert.match(r.out, /The admin login: npx lma admin/)
    const migrated = npxRuns(dir).find((run) => run.argv.includes('db:migrate') && !run.argv.includes('--help'))
    const started = devRuns(dir).find((run) => run.argv[0] === 'run')
    assert.ok(BigInt(migrated.at) < BigInt(started.at), 'the database comes before the apps')
})

test('init leaves a git repo with nothing committed, and a workspace file', () => {
    const { dir, r } = installed()
    assert.strictEqual(r.status, 0, r.out)
    assert.ok(fs.existsSync(path.join(dir, '.git')))
    const workspace = json(dir, 'tutor-two.code-workspace')
    assert.deepStrictEqual(workspace.folders.map((f) => f.path), ['./apps/api', './apps/frontend', '.'])
})

test('init refuses a bad name before it installs anything', () => {
    const dir = empty()
    const r = cli(['init', '--backend', 'redis', '--store', 'frontend', '--yes'], { cwd: dir, env })
    assert.notStrictEqual(r.status, 0)
    assert.match(r.out, /'redis' is taken/)
    assert.deepStrictEqual(fs.readdirSync(dir).filter((f) => !/log$/.test(f)), [])
})

test('init refuses the same name twice', () => {
    const dir = empty()
    const r = cli(['init', '--backend', 'shop', '--store', 'shop', '--yes'], { cwd: dir, env })
    assert.notStrictEqual(r.status, 0)
    assert.match(r.out, /already the name of the other app/)
})

test('init stops when Docker is off and there is no terminal to ask on', () => {
    const dir = empty()
    const r = cli(['init', '--backend', 'api', '--store', 'frontend'], { cwd: dir, env: { ...env, LMA_TEST_DOCKER_DOWN: '1' } })
    assert.notStrictEqual(r.status, 0)
    assert.match(r.out, /Docker is not running, and there is no terminal to ask on/)
    assert.deepStrictEqual(npxRuns(dir), [])
})

test('a failed install says so and points at its log', () => {
    const dir = empty()
    const r = cli(['init', '--backend', 'api', '--store', 'frontend', '--yes'], { cwd: dir, env: { ...env, LMA_TEST_INSTALLER_FAILS: '1' } })
    assert.notStrictEqual(r.status, 0)
    assert.match(r.out, /Medusa's installer did not finish/)
    assert.match(r.out, /\.lma-install\/install\.log/)
    assert.match(r.out, /ran out of luck/)
    assert.ok(!fs.existsSync(path.join(dir, 'lma.js')))
})

test('a failed install can be run again', () => {
    const dir = empty()
    // the stand-ins log beside the project here: their usual files would make the folder look taken
    const logs = Object.fromEntries(['DOCKER', 'NPM', 'NPX'].map((k) => [`LMA_TEST_${k}_LOG`, path.join(dir, '..', `${k}.log`)]))
    cli(['init', '--backend', 'api', '--store', 'frontend', '--yes'], { cwd: dir, env: { ...env, ...logs, LMA_TEST_INSTALLER_FAILS: '1' } })
    const r = cli(['init', '--backend', 'api', '--store', 'frontend', '--yes'], { cwd: dir, env: { ...env, ...logs } })
    assert.strictEqual(r.status, 0, r.out)
})

test('init with nothing to ask on still only writes the config', () => {
    const dir = empty()
    const r = cli(['init'], { cwd: dir, env })
    assert.strictEqual(r.status, 0, r.out)
    assert.ok(fs.existsSync(path.join(dir, 'lma.js')))
    assert.deepStrictEqual(npxRuns(dir), [])
})

test('init works when npx was told the package, and hands that setting to no child', () => {
    const { dir, r } = installed({ npm_config_package: '@selveq/medusa-scripts' })
    assert.strictEqual(r.status, 0, r.out)
    assert.ok(fs.existsSync(path.join(dir, 'lma.js')))
})

test('init leaves no commit behind, and the links of the installer\'s folder names are gone', () => {
    const { dir, r } = installed()
    assert.strictEqual(r.status, 0, r.out)
    assert.notStrictEqual(spawnSync('git', ['rev-parse', '--verify', 'HEAD'], { cwd: dir, stdio: 'ignore' }).status, 0)
    assert.ok(!fs.existsSync(path.join(dir, 'node_modules', '@dtc')))
    assert.ok(!fs.existsSync(path.join(dir, 'apps', 'api', 'node_modules')))
})

for (const folder of ['My Shop', 'R&D']) {
    test(`init installs into a folder called ${folder}: the installer gets no path to trip on`, () => {
        const dir = empty(folder)
        const r = cli(['init', '--backend', 'api', '--store', 'web', '--yes'], { cwd: dir, env: { ...env, ...sideLogs(dir) } })
        assert.strictEqual(r.status, 0, r.out)
        assert.ok(fs.existsSync(path.join(dir, 'apps', 'api', 'package.json')))
    })
}

for (const folder of ['shop (copy)', 'shop[1]']) {
    test(`init refuses ${folder} before installing: Medusa finds no migrations under a path like that`, () => {
        const dir = empty(folder)
        const r = cli(['init', '--backend', 'api', '--store', 'web', '--yes'], { cwd: dir, env: { ...env, ...sideLogs(dir) } })
        assert.notStrictEqual(r.status, 0)
        assert.match(r.out, /Medusa cannot run from a path with .* in it/)
        assert.deepStrictEqual(fs.readdirSync(dir), [])
    })
}

for (const [backend, store] of [['storefront', 'store'], ['api', 'backend'], ['storefront', 'backend']]) {
    test(`a backend called ${backend} and a store called ${store} land in their own folders`, () => {
        const dir = empty()
        const r = cli(['init', '--backend', backend, '--store', store, '--yes'], { cwd: dir, env: { ...env, ...sideLogs(dir) } })
        assert.strictEqual(r.status, 0, r.out)
        assert.strictEqual(json(dir, `apps/${backend}/package.json`).scripts.dev, 'medusa develop')
        assert.match(json(dir, `apps/${store}/package.json`).scripts.dev, /^next dev/)
    })
}

test('a new name holding an old one is renamed once, not twice', () => {
    const dir = empty()
    const r = cli(['init', '--backend', 'storefront-api', '--store', 'shop', '--yes'], { cwd: dir, env: { ...env, ...sideLogs(dir) } })
    assert.strictEqual(r.status, 0, r.out)
    assert.match(text(dir, 'AGENTS.md'), /cd apps\/storefront-api/)
    assert.doesNotMatch(text(dir, 'AGENTS.md'), /shop-api/)
    assert.ok(fs.existsSync(path.join(dir, 'apps', 'storefront-api')))
})

test('a backend called storefront with no store named gets a store that fits', () => {
    const dir = empty()
    const r = cli(['init', '--backend', 'storefront', '--yes'], { cwd: dir, env: { ...env, ...sideLogs(dir) } })
    assert.strictEqual(r.status, 0, r.out)
    assert.ok(fs.existsSync(path.join(dir, 'apps', 'store')))
})

test('--backend=name works, and a name left out is refused', () => {
    const dir = empty()
    const given = cli(['init', '--backend=api', '--store=web', '--yes'], { cwd: dir, env: { ...env, ...sideLogs(dir) } })
    assert.strictEqual(given.status, 0, given.out)
    assert.ok(fs.existsSync(path.join(dir, 'apps', 'web')))
    const bare = empty()
    const r = cli(['init', '--backend'], { cwd: bare, env: sideLogs(bare) })
    assert.notStrictEqual(r.status, 0)
    assert.match(r.out, /--backend needs a name/)
    assert.deepStrictEqual(fs.readdirSync(bare), [])
})

test('a dry run installs nothing, even with the names given', () => {
    const dir = empty()
    const r = cli(['init', '--backend', 'api', '--store', 'web', '-n'], { cwd: dir, env: sideLogs(dir) })
    assert.strictEqual(r.status, 0, r.out)
    assert.match(r.out, /\[dry-run\] would start Docker/)
    assert.deepStrictEqual(fs.readdirSync(dir), [])
})

test('a failed npm install leaves nothing but the work folder, and running again works', () => {
    const dir = empty()
    const failed = cli(['init', '--backend', 'api', '--store', 'web', '--yes'], { cwd: dir, env: { ...env, ...sideLogs(dir), LMA_TEST_NPM_INSTALL_EXIT: '1' } })
    assert.notStrictEqual(failed.status, 0)
    assert.match(failed.out, /npm install failed\. Run lma init again once that is fixed/)
    assert.deepStrictEqual(fs.readdirSync(dir), ['.lma-install'])
    const again = cli(['init', '--backend', 'api', '--store', 'web', '--yes'], { cwd: dir, env: { ...env, ...sideLogs(dir) } })
    assert.strictEqual(again.status, 0, again.out)
    assert.ok(!fs.existsSync(path.join(dir, '.lma-install')))
})

test('an installer that left only one of the two apps is a failed install, and can be run again', () => {
    const dir = empty()
    const r = cli(['init', '--backend', 'api', '--store', 'web', '--yes'], { cwd: dir, env: { ...env, ...sideLogs(dir), LMA_TEST_INSTALLER_PARTIAL: '1' } })
    assert.notStrictEqual(r.status, 0)
    assert.match(r.out, /Medusa's installer did not finish/)
    assert.deepStrictEqual(fs.readdirSync(dir), ['.lma-install'])
})

for (const [what, extra, said] of [
    ['a failed migration', { LMA_TEST_MIGRATE_FAILS: '1' }, /lma migrate failed/],
    ['containers that will not start', { LMA_TEST_COMPOSE_FAILS: '1' }, /lma migrate failed/],
    ['an app that does not come up', { LMA_TEST_DEV_CRASH: '1' }, /lma start failed/],
]) {
    test(`${what} stops init, says how to finish, and prints no addresses`, () => {
        const dir = empty()
        const r = cli(['init', '--backend', 'api', '--store', 'web', '--yes'], { cwd: dir, env: { ...env, ...sideLogs(dir), ...extra } })
        assert.notStrictEqual(r.status, 0)
        assert.match(r.out, said)
        assert.match(r.out, /The project is in place.*npx lma migrate && npx lma start/)
        assert.doesNotMatch(r.out, /web: http:\/\/localhost/)
        assert.ok(fs.existsSync(path.join(dir, 'apps', 'api')))
    })
}

test('init refuses a folder whose old database is still around, before installing anything', () => {
    const dir = empty()
    const r = cli(['init', '--backend', 'api', '--store', 'web', '--yes'], { cwd: dir, env: { ...sideLogs(dir), LMA_TEST_OLD_VOLUMES: 'x_postgres-data' } })
    assert.notStrictEqual(r.status, 0)
    assert.match(r.out, /left its database behind\. Remove it with: docker volume rm x_postgres-data/)
    assert.deepStrictEqual(fs.readdirSync(dir), [])
})

test('a folder the installer would also make is named, before anything moves', () => {
    const dir = empty()
    fs.mkdirSync(path.join(dir, '.vscode'))
    const r = cli(['init', '--backend', 'api', '--store', 'web', '--yes'], { cwd: dir, env: { ...env, ...sideLogs(dir), LMA_TEST_INSTALLER_EXTRA: '.vscode/settings.json' } })
    assert.notStrictEqual(r.status, 0)
    assert.match(r.out, /also makes .*\.vscode.*, which this folder already has/)
    assert.deepStrictEqual(fs.readdirSync(dir).sort(), ['.lma-install', '.vscode'])
})

test('on a terminal init asks the names, and a clash with a name already given is asked again', () => {
    const dir = empty()
    const r = onTerminal(['init', '--store', 'shop', '--yes'], { cwd: dir, env: { ...env, ...sideLogs(dir) }, lines: ['shop', 'api'] })
    assert.strictEqual(r.status, 0, r.out)
    assert.match(r.out, /Name for the Medusa backend and admin \[backend\]:/)
    assert.match(r.out, /'shop' is already the name of the other app/)
    assert.ok(fs.existsSync(path.join(dir, 'apps', 'api')))
    assert.ok(fs.existsSync(path.join(dir, 'apps', 'shop')))
})

test('on a terminal with Docker off, init asks before starting it', () => {
    const dir = empty()
    const r = onTerminal(['init'], { cwd: dir, env: { ...sideLogs(dir), LMA_TEST_DOCKER_DOWN: '1' }, lines: ['n'] })
    assert.notStrictEqual(r.status, 0)
    assert.match(r.out, /Docker is not running\. Start Docker Desktop\? \[y\/N\]/)
    assert.match(r.out, /aborted/)
    assert.deepStrictEqual(fs.readdirSync(dir), [])
})
