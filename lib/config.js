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

// one backend, the app called backend whatever its folder is, and any number of stores: every other key under apps, in config order
const apps = (cfg = {}) => {
    if (cfg.apps !== undefined && (!cfg.apps || typeof cfg.apps !== 'object' || Array.isArray(cfg.apps))) {
        throw new Error('apps must be an object with one key per app')
    }
    const given = Object.keys(cfg.apps || {}).length ? cfg.apps : { backend: {}, storefront: {} }
    const entry = (name, role, app) => ({ name, role, dir: app.dir || `apps/${name}`, ...(Number(app.port) ? { port: Number(app.port) } : {}) })
    const stores = []
    for (const [name, app] of Object.entries(given)) {
        if ((app || {}).role) throw new Error(`apps: ${name} has a role, and role is no longer read: the backend is the app called backend, with its folder in dir`)
        if (name === 'backend') continue
        const problem = nameProblem(name)
        if (problem) throw new Error(`apps: ${problem}`)
        stores.push(entry(name, 'store', app || {}))
    }
    // the store the proxy sends / to
    const main = (cfg.proxy || {}).store
    if (main && !stores.some((store) => store.name === main)) {
        throw new Error(`proxy.store: no store called '${main}'; this project has: ${stores.map((store) => store.name).join(', ') || 'none'}`)
    }
    return { backend: entry('backend', 'backend', given.backend || {}), stores, main: main || (stores[0] || {}).name || '' }
}

module.exports = { NAMES, findRoot, configPath, packageType, configName, load, slug, project, apps, nameProblem }
