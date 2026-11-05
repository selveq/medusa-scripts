#!/usr/bin/env node
// find the project root, dispatch to the bash engine in assets/
const { spawn, spawnSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const config = require('../lib/config.js')
const install = require('../lib/install.js')
const paths = require('../lib/paths.js')
const secrets = require('../lib/secrets.js')

// npx hands these to every child, and an inner npx would then look for its command in the wrong package
delete process.env.npm_config_package
delete process.env.npm_config_call

// started from inside lma run or a dev server: those settings describe that stack, and must not steer this command
if (process.env.LMA_RUNNING) {
    for (const key of Object.keys(process.env)) {
        if (key.startsWith('LMA_') && !key.startsWith('LMA_TEST_')) delete process.env[key]
    }
    for (const key of ['DATABASE_URL', 'REDIS_URL', 'DB_HOST', 'DB_PORT', 'DB_USERNAME', 'DB_PASSWORD']) delete process.env[key]
}

const ASSETS = path.join(__dirname, '..', 'assets')
const TEMPLATES = path.join(__dirname, '..', 'templates')

const render = (tpl, vars) =>
    fs.readFileSync(path.join(TEMPLATES, tpl), 'utf8')
        .replace(/__([A-Z_]+)__/g, (_, k) => vars[k] ?? `__${k}__`)

const SCRIPTS = {
    lma: 'lma',
    start: 'lma start', stop: 'lma stop', restart: 'lma restart',
    destroy: 'lma destroy', status: 'lma status', logs: 'lma logs',
    psql: 'lma psql', redis: 'lma redis',
    'import-db': 'lma import-db', 'dump-db': 'lma dump-db', 'reset-db': 'lma reset-db',
    migrate: 'lma migrate', 'seed-admin': 'lma seed-admin',
    admin: 'lma admin', 'show-env': 'lma show-env',
    tunnel: 'lma tunnel', 'tunnel:setup': 'lma tunnel setup',
    'tunnel:quick': 'lma tunnel quick', 'tunnel:start': 'lma tunnel start',
    'tunnel:stop': 'lma tunnel stop', 'tunnel:status': 'lma tunnel status',
    'tunnel:logs': 'lma tunnel logs',
}

// merge npm aliases into package.json; true when `npm run <alias>` works
const addScripts = (cwd, wanted) => {
    const pkgPath = path.join(cwd, 'package.json')
    const manual = Object.entries(wanted).map(([k, v]) => `    "${k}": "${v}"`).join(',\n')
    if (!fs.existsSync(pkgPath)) {
        console.log(`  no package.json here; add these scripts yourself:\n${manual}`)
        return false
    }
    let raw, pkg
    try {
        raw = fs.readFileSync(pkgPath, 'utf8')
        pkg = JSON.parse(raw)
    } catch (e) {
        console.log(`  skipped   package.json (${e.message}); add these scripts yourself:\n${manual}`)
        return false
    }
    const indent = (raw.match(/^([ \t]+)"/m) || [, '  '])[1]
    const eof = raw.endsWith('\n') ? '\n' : ''
    const existing = pkg.scripts || {}
    const fresh = {}
    const added = []
    const kept = []
    for (const [k, v] of Object.entries(wanted)) {
        if (existing[k] === v) continue
        if (existing[k]) kept.push(k)
        else { fresh[k] = v; added.push(k) }
    }
    if (!added.length) {
        console.log(`  kept      package.json scripts${kept.length ? ` (yours win: ${kept.join(', ')})` : ''}`)
        return true
    }
    pkg.scripts = { ...fresh, ...existing }
    fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, indent) + eof)
    console.log(`  updated   package.json (+${added.join(', ')})${kept.length ? ` (yours win: ${kept.join(', ')})` : ''}`)
    return true
}

const init = (cwd, args) => {
    const project = config.slug(path.basename(cwd)) || 'app'
    const vars = { PROJECT: project }
    const name = config.configName(cwd)
    const existing = config.configPath(cwd)
    console.log(`Initializing lma for '${project}' in ${cwd}`)
    if (existing) {
        console.log(`  kept      ${path.relative(cwd, existing)}`)
    } else {
        fs.writeFileSync(path.join(cwd, name), render('lma.js.tpl', vars))
        console.log(`  created   ${name}${name === 'lma.cjs' ? '  (.cjs: this project is "type": "module")' : ''}`)
    }

    secrets.ensure(cwd)
    console.log(`  created   ${paths.stateDir(cwd)}  (secrets, dumps, logs; outside the project)`)

    // --scripts adds an alias per command, --no-scripts none
    const wired = !args.includes('--no-scripts') &&
        addScripts(cwd, args.includes('--scripts') ? SCRIPTS : { lma: 'lma' })
    // npx may have run this from its own cache, and the bare name lma on npm is an unrelated package
    const installed = fs.existsSync(path.join(cwd, 'node_modules', '@selveq', 'medusa-scripts'))
    const run = wired ? 'npm run lma start' : installed ? 'npx lma start' : 'npx @selveq/medusa-scripts start'
    console.log(`\nThe admin login is generated when the stack first starts; lma admin prints it.`)
    if (wired && !installed) console.log('Next: npm i -D @selveq/medusa-scripts')
    console.log(`Next: edit ${existing ? path.basename(existing) : name}, then run: ${run}`)
}

const INIT_HELP = `lma init: in an empty folder, ask two names, install the latest Medusa and start it
         in an existing project, write the config and the 'lma' npm alias

  --backend <name>   name the backend without asking
  --store <name>     name the store without asking
  -y, --yes          start Docker without asking
  -n, --dry-run      say which of the two it would do, and do nothing
  --scripts          existing project: add an npm alias per command
  --no-scripts       existing project: add none`

const initCommand = (args) => {
    if (args.includes('--help') || args.includes('-h')) return console.log(INIT_HELP)
    const cwd = process.cwd()
    const fail = (e) => { console.error(`lma init: ${e.message}`); process.exit(1) }
    const parent = config.findRoot(cwd)
    if (parent && parent !== cwd) {
        return fail(new Error(`${parent} is already an lma project and this folder is inside it. lma commands work from here as they are; a separate project needs a folder outside it.`))
    }
    let installs
    try {
        installs = install.wanted(cwd, args)
    } catch (e) { return fail(e) }
    if (args.includes('-n') || args.includes('--dry-run')) {
        return console.log(installs
            ? '[dry-run] would start Docker if needed, ask for the names, install the latest Medusa here and start it'
            : `[dry-run] would write ${config.configName(cwd)} and the npm alias, and leave the rest of this folder alone`)
    }
    if (installs) return install.run(cwd, args, { addScripts, render }).catch(fail)
    const crowd = install.inTheWay(cwd)
    if (crowd.length && !config.configPath(cwd)) {
        console.log(`This folder is not empty (${crowd.slice(0, 3).join(', ')}), so lma only writes its config. A new Medusa project needs an empty folder.\n`)
    }
    return init(cwd, args)
}

// alias → engine command
const ALIAS = {
    'import-db': ['local.sh', 'db:import'],
    'dump-db': ['local.sh', 'db:dump'],
    'reset-db': ['local.sh', 'db:reset'],
    redis: ['local.sh', 'redis-cli'],
}

// lma runs from the project root, and a path or a command it is given belongs to where the user is
// npm run only ever moves up to a package root, so INIT_CWD counts when it lies below; any other script chose its own folder
const callerCwd = () => {
    const below = path.relative(process.cwd(), process.env.INIT_CWD || '')
    const movedUp = process.env.npm_lifecycle_event && process.env.INIT_CWD && !below.startsWith('..') && !path.isAbsolute(below)
    return movedUp ? process.env.INIT_CWD : process.cwd()
}

// the command itself, and not caffeinate around it: that would die at once and lose the command's exit code
const leaves = (pid) => {
    const { stdout } = spawnSync('pgrep', ['-P', String(pid)], { encoding: 'utf8' })
    const kids = (stdout || '').split('\n').filter(Boolean)
    return kids.length ? kids.flatMap(leaves) : [String(pid)]
}

const main = () => {
    const [cmd = 'help', ...args] = process.argv.slice(2)

    if (cmd === '--version' || cmd === '-v' || cmd === 'version') {
        const { name, version } = require('../package.json')
        return console.log(`${name} ${version} (node ${process.versions.node})`)
    }

    if (cmd === 'init') return initCommand(args)

    const isHelp = cmd === 'help' || cmd === '-h' || cmd === '--help'
    const root = config.findRoot(process.cwd())
    if (!root && !isHelp) {
        console.error(`No ${config.NAMES.join(' or ')} here or in any parent directory. Run 'lma init' in your project root first.`)
        process.exit(1)
    }

    if (cmd === 'ports') {
        const reset = args.includes('--reset')
        const dry = args.includes('-n') || args.includes('--dry-run')
        return require('../lib/ports.js')
            .resolve(root, { reset, frozen: !reset || dry })
            .then(({ ports, bases, cachePath }) => {
                if (args.includes('--json')) {
                    const moved = Object.keys(ports).filter((svc) => ports[svc] !== bases[svc])
                    return console.log(JSON.stringify({ ports, preferred: bases, moved, cache: cachePath }))
                }
                for (const [svc, p] of Object.entries(ports)) {
                    const moved = p !== bases[svc] ? `  (preferred ${bases[svc]} busy)` : ''
                    console.log(`  ${svc.padEnd(12)} ${p}${moved}`)
                }
                console.log(`\ncache: ${cachePath}`)
            })
            .catch((e) => { console.error(e.message); process.exit(1) })
    }

    let script, engineArgs
    if (cmd === 'tunnel') {
        script = 'tunnel.sh'
        engineArgs = args.length ? args : ['help']
    } else if (ALIAS[cmd]) {
        ;[script, ...engineArgs] = ALIAS[cmd]
        engineArgs = [...engineArgs, ...args]
    } else {
        script = 'local.sh'
        engineArgs = [cmd, ...args]
    }

    const env = { ...process.env, LMA_ASSETS: ASSETS, LMA_CALLER_CWD: callerCwd(), LMA_RUNNING: '1' }
    if (root) env.LMA_ROOT = root
    else delete env.LMA_ROOT

    const child = spawn('bash', [path.join(ASSETS, script), ...engineArgs], {
        stdio: 'inherit',
        cwd: root || process.cwd(),
        env,
    })
    // the terminal sends ctrl C to the whole group: lma stays to return how the command ended
    process.on('SIGINT', () => {})
    process.on('SIGTERM', () => {
        for (const pid of new Set([String(child.pid), ...leaves(child.pid)])) {
            try { process.kill(Number(pid), 'SIGTERM') } catch { /* already gone */ }
        }
    })
    child.on('error', (e) => { console.error(`lma: ${e.message}`); process.exit(1) })
    child.on('close', (code, signal) => process.exit(code ?? 128 + (os.constants.signals[signal] || 0)))
}

main()
