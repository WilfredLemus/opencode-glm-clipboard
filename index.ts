import type { Plugin } from "@opencode-ai/plugin"
import { mkdir, readdir, readFile, stat, unlink, writeFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import { join } from "node:path"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type MaybeFilePart = {
  type?: string
  url?: string
  image?: string
  text?: string
  [key: string]: unknown
}

type ModelsDevEntry = {
  modalities?: { input?: string[]; output?: string[] }
  attachment?: boolean
}

type CapabilityCache = {
  v: number
  data: Record<string, boolean>
}

const CACHE_VERSION = 2

const DATA_URL_REGEX = /^data:([^;,]+)?(?:;charset=[^;,]+)?(;base64)?,([\s\S]*)$/i
const MODELS_DEV_URL = "https://models.dev/api.json"
const DEFAULT_MAX_AGE_MS = 24 * 60 * 60 * 1000

// ---------------------------------------------------------------------------
// Model capability knowledge
// ---------------------------------------------------------------------------

const IMAGE_CAPABLE = new Set([
  "CrofAI/kimi-k2.6",
  "CrofAI/kimi-k2.6-precision",
])

const TEXT_ONLY_PROVIDERS = new Set(["CrofAI", "zai-coding-plan"])

// ---------------------------------------------------------------------------
// models.dev cache
// ---------------------------------------------------------------------------

function cacheDir(): string {
  return join(process.env.TMPDIR || "/tmp", "opencode-glm-clipboard")
}

function cachePath(): string {
  return join(cacheDir(), "model-capabilities.json")
}

async function readCache(): Promise<Record<string, boolean>> {
  const p = cachePath()
  if (!existsSync(p)) return {}
  try {
    const raw = JSON.parse(await readFile(p, "utf-8")) as CapabilityCache
    return raw.v === CACHE_VERSION ? raw.data : {}
  } catch {
    return {}
  }
}

async function writeCache(data: Record<string, boolean>): Promise<void> {
  await mkdir(cacheDir(), { recursive: true })
  await writeFile(cachePath(), JSON.stringify({ v: CACHE_VERSION, data }))
}

async function fetchImageSupport(modelID: string): Promise<boolean | undefined> {
  try {
    const resp = await fetch(MODELS_DEV_URL, { signal: AbortSignal.timeout(10_000) })
    if (!resp.ok) return undefined
    const data = JSON.parse(await resp.text()) as Record<string, any>
    for (const provider of Object.values(data)) {
      const models = provider?.models as Record<string, ModelsDevEntry> | undefined
      if (!models) continue
      const entry = models[modelID]
      if (!entry) continue
      if (entry.modalities?.input?.includes("image")) return true
    }
    return false
  } catch {
    return undefined
  }
}

// ---------------------------------------------------------------------------
// Image file helpers
// ---------------------------------------------------------------------------

function parseDataUrl(url: string) {
  const match = DATA_URL_REGEX.exec(url)
  if (!match) return null
  const mimeType = (match[1] || "application/octet-stream").toLowerCase()
  const isBase64 = Boolean(match[2])
  const payload = match[3] || ""
  return isBase64
    ? { mimeType, bytes: Buffer.from(payload, "base64") }
    : { mimeType, bytes: Buffer.from(decodeURIComponent(payload), "utf8") }
}

function extensionFromMime(mimeType: string) {
  if (mimeType === "image/jpeg") return "jpg"
  if (mimeType === "image/svg+xml") return "svg"
  const slash = mimeType.indexOf("/")
  if (slash === -1) return "bin"
  return mimeType.slice(slash + 1).replace(/[^a-z0-9.+-]/gi, "") || "bin"
}

function cleanupMaxAgeMs() {
  const raw = process.env.OPENCODE_GLM_CLIPBOARD_MAX_AGE_HOURS
  if (!raw) return DEFAULT_MAX_AGE_MS
  const hours = Number(raw)
  return Number.isFinite(hours) && hours > 0 ? hours * 60 * 60 * 1000 : DEFAULT_MAX_AGE_MS
}

async function cleanupTempFiles(saveDir: string, maxAgeMs: number, now = Date.now()) {
  const entries = await readdir(saveDir).catch(() => [])
  await Promise.all(
    entries
      .filter((n) => n.startsWith("paste-") && n.includes("."))
      .map(async (name) => {
        const fp = join(saveDir, name)
        const info = await stat(fp).catch(() => undefined)
        if (info?.isFile() && now - info.mtimeMs > maxAgeMs) await unlink(fp).catch(() => {})
      }),
  )
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

export const GLMClipboardImagePlugin: Plugin = async () => {
  const tmpRoot = process.env.TMPDIR || "/tmp"
  const saveDir = join(tmpRoot, "opencode-pasted-images")
  const maxAgeMs = cleanupMaxAgeMs()

  // In-memory cache for the session — populated lazily
  let memCache: Record<string, boolean> | null = null

  async function supportsImages(providerID: string, modelID: string): Promise<boolean> {
    const key = `${providerID}/${modelID}`
    if (IMAGE_CAPABLE.has(key)) return true
    if (!memCache) memCache = await readCache()
    if (key in memCache) return memCache[key]!

    const result = await fetchImageSupport(modelID)
    const yes = result === true
    memCache[key] = yes
    await writeCache(memCache)
    return yes
  }

  return {
    "chat.message": async (input, output) => {
      const providerID = input.model?.providerID ?? ""
      const modelID = output.message.model?.modelID ?? input.model?.modelID ?? ""

      // Only intercept providers that don't declare image support
      if (!TEXT_ONLY_PROVIDERS.has(providerID) && !modelID.startsWith("glm-")) return

      // If the model supports images natively, let OpenCode handle it
      if (await supportsImages(providerID, modelID)) return

      // Text-only model — save image to disk, replace with file path
      await mkdir(saveDir, { recursive: true })
      await cleanupTempFiles(saveDir, maxAgeMs)

      const nextParts = await Promise.all(
        output.parts.map(async (part) => {
          const p = part as MaybeFilePart
          const dataUrl =
            typeof p.url === "string"
              ? p.url
              : typeof p.image === "string"
                ? p.image
                : null
          if (!dataUrl || !dataUrl.startsWith("data:")) return part

          const parsed = parseDataUrl(dataUrl)
          if (!parsed || !parsed.mimeType.startsWith("image/")) return part

          const ts = Date.now()
          const rand = Math.random().toString(36).slice(2, 8)
          const ext = extensionFromMime(parsed.mimeType)
          const filePath = join(saveDir, `paste-${ts}-${rand}.${ext}`)
          await writeFile(filePath, parsed.bytes)

          return { ...p, type: "text" as const, text: `📷 Image: ${filePath}` }
        }),
      )

      output.parts.splice(0, output.parts.length, ...(nextParts as typeof output.parts))
    },
  }
}

export default GLMClipboardImagePlugin
