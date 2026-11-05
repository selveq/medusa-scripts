// KEY=value reader, matching dotenv on quotes and trailing comments
const fs = require('node:fs')

// a value is quoted whole, or runs up to the first #
const LINE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*('[^']*'|"[^"]*"|`[^`]*`|[^#]*?)\s*(?:#.*)?$/

const parse = (text) => {
    const out = {}
    for (const line of String(text).split(/\r?\n/)) {
        const m = line.match(LINE)
        if (!m) continue
        const quoted = m[2].match(/^(['"`])([\s\S]*)\1$/)
        out[m[1]] = quoted ? quoted[2] : m[2]
    }
    return out
}

const read = (file) => {
    try { return parse(fs.readFileSync(file, 'utf8')) } catch { return {} }
}

// sets each key where it stands and appends the rest; every other line is untouched
const write = (file, values) => {
    let text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : ''
    for (const [key, value] of Object.entries(values)) {
        const line = `${key}=${value}`
        const existing = new RegExp(`^${key}=.*$`, 'm')
        if (existing.test(text)) text = text.replace(existing, () => line)
        else text += `${text && !text.endsWith('\n') ? '\n' : ''}${line}\n`
    }
    fs.writeFileSync(file, text)
}

module.exports = { parse, read, write }
