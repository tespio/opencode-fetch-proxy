#!/usr/bin/env node
// Set or remove the proxy for one OpenCode provider, from the command line.
//
//   opencode-fetch-proxy-set http://192.168.10.101:3128
//   opencode-fetch-proxy-set http://192.168.10.101:3128 --provider 063
//   opencode-fetch-proxy-set --remove
//   opencode-fetch-proxy-set --list
//   opencode-fetch-proxy-set --file          print the mapping file path
//
// WHY THIS EXISTS, and why /proxy cannot replace it:
//
// The /proxy slash command is a prompt template. Submitting it starts a model turn, and the tool
// that writes the mapping runs *inside* that turn -- after the model responds. So /proxy needs a
// working model in order to make a model work. When the only configured provider sits behind a
// proxy that is not yet configured, the turn cannot complete and nothing is ever written. That is
// a property of how slash commands execute, not a bug that can be fixed in the plugin.
//
// This script writes the same file the tool writes, from outside the session, so the mapping
// exists before OpenCode's first provider request. Verified: with no `options.proxy` and this
// mapping present, the first request after startup routes through the proxy.
//
// Restart OpenCode after running it. The plugin reads the mapping at startup; there is no config
// file watcher, so a running instance will not notice the change.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

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
  return (
    h === 'localhost' ||
    h === '::1' ||
    h === '0.0.0.0' ||
    h.endsWith('.localhost') ||
    /^127\./.test(h)
  )
}

/** Providers with a baseURL that is not loopback -- the ones a proxy could be needed for. */
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
    out.push({ id, host, base, declared: p?.options?.proxy || p?.settings?.proxy })
  }
  return out
}

// ---------------------------------------------------------------------- args

const argv = process.argv.slice(2)
const flag = (n) => argv.includes(n)
const value = (n) => {
  const i = argv.indexOf(n)
  return i >= 0 ? argv[i + 1] : undefined
}
const positional = argv.filter((a, i) => !a.startsWith('--') && argv[i - 1] !== '--provider' && argv[i - 1] !== '--model')

if (flag('--help') || flag('-h')) {
  console.log(fs.readFileSync(new URL(import.meta.url), 'utf8').split(NL).slice(1, 22).join(NL).replace(/^\/\/ ?/gm, ''))
  process.exit(0)
}

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
    console.log(`  ${id} -> ${proxy}${model ? `   (${model})` : ''}`)
  }
  if (candidates.length) {
    console.log('providers    :')
    for (const c of candidates) {
      console.log(`  ${c.id}  ${c.host}${c.declared ? '   [proxy declared in config]' : ''}`)
    }
  }
  process.exit(0)
}

// ---------------------------------------------------------------------- remove

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

// ---------------------------------------------------------------------- set

const proxy = positional[0]
if (!proxy) {
  console.error('Usage: opencode-fetch-proxy-set <proxyURL> [--provider <id>] [--model <name>]')
  console.error('       opencode-fetch-proxy-set --remove [--provider <id>]')
  console.error('       opencode-fetch-proxy-set --list')
  const shown = candidates.length ? candidates.map((c) => c.id).join(', ') : 'none found'
  console.error(`${NL}Providers a proxy could apply to: ${shown}`)
  process.exit(1)
}

let parsed
try {
  parsed = new URL(proxy)
  if (!/^https?:$/.test(parsed.protocol)) throw new Error('proxy URL must be http:// or https://')
} catch (e) {
  console.error(`Not a usable proxy URL: ${proxy}`)
  console.error(`  ${e.message}`)
  process.exit(1)
}

// Percent-encoding check, mirroring the plugin: an unencoded backslash (DOMAIN\user) parses as a
// URL but silently drops the credentials, producing a confusing 407 later.
if (/[\\]/.test(proxy)) {
  console.error('The proxy URL contains a backslash, which makes the parser drop the credentials.')
  console.error('Percent-encode it: DOMAIN\\user -> DOMAIN%5Cuser')
  process.exit(1)
}

const id = value('--provider') ?? (candidates.length === 1 ? candidates[0].id : undefined)
if (!id) {
  console.error('Cannot tell which provider you mean.')
  if (candidates.length) {
    console.error(`  Candidates: ${candidates.map((c) => c.id).join(', ')}`)
    console.error('  Pass --provider <id>, or configure the mapping by hand.')
  } else {
    console.error('  No provider with a non-loopback baseURL was found in the config.')
  }
  process.exit(1)
}

if (!candidates.some((c) => c.id === id)) {
  console.error(`Warning: "${id}" is not a provider with a non-loopback baseURL in the config.`)
  console.error('  Writing the mapping anyway.')
}

// Same shape the /proxy tool writes, so the two cannot disagree.
const existing = mapping[id]
const existingModel = typeof existing === 'object' ? existing?.model : undefined
const model = value('--model') ?? existingModel ?? ''
mapping[id] = { proxy, ...(model ? { model } : {}) }
writeMapping(mapping)

const redacted = proxy.replace(/\/\/([^/@:]*):[^/@]*@/, '//$1:REDACTED@')
console.log(`Proxy for "${id}" set to ${redacted}`)
console.log(`Written to ${mappingFile}`)
if (candidates.find((c) => c.id === id)?.declared) {
  console.log('')
  console.log(`NOTE: provider "${id}" also declares options.proxy in opencode.jsonc.`)
  console.log('That declaration takes precedence over this mapping, so this value will not be used')
  console.log('until the declared key is removed.')
}
console.log('')
console.log('Restart OpenCode. The mapping is read at startup and has no file watcher, and the')
console.log('proxy then applies from the very first provider request.')
