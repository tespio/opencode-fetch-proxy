#!/usr/bin/env node
// Copies the plugin into OpenCode's global plugin directory as a single file.
//
//   node install.js            copy (refuses to overwrite a different file)
//   node install.js --force    overwrite whatever is there
//   node install.js --print    show the target path and exit
//
// Why a script rather than "drop the file here": the published file is called index.js, but
// OpenCode's auto-discovery only matches direct children of plugins/ ending in .js or .ts. Copying
// index.js straight in would work, but leaving it named index.js next to other plugins is
// confusing, and a subdirectory would not be discovered at all. This does the rename for you.

import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const here = path.dirname(fileURLToPath(import.meta.url))
const source = path.join(here, "index.js")

// OpenCode resolves its config to ~/.config/opencode on every platform, Windows included; it does
// not use %APPDATA%. OPENCODE_CONFIG_DIR and XDG_CONFIG_HOME take precedence, so honour them.
function configDir() {
  if (process.env.OPENCODE_CONFIG_DIR) return process.env.OPENCODE_CONFIG_DIR
  if (process.env.XDG_CONFIG_HOME) return path.join(process.env.XDG_CONFIG_HOME, "opencode")
  return path.join(os.homedir(), ".config", "opencode")
}

const target = path.join(configDir(), "plugins", "opencode-fetch-proxy.js")
const force = process.argv.includes("--force")
const printOnly = process.argv.includes("--print")

if (printOnly) {
  console.log(target)
  process.exit(0)
}

if (!fs.existsSync(source)) {
  console.error(`Cannot find ${source}. Run this from the package directory.`)
  process.exit(1)
}

if (!fs.existsSync(target) || force) {
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.copyFileSync(source, target)
  console.log(`installed -> ${target}`)
} else {
  const same = fs.readFileSync(source, "utf8") === fs.readFileSync(target, "utf8")
  if (same) {
    console.log(`already installed and identical -> ${target}`)
  } else {
    console.log(`a different file already exists at ${target}`)
    console.log("re-run with --force to replace it")
    process.exit(1)
  }
}

console.log("")
console.log("Restart OpenCode, then confirm it loaded. With log enabled in proxy.json, look for:")
console.log("  [fetch-proxy] active - per-provider proxies only (options.proxy or /proxy)")
console.log("")
console.log("If that line is absent, the plugin was skipped. The usual causes:")
console.log("  - the config key must be `plugin`, not `plugins`")
console.log("  - a file in plugins/ must end in .js or .ts (.mjs is skipped)")
console.log("  - a file inside a subdirectory is not auto-discovered; declare the path instead")
