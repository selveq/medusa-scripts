// loads the project config for every reader; ESM projects must name it lma.cjs
const fs = require('node:fs')
const path = require('node:path')

const NAMES = ['lma.js', 'lma.cjs']

const findRoot = (from) => {
    let dir = path.resolve(from)
    for (;;) {
        if (NAMES.some((n) => fs.existsSync(path.join(dir, n)))) return dir
        const parent = path.dirname(dir)
        if (parent === dir) return null
        dir = parent
    }
}

// "type" from the nearest package.json at or above dir
const packageType = (dir) => {
    let d = path.resolve(dir)
    for (;;) {
        const p = path.join(d, 'package.json')
        if (fs.existsSync(p)) {
            try { return JSON.parse(fs.readFileSync(p, 'utf8')).type || 'commonjs' }
            catch { return 'commonjs' }
        }
        const parent = path.dirname(d)
        if (parent === d) return 'commonjs'
        d = parent
    }
}

// the filename `lma init` should write in dir
const configName = (dir) => (packageType(dir) === 'module' ? 'lma.cjs' : 'lma.js')

// prefer the extension matching the module type so a leftover lma.js cannot shadow lma.cjs
const configPath = (root) => {
    const preferred = configName(root)
    for (const n of [preferred, ...NAMES.filter((n) => n !== preferred)]) {
        const p = path.join(root, n)
        if (fs.existsSync(p)) return p
    }
    return null
}

const load = (root) => {
    const file = configPath(root)
    if (!file) throw new Error(`no ${NAMES.join(' or ')} in ${root}; run 'lma init' first`)
    if (file.endsWith('.js') && packageType(root) === 'module') {
        const target = `${file.slice(0, -3)}.cjs`
        // .cjs is absent when we get here; never suggest a mv that would overwrite
        throw new Error(
            `${file} is CommonJS but this project is "type": "module", so it cannot be loaded.\n` +
            (fs.existsSync(target)
                ? `Delete it; ${path.basename(target)} is the config in use.`
                : `Rename it to lma.cjs:  mv ${file} ${target}`)
        )
    }
    const cfg = require(file)
    if (!cfg || typeof cfg !== 'object' || Object.keys(cfg).length === 0) {
        throw new Error(`${file} exported no config; it must be CommonJS: module.exports = { ... }`)
    }
    return cfg
}

const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')

// the single project name used for containers, volumes and the DB; always slugged or compose splits the stack
const project = (root, cfg = {}) =>
    slug(cfg.project || '') || slug(path.basename(path.resolve(root))) || 'app'

// constructor: the name would read through to every object's own
const RESERVED = ['postgres', 'redis', 'http', 'proxy', 'constructor']

// why a name cannot be an app, or null: it is a folder, a package name and a word on the lma command line
const nameProblem = (name) => {
    if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(name)) return `'${name}' must be lowercase letters and digits, with single hyphens between them`
    if (RESERVED.includes(name)) return `'${name}' is taken: lma uses that name for a service`
    return null
}

// one backend and at most one store; the backend is the app marked role: 'backend', or the one called backend
const apps = (cfg = {}) => {
    const given = cfg.apps || {}
    const marked = Object.keys(given).filter((name) => (given[name] || {}).role === 'backend')
    if (marked.length > 1) throw new Error(`apps: ${marked.join(' and ')} are all marked role: 'backend'; a project has one backend`)
    const backend = marked[0] || 'backend'
    const fronts = Object.keys(given).filter((name) => name !== backend)
    // a config from before names existed may list more apps: only storefront was ever started as the store
    if (fronts.length > 1 && !fronts.includes('storefront')) {
        throw new Error(`apps: ${fronts.join(' and ')} would all be stores; a project has one store`)
    }
    const store = fronts.includes('storefront') ? 'storefront' : fronts[0] || 'storefront'
    for (const name of [backend, store]) {
        const problem = nameProblem(name)
        if (problem) throw new Error(`apps: ${problem}`)
    }
    const entry = (name, port) => {
        const app = given[name] || {}
        return { name, dir: app.dir || `apps/${name}`, port: Number(app.port) || port }
    }
    return { backend: entry(backend, 9000), store: entry(store, 8000) }
}

module.exports = { NAMES, findRoot, configPath, packageType, configName, load, slug, project, apps, nameProblem }
