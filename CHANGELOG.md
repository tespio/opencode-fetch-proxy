# Changelog

## 1.0.7

`set-proxy` now opens a browser form when run without arguments.

1.0.6 shipped a command-line setter, which is not an accessible way to configure a proxy: it
requires a terminal, a path to the script, and remembering `--provider` flags. Running it with no
arguments now serves a small local page instead, listing every provider it found in
`opencode.jsonc` with its endpoint, current mapping and model count, and one field for the proxy
URL. Saving writes the same `proxy-providers.json`.

The server binds to 127.0.0.1 on an ephemeral port, opens the default browser, and exits as soon
as the form is submitted, so no process is left behind. An invalid URL is rejected in the page and
nothing is written.

The command-line form is unchanged and still available for scripts.

## 1.0.6

Add `set-proxy.js`, because `/proxy` cannot bootstrap the model it is meant to configure.

A slash command is a prompt template, so submitting `/proxy <url>` starts a model turn, and the
tool that writes the mapping runs inside that turn — after the model responds. When the only
configured provider is unreachable, the turn never completes and nothing is written. This is a
property of how slash commands execute and cannot be fixed in a plugin: a plugin cannot register
a TUI command, cannot pre-empt a slash command, and cannot run code without an agent turn.

So the mapping now has a way to be written from outside the session:

```
npx opencode-fetch-proxy-set http://192.168.10.101:3128
npx opencode-fetch-proxy-set --list
npx opencode-fetch-proxy-set --remove
```

It writes the same `proxy-providers.json` the tool writes, choosing the provider the same way
(explicitly, or the sole non-loopback provider), and refuses a proxy URL with an unencoded
backslash. Verified end to end: with no `options.proxy` and the mapping written by this script, a
cold start routes the very first provider request through the proxy.

Restart OpenCode afterwards — the mapping is read at startup and there is no config file watcher.

## 1.0.5

Stop the release workflow failing on the floating `v1` tag.

The workflow triggered on `v*`, which includes `v1`. Moving that tag is part of every release,
so each release started two runs: one for `vX.Y.Z` and one for `v1`. The second always failed,
because the version check compares the tag against `package.json` and `1` never equals `1.0.5`.
Two failure notifications per release, from the project's own convenience tag.

The trigger is now `v[0-9]+.[0-9]+.[0-9]+`, so `v1` no longer starts a run at all. The version
check is unchanged and still guards real version tags.

No functional change to the plugin.

## 1.0.4

Ship `install.js`, and document the plugin-discovery rules properly.

The README previously said to place the file at `plugins/opencode-fetch-proxy.js` while the
package ships it as `index.js`, without saying the name has to change. It also did not mention
that a subdirectory is never auto-discovered. Both are now stated, with the loader behaviour
verified against the actual bundle:

- discovery globs `{plugin,plugins}/*.{ts,js}` — single segment, so `plugins/<dir>/index.js` is
  invisible however it is named, and `.mjs` / `.cjs` are skipped silently
- an explicitly declared path may point at a directory, which resolves `index.js` / `index.mjs`
  inside it, so a subdirectory works once declared

New: `npx opencode-fetch-proxy-install` copies the plugin to the right place with the right name,
creating the directory if needed, and refuses to overwrite a file that differs.

## 1.0.3

Make `/proxy <url>` work on the first attempt in a fresh session.

Previously the tool needed to be told which provider to configure, and it learned that only from
`chat.params` -- which fires on a model request. In a new session whose selected provider is not
yet reachable, the first request fails before the tool can run, so `/proxy` replied "send one
message first" and the command had to be issued twice.

Now, when exactly one non-loopback provider is configured, that provider is used, so the intended
flow works immediately: add a provider, select it, run `/proxy <url>`, done.

It still refuses to guess when two or more providers are candidates, and loopback providers are
never counted. The label also falls back to the provider's configured model name, so the output
reads `Qwen3.8 27B Uncensored (provider 063)` rather than just the opaque provider id.

## 1.0.2

Fix a misleading `/proxy remove` result. When a proxy was declared as `options.proxy` in
`opencode.jsonc`, removing via the command reported "has no proxy set ... already connecting
directly" while that declaration was in fact routing the provider's traffic. The command only
owns its own mapping file and never edits `opencode.jsonc`, so it now reads the declared value
back and says where the proxy actually lives, instead of denying one exists.

The check strips comments first, so a commented-out `proxy` key is not mistaken for a live one.

## 1.0.1

Fix the repository metadata. 1.0.0 shipped with `repository`, `homepage` and `bugs` pointing at
`github.com/init3/opencode-fetch-proxy`, which does not exist — the GitHub account is `tespio`
while `init3` is the npm account, and the two were conflated when the package was first
committed. Published versions are immutable, so this is corrected in a new version.

No functional change.

## 1.0.0

First release. Built and verified against OpenCode 1.19.0 desktop on Windows 11, with a live
corporate proxy and a live LAN vLLM endpoint.

**Routing**

- Per-provider proxy via `options.proxy` (or `settings.proxy`), declared on the provider entry.
- Per-provider proxy via the `/proxy` command, stored in `proxy-providers.json`.
- Global proxy via `proxy.json`, applied to explicit `targets` and — only when
  `routeAllProviders` is enabled — to every non-loopback provider host.
- Rules are keyed by `host:port`; loopback is bypassed unconditionally and not configurable.
- HTTPS supported by negotiating TLS inside the CONNECT tunnel. Streaming responses pass through
  as a streamed `Response`.

**Transports**

- `undici` `ProxyAgent` when it resolves, including proxy basic-auth.
- A dependency-free manual CONNECT tunnel otherwise, using only `node:net`, `node:tls` and
  `Readable.toWeb`. This is the path the Node-based 1.19 desktop server takes.

**Command**

- Ships `command/proxy.md` so `/proxy` appears in the slash menu, written and kept current by the
  plugin. A plugin cannot register a command directly — the command list's `source` union has no
  `"plugin"` member.
- Defaults to the session's active provider, so the provider id can be omitted.
- Reports scope, persistence and an undo hint; probes the proxy once, bounded and cached, through
  the proxy rather than around it.
- The command template is one line because templates are rendered into the chat transcript.

**Known constraints**

- `/proxy` needs a model turn, so it cannot configure the only gated model. Use `options.proxy`
  when the gated provider is the only provider. Documented in the README.
- Patching the global `fetch` cannot intercept a provider package that supplies its own `fetch`.
- Basic-auth proxies only; NTLM and Kerberos need an authenticating gateway.
