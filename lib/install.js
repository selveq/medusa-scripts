// a new project from an empty folder: the latest Medusa from its own installer, renamed and wired to the local stack
const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const readline = require('node:readline')
const config = require('./config.js')
const cors = require('./cors.js')
const envfile = require('./envfile.js')
const ports = require('./ports.js')
const secrets = require('./secrets.js')

const ASSETS = path.join(__dirname, '..', 'assets')
const WORK = '.lma-install'
// what may already be in a folder Medusa is installed into
const HARMLESS = new Set(['.git', '.DS_Store', '.claude', '.vscode', '.idea', WORK])

// Medusa finds its migrations with a glob over the full path: with these in it, it finds none and calls an empty database up to date
const GLOB_CHARS = /[()[\]{}*?!]/

const flag = (args, name) => {
    const joined = args.find((arg) => arg.startsWith(`${name}=`))
    if (joined) return joined.slice(name.length + 1)
    const at = args.indexOf(name)
    if (at === -1) return undefined
    const value = args[at + 1]
    if (value === undefined || value.startsWith('-')) throw new Error(`${name} needs a name`)
    return value
}

const inTheWay = (cwd) => fs.readdirSync(cwd).filter((entry) => !HARMLESS.has(entry))

// a store called backend needs the backend to be called something else, and the other way round
const defaults = ({ backend, store }) => ({
    backend: store === 'backend' ? 'api' : 'backend',
    store: backend === 'storefront' ? 'store' : 'storefront',
})

// no names and no terminal, or a project already here: init only writes the config, as it always has
const wanted = (cwd, args, isTTY = process.stdin.isTTY) => {
    const named = flag(args, '--backend') !== undefined || flag(args, '--store') !== undefined
    const clear = inTheWay(cwd).length === 0
    if (named && !clear) {
        throw new Error(`Medusa only installs into an empty folder, and this one has: ${inTheWay(cwd).slice(0, 5).join(', ')}`)
    }
    return named || (Boolean(isTTY) && clear)
}

const problemWith = (name, other) => {
    if (name === other) return `'${name}' is already the name of the other app`
    return config.nameProblem(name)
}

const askNames = async ({ input = process.stdin, output = process.stdout, backend, store } = {}) => {
    const rl = readline.createInterface({ input, terminal: false })
    const lines = rl[Symbol.asyncIterator]()
    const fallbacks = defaults({ backend, store })
    const ask = async (question, fallback, other) => {
        for (;;) {
            output.write(`${question} [${fallback}]: `)
            const { value, done } = await lines.next()
            if (done) throw new Error(`no answer to: ${question}`)
            const name = value.trim() || fallback
            const problem = problemWith(name, other)
            if (!problem) return name
            output.write(`${problem}\n`)
        }
    }
    try {
        const b = backend ?? await ask('Name for the Medusa backend and admin', fallbacks.backend, store)
        const s = store ?? await ask('Name for the store', defaults({ backend: b }).store, b)
        return { backend: b, store: s }
    } finally { rl.close() }
}

const checked = (r, what) => {
    if (r.error) throw new Error(`${what}: ${r.error.message}`)
    if (r.status !== 0) throw new Error(`${what} failed`)
    return r
}

// a new install here would keep the old database, with an admin whose password it can no longer print
const refuseOldVolumes = (cwd, project) => {
    const prefix = ports.projectName(cwd, { project })
    const r = spawnSync('docker', ['volume', 'ls', '-q', '--filter', `name=^${prefix}_`], { encoding: 'utf8' })
    const names = (r.stdout || '').split('\n').filter(Boolean)
    if (!names.length) return
    throw new Error(`an earlier install in this folder left its database behind. Remove it with: docker volume rm ${names.join(' ')}\nOr install in another folder.`)
}

const latestMedusa = () => {
    const r = spawnSync('npm', ['view', '@medusajs/medusa', 'version'], { encoding: 'utf8' })
    const version = (r.stdout || '').trim()
    if (r.status !== 0 || !version) throw new Error('could not ask npm for the latest Medusa version; are you online?')
    return version
}

