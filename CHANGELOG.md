# Changelog

## 1.0.24

Add a screenshot of the command working.

It is a real session, showing `/proxy remove` and then `/proxy <url>`: both results appear
immediately, with no model reply between them. That is the property this command took some effort
to get right, so a picture of it is more useful than another paragraph describing it.

Shipped in `docs/` and listed in `files`, because the README is also rendered on npm -- an image
the package does not carry would be a broken link there. The reference is relative (`docs/...`); a
leading slash would be root-absolute and break on both GitHub and npm.

Downscaled to half resolution: 52 KB rather than 101 KB. It is a transcript, so legibility survives
the reduction and the package stays small.

## 1.0.23

Remove the debugging instrumentation.

The hook was writing a record on every /proxy invocation: the raw argv and stdin, the parts array,
and the result of the whitespace filter. That was scaffolding for diagnosing why the command still
reached a model, and it is no longer needed now that the cause is fixed.

Kept, because they are diagnostics rather than scaffolding:

- `set-proxy.js` still writes `proxy-command.log`, one line per invocation recording what argv
  actually arrived. That single line is what exposed the `cmd.exe` `ECHO is on.` bug and the
  `--silent` flag arriving as an argument. No other part of the suite had that visibility.
- `set-proxy.js` still writes `proxy-last-result.json`, which is how the command result reaches
  the plugin hook so it can be posted with `noReply`.
- The hook still logs to stderr if the `noReply` post fails. That is error reporting, not
  diagnostics.

Both files live in the OpenCode config directory, are plain text, contain no credentials beyond a
proxy URL the user typed, and can be deleted at any time.

## 1.0.22

Document what /proxy actually does. No code change.

The README still described the original, wrong mechanism -- that the set_proxy tool runs inside the
model turn, and therefore that /proxy cannot configure an unreachable provider. That was true of the
first implementation and is false of the shipped one, which is misleading in the worst direction: it
tells readers the feature does not work.

The section now describes the three mechanisms that make it work, with the server code that each
relies on quoted inline: the command template shell expansion that runs before the model call; the
noReply post that delivers the result as its own message; and the in-process answer for the turn
that is still issued.

Also corrected: the claim that a restart is needed, and the note about pipes, which is where the
cmd.exe ECHO-is-on bug came from.

## 1.0.21

Arm the local answer last, not first.

1.0.20 answered the /proxy turn in-process, but armed it at the top of the command hook -- before
the hook own `await client.session.prompt({ noReply: true })`. That post is an HTTP request to the
OpenCode server, so the stub intercepted it instead. The runtime log showed it plainly:

```
[fetch-proxy] http://127.0.0.1:32831/session/ses_.../message -> answered locally
```

An OpenAI chat completion returned where the session-message endpoint was expected. `noReply`
never reached the server, so the turn ran for real and the model replied with generic greetings.

The arming now happens at the very end of the hook, once every request the hook makes itself has
completed. The first request to arrive afterwards is necessarily the model call.

Tested with a real local HTTP server standing in for the OpenCode server: the noReply post must
reach it, and the subsequent model request must be answered locally in about a millisecond.

## 1.0.20

Answer the /proxy turn in-process, so it cannot hang or fail.

The command mechanism calls the model unconditionally -- `SessionPrompt.command` always reaches
`prompt()` -- and a plugin cannot cancel that call. Clearing the parts did not prevent it either:
an empty-parts request is still issued, and after `/proxy remove` it retried a disconnected
provider five times before reporting a connection error.

But that call travels through this plugin's patched global fetch. So the plugin answers it
itself: the command hook arms a local response, and the fetch wrapper returns an empty OpenAI
chat completion -- 200, `finish_reason: stop`, empty content, and an SSE form for providers that
request a stream. Measured at 2ms, with no server, no socket and no network.

The arming is a timestamp, consumed on first use, so an abandoned turn cannot swallow a later
real request. Verified: a request before the command is untouched, the turn is answered locally,
and the following request goes to the network again.

A background HTTP server was considered and rejected: it would add a listening socket and a
generated provider entry for something the existing fetch patch can do in two lines.

## 1.0.19

Remove whitespace-only parts, not just empty ones.

1.0.18 ran the command silently so the shell substitution expanded to nothing -- but the
substitution sits on its own line of the template, so what remained was a newline. A blank part is
still a part, so OpenCode still issued the model request and the user still waited through a
connect timeout after `/proxy remove`.

