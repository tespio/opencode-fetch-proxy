#!/usr/bin/env node
// Set the proxy for an OpenCode provider.
//
//   opencode-fetch-proxy-set                 open a browser form (default)
//   opencode-fetch-proxy-set --gui            same
//   opencode-fetch-proxy-set <proxyURL>       set it from the command line
//   opencode-fetch-proxy-set --list           show what is configured
//   opencode-fetch-proxy-set --remove         clear it
//   opencode-fetch-proxy-set --provider <id> <proxyURL>
//   opencode-fetch-proxy-set --file           print the mapping file path
//
// WHY THIS EXISTS, and why /proxy cannot replace it:
//
// The /proxy slash command is a prompt template. Submitting it starts a model turn, and the tool
// that writes the mapping runs *inside* that turn -- after the model responds. So /proxy needs a
// working model in order to make a model work. When the only configured provider sits behind a
// proxy that is not yet configured, the turn cannot complete and nothing is ever written. That is
// a property of how slash commands execute, not a bug that can be fixed in a plugin.
//
// This writes the same file the tool writes, from outside the session, so the mapping exists
// before OpenCode's first provider request. Verified: with no `options.proxy` and this mapping
// present, the first request after startup routes through the proxy.
//
// Restart OpenCode afterwards. The plugin reads the mapping at startup; there is no config file
// watcher, so a running instance will not notice the change.

import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'

const NL = '\n'

function configDir() {
  if (process.env.OPENCODE_CONFIG_DIR) return process.env.OPENCODE_CONFIG_DIR
  if (process.env.XDG_CONFIG_HOME) return path.join(process.env.XDG_CONFIG_HOME, 'opencode')
  return path.join(os.homedir(), '.config', 'opencode')
}

const dir = configDir()
const mappingFile = path.join(dir, 'proxy-providers.json')

/** Strip comments so a commented-out setting is not read as live. Mirrors the plugin. */
function stripJsonComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')
}

function readConfig() {
  for (const name of ['opencode.jsonc', 'opencode.json']) {
    try {
      return JSON.parse(stripJsonComments(fs.readFileSync(path.join(dir, name), 'utf8')))
    } catch {
      /* try the next candidate */
    }
  }
  return null
}

