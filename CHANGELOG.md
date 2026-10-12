# Changelog

## Unreleased

- Scoped the package as `@init3/opencode-fetch-proxy`. The unscoped name `opencode-fetch-proxy` is held by a
  registry placeholder awaiting a staged release, so it cannot be published to directly.
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
