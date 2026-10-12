# Changelog

## 1.0.13

Make `/proxy` take effect immediately, regardless of which hooks fire.

Routing consulted a registry that was only rebuilt on hooks (`config`, `chat.params`,
`chat.message`). Rebuilds also reused the in-memory mapping rather than re-reading the file, so a
rebuild could produce rules identical to the ones it already had.

That made behaviour depend on hook timing. One session rebuilt rules repeatedly and `/proxy`
appeared to apply with no restart; another fired the config hook twice at startup and never again,
and `/proxy` looked like it did nothing at all -- writes landed on disk, requests kept going
direct, and the provider timed out. Reproduced as a test: configure once, then change the mapping
with no hook calls, and the old code could not see the change.

Two changes:

- `rebuildRules` re-reads `proxy-providers.json` before rebuilding, so a rebuild always reflects
  the file rather than a cached copy.
- The fetch wrapper stats the mapping file before deciding a route, and rebuilds when it changed.
  One `stat` per request, next to the HTTP call it precedes.

The mapping now applies on the next request even if no hook ever fires again.

## 1.0.12

Stop telling users to restart OpenCode. They do not need to, and the instruction was wrong.

The plugin re-reads `proxy-providers.json` every time the config hook runs, and that hook runs
more than once during a session -- visible in the runtime log as repeated
`[fetch-proxy] active` / `provider "local" -> ... (from /proxy)` pairs. So a mapping written by
`/proxy` is picked up on the next request, mid-session, with no restart.

This was tested rather than reasoned about: a user set the proxy and the provider worked
immediately. Every user-facing message that said otherwise has been corrected, including the
browser form and the model-id repair.

Worth noting for anyone reading the history: `options.proxy` in `opencode.jsonc` is the case that
genuinely benefits from a restart, because that file is read by OpenCode itself rather than by the
plugin. The plugin-owned mapping never needed one.

## 1.0.11

Stop the helper script being loaded as a plugin.

OpenCode discovers plugins with the glob `{plugin,plugins}/*.{ts,js}` -- every direct `.js` child
of a plugin directory is imported. 1.0.6 through 1.0.10 told users to copy `set-proxy.js` next to
the plugin, which put it inside that glob. It has no exports, so importing it ran its CLI top
level, and that opened the browser form at every startup.

Two fixes, because either alone would be fragile:

1. `set-proxy.js` now checks whether it was executed or imported (`process.argv[1]` against its
   own path) and does nothing at all when imported. This holds wherever the file ends up.
2. The helper belongs in a `lib/` subdirectory, which the single-segment glob never matches. The
   plugin resolves `lib/set-proxy.js` first and falls back to a sibling for compatibility.

The last three releases of this command were each broken in a way the handler tests could not
see, because the failures were all in the integration: undici not importing, `echo` under cmd.exe,
and now plugin discovery. The handler was always fine.

## 1.0.10

Fix the `/proxy` command on Windows, which 1.0.9 got wrong.

1.0.9 piped the arguments through `echo` into the script. Under `cmd.exe` a bare `echo` does not
print an empty line -- it prints the literal text `ECHO is on.` -- so using `/proxy` with no
arguments pushed that string down the pipe, and the handler reported a nonsensical URL error.

The arguments are now appended to the command as a normal command-line argument instead:

```
!`node <set-proxy.js> proxy-cmd $ARGUMENTS`
```

That removes the shell from the data path entirely, so there is no quoting to get wrong and no
`echo` behaviour to depend on. The handler accepts argv or stdin, keeping both call shapes valid.

`/proxy` also writes one line per invocation to `proxy-command.log` in the OpenCode config
directory, recording what argv and stdin actually contained. The previous version failed silently
from the user's side and there was no way to see why; that is now diagnosable in one file.

## 1.0.9

`/proxy` now works with no reachable model. This removes the deadlock entirely.

A slash command whose body is a prompt still needs a model turn to run its tool, which is why
`/proxy` could never configure the only provider -- that provider is unreachable until configured.
But the server expands `` !`cmd` `` in a command template with a real shell BEFORE it calls the
model: `SessionPrompt.command` collects `shellMatches`, runs them, substitutes the output, and only
then calls `prompt()`. A command can therefore have a side effect with no turn at all.

The generated command is now:

```
!`echo $ARGUMENTS | node <set-proxy.js> proxy-cmd`
```

Nothing the user types reaches the command line -- the payload goes over stdin -- so there is no
quoting to get wrong and no metacharacter to escape. The script path uses forward slashes because
the string is handed to a real shell.

`/proxy <url>`, `/proxy remove`, `/proxy list` and bare `/proxy` all run this way. It falls back to
the previous prompt-template form when `set-proxy.js` is not beside the plugin, so single-file
installs keep working.

Also documented: OpenCode natively honours `HTTP_PROXY` / `http_proxy` via
`http.setGlobalProxyFromEnv()` and already exempts loopback itself. That is a global, not
per-provider, route -- but it is zero-config and needs no plugin at all.

## 1.0.8

Check and repair the model id, which is what produced `The model \`063\` does not exist`.

In `opencode.jsonc` the outer key under `provider` is a provider id you invent; the inner key
under `models` is a model id the server must actually serve. Both are plain strings and nothing
validates the inner one when you write it, so naming a provider `063` easily leads to `063`
appearing as the model key too. The failure surfaces only later, when you try to use the model.

`set-proxy` now asks the provider for `GET /v1/models` and reports what it really serves:

```
opencode-fetch-proxy-set --models
```

If the declared model key is not in that list it rewrites the key in `opencode.jsonc`, keeping
every other line and comment, and saves a `.bak-modelkey` backup first. The browser form has a
'Check model ids' button that does the same.

Also: the model list is fetched through a manual CONNECT tunnel rather than undici. undici is not
reliably importable from an installed package, and when the import failed the request silently
went direct -- which for a proxy-only endpoint looked like a timeout rather than a missing
dependency.

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