function readMapping() {
  try {
    const parsed = JSON.parse(fs.readFileSync(mappingFile, 'utf8'))
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

function writeMapping(mapping) {
  fs.mkdirSync(path.dirname(mappingFile), { recursive: true })
  fs.writeFileSync(mappingFile, JSON.stringify(mapping, null, 2) + NL)
}

function isLoopback(host) {
  const h = String(host ?? '').toLowerCase()
  return h === 'localhost' || h === '::1' || h === '0.0.0.0' || h.endsWith('.localhost') || /^127\./.test(h)
}

/** Providers with a non-loopback baseURL -- the ones a proxy could be needed for. */
function proxyCandidates(cfg) {
  const providers = cfg?.provider
  if (!providers || typeof providers !== 'object') return []
  const out = []
  for (const [id, p] of Object.entries(providers)) {
    const base = p?.options?.baseURL || p?.settings?.baseURL || p?.api
    if (typeof base !== 'string' || !base.trim()) continue
    let host = ''
    try {
      host = new URL(base).hostname
    } catch {
      continue
    }
    if (isLoopback(host)) continue
    out.push({
      id,
      host,
      base,
      name: p?.name,
      declared: p?.options?.proxy || p?.settings?.proxy,
      models: Object.keys(p?.models ?? {}),
    })
  }
  return out
}

const redact = (u) => String(u).replace(/\/\/([^/@:]*):[^/@]*@/, '//$1:REDACTED@')

function checkProxyUrl(proxy) {
  let parsed
  try {
    parsed = new URL(proxy)
  } catch {
    return 'That is not a valid URL. Include the scheme and port, e.g. http://192.168.10.101:3128'
  }
  if (!/^https?:$/.test(parsed.protocol)) return 'The proxy URL must start with http:// or https://'
  if (/\\/.test(proxy)) {
    return 'The URL contains a backslash, which makes the parser drop the credentials. Percent-encode it: DOMAIN\\user -> DOMAIN%5Cuser'
  }
  return null
}

// ---------------------------------------------------------------------- args

const argv = process.argv.slice(2)
const flag = (n) => argv.includes(n)
const value = (n) => {
  const i = argv.indexOf(n)
  return i >= 0 ? argv[i + 1] : undefined
}
const positional = argv.filter((a, i) => !a.startsWith('--') && argv[i - 1] !== '--provider' && argv[i - 1] !== '--model')

if (flag('--file')) {
  console.log(mappingFile)
  process.exit(0)
}

const cfg = readConfig()
const candidates = proxyCandidates(cfg)
const mapping = readMapping()

if (flag('--list')) {
  console.log(`mapping file : ${mappingFile}`)
  const entries = Object.entries(mapping)
  console.log(entries.length ? 'configured   :' : 'configured   : nothing')
  for (const [id, entry] of entries) {
    const proxy = typeof entry === 'string' ? entry : entry?.proxy
    const model = typeof entry === 'object' ? entry?.model : undefined
    console.log(`  ${id} -> ${redact(proxy)}${model ? `   (${model})` : ''}`)
  }
  if (candidates.length) {
    console.log('providers    :')
    for (const c of candidates) console.log(`  ${c.id}  ${c.host}${c.declared ? '   [proxy declared in config]' : ''}`)
  }
  process.exit(0)
}

if (flag('--remove')) {
  const id = value('--provider') ?? (candidates.length === 1 ? candidates[0].id : undefined)
  if (!id) {
    console.error('Cannot tell which provider to remove. Pass --provider <id>.')
    process.exit(1)
  }
  if (!mapping[id]) {
    console.log(`No mapping for "${id}". Nothing to remove.`)
    process.exit(0)
  }
  delete mapping[id]
  writeMapping(mapping)
  console.log(`Removed the proxy mapping for "${id}".`)
  console.log('Restart OpenCode for it to take effect.')
  process.exit(0)
}

// ---------------------------------------------------------------------- set (CLI)

const proxy = positional[0]

if (proxy) {
  const problem = checkProxyUrl(proxy)
  if (problem) {
    console.error(problem)
    process.exit(1)
  }
  const id = value('--provider') ?? (candidates.length === 1 ? candidates[0].id : undefined)
  if (!id) {
    console.error('Cannot tell which provider you mean.')
    if (candidates.length) {
      console.error(`  Candidates: ${candidates.map((c) => c.id).join(', ')}`)
      console.error('  Pass --provider <id>, or run without arguments for the browser form.')
    } else {
      console.error('  No provider with a non-loopback baseURL was found in the config.')
    }
    process.exit(1)
  }
  const existing = mapping[id]
  const existingModel = typeof existing === 'object' ? existing?.model : undefined
  const model = value('--model') ?? existingModel ?? ''
  mapping[id] = { proxy, ...(model ? { model } : {}) }
  writeMapping(mapping)
  console.log(`Proxy for "${id}" set to ${redact(proxy)}`)
  console.log(`Written to ${mappingFile}`)
  if (candidates.find((c) => c.id === id)?.declared) {
    console.log('')
    console.log(`NOTE: provider "${id}" also declares options.proxy in opencode.jsonc, which takes`)
    console.log('precedence. This mapping will not be used until that key is removed.')
  }
  console.log('')
  console.log('Restart OpenCode for it to take effect.')
  process.exit(0)
}

// ---------------------------------------------------------------------- GUI

// No arguments: serve a small local form. This is the accessible path -- no flags to remember,
// nothing to type. It binds to loopback only and exits as soon as the form is submitted.

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])

function page(message = '', tone = 'info') {
  const rows = candidates.length
    ? candidates
        .map((c) => {
          const current = mapping[c.id]
          const currentProxy = typeof current === 'string' ? current : current?.proxy
          return `
        <label class="prov">
          <input type="radio" name="provider" value="${esc(c.id)}"${candidates.length === 1 ? ' checked' : ''}>
          <span class="body">
            <span class="id">${esc(c.id)}${c.name ? ` &middot; ${esc(c.name)}` : ''}</span>
            <span class="meta">${esc(c.base)}</span>
            <span class="meta">${c.models.length ? c.models.length + ' model(s)' : 'no models declared'}</span>
            ${currentProxy ? `<span class="on">proxy: ${esc(redact(currentProxy))}</span>` : ''}
            ${c.declared ? `<span class="warn">options.proxy is declared in opencode.jsonc, which overrides this</span>` : ''}
          </span>
        </label>`
        })
        .join('')
    : '<p class="empty">No provider with a non-loopback baseURL was found in your OpenCode config.</p>'

  return `<!doctype html>
<html><head><meta charset="utf-8"><title>OpenCode proxy</title>
<style>
  :root { color-scheme: dark light }
  body { font: 15px/1.5 system-ui, sans-serif; max-width: 640px; margin: 40px auto; padding: 0 20px }
  h1 { font-size: 20px; margin: 0 0 4px }
  p.sub { color: #888; margin: 0 0 24px }
  .prov { display: flex; gap: 12px; padding: 12px; border: 1px solid #8884; border-radius: 8px; margin-bottom: 8px; cursor: pointer }
  .prov:hover { border-color: #8888 }
  .body { display: flex; flex-direction: column; gap: 2px }
  .id { font-weight: 600 }
  .meta { color: #888; font-size: 13px; font-family: ui-monospace, monospace }
  .on { color: #2a9d3f; font-size: 13px; font-family: ui-monospace, monospace }
  .warn { color: #d08b00; font-size: 13px }
  input[type=text] { width: 100%; padding: 10px; font: inherit; font-family: ui-monospace, monospace; border: 1px solid #8886; border-radius: 6px; box-sizing: border-box }
  button { padding: 10px 18px; font: inherit; font-weight: 600; border: 0; border-radius: 6px; background: #2a6df4; color: #fff; cursor: pointer }
  button.ghost { background: transparent; color: #888; border: 1px solid #8886 }
  .row { display: flex; gap: 8px; align-items: center; margin-top: 16px }
  .msg { padding: 12px; border-radius: 6px; margin-bottom: 20px }
  .msg.ok { background: #2a9d3f22; border: 1px solid #2a9d3f66 }
  .msg.err { background: #e5484d22; border: 1px solid #e5484d66 }
  label.lbl { display: block; margin: 24px 0 6px; font-weight: 600 }
  code { background: #8882; padding: 2px 5px; border-radius: 4px }
  .note { color: #888; font-size: 13px; margin-top: 8px }
  details { margin-top: 28px } summary { cursor: pointer; color: #888 }
</style></head><body>
<h1>Proxy for one OpenCode provider</h1>
<p class="sub">Only the provider you pick is routed through the proxy. Everything else stays direct.</p>
${message ? `<div class="msg ${tone}">${message}</div>` : ''}
<form method="POST" action="/set">
  <label class="lbl">Provider</label>
  ${rows}
  <label class="lbl">Proxy URL</label>
  <input type="text" name="proxy" placeholder="http://192.168.10.101:3128" autofocus>
  <div class="note">Include the scheme and port. Credentials go in the URL:
    <code>http://user:pass@host:3128</code> &mdash; percent-encode <code>\\</code> as <code>%5C</code>.</div>
  <div class="row">
    <button type="submit">Save and close</button>
    <button type="submit" class="ghost" formaction="/remove" formnovalidate>Remove instead</button>
  </div>
</form>
<details>
  <summary>What this writes</summary>
  <p><code>${esc(mappingFile)}</code></p>
  <pre>${esc(JSON.stringify(mapping, null, 2))}</pre>
  <p class="note">Restart OpenCode afterwards. The mapping is read at startup and there is no config
  file watcher.</p>
</details>
</body></html>`
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = ''
    req.on('data', (c) => (data += c))
    req.on('end', () => resolve(new URLSearchParams(data)))
  })
}