// Medusa's installer always builds apps/backend and apps/storefront, and puts its path unquoted into a shell command, so it gets a bare name
// everything that can fail runs aside: until it has all worked, running init again starts clean
const runInstaller = (cwd, project, version) => {
    const work = path.join(cwd, WORK)
    fs.rmSync(work, { recursive: true, force: true })
    fs.mkdirSync(work, { recursive: true })
    const logFile = path.join(work, 'install.log')
    const log = fs.openSync(logFile, 'w')
    const r = spawnSync('npx', [
        '--yes', 'create-medusa-app@latest', project,
        '--use-npm', '--skip-db', '--no-browser', '--with-nextjs-starter',
        '--version', version,
    ], { cwd: work, stdio: ['ignore', log, log] })
    fs.closeSync(log)
    const built = path.join(work, project)
    const complete = ['backend', 'storefront'].every((app) => fs.existsSync(path.join(built, 'apps', app, 'package.json')))
    if (r.error || r.status !== 0 || !complete) {
        const tail = fs.readFileSync(logFile, 'utf8').trim().split('\n').slice(-15).join('\n')
        throw new Error(`Medusa's installer did not finish. The whole log is at ${path.relative(cwd, logFile)}\n${tail}`)
    }
    return built
}

const moveIn = (cwd, built) => {
    const entries = fs.readdirSync(built)
    const clash = entries.filter((entry) => fs.existsSync(path.join(cwd, entry)))
    if (clash.length) throw new Error(`Medusa's installer also makes ${clash.join(', ')}, which this folder already has. Move it away and run init again.`)
    for (const entry of entries) fs.renameSync(path.join(built, entry), path.join(cwd, entry))
    fs.rmSync(path.join(cwd, WORK), { recursive: true, force: true })
}

const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'))
const writeJson = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n')