The hook now filters out any text part whose content is empty or whitespace-only. Non-text parts
are preserved, so an attachment on a command is unaffected, and other commands are untouched.

Tested against the exact expansion the command produces (`"\n"`) and against a file part to make
sure the filter cannot drop anything it should keep.

## 1.0.18

Make the /proxy command genuinely silent, so there is no prompt to answer.

1.0.17 emptied the command parts, which was not enough: the turn still ran and the model replied
with something of its own invention -- after a removal it said the provider "now connects
directly", which is the opposite of what had just happened.

Clearing the parts removes the content but not the turn. The fix is upstream of that: the command
template runs the script with `--silent`, and the script writes its result to a file and prints
nothing. The shell substitution in the template therefore expands to an empty string, the whole
command message is empty, and there is nothing for a model to respond to.

The command body is now only the shell substitution. No instruction text remains, because there
is no longer a model in the path to instruct.

The result still reaches the user: the plugin hook posts it as its own message with `noReply`,
which persists a message and skips the model loop.

`--silent` is filtered out of the argument string, since it sits before `$ARGUMENTS` in the
template and would otherwise be read as a proxy URL.

## 1.0.17

Stop `/proxy` starting a model turn at all.

The command is local: it writes a mapping. Involving a model was wrong in three ways. It showed
"Thinking..." for a command that had already finished; it could not complete at all after
`/proxy remove` disconnected the only reachable provider; and when it did complete, the model
either echoed the result a second time or had nothing to say.

`command.execute.before` receives the parts the command is about to submit. The hook now clears
them, after posting the result as its own `noReply` message. There is nothing left for a turn to
do, so no request is made.

Ordering in the hook matters and is deliberate: post the result first, then empty the parts. If it
emptied them first, the transcript would gain no message at all when the post failed.

The command template no longer instructs the model to report anything, because there is no longer
a model in the path to instruct.

## 1.0.16

Stop the /proxy result appearing twice.

1.0.15 delivered the result as its own message with `noReply`, which lands immediately. But the
command message still carried the same text, and its instruction was "Report the result above" --
so once a turn finally completed the model reproduced it, giving a second copy after the proxy was
restored.

The template now says the result has already been shown and asks for an empty reply. The
immediate message is the one the user reads; the turn's output is suppressed.

Detecting which copy was which mattered: the late one read `run /proxy directly`, losing the
`<newURL>` placeholder. That is a paraphrase, so it came from the model rather than from the
script, which is what identified it as the second delivery rather than a duplicate of the first.

## 1.0.15

Report the /proxy result independently of reachability.

The command's shell expansion always ran, so the mapping was always written. But the text was
delivered as part of the command message, which appears when the model turn ends -- and
`/proxy remove` disconnects a provider reachable only through the proxy, so the turn could not
end. The user saw "Thinking..." and nothing else until they happened to set a proxy again.

The result is now also written to `proxy-last-result.json`, and a `command.execute.before` hook
posts it into the session as its own message with `noReply: true`. The SDK documents that flag
as:

```js
if (input.noReply === true) return message;
return yield* loop({ sessionID });
```

so the message is persisted and the model loop is skipped entirely. The report arrives whether or
not any provider is reachable.

The hook only acts on the `proxy` command, consumes the file so a result is never replayed, and
ignores anything older than 15 seconds. A failure to post is logged and never breaks the turn.

Server-side ordering this depends on, which was verified in the bundle before building on it:

```js
const parts = [...uniqueTemplateParts, ...input.parts ?? []];
yield* plugin.trigger("command.execute.before", { command, sessionID, arguments }, { parts });
const result = yield* prompt({ ..., parts });
```

## 1.0.14

Say what `/proxy remove` actually does to reachability.

Removing the proxy disconnects any provider that is reachable only through it. That was not
stated, and it has a second consequence that looks like a bug: the confirmation text is delivered
when a model turn ends, and the next turn cannot complete without a route -- so the confirmation
can take a while to appear, or appear only after a proxy is set again.

Measured, with the provider reachable only through the proxy:

```
with the mapping present : HTTP 401 in 186ms
after /proxy remove      : unreachable after 10501ms (UND_ERR_CONNECT_TIMEOUT)
```

The remove output now states the consequence and points at the action that avoids it: setting a
new proxy replaces the old one, so switching proxies never needs a removal.

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