let done = false
const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(page())
      return
    }

    const form = await readBody(req)

    if (req.url === '/remove') {
      const ids = Object.keys(mapping)
      if (!ids.length) {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        res.end(page('Nothing was configured, so there was nothing to remove.', 'info'))
        return
      }
      writeMapping({})
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(page(`Removed ${ids.length} mapping(s). <strong>Restart OpenCode.</strong>`, 'ok'))
      done = true
      setTimeout(() => server.close(() => process.exit(0)), 400)
      return
    }

    const id = form.get('provider')
    const proxy = (form.get('proxy') ?? '').trim()

    if (!id) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(page('Pick a provider first.', 'err'))
      return
    }
    const problem = checkProxyUrl(proxy)
    if (problem) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(page(esc(problem), 'err'))
      return
    }

    const existing = mapping[id]
    const model = typeof existing === 'object' ? existing?.model : undefined
    mapping[id] = { proxy, ...(model ? { model } : {}) }
    writeMapping(mapping)

    const declared = candidates.find((c) => c.id === id)?.declared
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(
      page(
        `Saved. <strong>${esc(id)}</strong> now routes through <code>${esc(redact(proxy))}</code>.` +
          (declared
            ? `<br><br>Heads up: this provider also declares <code>options.proxy</code> in opencode.jsonc, and that takes precedence &mdash; remove it or this will be ignored.`
            : '') +
          '<br><br><strong>Restart OpenCode</strong> for it to take effect.',
        'ok',
      ),
    )
    done = true
    setTimeout(() => server.close(() => process.exit(0)), 400)
  } catch (e) {
    res.writeHead(500, { 'content-type': 'text/plain' })
    res.end('Internal error: ' + e.message)
  }
})

server.listen(0, '127.0.0.1', () => {
  const { port } = server.address()
  const url = `http://127.0.0.1:${port}/`
  console.log('OpenCode proxy setup')
  console.log(`  config : ${dir}`)
  console.log(`  mapping: ${mappingFile}`)
  console.log(`  form   : ${url}`)
  console.log('')
  console.log('Opening in your browser. Close the browser tab or press Ctrl+C here when done.')
  openBrowser(url)
})

server.on('error', (e) => {
  console.error('Could not start the local form:', e.message)
  console.error('Use the command-line form instead:  opencode-fetch-proxy-set <proxyURL> --provider <id>')
  process.exit(1)
})

// Leave no process behind if the user closes the terminal.
process.on('SIGINT', () => server.close(() => process.exit(0)))

function openBrowser(url) {
  const cmd =
    process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]]
    : process.platform === 'darwin' ? ['open', [url]]
    : ['xdg-open', [url]]
  try {
    spawn(cmd[0], cmd[1], { detached: true, stdio: 'ignore' }).unref()
  } catch {
    console.log('Open this URL manually:', url)
  }
}