// one pass, so a new name that contains an old one is not renamed again
const rewriteText = (file, swaps) => {
    if (!fs.existsSync(file)) return
    const pattern = new RegExp([...swaps.keys()].sort((a, b) => b.length - a.length).map((s) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')).join('|'), 'g')
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(pattern, (hit) => swaps.get(hit)))
}

// the names go everywhere the installer wrote its own, lockfile included, so npm sees one consistent project
const rename = (cwd, { project, backend, store }) => {
    const apps = path.join(cwd, 'apps')
    const swaps = new Map()
    const moves = [['backend', backend], ['storefront', store]]
    for (const [from, to] of moves) {
        const pkgFile = path.join(apps, from, 'package.json')
        const pkg = readJson(pkgFile)
        const name = `@${project}/${to}`
        swaps.set(pkg.name, name).set(`apps/${from}`, `apps/${to}`).set(`── ${from}/`, `── ${to}/`)
        pkg.name = name
        writeJson(pkgFile, pkg)
    }
    // through a side name: a backend called storefront arrives where the store still is
    for (const [from] of moves) fs.renameSync(path.join(apps, from), path.join(apps, `.lma-${from}`))
    for (const [from, to] of moves) fs.renameSync(path.join(apps, `.lma-${from}`), path.join(apps, to))
    for (const doc of ['AGENTS.md', 'README.md', 'CLAUDE.md', 'package-lock.json', 'package.json']) {
        rewriteText(path.join(cwd, doc), swaps)
    }
    const rootFile = path.join(cwd, 'package.json')
    const root = readJson(rootFile)
    const scripts = {}
    for (const [key, value] of Object.entries(root.scripts || {})) {
        scripts[key.replace(/^backend:/, `${backend}:`).replace(/^storefront:/, `${store}:`)] = value
    }
    writeJson(rootFile, { ...root, name: project, private: true, scripts })
    // a pnpm setting the starter ships: npm warns about it on every command
    const npmrc = path.join(cwd, '.npmrc')
    if (fs.existsSync(npmrc) && fs.readFileSync(npmrc, 'utf8').trim() === 'auto-install-peers=true') fs.rmSync(npmrc)
    // the links in here name the old folders; npm rebuilds them from the rewritten lockfile
    fs.rmSync(path.join(cwd, 'node_modules'), { recursive: true, force: true })
    for (const dir of [backend, store]) fs.rmSync(path.join(apps, dir, 'node_modules'), { recursive: true, force: true })
}

const installDependencies = (cwd, selfSpec) => {
    const log = path.join(cwd, 'npm-install.log')
    const fd = fs.openSync(log, 'w')
    const r = spawnSync('npm', ['install', '--save-dev', selfSpec, '--no-audit', '--no-fund'], { cwd, stdio: ['ignore', fd, fd] })
    fs.closeSync(fd)
    if (r.error || r.status !== 0) {
        throw new Error(`npm install failed. Run lma init again once that is fixed. The whole log is at ${path.relative(path.join(cwd, '..', '..'), log)}\n${fs.readFileSync(log, 'utf8').trim().split('\n').slice(-15).join('\n')}`)
    }
    fs.rmSync(log, { force: true })
}

const writeConfig = (cwd, vars, render) => fs.writeFileSync(path.join(cwd, 'lma.js'), render('lma.app.js.tpl', vars))

// the assigned ports are saved in the config: the cache in node_modules is gone after a clean install
const assignPorts = async (cwd, { project, backend, store }, render) => {
    const noPorts = { PROJECT: project, BACKEND: backend, STORE: store, PG: 5432, REDIS: 6379, HTTP: 80, BACKEND_PORT: 9000, STORE_PORT: 8000 }
    writeConfig(cwd, noPorts, render)
    const { ports: map } = await ports.resolve(cwd)
    writeConfig(cwd, {
        ...noPorts, PG: map.postgres, REDIS: map.redis, HTTP: map.http, BACKEND_PORT: map[backend], STORE_PORT: map[store],
    }, render)
    await ports.resolve(cwd, { reset: true })
    return map
}

const wire = (cwd, { backend, store }, map) => {
    const cfg = config.load(cwd)
    const { values } = secrets.ensure(cwd)
    const owned = cors.owned(cfg, map)
    const backendEnv = path.join(cwd, 'apps', backend, '.env')
    envfile.write(backendEnv, {
        PORT: map[backend],
        STORE_CORS: owned.STORE_CORS.join(','),
        ADMIN_CORS: owned.ADMIN_CORS.join(','),
        AUTH_CORS: owned.AUTH_CORS.join(','),
        DATABASE_URL: `postgres://medusa:medusa@localhost:${map.postgres}/medusa-backend`,
        REDIS_URL: `redis://localhost:${map.redis}`,
        JWT_SECRET: values.LMA_JWT_SECRET,
        COOKIE_SECRET: values.LMA_COOKIE_SECRET,
    })
    // the installer pointed this at the folder it ran in, which is gone
    if (envfile.read(backendEnv).MEDUSA_ADMIN_ONBOARDING_NEXTJS_DIRECTORY) {
        envfile.write(backendEnv, { MEDUSA_ADMIN_ONBOARDING_NEXTJS_DIRECTORY: path.join(cwd, 'apps', store) })
    }
    fs.chmodSync(backendEnv, 0o600)

    const storeDir = path.join(cwd, 'apps', store)
    const urls = {
        NEXT_PUBLIC_MEDUSA_BACKEND_URL: `http://localhost:${map[backend]}`,
        NEXT_PUBLIC_BASE_URL: `http://localhost:${map[store]}`,
    }
    // the installer turned the template into .env.local; a fresh clone needs it back
    const local = path.join(storeDir, '.env.local')
    const template = path.join(storeDir, '.env.template')
    if (fs.existsSync(local) && !fs.existsSync(template)) fs.copyFileSync(local, template)
    envfile.write(template, urls)
    envfile.write(local, urls)

    // lma exports PORT and may have moved it; a fixed -p would ignore that and fail on the busy port
    const pkgFile = path.join(storeDir, 'package.json')
    const pkg = readJson(pkgFile)
    for (const script of ['dev', 'start']) {
        if (pkg.scripts && pkg.scripts[script]) {
            pkg.scripts[script] = pkg.scripts[script].replace(/ -p \d+/, ` -p \${PORT:-${map[store]}}`)
        }
    }
    writeJson(pkgFile, pkg)
}

const finishProject = (cwd, { project, backend, store }, { addScripts, render }) => {
    addScripts(cwd, { lma: 'lma' })
    fs.writeFileSync(
        path.join(cwd, `${project}.code-workspace`),
        render('project.code-workspace.tpl', { PROJECT: project, BACKEND: backend, STORE: store })
    )
    if (!fs.existsSync(path.join(cwd, '.git'))) checked(spawnSync('git', ['init', '-q'], { cwd }), 'git init')
}

const engine = (cwd, args, stdio = ['ignore', 'inherit', 'inherit']) => spawnSync(
    'bash', [path.join(ASSETS, 'local.sh'), ...args],
    { cwd, stdio, encoding: 'utf8', env: { ...process.env, LMA_ASSETS: ASSETS, LMA_ROOT: cwd, LMA_RUNNING: '1' } }
)

// the frontend's own build reads the key from .env.local; in dev lma passes it along itself
const saveStoreKey = (cwd, store) => {
    const sql = "SELECT token FROM api_key WHERE type='publishable' AND revoked_at IS NULL AND deleted_at IS NULL LIMIT 1"
    const r = engine(cwd, ['psql', '-tAc', sql], ['ignore', 'pipe', 'ignore'])
    const key = (r.stdout || '').trim()
    if (key) envfile.write(path.join(cwd, 'apps', store, '.env.local'), { NEXT_PUBLIC_MEDUSA_PUBLISHABLE_KEY: key })
    else console.log(`  no publishable key yet; npm run build in apps/${store} needs one in .env.local`)
}

const run = async (cwd, args, { addScripts, render }) => {
    const glob = cwd.match(GLOB_CHARS)
    if (glob) throw new Error(`Medusa cannot run from a path with ${glob[0]} in it: its migrations would find nothing. Install in a folder whose path has none of ( ) [ ] { } * ? !`)
    const project = config.slug(path.basename(cwd)) || 'app'
    const given = { backend: flag(args, '--backend'), store: flag(args, '--store') }
    for (const [name, other] of [[given.backend, given.store], [given.store, given.backend]]) {
        const problem = name === undefined ? null : problemWith(name, other)
        if (problem) throw new Error(problem)
    }
    const fallbacks = defaults(given)
    const offTerminal = { backend: given.backend ?? fallbacks.backend, store: given.store ?? fallbacks.store }

    const yes = args.includes('--yes') || args.includes('-y')
    checked(spawnSync('bash', [path.join(ASSETS, 'docker.sh'), ...(yes ? ['--yes'] : [])], { stdio: 'inherit' }), 'Docker')
    refuseOldVolumes(cwd, project)

    const names = process.stdin.isTTY ? await askNames(given) : offTerminal
    const opts = { project, ...names }

    const version = latestMedusa()
    console.log(`Installing Medusa ${version} with its own installer. This takes a few minutes.`)
    const built = runInstaller(cwd, project, version)
    rename(built, opts)
    console.log('Installing dependencies.')
    const { version: self } = require('../package.json')
    installDependencies(built, process.env.LMA_TEST_SELF_SPEC || `@selveq/medusa-scripts@^${self}`)
    moveIn(cwd, built)

    let map
    try {
        map = await assignPorts(cwd, opts, render)
        wire(cwd, opts, map)
        finishProject(cwd, opts, { addScripts, render })
        console.log('Creating the database.')
        checked(engine(cwd, ['migrate', '--yes']), 'lma migrate')
        saveStoreKey(cwd, names.store)
        checked(engine(cwd, ['start', '--yes']), 'lma start')
    } catch (e) {
        throw new Error(`${e.message}\nThe project is in place, so running init again would refuse. Fix that, then run here: npx lma migrate && npx lma start`)
    }

    console.log(`\n${names.store}: http://localhost:${map[names.store]}`)
    console.log(`${names.backend}: http://localhost:${map[names.backend]}/app`)
    // not into a log: the password goes to a terminal, or waits to be asked for
    if (process.stdout.isTTY) engine(cwd, ['admin'])
    else console.log('The admin login: npx lma admin')
}

module.exports = { wanted, inTheWay, askNames, run, WORK }
