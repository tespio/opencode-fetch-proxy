/**
 * opencode-fetch-proxy
 * ----------------------------------------------------------------------------
 * Route OpenCode provider traffic through an HTTP proxy, for one provider or a
 * list of target hosts. Built for the corporate shape where the VPN proxy is the
 * only route to a model server on the LAN, while the public internet is reachable
 * normally -- without changing the system proxy.
 *
 * Verified against @opencode-ai/plugin 1.18.25 / 1.19.0 (V1 plugin API) and the
 * OpenCode 1.19 desktop sidecar, which runs on Node (not Bun).
 *
 * WHY THIS PATCHES fetch:
 * the V1 plugin API exposes only: config, provider, auth, event, tool, dispose,
 * chat.message, chat.params, chat.headers, permission.ask, tool.execute.* and
 * experimental.*. No hook can attach a proxy to a provider request, and provider
 * `options` is the only schema-legal place for extra per-provider settings
 * (ProviderConfig is additionalProperties:false; options is an open record).
 * So this wraps the runtime `fetch` the AI SDK providers fall back to.
 *
 * HOW A PROXY IS CHOSEN FOR A URL (first match wins):
 *   1. options.proxy / settings.proxy  declared on that provider
 *   2. proxy-providers.json            written by the /proxy command
 *   3. proxy.json `proxy`              only for `targets`, or for every provider
 *                                      when routeAllProviders is enabled
 * Loopback is never proxied, unconditionally.
 */

import fs from "node:fs"
import net from "node:net"
import tls from "node:tls"
import os from "node:os"
import path from "node:path"
import { Readable } from "node:stream"
import { fileURLToPath } from "node:url"

const MARKER = Symbol.for("opencode.fetch.proxy.installed")

// Newline constant: keeps the message strings readable without escape soup.
const NL = String.fromCharCode(10)

/* ------------------------------------------------------------------ config */

/**
 * OpenCode resolves its global config directory to ~/.config/opencode on every
 * platform, including Windows (confirmed from its own startup log). It does not
 * use %APPDATA%\opencode.
 */
function configDir() {
  if (process.env.OPENCODE_CONFIG_DIR) return process.env.OPENCODE_CONFIG_DIR
  const xdg = process.env.XDG_CONFIG_HOME
  if (xdg) return path.join(xdg, "opencode")
  return path.join(os.homedir(), ".config", "opencode")
}

function str(v) {
  return typeof v === "string" && v.trim() ? v.trim() : ""
}

function loadFileConfig() {
  const file = path.join(configDir(), "proxy.json")
  let fromFile = {}
  try {
    fromFile = JSON.parse(fs.readFileSync(file, "utf8"))
  } catch (err) {
    if (err && err.code !== "ENOENT") console.error("[fetch-proxy] bad proxy.json:", err.message)
  }
  const rawTargets = fromFile.targets ?? []
  return {
    proxy: str(fromFile.proxy),
    targets: (Array.isArray(rawTargets) ? rawTargets : [rawTargets]).map(str).filter(Boolean),
    // OFF by default. Routing every provider through one proxy is wrong when only one
    // destination sits behind it: unrelated providers would depend on that proxy and
    // their traffic would go somewhere it need not go.
    routeAllProviders:
      process.env.OPENCODE_PROXY_ALL === "1" || fromFile.routeAllProviders === true,
    log: fromFile.log === true,
    file,
  }
}

/**
 * Slash commands are NOT registrable from a plugin in this build -- the command list is
 * built from the `command` config map, markdown files, MCP prompts and skills only, and
 * the `source` union has no "plugin" member. The supported way to ship one is a markdown
 * file under <config>/command/, so the plugin writes and maintains one.
 *
 * Discovered from markdown files in command/ and commands/ under ~/.config/opencode,
 * ~/.opencode, and every .opencode up to the worktree root. Frontmatter keys:
 * description, agent, model, variant, subtask. The body is the template; $ARGUMENTS is
 */
function commandFilePath() {
  return path.join(configDir(), "command", "proxy.md")
}

/**
 * Where set-proxy.js lives, if it shipped alongside this file. Bundling it is what lets the
 * /proxy command do real work without a model turn, so its absence matters and is reported.
 */
function helperScriptPath() {
  try {
    const here = path.dirname(fileURLToPath(import.meta.url))
    // lib/ first. The discovery glob is {plugin,plugins}/*.{ts,js} -- a single path segment,
    // never a directory -- so a subdirectory is never imported as a plugin. Shipping the helper
    // as a direct sibling put it INSIDE that glob, and OpenCode imported it at every startup: it
    // has no exports, so its CLI top level ran and opened the browser form on each launch.
    const candidates = [path.join(here, "lib", "set-proxy.js"), path.join(here, "set-proxy.js")]
    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) return candidate
    }
    return ""
  } catch {
    return ""
  }
}

/**
 * The /proxy command, as a SHELL-BACKED command rather than a prompt template.
 *
 * Why this shape: a slash command whose body is a prompt still needs a model turn to run its
 * tool, so it cannot configure the only provider -- that provider is unreachable until
 * configured. But the server expands `!`...`` in a command template with a real shell BEFORE it
 * calls the model (SessionPrompt.command: shellMatches -> prompt()). So a command can have a
 * side effect with no turn at all. That is the whole trick.
 *
 * Nothing the user types reaches the command line: the only variable text is a base64 payload,
 * and base64 cannot contain a shell metacharacter or require quoting. decode happens in the
 * script, which reads stdin.
 *
 * Falls back to the prompt-template form when set-proxy.js is not beside this file, so a
 * single-file install still behaves as before instead of breaking.
 */
