#!/usr/bin/env node
// Set the proxy for an OpenCode provider, and check the model ids it serves.
//
//   opencode-fetch-proxy-set                 open a browser form (default)
//   opencode-fetch-proxy-set <proxyURL>      set it from the command line
//   opencode-fetch-proxy-set --list          show what is configured
//   opencode-fetch-proxy-set --models        ask the provider what model ids it serves
//   opencode-fetch-proxy-set --remove        clear it
//   opencode-fetch-proxy-set --provider <id> use a specific provider
//   opencode-fetch-proxy-set --file          print the mapping file path
//
// WHY THIS EXISTS, and why /proxy cannot replace it:
//
// The /proxy slash command is a prompt template. Submitting it starts a model turn, and the tool
// that writes the mapping runs *inside* that turn -- after the model responds. So /proxy needs a
// working model in order to make a model work. When the only configured provider sits behind a
// proxy that is not yet configured, the turn cannot complete and nothing is ever written.
//
// WHY IT CHECKS MODEL IDS:
//
// In opencode.jsonc the outer key under "provider" is a provider id you invent, and the inner key
// under "models" is a model id the server must actually serve. Both are plain strings and nothing
// validates the inner one when you write it. Name a provider "063" and it is easy to end up with
// "063" as the model key too -- and the failure only appears later, as
// "The model `063` does not exist". So this asks the provider for GET /v1/models and, when the
// declared key is not in that list, rewrites it.

import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import tls from 'node:tls'
import { spawn } from 'node:child_process'

// ---------------------------------------------------------------------------------------------
// This is a CLI tool, not a plugin. OpenCode imports every direct .js child of a plugin directory,
// so an earlier release that shipped this file into ~/.config/opencode/plugins/ had it executed as
// a plugin at every startup -- its top-level code opened the browser form. Refuse that role: if we
// were imported rather than run, do nothing at all.
//
// process.argv[1] is this file when run as a CLI, and the OpenCode server bundle when imported.
// ---------------------------------------------------------------------------------------------
const invokedAsScript = (() => {
  try {
    const entry = process.argv[1]
    if (!entry) return false
    const self = fileURLToPath(import.meta.url)
    const norm = (p) => path.resolve(p).replace(/\\/g, '/').toLowerCase()
    return norm(entry) === norm(self)
  } catch {
    return false
  }
})()

