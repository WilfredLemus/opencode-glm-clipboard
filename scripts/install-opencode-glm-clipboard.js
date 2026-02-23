#!/usr/bin/env node

import { existsSync } from "node:fs"
import { mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { applyEdits, modify, parse, printParseErrorCode } from "jsonc-parser"

const PLUGIN_NAME = "opencode-glm-clipboard"
const args = new Set(process.argv.slice(2))
const dryRun = args.has("--dry-run")
const uninstall = args.has("--uninstall")

if (args.has("--help") || args.has("-h")) {
  console.log(
    `Usage: ${PLUGIN_NAME} [--uninstall] [--dry-run]\n\n` +
      "Default behavior:\n" +
      "  - Adds plugin to ~/.config/opencode/opencode.jsonc (or .json)\n" +
      "  - Clears OpenCode plugin cache for this plugin\n\n" +
      "Options:\n" +
      "  --uninstall    Remove plugin entry from OpenCode config\n" +
      "  --dry-run      Print actions without writing files\n",
  )
  process.exit(0)
}

const configDir = join(homedir(), ".config", "opencode")
const configPathJson = join(configDir, "opencode.json")
const configPathJsonc = join(configDir, "opencode.jsonc")
const cacheDir = join(homedir(), ".cache", "opencode")
const cacheNodeModules = join(cacheDir, "node_modules", PLUGIN_NAME)

const JSONC_PARSE_OPTIONS = { allowTrailingComma: true, disallowComments: false }
const JSONC_FORMAT_OPTIONS = { insertSpaces: true, tabSize: 2, eol: "\n" }

function resolveConfigPath() {
  if (existsSync(configPathJsonc)) return configPathJsonc
  if (existsSync(configPathJson)) return configPathJson
  return configPathJsonc
}

function normalizePluginList(list) {
  const entries = Array.isArray(list) ? list.filter(Boolean) : []
  const withoutCurrent = entries.filter((entry) => {
    if (typeof entry !== "string") return true
    return entry !== PLUGIN_NAME && !entry.startsWith(`${PLUGIN_NAME}@`)
  })
  return [...withoutCurrent, PLUGIN_NAME]
}

function removePluginEntries(list) {
  const entries = Array.isArray(list) ? list.filter(Boolean) : []
  return entries.filter((entry) => {
    if (typeof entry !== "string") return true
    if (entry === PLUGIN_NAME || entry.startsWith(`${PLUGIN_NAME}@`)) return false
    return !entry.includes(PLUGIN_NAME)
  })
}

function applyJsoncUpdate(content, path, value) {
  const edits = modify(content, path, value, {
    formattingOptions: JSONC_FORMAT_OPTIONS,
  })
  const next = applyEdits(content, edits)
  return next.endsWith("\n") ? next : `${next}\n`
}

async function readConfig(configPath) {
  const content = await readFile(configPath, "utf-8")
  const errors = []
  const data = parse(content, errors, JSONC_PARSE_OPTIONS)
  if (errors.length) {
    const detail = errors.map((error) => printParseErrorCode(error.error)).join(", ")
    throw new Error(`Invalid JSONC (${detail})`)
  }
  return { content, data: data ?? {} }
}

async function writeConfig(configPath, content) {
  if (dryRun) {
    console.log(`[dry-run] Would write ${configPath}`)
    return
  }
  await mkdir(dirname(configPath), { recursive: true })
  await writeFile(configPath, content, "utf-8")
}

async function clearPluginCache() {
  if (dryRun) {
    console.log(`[dry-run] Would remove ${cacheNodeModules}`)
    return
  }
  await rm(cacheNodeModules, { recursive: true, force: true })
}

async function install() {
  const configPath = resolveConfigPath()
  if (!existsSync(configPath)) {
    const next = `${JSON.stringify({ plugin: [PLUGIN_NAME] }, null, 2)}\n`
    await writeConfig(configPath, next)
    console.log(`${dryRun ? "Would create" : "Created"} ${configPath}`)
    await clearPluginCache()
    return
  }

  const { content, data } = await readConfig(configPath)
  const nextPlugins = normalizePluginList(data.plugin)
  const nextContent = applyJsoncUpdate(content, ["plugin"], nextPlugins)
  await writeConfig(configPath, nextContent)
  console.log(`${dryRun ? "Would update" : "Updated"} ${configPath}`)
  await clearPluginCache()
}

async function uninstallPlugin() {
  const configPath = resolveConfigPath()
  if (!existsSync(configPath)) {
    console.log("No OpenCode config found. Nothing to uninstall.")
    return
  }

  const { content, data } = await readConfig(configPath)
  const nextPlugins = removePluginEntries(data.plugin)
  const nextContent = applyJsoncUpdate(content, ["plugin"], nextPlugins.length ? nextPlugins : undefined)
  await writeConfig(configPath, nextContent)
  console.log(`${dryRun ? "Would update" : "Updated"} ${configPath}`)
  await clearPluginCache()
}

async function main() {
  if (uninstall) {
    await uninstallPlugin()
    console.log("Done. Restart OpenCode.")
    return
  }

  await install()
  console.log("Done. Restart OpenCode.")
}

main().catch((error) => {
  console.error(`Installer failed: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
})