function proxyCommandBody() {
  const helper = helperScriptPath()
  if (!helper) return PROMPT_TEMPLATE_BODY
  const NLc = String.fromCharCode(10)
  // Forward slashes, not JSON.stringify's backslashes: this string is handed to a real shell,
  // and a Windows path in backslashes loses them to escape processing ("C:\U..." -> "C:U...").
  //
  // $ARGUMENTS is passed as a command-line argument, NOT piped through echo: cmd.exe answers a
  // bare `echo` with the literal text "ECHO is on.", so an argument-less /proxy would push that
  // down the pipe. argv has no such failure mode and keeps a single code path.
  const quoted = '"' + helper.replace(/\\/g, "/") + '"'
  return [
    "---",
    "description: Set or remove the HTTP proxy for one provider (works with no reachable model)",
    "---",
    "!`node " + quoted + " proxy-cmd $ARGUMENTS`",
    "",
    "Report the result above, then stop.",
  ].join(NLc)
}

/** The original prompt-template form, used only when set-proxy.js is unavailable. */
const PROMPT_TEMPLATE_BODY = [
  "---",
  "description: Set or remove the HTTP proxy for one provider",
  "---",
  "Run set_proxy once with these arguments, then reply with its output and nothing else: $ARGUMENTS",
].join(String.fromCharCode(10))

const PROXY_COMMAND_BODY = PROMPT_TEMPLATE_BODY

// Kept short on purpose: this template is shown in the transcript, so a verbose one
// produces a wall of text on every use. Guidance belongs in the tool description.

/** Writes the command file if absent or out of date. Never throws. */
function ensureProxyCommandFile() {
  const file = commandFilePath()
  const want = proxyCommandBody()
  try {
    let existing = ""
    try {
      existing = fs.readFileSync(file, "utf8")
    } catch {
      /* not there yet */
    }
    if (existing.trim() === want.trim()) return { file, action: "unchanged" }
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, want + "\n", "utf8")
    return { file, action: existing ? "updated" : "created" }
  } catch (err) {
    return { file, action: "failed", error: String(err && err.message ? err.message : err) }
  }
}

/**
 * Reads an `options.proxy` declaration out of opencode.jsonc, if any, so the tool can
 * report a proxy it does not own. Deliberately tolerant: this only needs to find a string,
 * not to parse JSONC properly, and any failure returns an empty string.
 */
/**
 * The single non-loopback provider declared in the config, or "" when there is not exactly
 * one. Used so /proxy works on the first try in a fresh session, where the selected provider
 * is not yet known but is also not in question.
 */
function soleProviderID() {
  const dir = configDir()
  for (const name of ["opencode.jsonc", "opencode.json"]) {
    try {
      const text = fs.readFileSync(path.join(dir, name), "utf8")
      const stripped = text
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^[ \t]*\/\/.*$/gm, "")
      const parsed = JSON.parse(stripped)
      const providers = parsed && parsed.provider
      if (!providers || typeof providers !== "object") continue
      const usable = []
      for (const [id, p] of Object.entries(providers)) {
        const base = str(p?.options?.baseURL) || str(p?.settings?.baseURL) || str(p?.api)
        if (!base) continue
        let host = ""
        try {
          host = new URL(base).hostname.toLowerCase()
        } catch {
          // An unparseable baseURL disqualifies this candidate but must not abort the scan.
          continue
        }
        if (isLoopback(host)) continue
        usable.push(id)
      }

      if (usable.length === 1) return usable[0]
      return ""
    } catch {
      /* not strict JSON, or unreadable: give up rather than guess */
    }
  }
  return ""
}

/**
 * Display name of the first model on a provider, from config. Used only to label output when
 * the session has not supplied a name yet.
 */
function soleProviderModel(id) {
  const dir = configDir()
  for (const name of ["opencode.jsonc", "opencode.json"]) {
    try {
      const text = fs.readFileSync(path.join(dir, name), "utf8")
      const stripped = text
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^[ \t]*\/\/.*$/gm, "")
      const p = JSON.parse(stripped)?.provider?.[id]
      const models = p?.models
      if (!models || typeof models !== "object") return ""
      const first = Object.values(models)[0]
      return str(first?.name) || str(Object.keys(models)[0])
    } catch {
      /* try the next candidate */
    }
  }
  return ""
}

function readDeclaredProxy() {
  const dir = configDir()
  for (const name of ["opencode.jsonc", "opencode.json"]) {
    try {
      const text = fs.readFileSync(path.join(dir, name), "utf8")
      // Strip comments so a commented-out proxy is not mistaken for a live one.
      const stripped = text
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^[ \t]*\/\/.*$/gm, "")
      const m = /"proxy"\s*:\s*"([^"]+)"/.exec(stripped)
      if (m && m[1]) return m[1]
    } catch {
      /* try the next candidate */
    }
  }
  return ""
}

function proxyProvidersPath() {
  return path.join(configDir(), "proxy-providers.json")
}

/**
 * Mapping entries are { proxy, model } so the file stays readable by a human. A bare
 * string is still accepted, so files written by an earlier version keep working.
 */