if (!invokedAsScript) {
  // Imported as a plugin. Export nothing and return before any CLI work happens.
  // (A plugin module with no usable export is skipped by the loader with a diagnostic, which is
  // the correct outcome -- this file was never meant to be one.)
} else {

  const NL = '\n'

  function configDir() {
    if (process.env.OPENCODE_CONFIG_DIR) return process.env.OPENCODE_CONFIG_DIR
    if (process.env.XDG_CONFIG_HOME) return path.join(process.env.XDG_CONFIG_HOME, 'opencode')
    return path.join(os.homedir(), '.config', 'opencode')
  }

  const dir = configDir()
  const mappingFile = path.join(dir, 'proxy-providers.json')
  const configFile = () =>
    ['opencode.jsonc', 'opencode.json'].map((n) => path.join(dir, n)).find((p) => fs.existsSync(p))

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
        modelKeys: Object.keys(p?.models ?? {}),
      })
    }
    return out
  }

  function providerEntry(id) {
    const providers = readConfig()?.provider
    return providers && typeof providers === 'object' ? providers[id] : undefined
  }

  const redact = (u) => String(u).replace(/\/\/([^/@:]*):[^/@]*@/, '//$1:REDACTED@')

  const esc = (s) =>
    String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])

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

  /** The API key OpenCode stores for a provider. Used only to ask what models it serves. */
  function authKeyFor(providerID) {
    const paths = [
      path.join(os.homedir(), '.local', 'share', 'opencode', 'auth.json'),
      path.join(dir, 'auth.json'),
    ]
    for (const file of paths) {
      try {
        const entry = JSON.parse(fs.readFileSync(file, 'utf8'))?.[providerID]
        const key = entry?.key || entry?.apiKey || entry?.access
        if (typeof key === 'string' && key.trim()) return key.trim()
      } catch {
        /* try the next candidate */
      }
    }
    return ''
  }

  // ---------------------------------------------------------------------- model ids

  /**
   * Asks an OpenAI-compatible endpoint for its model list, through the configured proxy when there
   * is one, since the endpoint may only be routable that way. Returns { ok, ids, error, via }.
   */

  /**
   * GET a URL through an HTTP proxy using a manual CONNECT tunnel.
   *
   * Why not undici's ProxyAgent: it is not reliably importable from an installed package directory,
   * and when the import fails the caller silently falls back to a direct request -- which for an
   * endpoint that is only routable through the proxy looks like a timeout, not a missing feature.
   * Only node:net and node:tls are used, so this always works.
   */
  function getThroughProxy(targetUrl, proxyUrl, headers) {
    return new Promise((resolve, reject) => {
      const target = new URL(targetUrl)
      const proxy = new URL(proxyUrl)
      const isTls = target.protocol === 'https:'
      const port = Number(target.port) || (isTls ? 443 : 80)

      const socket = net.connect({
        host: proxy.hostname,
        port: Number(proxy.port) || 80,
        timeout: 12000,
      })

      const fail = (e) => {
        socket.destroy()
        reject(e)
      }

      socket.on('timeout', () => fail(new Error('timed out')))
      socket.on('error', fail)

      socket.once('connect', () => {
        const auth = proxy.username
          ? 'Proxy-Authorization: Basic ' +
            Buffer.from(
              decodeURIComponent(proxy.username) + ':' + decodeURIComponent(proxy.password || ''),
            ).toString('base64') +
            '\r\n'
          : ''
        socket.write(
          'CONNECT ' + target.hostname + ':' + port + ' HTTP/1.1\r\n' +
            'Host: ' + target.hostname + ':' + port + '\r\n' +
            auth +
            '\r\n',
        )
      })

      let handshake = ''
      const onData = (chunk) => {
        handshake += chunk.toString('latin1')
        const end = handshake.indexOf('\r\n\r\n')
        if (end < 0) return
        socket.removeListener('data', onData)

        const status = Number((handshake.match(/^HTTP\/1\.[01] (\d{3})/) || [])[1] || 0)
        if (status !== 200) return fail(new Error('proxy refused CONNECT: HTTP ' + status))

        // Anything already read past the header belongs to the tunnel.
        const rest = Buffer.from(handshake.slice(end + 4), 'latin1')

        const carryOn = (stream) => {
          const head =
            'GET ' + target.pathname + (target.search || '') + ' HTTP/1.1\r\n' +
            'Host: ' + target.hostname + '\r\n' +
            Object.entries(headers || {})
              .map(([k, v]) => k + ': ' + v + '\r\n')
              .join('') +
            'Connection: close\r\n\r\n'
          stream.write(head)

          const parts = []
          if (rest.length) parts.push(rest)
          stream.on('data', (d) => parts.push(d))
          stream.on('end', () => {
            const raw = Buffer.concat(parts).toString('utf8')
            const split = raw.indexOf('\r\n\r\n')
            const head2 = split < 0 ? raw : raw.slice(0, split)
            const body = split < 0 ? '' : raw.slice(split + 4)
            resolve({ status: Number((head2.match(/^HTTP\/1\.[01] (\d{3})/) || [])[1] || 0), body })
          })
          stream.on('error', fail)
        }

        if (isTls) {
          const secure = tls.connect({ socket, servername: target.hostname }, () => carryOn(secure))
          secure.on('error', fail)
        } else {
          carryOn(socket)
        }
      }
      socket.on('data', onData)
    })
  }

  async function fetchModelIds(provider) {
    const entry = providerEntry(provider.id) ?? {}
    const base = entry?.options?.baseURL || entry?.settings?.baseURL || provider.base
    const key = authKeyFor(provider.id)
    const mapped = readMapping()[provider.id]
    const proxy = (typeof mapped === 'object' ? mapped?.proxy : mapped) || entry?.options?.proxy || ''
    const url = String(base).replace(/\/+$/, '') + '/models'

    const attempt = async (dispatcher) => {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 12000)
      try {
        const res = await fetch(url, {
          headers: key ? { authorization: 'Bearer ' + key } : {},
          signal: controller.signal,
          ...(dispatcher ? { dispatcher } : {}),
        })
        const body = await res.json().catch(() => null)
        const ids = (body?.data ?? body?.models ?? [])
          .map((m) => (typeof m === 'string' ? m : (m?.id ?? m?.name)))
          .filter((x) => typeof x === 'string' && x.trim())
        if (!res.ok) return { ok: false, ids: [], error: 'HTTP ' + res.status }
        return { ok: true, ids }
      } catch (e) {
        const reason = e?.name === 'AbortError' ? 'timed out' : e?.cause?.code || e?.message || 'failed'
        return { ok: false, ids: [], error: reason }
      } finally {
        clearTimeout(timer)
      }
    }

    if (proxy) {
      // Manual tunnel first: no dependency, and it cannot silently degrade to a direct request.
      try {
        const res = await getThroughProxy(url, proxy, key ? { authorization: 'Bearer ' + key } : {})
        if (res.status >= 200 && res.status < 300) {
          const body = JSON.parse(res.body)
          const ids = (body?.data ?? body?.models ?? [])
            .map((m) => (typeof m === 'string' ? m : (m?.id ?? m?.name)))
            .filter((x) => typeof x === 'string' && x.trim())
          return { ok: true, ids, via: 'via proxy ' + redact(proxy) }
        }
        return { ok: false, ids: [], error: 'HTTP ' + res.status, via: 'via proxy ' + redact(proxy) }
      } catch (e) {
        // A working proxy that refuses the target is worth reporting as such.
        if (!/undici/.test(String(e?.message))) {
          return { ok: false, ids: [], error: e?.message || 'tunnel failed', via: 'via proxy ' + redact(proxy) }
        }
      }
      try {
        const { ProxyAgent } = await import('undici')
        const r = await attempt(new ProxyAgent(proxy))
        return { ...r, via: 'via proxy ' + redact(proxy) }
      } catch {
        /* fall through to a direct attempt */
      }
    }
    const r = await attempt(null)
    return { ...r, via: proxy ? 'direct (proxy client unavailable)' : 'direct' }
  }

  /**
   * Rewrites the model key in opencode.jsonc when it is not in the provider's real list. Replaces
   * only the models block, so every other line and comment survives. Writes a .bak-modelkey backup.
   */
  function repairModelKey(providerID, realIds) {
    const file = configFile()
    if (!file || !realIds.length) return null

    const text = fs.readFileSync(file, 'utf8')
    let config
    try {
      config = JSON.parse(stripJsonComments(text))
    } catch {
      return null
    }
    const models = config?.provider?.[providerID]?.models
    if (!models || typeof models !== 'object') return null

    const declared = Object.keys(models)
    const wrong = declared.filter((k) => !realIds.includes(k))
    if (!wrong.length) return null

    const label = models[wrong[0]]?.name
    const rebuilt = {}
    realIds.forEach((id, i) => {
      rebuilt[id] = { name: i === 0 && label ? label : id }
    })

    const mi = text.indexOf('"models"')
    if (mi < 0) return null
    const open = text.indexOf('{', mi)
    if (open < 0) return null
    let depth = 0
    let close = -1
    for (let i = open; i < text.length; i++) {
      if (text[i] === '{') depth++
      else if (text[i] === '}') {
        depth--
        if (depth === 0) {
          close = i
          break
        }
      }
    }
    if (close < 0) return null

    const inner = text.slice(open, close)
    const indentMatch = inner.match(/\n(\s+)"/)
    const baseIndent = indentMatch ? indentMatch[1] : '        '
    const rendered = JSON.stringify(rebuilt, null, 2)
      .split('\n')
      .join('\n' + baseIndent.slice(0, Math.max(0, baseIndent.length - 2)))

    const next = text.slice(0, open) + rendered + text.slice(close + 1)
    const backup = file + '.bak-modelkey'
    fs.writeFileSync(backup, text)
    fs.writeFileSync(file, next)
    return { file, removed: wrong, added: realIds, backup }
  }

  async function describeModels(provider) {
    const found = await fetchModelIds(provider)
    if (!found.ok) {
      return {
        ok: false,
        text:
          'Could not read the model list for <strong>' + esc(provider.id) + '</strong> (' + esc(found.error) +
          ', ' + esc(found.via) + '). If the endpoint is only reachable through the proxy, set the proxy first and check again.',
      }
    }
    const declared = provider.modelKeys ?? []
    const wrong = declared.filter((k) => !found.ids.includes(k))
    const listed = found.ids.map((i) => '<code>' + esc(i) + '</code>').join(', ')

    if (wrong.length) {
      const repair = repairModelKey(provider.id, found.ids)
      if (repair) {
        return {
          ok: true,
          text:
            'Your config declared the model id ' + wrong.map((w) => '<code>' + esc(w) + '</code>').join(', ') +
            ', but <strong>' + esc(provider.id) + '</strong> serves ' + listed +
            '. <strong>Fixed</strong> &mdash; the model key was rewritten (backup: <code>' +
            esc(path.basename(repair.backup)) + '</code>). <strong>Applied on the next request.</strong>',
        }
      }
      return {
        ok: false,
        text: 'Declared model id ' + esc(wrong.join(', ')) + ' is not served. The server offers ' + listed + '.',
      }
    }
    if (!declared.length) {
      return {
        ok: true,
        text: '<strong>' + esc(provider.id) + '</strong> serves ' + listed + '. No model ids are declared in your config.',
      }
    }
    return { ok: true, text: 'Model ids look right. <strong>' + esc(provider.id) + '</strong> serves ' + listed + '.' }
  }


  /**
   * Entry point for the in-app /proxy command.
   *
   * The plugin writes a command whose template runs:
   *     echo <base64> | node <this file> proxy-cmd
   * The server expands that with the real shell BEFORE it calls the model, so this runs even when
   * the provider is unreachable and no turn can complete. Nothing user-supplied is on the command
   * line: the payload is base64, so there is no quoting to get wrong and no metacharacter to escape.
   *
   * Recognised input:
   *     <proxyURL>              set the proxy for the provider that needs one
   *     remove | off | clear    remove it
   *     list | show             print current state
   *     (anything else)         usage
   */
  function runProxyCommand(argvArgs) {
    let raw = ''
    try {
      raw = fs.readFileSync(0, 'utf8')
    } catch {
      /* no stdin */
    }

    // Arguments arrive either as argv (the generated /proxy command) or on stdin.
    //     !`node <this file> proxy-cmd $ARGUMENTS`
    // A base64 payload is also accepted, so the generated command can keep the command line free
    // of anything but shell-inert characters when that matters.
    let args = raw.trim()
    if (args && args.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(args)) {
      try {
        const decoded = Buffer.from(args, 'base64').toString('utf8').trim()
        if (decoded && /^[\x20-\x7e]+$/.test(decoded)) args = decoded
      } catch {
        /* keep the raw text */
      }
    }

    if (typeof argvArgs === 'string' && argvArgs.trim()) args = argvArgs.trim()

    // Diagnostics. The first version of this shipped a broken shell form -- a bare `echo` under
    // cmd.exe yields the literal "ECHO is on." -- and there was no way to see what arrived.
    // One line per invocation; the value is truncated.
    try {
      fs.appendFileSync(
        path.join(dir, 'proxy-command.log'),
        new Date().toISOString() +
          '  argv=' + JSON.stringify(String(argvArgs ?? '')) +
          '  stdin=' + JSON.stringify(String(raw ?? '').slice(0, 120)) +
          '  used=' + JSON.stringify(String(args).slice(0, 120)) +
          '\n',
      )
    } catch {
      /* logging must never break the command */
    }

    const cfg2 = readConfig()
    const cands = proxyCandidates(cfg2)
    const map = readMapping()

    /** The provider to configure: the only candidate, or the only one not already covered. */
    const chooseTarget = () => {
      if (cands.length === 1) return cands[0]
      const uncovered = cands.filter((c) => !map[c.id])
      if (uncovered.length === 1) return uncovered[0]
      return null
    }

    const target = chooseTarget()
    const who = target
      ? target.id + (target.name ? ' (' + target.name + ')' : '')
      : cands.length
        ? cands.map((c) => c.id).join(', ')
        : 'none found'

    const lower = args.toLowerCase()

    // no arguments: report state, which is itself useful
    if (!args) {
      const entries = Object.entries(map)
      const lines = []
      lines.push(entries.length ? 'Proxy configured:' : 'No proxy configured yet.')
      for (const [id, e] of entries) {
        lines.push('  ' + id + ' -> ' + redact(typeof e === 'string' ? e : e?.proxy))
      }
      if (!entries.length) {
        lines.push('')
        lines.push('Usage:  /proxy <proxyURL>      route ' + who + ' through a proxy')
        lines.push('        /proxy remove          undo it')
      }
      return lines.join('\n')
    }

    if (lower === 'remove' || lower === 'off' || lower === 'clear' || lower === 'none') {
      if (!target) {
        const ids = Object.keys(map)
        if (!ids.length) return 'Nothing is configured, so there is nothing to remove.'
        writeMapping({})
        return 'Removed the proxy for ' + ids.join(', ') + '. Applied on the next request.'
      }
      if (!map[target.id]) return 'No proxy is set for ' + who + ', so there is nothing to remove.'
      delete map[target.id]
      writeMapping(map)
      return 'Removed the proxy for ' + who + '. Applied on the next request.'
    }

    if (lower === 'list' || lower === 'show' || lower === 'status') {
      const entries = Object.entries(map)
      return entries.length
        ? 'Configured: ' + entries.map(([id, e]) => id + ' -> ' + redact(typeof e === 'string' ? e : e?.proxy)).join(', ')
        : 'Nothing configured. Providers: ' + who
    }

    const problem = checkProxyUrl(args)
    if (problem) return problem + '\n\nGot: ' + args

    if (!target) {
      return (
        'Cannot tell which provider you mean. Candidates: ' + who + '.' + '\n' +
        'Set one explicitly with:  opencode-fetch-proxy-set ' + args + ' --provider <id>'
      )
    }

    if (target.declared) {
      return (
        'Provider ' + who + ' already declares options.proxy in opencode.jsonc, and that takes' + '\n' +
        'precedence over anything written here. Remove that key first.'
      )
    }

    map[target.id] = { proxy: args }
    writeMapping(map)
    return (
      'Proxy set for ' + who + '.' + '\n' +
      '  ' + redact(args) + '\n' +
      '  written to ' + mappingFile + '\n' +
      'Applied on the next request - no restart needed.'
    )
  }

  // ---------------------------------------------------------------------- args

  const argv = process.argv.slice(2)
  const flag = (n) => argv.includes(n)
  const value = (n) => {
    const i = argv.indexOf(n)
    return i >= 0 ? argv[i + 1] : undefined
  }
  const positional = argv.filter(
    (a, i) => !a.startsWith('--') && argv[i - 1] !== '--provider' && argv[i - 1] !== '--model',
  )

  if (argv[0] === 'proxy-cmd') {
    console.log(runProxyCommand(argv.slice(1).join(' ')))
    process.exit(0)
  }

  if (flag('--file')) {
    console.log(mappingFile)
    process.exit(0)
  }

  const cfg = readConfig()
  const candidates = proxyCandidates(cfg)
  const mapping = readMapping()

  /** Resolve a target provider: explicit id, else the only candidate, else nothing. */
  function pickProvider(explicit) {
    if (explicit) {
      const known = candidates.find((c) => c.id === explicit)
      if (known) return known
      const entry = providerEntry(explicit) ?? {}
      return {
        id: explicit,
        base: entry?.options?.baseURL || entry?.settings?.baseURL || '',
        modelKeys: Object.keys(entry?.models ?? {}),
        declared: entry?.options?.proxy || entry?.settings?.proxy,
      }
    }
    return candidates.length === 1 ? candidates[0] : null
  }

  if (flag('--list')) {
    console.log('mapping file : ' + mappingFile)
    const entries = Object.entries(mapping)
    console.log(entries.length ? 'configured   :' : 'configured   : nothing')
    for (const [id, entry] of entries) {
      const proxyValue = typeof entry === 'string' ? entry : entry?.proxy
      const model = typeof entry === 'object' ? entry?.model : undefined
      console.log('  ' + id + ' -> ' + redact(proxyValue) + (model ? '   (' + model + ')' : ''))
    }
    if (candidates.length) {
      console.log('providers    :')
      for (const c of candidates) {
        console.log(
          '  ' + c.id + '  ' + c.host +
            (c.declared ? '   [proxy declared in config]' : '') +
            (c.modelKeys.length ? '   models: ' + c.modelKeys.join(', ') : '   [no model ids declared]'),
        )
      }
    }
    process.exit(0)
  }

  if (flag('--models')) {
    const target = pickProvider(value('--provider'))
    if (!target) {
      console.error('Cannot tell which provider you mean. Pass --provider <id>.')
      if (candidates.length) console.error('  Candidates: ' + candidates.map((c) => c.id).join(', '))
      process.exit(1)
    }
    const report = await describeModels(target)
    console.log(
      report.text
        .replace(/<[^>]+>/g, '')
        .replace(/&mdash;/g, '-')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'"),
    )
    process.exit(report.ok ? 0 : 1)
  }

  if (flag('--remove')) {
    const target = pickProvider(value('--provider'))
    if (!target) {
      console.error('Cannot tell which provider to remove. Pass --provider <id>.')
      process.exit(1)
    }
    if (!mapping[target.id]) {
      console.log('No mapping for "' + target.id + '". Nothing to remove.')
      process.exit(0)
    }
    delete mapping[target.id]
    writeMapping(mapping)
    console.log('Removed the proxy mapping for "' + target.id + '".')
    console.log('Applied on the next request - no restart needed.')
    process.exit(0)
  }

  // ---------------------------------------------------------------------- set (CLI)

  const proxyArg = positional[0]

  if (proxyArg) {
    const problem = checkProxyUrl(proxyArg)
    if (problem) {
      console.error(problem)
      process.exit(1)
    }
    const target = pickProvider(value('--provider'))
    if (!target) {
      console.error('Cannot tell which provider you mean.')
      if (candidates.length) {
        console.error('  Candidates: ' + candidates.map((c) => c.id).join(', '))
        console.error('  Pass --provider <id>, or run without arguments for the browser form.')
      } else {
        console.error('  No provider with a non-loopback baseURL was found in the config.')
      }
      process.exit(1)
    }
    const existing = mapping[target.id]
    const existingModel = typeof existing === 'object' ? existing?.model : undefined
    const model = value('--model') ?? existingModel ?? ''
    mapping[target.id] = { proxy: proxyArg, ...(model ? { model } : {}) }
    writeMapping(mapping)
    console.log('Proxy for "' + target.id + '" set to ' + redact(proxyArg))
    console.log('Written to ' + mappingFile)
    if (target.declared) {
      console.log('')
      console.log('NOTE: provider "' + target.id + '" also declares options.proxy in opencode.jsonc, which takes')
      console.log('precedence. This mapping will not be used until that key is removed.')
    }
    console.log('')
    console.log('Applied on the next request - no restart needed.')
    process.exit(0)
  }

  // ---------------------------------------------------------------------- GUI

  function page(message = '', tone = 'info', modelReport = null) {
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
              <span class="meta">${
                c.modelKeys.length ? 'model id: ' + esc(c.modelKeys.join(', ')) : 'no model ids declared'
              }</span>
              ${currentProxy ? `<span class="on">proxy: ${esc(redact(currentProxy))}</span>` : ''}
              ${
                c.declared
                  ? `<span class="warn">options.proxy is declared in opencode.jsonc, which overrides this</span>`
                  : ''
              }
            </span>
          </label>`
          })
          .join('')
      : '<p class="empty">No provider with a non-loopback baseURL was found in your OpenCode config.</p>'

    return `<!doctype html>
  <html><head><meta charset="utf-8"><title>OpenCode proxy</title>
  <style>
    :root { color-scheme: dark light }
    body { font: 15px/1.5 system-ui, sans-serif; max-width: 660px; margin: 40px auto; padding: 0 20px }
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
    button { padding: 10px 16px; font: inherit; font-weight: 600; border: 0; border-radius: 6px; background: #2a6df4; color: #fff; cursor: pointer }
    button.ghost { background: transparent; color: #888; border: 1px solid #8886 }
    .row { display: flex; gap: 8px; align-items: center; margin-top: 16px; flex-wrap: wrap }
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
  ${modelReport ? `<div class="msg ${modelReport.ok ? 'ok' : 'err'}">${modelReport.text}</div>` : ''}
  <form method="POST" action="/set">
    <label class="lbl">Provider</label>
    ${rows}
    <label class="lbl">Proxy URL</label>
    <input type="text" name="proxy" placeholder="http://192.168.10.101:3128" autofocus>
    <div class="note">Include the scheme and port. Credentials go in the URL:
      <code>http://user:pass@host:3128</code> &mdash; percent-encode <code>\\</code> as <code>%5C</code>.</div>
    <div class="row">
      <button type="submit">Save and close</button>
      <button type="submit" class="ghost" formaction="/models" formnovalidate>Check model ids</button>
      <button type="submit" class="ghost" formaction="/remove" formnovalidate>Remove instead</button>
    </div>
  </form>
  <details>
    <summary>What this writes</summary>
    <p><code>${esc(mappingFile)}</code></p>
    <pre>${esc(JSON.stringify(mapping, null, 2))}</pre>
    <p class="note">Applied on the next request. The plugin re-reads the mapping whenever OpenCode reloads its config, which happens during a session - no restart needed.</p>
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

  const server = http.createServer(async (req, res) => {
    const html = (body) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(body)
    }
    try {
      if (req.method === 'GET') return html(page())

      const form = await readBody(req)

      if (req.url === '/models') {
        const target = pickProvider(form.get('provider'))
        if (!target) return html(page('Pick a provider first.', 'err'))
        return html(page('', 'info', await describeModels(target)))
      }

      if (req.url === '/remove') {
        const ids = Object.keys(mapping)
        if (!ids.length) return html(page('Nothing was configured, so there was nothing to remove.'))
        writeMapping({})
        html(page('Removed ' + ids.length + ' mapping(s). <strong>Applied on the next request.</strong>', 'ok'))
        setTimeout(() => server.close(() => process.exit(0)), 400)
        return
      }

      const target = pickProvider(form.get('provider'))
      if (!target) return html(page('Pick a provider first.', 'err'))

      const entered = (form.get('proxy') ?? '').trim()
      const problem = checkProxyUrl(entered)
      if (problem) return html(page(esc(problem), 'err'))

      const existing = mapping[target.id]
      const model = typeof existing === 'object' ? existing?.model : undefined
      mapping[target.id] = { proxy: entered, ...(model ? { model } : {}) }
      writeMapping(mapping)

      html(
        page(
          'Saved. <strong>' + esc(target.id) + '</strong> now routes through <code>' + esc(redact(entered)) + '</code>.' +
            (target.declared
              ? '<br><br>Heads up: this provider also declares <code>options.proxy</code> in opencode.jsonc, and that takes precedence &mdash; remove it or this will be ignored.'
              : '') +
            '<br><br><strong>Applied on the next request.</strong>',
          'ok',
        ),
      )
      setTimeout(() => server.close(() => process.exit(0)), 400)
    } catch (e) {
      res.writeHead(500, { 'content-type': 'text/plain' })
      res.end('Internal error: ' + e.message)
    }
  })

  server.listen(0, '127.0.0.1', () => {
    const { port } = server.address()
    const url = 'http://127.0.0.1:' + port + '/'
    console.log('OpenCode proxy setup')
    console.log('  config : ' + dir)
    console.log('  mapping: ' + mappingFile)
    console.log('  form   : ' + url)
    console.log('')
    console.log('Opening in your browser. Close the tab or press Ctrl+C here when done.')
    openBrowser(url)
  })

  server.on('error', (e) => {
    console.error('Could not start the local form: ' + e.message)
    console.error('Use the command line instead:  opencode-fetch-proxy-set <proxyURL> --provider <id>')
    process.exit(1)
  })

  process.on('SIGINT', () => server.close(() => process.exit(0)))

  function openBrowser(url) {
    const cmd =
      process.platform === 'win32'
        ? ['cmd', ['/c', 'start', '', url]]
        : process.platform === 'darwin'
          ? ['open', [url]]
          : ['xdg-open', [url]]
    try {
      spawn(cmd[0], cmd[1], { detached: true, stdio: 'ignore' }).unref()
    } catch {
      console.log('Open this URL manually: ' + url)
    }
  }

}
