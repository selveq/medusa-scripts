// state lives outside the project: the admin's dev server hands out almost any file inside it to whoever reaches the backend
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { slug } = require('./config.js')

const LEGACY = '.local-medusa-app'
const OLD_CACHE = path.join('node_modules', '.local-medusa-app-cache')

// the same folder always gets the same id, and with it the same state, containers and volumes
const pathId = (root) => {
    const s = path.resolve(root)
    let h = 5381
    for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0
    return h
}

const home = () => path.join(os.homedir(), LEGACY)
const stateDir = (root) => path.join(home(), `${slug(path.basename(path.resolve(root))) || 'app'}-${pathId(root)}`)

const move = (from, to) => {
    try {
        fs.renameSync(from, to)
    } catch (e) {
        if (e.code !== 'EXDEV') throw e
        fs.cpSync(from, to, { recursive: true })
        fs.rmSync(from, { recursive: true, force: true })
    }
}

const moveLegacy = (root, state) => {
    const legacy = path.join(path.resolve(root), LEGACY)
    if (legacy === home() || !fs.existsSync(legacy)) return
    if (fs.existsSync(state)) {
        console.error(`lma: ${legacy} is still in the project, where the admin's dev server can serve it. lma now uses ${state}: delete the old one`)
        return
    }
    fs.mkdirSync(home(), { recursive: true, mode: 0o700 })
    move(legacy, state)
    console.error(`lma: moved ${LEGACY}/ to ${state}, out of reach of the admin's dev server`)
}

// older versions kept the logs and the port map in the install cache, which the dev server serves as well; a server still writing to a log keeps its file through a rename
const moveOldCache = (root, state) => {
    const old = path.join(path.resolve(root), OLD_CACHE)
    if (!fs.existsSync(old)) return
    const logs = path.join(old, 'logs')
    if (fs.existsSync(logs)) {
        fs.mkdirSync(path.join(state, 'logs'), { recursive: true })
        for (const name of fs.readdirSync(logs)) {
            const target = path.join(state, 'logs', name)
            move(path.join(logs, name), fs.existsSync(target) ? `${target}.old` : target)
        }
    }
    const pins = path.join(old, 'ports.json')
    if (fs.existsSync(pins) && !fs.existsSync(path.join(state, 'ports.json'))) move(pins, path.join(state, 'ports.json'))
    fs.rmSync(old, { recursive: true, force: true })
    console.error(`lma: moved the old logs and port map to ${state}, out of reach of the admin's dev server`)
}

const ensure = (root) => {
    const state = stateDir(root)
    moveLegacy(root, state)
    fs.mkdirSync(state, { recursive: true, mode: 0o700 })
    // a moved folder keeps the mode it had in the project
    fs.chmodSync(state, 0o700)
    moveOldCache(root, state)
    return state
}

const sub = (root, ...parts) => path.join(stateDir(root), ...parts)

module.exports = { pathId, home, stateDir, ensure, sub }