function mappingProxy(entry) {
  if (typeof entry === "string") return str(entry)
  return entry && typeof entry === "object" ? str(entry.proxy) : ""
}

function mappingModel(entry) {
  return entry && typeof entry === "object" ? str(entry.model) : ""
}

function readProxyProviders(file) {
  let raw
  try {
    raw = fs.readFileSync(file, "utf8")
  } catch (err) {
    if (err && err.code !== "ENOENT") {
      console.error("[fetch-proxy] cannot read proxy-providers.json:", err.message)
    }
    return {}
  }
  try {
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {}
    const out = {}
    for (const [k, v] of Object.entries(parsed)) {
      const value = mappingProxy(v)
      if (value) out[k] = v
    }
    return out
  } catch (err) {
    console.error("[fetch-proxy] bad proxy-providers.json:", err.message)
    return {}
  }
}

function writeProxyProviders(file, mapping) {
  fs.writeFileSync(file, JSON.stringify(mapping, null, 2) + "\n", "utf8")
}


/**
 * A backslash in the authority (e.g. DOMAIN\user) makes WHATWG URL parsing drop the
 * credentials entirely, so the proxy would be contacted unauthenticated and fail with a
 * confusing 407. Detect it and tell the user how to fix it instead of letting it fail.
 */
function malformedCredentials(proxy) {
  const m = /^([a-z][a-z0-9+.-]*:\/\/)([^/?#]*)$/i.exec(str(proxy))
  if (!m) return false
  const authority = m[2]
  if (!authority.includes("@")) return false
  // Strip the real userinfo, then look for leftovers that mean it was not parsed.
  try {
    const u = new URL(proxy)
    return !u.username && !u.password && authority.includes(":")
  } catch {
    return true
  }
}

/** The effective port for a URL, so "host" and "host:port" are comparable. */
function hostPortOf(url) {
  const u = new URL(url)
  const port = u.port ? Number(u.port) : u.protocol === "https:" ? 443 : 80
  return `${u.hostname.toLowerCase()}:${port}`
}

/** Normalize a target entry: URL, "host", or "host:port" all become "host:port". */
function normalizeTarget(entry) {
  let t = str(entry)
  if (!t) return ""
  if (t.includes("://")) {
    try {
      return hostPortOf(t)
    } catch {
      /* fall through */
    }
  }
  return t.toLowerCase().replace(/\/+$/, "")
}

function globToRegExp(pattern) {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^:]*")
  return new RegExp(`^${escaped}$`)
}

/**
 * Loopback is never proxied, and this is deliberately not configurable.
 *
 * OpenCode's own client/server traffic is loopback, so routing it through a proxy
 * creates a routing loop. And a proxy reached over the network usually has no route
 * back to your loopback, so the request dies with an opaque error (typically 503)
 * rather than anything actionable.
 */
function isLoopback(host) {
  const h = host.replace(/^\[|\]$/g, "")
  return (
    h === "localhost" ||
    h === "::1" ||
    h === "0.0.0.0" ||
    h.endsWith(".localhost") ||
    /^127\./.test(h)
  )
}

function matchesTarget(url, targets) {
  if (targets.length === 0 || targets.includes("*")) return true
  const hp = hostPortOf(url)
  const host = hp.split(":")[0]
  for (const raw of targets) {
    const t = normalizeTarget(raw)
    if (!t) continue
    if (t.includes("*")) {
      if (globToRegExp(t).test(hp) || globToRegExp(t).test(host)) return true
      continue
    }
    if (t === hp || t === host) return true
  }
  return false
}

/**
 * Proxy rules for one provider entry.
 *
 * Precedence: a proxy declared on the provider, then the /proxy mapping, then the
 * global router (only when routeAllProviders is on).
 */
function providerProxyEntries(id, p, router, byProvider) {
  if (!p || typeof p !== "object") return []

  const baseURL = str(p?.options?.baseURL) || str(p?.settings?.baseURL) || str(p?.api)
  const host = baseURL ? normalizeTarget(baseURL) : ""
  if (host && isLoopback(host.split(":")[0])) return []

  const declared = str(p?.options?.proxy) || str(p.proxy) || str(p?.settings?.proxy)
  const mapped = mappingProxy((byProvider ?? {})[id])
  const proxy = declared || mapped || router
  if (!proxy) return []

  const own = p?.options?.proxyTargets ?? p?.proxyTargets ?? p?.options?.noProxy ?? p?.noProxy
  const targets = (Array.isArray(own) ? own : own ? [own] : []).map(str).filter(Boolean)

  return [
    {
      id,
      proxy,
      host,
      targets,
      declared: Boolean(declared),
      mapped: Boolean(mapped) && !declared,
    },
  ]
}

/**
 * Rule registry keyed by "host:port".
 *   exact: Map<"host:port", proxy>
 *   hosts: Map<"host", proxy>      when no port was given
 *   globs: Array<[RegExp, proxy]>
 */
function buildRegistry(cfg, inline, byProvider = {}) {
  const exact = new Map()
  const hosts = new Map()
  const globs = []

  const addHost = (target, proxy) => {
    if (!target) return
    if (isLoopback(target.split(":")[0])) return
    if (target.includes(":")) exact.set(target, proxy)
    else hosts.set(target, proxy)
  }

  const add = (proxy, host, targets) => {
    if (!proxy) return
    for (const raw of targets) {
      const t = normalizeTarget(raw)
      if (!t) continue
      if (t === "*") globs.push([/.*/, proxy])
      else if (t.includes("*")) globs.push([globToRegExp(t), proxy])
      else addHost(t, proxy)
    }
    if (host) addHost(host, proxy)
  }

  // Any host a provider actually uses.
  for (const e of inline) {
    if (e.host) addHost(e.host, e.proxy)
  }

  // Global proxy: explicit targets always; provider hosts only when opted in.
  if (cfg.proxy) {
    if (cfg.routeAllProviders) {
      for (const e of inline) if (e.host) addHost(e.host, cfg.proxy)
    }
    add(cfg.proxy, "", cfg.targets)
  }

  return { exact, hosts, globs }
}

function proxyFor(url, registry) {
  let hp = ""
  try {
    hp = hostPortOf(url)
  } catch {
    return null
  }
  const host = hp.split(":")[0]
  if (isLoopback(host)) return null
  const hit = registry.exact.get(hp) ?? registry.hosts.get(host)
  if (hit) return hit
  for (let i = registry.globs.length - 1; i >= 0; i--) {
    const [re, proxy] = registry.globs[i]
    if (re.test(hp) || re.test(host)) return proxy
  }
  return null
}

/* -------------------------------------------------------- proxy transports */

/**
 * Preferred path: undici's ProxyAgent, which implements CONNECT tunnelling and
 * proxy basic-auth for http and https targets. Not always resolvable, so the
 * manual tunnel below is a real fallback rather than a theoretical one.
 */
async function makeDispatcher(proxyUrl) {
  try {
    const undici = await import("undici")
    const ProxyAgent = undici.ProxyAgent ?? undici.default?.ProxyAgent
    if (!ProxyAgent) return { dispatcher: null, via: "manual CONNECT tunnel" }
    return { dispatcher: new ProxyAgent({ uri: proxyUrl }), via: "undici ProxyAgent" }
  } catch {
    return { dispatcher: null, via: "manual CONNECT tunnel" }
  }
}

/** Opens a CONNECT tunnel and speaks HTTP/1.1 over it, streamed back as a Response. */
async function tunnelledFetch(url, init, proxyUrl, shouldLog) {
  const target = new URL(url)
  const proxy = new URL(proxyUrl)

  const secure = target.protocol === "https:"
  if (!secure && target.protocol !== "http:") {
    throw new Error(`[fetch-proxy] unsupported target protocol: ${target.protocol}`)
  }

  const port = target.port ? Number(target.port) : secure ? 443 : 80
  const socket = await new Promise((resolve, reject) => {
    const s = net.connect(Number(proxy.port || 3128), proxy.hostname, () => resolve(s))
    s.on("error", reject)
    s.setTimeout(30000, () => reject(new Error("proxy connect timeout")))
  })

  try {
    const auth =
      proxy.username || proxy.password
        ? "Proxy-Authorization: Basic " +
          Buffer.from(
            `${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`,
          ).toString("base64") +
          "\r\n"
        : ""

    await new Promise((resolve, reject) => {
      let buf = ""
      const onData = (chunk) => {
        buf += chunk.toString("latin1")
        const end = buf.indexOf("\r\n\r\n")
        if (end === -1) return
        socket.removeListener("data", onData)
        const statusLine = buf.slice(0, buf.indexOf("\r\n"))
        if (!/^HTTP\/1\.[01] 200/.test(statusLine)) {
          return reject(new Error("proxy CONNECT failed: " + statusLine))
        }
        const leftover = buf.slice(end + 4)
        if (leftover.length) socket.unshift(Buffer.from(leftover, "latin1"))
        socket.setTimeout(0)
        resolve()
      }
      socket.on("data", onData)
      socket.on("error", reject)
      socket.write(
        `CONNECT ${target.hostname}:${port} HTTP/1.1\r\nHost: ${target.hostname}:${port}\r\n${auth}\r\n`,
      )
    })

    const transport = secure
      ? await new Promise((resolve, reject) => {
          const s = tls.connect({ socket, servername: target.hostname }, () => resolve(s))
          s.on("error", reject)
        })
      : socket

    const headers = {}
    new Headers(init?.headers || {}).forEach((v, k) => {
      if (k.toLowerCase() !== "host" && k.toLowerCase() !== "connection") headers[k] = v
    })
    headers["host"] = target.port ? `${target.hostname}:${target.port}` : target.hostname
    headers["connection"] = "close"

    const bodyBuf = init?.body ? Buffer.from(init.body) : null
    if (bodyBuf) headers["content-length"] = String(bodyBuf.length)

    let raw = `${(init?.method || "GET").toUpperCase()} ${target.pathname + target.search} HTTP/1.1\r\n`
    for (const [k, v] of Object.entries(headers)) raw += `${k}: ${v}\r\n`
    raw += "\r\n"

    if (shouldLog()) console.error(`[fetch-proxy] tunnel ${init?.method || "GET"} ${url}`)

    await new Promise((resolve, reject) => {
      transport.write(raw, "latin1", (err) => (err ? reject(err) : resolve()))
      if (bodyBuf) transport.write(bodyBuf)
    })

    const { status, headers: resHeaders, rest } = await new Promise((resolve, reject) => {
      let buf = Buffer.alloc(0)
      const onData = (chunk) => {
        buf = Buffer.concat([buf, chunk])
        const end = buf.indexOf("\r\n\r\n")
        if (end === -1) return
        transport.removeListener("data", onData)
        const lines = buf.slice(0, end).toString("latin1").split("\r\n")
        const m = /^HTTP\/1\.[01] (\d{3})/.exec(lines[0])
        if (!m) return reject(new Error("bad response: " + lines[0]))
        const out = {}
        for (const line of lines.slice(1)) {
          const i = line.indexOf(":")
          if (i > 0) out[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim()
        }
        resolve({ status: Number(m[1]), headers: out, rest: buf.slice(end + 4) })
      }
      transport.on("data", onData)
      transport.on("error", reject)
      transport.on("close", () => reject(new Error("socket closed before response headers")))
    })

    const webStream = Readable.toWeb(
      (() => {
        if (rest.length) transport.unshift(rest)
        return transport
      })(),
    )

    return new Response(webStream, { status, headers: resHeaders })
  } catch (err) {
    socket.destroy()
    throw err
  }
}

/* -------------------------------------------------------------- proxy tool */

/** Input schema for the tool. Plain JSON Schema so it needs no SDK import. */
const PROXY_TOOL_INPUT = {
  type: "object",
  properties: {
    providerID: {
      type: "string",
      description: "Provider id exactly as it appears in opencode.jsonc, for example 063.",
    },
    proxy: {
      type: "string",
      description: "Proxy URL for that provider, for example http://192.168.10.101:3128.",
    },
    remove: {
      type: "boolean",
      description: "Set true to remove the proxy for this provider and connect directly.",
    },
  },
  required: ["providerID"],
  additionalProperties: false,
}

/**
 * Builds the tool the agent calls when /proxy runs.
 *
 * Prefers the SDK helper (which coerces the schema into what OpenCode expects) and
 * falls back to a plain object, so the file stays dependency-free.
 */
function buildSetProxyTool(toolHelper, state, persist, getRegistry, readDeclaredProxy) {
  const run = async (raw) => {
    const args = raw && typeof raw === "object" ? raw : {}

    // Resolve the provider: explicit id, else whatever this session is already using.
    // The model is already selected, so the user should not have to look up its id.
    const providerID = str(args.providerID) || str(state.currentProviderID)

    // Fall back to the only provider there is. In a fresh session /proxy cannot know which
    // provider is selected -- chat.params has not fired for a successful turn yet -- but if
    // exactly one non-loopback provider is configured, the answer is unambiguous.
    // If we fell back to the sole provider, its configured model name is the best available
    // label -- the session has not told us one yet.
    const sole = soleProviderID()
    const resolvedID = providerID || sole
    const soleModel = !providerID && sole ? soleProviderModel(sole) : ""

    // Prefer a human label. The provider id is an opaque key like "063"; the model name
    // is what the user recognises in the model picker.
    const model =
      str(args.model) ||
      str(state.currentModelName) ||
      str(state.currentModelID) ||
      soleModel
    const providerLabel = model
      ? model + " (provider " + resolvedID + ")"
      : "provider " + resolvedID
    const all = Object.entries(state.byProvider)
      .map(([k, v]) => {
        const label = mappingModel(v)
        return label ? label + " -> " + redactProxy(mappingProxy(v)) : k + " -> " + redactProxy(mappingProxy(v))
      })
      .join("; ")

    if (!resolvedID) {
      return {
        title: "Proxy: no provider yet",
        output:
          "I cannot tell which provider you mean yet. **Send one message first** so a " +
          "provider is chosen, or name it explicitly:" + NL + NL +
          "```" + NL + "/proxy <resolvedID> <proxyURL>" + NL + "```" + NL + NL +
          "Already configured: " + (all || "nothing yet"),
      }
    }

    // ---- remove ----
    if (args.remove === true) {
      // A proxy can also be declared on the provider itself. That declaration takes
      // precedence over this mapping and the tool cannot remove it, so report it rather
      // than claiming nothing is configured while traffic is plainly being proxied.
      const alsoDeclared = readDeclaredProxy()
      if (!mappingProxy(state.byProvider[resolvedID])) {
        return {
          title: alsoDeclared ? "Proxy: declared in config" : "Proxy: nothing to remove",
          output: alsoDeclared
            ? "**" + providerLabel + "** has no proxy in the mapping file, but `opencode.jsonc` " +
              "declares one that takes precedence:" + NL + NL +
              "```" + NL + "\"options\": { \"proxy\": \"" + redactProxy(alsoDeclared) + "\" }" + NL + "```" + NL + NL +
              "Remove that line to stop proxying. This command will not edit opencode.jsonc, " +
              "because the file is JSONC and rewriting it would discard your comments." +
              (all ? NL + NL + "Mapping file also has: " + all : "")
            : "**" + providerLabel + "** has no proxy set, so there is nothing to undo. " +
              "It is already connecting directly, which is honestly the simpler life." +
              NL + NL + "Configured: " + (all || "nothing yet"),
        }
      }
      delete state.byProvider[resolvedID]
      persist()
      const left = Object.keys(state.byProvider)
      return {
        title: "Proxy removed",
        output:
          "**Proxy removed** for **" + providerLabel + "**. It goes direct again, and " +
          "that is saved." + NL + NL +
          "Remaining: " + (left.length ? left.join(", ") : "nothing") +
          ". Set it again any time with `/proxy`.",
      }
    }

    // ---- set ----
    const proxy = str(args.proxy)
    if (!proxy) {
      return {
        title: "Proxy: needs a URL",
        output:
          "I need a proxy URL to work with." + NL + NL +
          "```" + NL +
          "/proxy <proxyURL>                 configure the current provider" + NL +
          "/proxy <resolvedID> <proxyURL>" + NL +
          "/proxy remove                      undo it" + NL +
          "```" + NL + NL +
          "Example: `/proxy http://192.168.10.101:3128`" +
          (all ? NL + NL + "Already configured: " + all : ""),
      }
    }

    let parsed
    try {
      parsed = new URL(proxy)
    } catch {
      return {
        title: "Proxy: bad URL",
        output:
          "`" + proxy + "` is not a URL I can use. It needs a scheme and a port, for " +
          "example `http://192.168.10.101:3128`.",
      }
    }
    if (malformedCredentials(proxy)) {
      return {
        title: "Proxy: credentials not usable",
        output:
          "`" + redactProxy(proxy) + "` has credentials in a form the URL parser drops, " +
          "so the proxy would be contacted with no authentication at all." + NL + NL +
          "This usually means a backslash in the username (for example `DOMAIN\\\\user`). " +
          "Percent-encode it as `%5C`, and percent-encode any special characters in the " +
          "password too:" + NL + NL +
          "```" + NL +
          "/proxy http://DOMAIN%5Cuser:p%40ssword@192.168.10.101:3128" + NL +
          "```",
      }
    }

    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return {
        title: "Proxy: bad protocol",
        output:
          "`" + parsed.protocol + "` is not something I can tunnel through. Use " +
          "`http://` or `https://`.",
      }
    }

    state.byProvider[resolvedID] = model ? { proxy, model } : { proxy }
    persist()

    // Probe once, bounded, so the user learns immediately whether the proxy actually
    // serves this provider rather than finding out on the next prompt. Cached per
    // provider+proxy, and never allowed to fail the write.
    let probeLine = ""
    try {
      const cacheKey = resolvedID + "|" + proxy
      if (!state.probe.has(cacheKey)) {
        let outcome
        try {
          // Route the probe THROUGH the proxy. Fetching the probe host directly would
          // succeed no matter how broken the proxy is, which makes the check worthless.
          // A temporary rule is installed for the probe host and removed in the finally,
          // so the real routing table is left exactly as it was.
          const probeHost = "example.com:443"
          const live = getRegistry()
          const savedExact = new Map(live.exact)
          const savedHosts = new Map(live.hosts)
          let res
          try {
            live.exact.set(probeHost, proxy)
            res = await fetch("https://example.com/", {
              method: "GET",
              signal: AbortSignal.timeout(3000),
            })
          } finally {
            live.exact.clear()
            for (const [k, v] of savedExact) live.exact.set(k, v)
            live.hosts.clear()
            for (const [k, v] of savedHosts) live.hosts.set(k, v)
          }
          outcome = res.status < 500 ? "reachable" : "answered HTTP " + res.status
        } catch (err) {
          const msg = String(err && err.message ? err.message : err)
          outcome = /timeout|abort/i.test(msg)
            ? "not responding (timed out)"
            : "unreachable (" + msg + ")"
        }
        state.probe.set(cacheKey, outcome)
      }
      probeLine = NL + "- **Check:** " + state.probe.get(cacheKey) + "."
    } catch {
      probeLine = ""
    }

    const others = Object.keys(state.byProvider).filter((k) => k !== resolvedID)
    return {
      title: "Proxy set",
      output:
        "**Done.** `" + redactProxy(proxy) + "` now carries traffic for **" + providerLabel + "**." + NL + NL +
        "- **Scope:** this provider only. Your other traffic stays direct and never " +
        "touches the corporate proxy." + NL +
        "- **Sticky:** saved to `proxy-providers.json`, so it survives a restart." + NL +
        "- **Undo:** `/proxy remove`." +
        probeLine +
        (others.length ? NL + NL + "Also configured: " + others.join(", ") : ""),
    }
  }

  if (toolHelper) {
    const { tool, z } = toolHelper
    return tool({
      description:
        "Set or remove the HTTP proxy used for one OpenCode provider. Use when a provider " +
        "must be reached through a proxy, e.g. a LAN model server behind a corporate proxy. " +
        "Applies to that provider ONLY; every other provider keeps connecting directly." +
        "\n\nArguments come from the /proxy command and may be: a bare proxy URL " +
        "(configure the provider this session is already using -- omit resolvedID and the " +
        "tool resolves it); a provider id followed by a URL; or the word remove. Call this " +
        "tool exactly once, then reply with its output verbatim and add nothing of your own." +
        "\n\nWith no proxy and no remove flag it returns usage help, which is the correct " +
        "response to a bare /proxy.",
      args: {
        resolvedID: z
          .string()
          .optional()
          .describe("Which provider to configure. Omit to use this session provider."),
        proxy: z.string().optional().describe("Proxy URL, e.g. http://192.168.10.101:3128"),
        remove: z.boolean().optional().describe("Remove the proxy for this provider."),
      },
      execute: run,
    })
  }

  return {
    description:
      "Set or remove the HTTP proxy for one OpenCode provider. Applies to that provider " +
      "only. Arguments: a bare proxy URL, a provider id plus a URL, or remove. Call once " +
      "and reply with the output verbatim.",
    args: PROXY_TOOL_INPUT,
    execute: run,
  }
}

/* ------------------------------------------------------------------ plugin */

export const FetchProxyPlugin = async ({ client } = {}) => {
  // NOTE: do NOT return early when another instance already patched fetch. OpenCode
  // instantiates this plugin more than once; each instance must still contribute its
  // config/tool hooks. Only the global fetch patch has to be installed once.
  const fetchAlreadyPatched = Boolean(globalThis[MARKER])

  const baseFetch = globalThis.fetch
  if (typeof baseFetch !== "function") {
    console.error("[fetch-proxy] global fetch unavailable; plugin inactive")
    return {}
  }

  // Ship the slash command as the file this build actually reads. The config-map
  // injection below is kept as a second path, but the file is the supported one.
  const cmdFile = ensureProxyCommandFile()

  const proxyProvidersFile = proxyProvidersPath()
  const proxyState = { byProvider: readProxyProviders(proxyProvidersFile), currentProviderID: null, currentModelName: "", currentModelID: "", probe: new Map() }
  let byProvider = proxyState.byProvider

  // Loaded dynamically so the file needs no hard dependency. Without it the /proxy
  // command still works; only the tool the agent calls is skipped.
  let toolHelper = null
  try {
    const sdk = await import("@opencode-ai/plugin")
    const t = sdk?.tool
    const z = sdk?.tool?.schema ?? sdk?.z
    if (typeof t === "function" && z) toolHelper = { tool: t, z }
  } catch {
    /* command-only mode */
  }

  const fileCfg = loadFileConfig()
  const envTargets = process.env.OPENCODE_PROXY_TARGETS
    ? process.env.OPENCODE_PROXY_TARGETS.split(",").map(str).filter(Boolean)
    : null

  const globalCfg = {
    proxy: str(process.env.OPENCODE_PROXY_URL) || fileCfg.proxy,
    targets: envTargets ?? fileCfg.targets,
    routeAllProviders:
      process.env.OPENCODE_PROXY_ALL === "1" || fileCfg.routeAllProviders === true,
    log: process.env.OPENCODE_PROXY_LOG === "1" || fileCfg.log,
  }

  let lastProviders = null
  let inline = []
  let registry = buildRegistry(globalCfg, inline, byProvider)
  const dispatchers = new Map()
  const pending = new Map()
  const log = (msg) => console.error(msg)
  const shouldLog = () => process.env.OPENCODE_PROXY_LOG === "1" || fileCfg.log

  /**
   * Recompute provider rules from the current mapping and the last config seen.
   * Always rebuilt from scratch: reusing a previous snapshot would leave a rule behind
   * for a mapping that was just removed.
   */
  const rebuildRules = () => {
    if (!lastProviders || typeof lastProviders !== "object") {
      registry = buildRegistry(globalCfg, inline, byProvider)
      return
    }
    const found = []
    for (const [id, p] of Object.entries(lastProviders)) {
      found.push(...providerProxyEntries(id, p, globalCfg.routeAllProviders ? globalCfg.proxy : undefined, byProvider))
    }
    inline = found
    registry = buildRegistry(globalCfg, inline, byProvider)
  }

  /** Persist a mapping change and apply it immediately, without a restart. */
  const persistProxyProviders = () => {
    byProvider = proxyState.byProvider
    writeProxyProviders(proxyProvidersFile, byProvider)
    rebuildRules()
  }

  if (!globalCfg.proxy) {
    log('[fetch-proxy] no global proxy configured; using per-provider "options.proxy" and /proxy mappings')
  }

  function dispatcherFor(proxyUrl) {
    if (dispatchers.has(proxyUrl)) return dispatchers.get(proxyUrl)
    if (pending.has(proxyUrl)) return pending.get(proxyUrl)
    const p = makeDispatcher(proxyUrl)
      .then(({ dispatcher, via }) => {
        dispatchers.set(proxyUrl, dispatcher ?? null)
        log(`[fetch-proxy] transport for ${redactProxy(proxyUrl)}: ${via}`)
        return dispatcher
      })
      .finally(() => pending.delete(proxyUrl))
    pending.set(proxyUrl, p)
    return p
  }

  async function patchedFetch(input, init) {
    let url
    try {
      url =
        typeof input === "string" ? input : input instanceof URL ? input.href : input?.url
    } catch {
      return baseFetch(input, init)
    }
    if (!url) return baseFetch(input, init)

    const proxy = proxyFor(url, registry)
    if (!proxy) return baseFetch(input, init)

    if (shouldLog()) log(`[fetch-proxy] ${init?.method || "GET"} ${url} -> ${redactProxy(proxy)}`)

    const dispatcher = await dispatcherFor(proxy)
    if (dispatcher) {
      return Reflect.apply(baseFetch, globalThis, [input, { ...init, dispatcher }])
    }
    return tunnelledFetch(url, init, proxy, shouldLog)
  }

  // Install the patch only once, but keep the hooks below for every instance.
  if (!fetchAlreadyPatched) {
    globalThis.fetch = patchedFetch
    globalThis[MARKER] = true
  }

  const banner = globalCfg.proxy
    ? globalCfg.routeAllProviders
      ? `[fetch-proxy] active - proxy=${redactProxy(globalCfg.proxy)}, routing ALL non-loopback provider hosts`
      : `[fetch-proxy] active - proxy=${redactProxy(globalCfg.proxy)}; routing targets=[${globalCfg.targets.join(",") || "none"}], other providers go direct`
    : "[fetch-proxy] active - per-provider proxies only (options.proxy or /proxy)"
  log(banner)
  log(
    "[fetch-proxy] /proxy command file: " +
      cmdFile.action +
      " (" + cmdFile.file + ")" +
      (cmdFile.error ? " error=" + cmdFile.error : ""),
  )
  try {
    await client?.app?.log?.({ body: { service: "fetch-proxy", level: "info", message: banner } })
  } catch {
    /* best effort */
  }

  return {
    /**
     * The tool the agent calls when /proxy runs. Registered so a mapping written from
     * inside a session takes effect immediately rather than only on the next restart.
     */
    /**
     * Records which provider the session is using, so /proxy can default to it. Fires
     * before each model request with the resolved provider and model.
     */
    "chat.params": async (input) => {
      const id = str(input?.provider?.info?.id) || str(input?.model?.resolvedID)
      if (id) proxyState.currentProviderID = id
      // Keep a human-readable model label too: the provider id is an opaque key like
      // "063", whereas the model name is what the user recognises in the picker.
      const label = str(input?.model?.name) || str(input?.model?.id)
      if (label) proxyState.currentModelName = label
      const modelID = str(input?.model?.id)
      if (modelID) proxyState.currentModelID = modelID
    },

    tool: {
set_proxy: buildSetProxyTool(toolHelper, proxyState, persistProxyProviders, () => registry, readDeclaredProxy),
    },

    /**
     * Runs once at startup with the fully resolved config, and again whenever OpenCode
     * re-resolves. Registers the /proxy command and applies proxy rules.
     */
    config: async (config) => {
      // Register /proxy: the provider form has no proxy field, so this is the in-session
      // equivalent of that missing control.
      if (config && typeof config === "object") {
        config.command = config.command ?? {}
        if (!config.command.proxy) {
          config.command.proxy = {
            description: "Set or remove the HTTP proxy used for one provider",
            template:
              "Configure an HTTP proxy for a single provider, using the set_proxy tool.\n\n" +
              "If no provider is named, the tool applies to the provider this session is " +
              "already using -- which is almost always what the user wants, since they have " +
              "already selected the model.\n\n" +
              "Forms: /proxy <proxyURL>            (configure the current provider)\n" +
              "       /proxy <resolvedID> <proxyURL>\n" +
              "       /proxy remove                 (current provider)\n" +
              "Given: $ARGUMENTS\n\n" +
              "The proxy applies to that provider ONLY; every other provider keeps " +
              "connecting directly. A proxy URL needs its scheme and port, for example " +
              "http://192.168.10.101:3128. Do not edit opencode.jsonc; just call the tool.",
          }
        }
      }
      // Pick up a mapping written by the tool or by hand.
      const fresh = readProxyProviders(proxyProvidersFile)
      if (JSON.stringify(fresh) !== JSON.stringify(proxyState.byProvider)) {
        proxyState.byProvider = fresh
        byProvider = fresh
      }

      const providers = config?.provider
      if (providers && typeof providers === "object") {
        lastProviders = providers
      }
      rebuildRules()

      if (!inline.length) return
      for (const e of inline) {
        log(
          `[fetch-proxy] provider "${e.id}" -> ${redactProxy(e.proxy)}` +
            (e.declared ? " (declared on provider)" : e.mapped ? " (from /proxy)" : " (from proxy.json)") +
            (e.host ? ` for ${e.host}` : e.targets.length ? ` for ${e.targets.join(",")}` : ""),
        )
        void dispatcherFor(e.proxy)
      }
      try {
        await client?.app?.log?.({
          body: {
            service: "fetch-proxy",
            level: "info",
            message: `[fetch-proxy] proxies applied to: ${inline.map((e) => e.id).join(", ")}`,
          },
        })
      } catch {
        /* best effort */
      }
    },

    dispose: async () => {
      if (globalThis.fetch === patchedFetch) globalThis.fetch = baseFetch
      globalThis[MARKER] = false
      for (const d of dispatchers.values()) {
        try {
          await d?.close?.()
        } catch {
          /* ignore */
        }
      }
      dispatchers.clear()
    },
  }
}

export default { id: "fetch-proxy", server: FetchProxyPlugin }
/**
 * Proxy URLs may carry credentials: http://user:pass@host:port. Never log or display the
 * password -- it would otherwise reach the chat transcript and OpenCode's server log.
 * The username is kept, since it is genuinely useful when diagnosing a 407.
 *
 * The regex fallback is applied unconditionally rather than only on a parse failure: a URL
 * containing a backslash (DOMAIN\\user) parses "successfully" with EMPTY credentials, so a
 * password check alone would let the raw string through.
 */
function maskAuthorityCredentials(raw) {
  return raw.replace(/\/\/([^/@:]*):[^/@]*@/, "//$1:REDACTED@")
}

function redactProxy(url) {
  const raw = str(url)
  if (!raw) return raw
  try {
    const u = new URL(raw)
    if (u.password) {
      u.password = "REDACTED"
      return maskAuthorityCredentials(u.toString())
    }
  } catch {
    /* fall through to the regex */
  }
  return maskAuthorityCredentials(raw)
}
