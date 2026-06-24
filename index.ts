import type { Plugin } from "@opencode-ai/plugin"
import { mkdir, readdir, readFile, stat, unlink, writeFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import { join } from "node:path"
import { homedir, tmpdir } from "node:os"
import { fileURLToPath } from "node:url"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type MaybeFilePart = {
  type?: string
  url?: string
  image?: string
  text?: string
  mime?: string
  filename?: string
  source?: { type?: string; path?: string; [key: string]: unknown }
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
// System-prompt nudge (the "observer" pattern — non-blocking)
//
// Injected via experimental.chat.system.transform so the model reads the image
// ON-DEMAND using the already-running zai-mcp-server MCP, instead of the plugin
// blocking the chat.message hook to run OCR itself.
// ---------------------------------------------------------------------------

const IMAGE_NUDGE = `## Reading pasted images

You cannot read images directly. When a message contains a marker like \`[Image saved to: /path/to/file.png]\` (a pasted clipboard image saved to disk), do NOT use the \`read\` tool on it — it will fail. Instead, read it by calling the \`zai-mcp-server_extract_text_from_screenshot\` MCP tool with \`image_source\` set to that path (to extract text/code/errors verbatim). If the image is a UI mockup, diagram, photo, or chart rather than text, call \`zai-mcp-server_analyze_image\` instead. Use the extracted/analyzed content as your understanding of the image.`

// ---------------------------------------------------------------------------
// Base Paths
// ---------------------------------------------------------------------------

function getOpenCodeCacheDir(): string {
  if (process.env.OPENCODE_GLM_CLIPBOARD_TEST_DIR) {
    return process.env.OPENCODE_GLM_CLIPBOARD_TEST_DIR
  }
  return join(homedir(), ".cache", "opencode")
}

// ---------------------------------------------------------------------------
// models.dev cache
// ---------------------------------------------------------------------------

function cacheDir(): string {
  return join(getOpenCodeCacheDir(), "glm-clipboard")
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
  try {
    await mkdir(cacheDir(), { recursive: true })
    await writeFile(cachePath(), JSON.stringify({ v: CACHE_VERSION, data }))
  } catch {
    // cache is best-effort; never break the chat over it
  }
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
// Unified image source resolution
//
// OpenCode delivers pasted images in two shapes:
//   Cmd+V → FilePart.url is a `data:image/...;base64,...` data URL
//   Ctrl+V → FilePart references a temp file PATH (source.path, url, or filename)
// This helper normalizes both into a single { kind, ... } so the per-part
// handler can treat them uniformly.
// ---------------------------------------------------------------------------

type ResolvedImageSource =
  | { kind: "data"; bytes: Buffer; mimeType: string }
  | { kind: "file"; filePath: string; mimeType: string }

const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg"])

function extFromPath(filePath: string): string {
  const dot = filePath.lastIndexOf(".")
  if (dot === -1) return ""
  return filePath.slice(dot + 1).toLowerCase()
}

function isImageByExt(filePath: string): boolean {
  return IMAGE_EXTENSIONS.has(extFromPath(filePath))
}

function looksLikeAbsolutePath(p: string): boolean {
  if (!p) return false
  return p.startsWith("/") || /^[A-Za-z]:[\\/]/.test(p)
}

/**
 * Resolve a part's image payload into a unified source descriptor.
 *
 * Returns `{ kind: "data", bytes, mimeType }` for data URLs,
 * `{ kind: "file", filePath, mimeType }` for file-path references,
 * or `null` if the part is not an image we can handle.
 *
 * NEVER throws — all resolution steps are wrapped defensively.
 */
function resolveImageSource(
  p: MaybeFilePart,
  saveDir: string,
): ResolvedImageSource | null {
  const partMime = typeof p.mime === "string" ? p.mime.toLowerCase() : undefined
  const isImageMime = !!partMime && partMime.startsWith("image/")

  // Gate: is this path an image (by declared mime or file extension)?
  const pathIsImage = (fp: string): boolean => isImageMime || isImageByExt(fp)

  // 1) data: URL (parseDataUrl validates image/*)
  const dataUrl =
    typeof p.url === "string"
      ? p.url
      : typeof p.image === "string"
        ? p.image
        : null
  if (dataUrl && dataUrl.startsWith("data:")) {
    try {
      const parsed = parseDataUrl(dataUrl) // can throw URIError on bad escapes
      if (parsed && parsed.mimeType.startsWith("image/")) {
        return { kind: "data", bytes: parsed.bytes, mimeType: parsed.mimeType }
      }
    } catch (e) {
      console.warn(
        "opencode-glm-clipboard: malformed data URL in part:",
        (e as Error).message,
      )
    }
    // data: URL but not an image, or malformed — do NOT fall through to
    // file-path strategies (the URL clearly intended to be inline data).
    return null
  }

  const url = typeof p.url === "string" ? p.url : null

  // 2) file: URL → resolve to a real path
  if (url && /^file:/i.test(url)) {
    try {
      const filePath = fileURLToPath(url)
      if (existsSync(filePath) && pathIsImage(filePath)) {
        return {
          kind: "file",
          filePath,
          mimeType: partMime ?? `image/${extFromPath(filePath) || "x"}`,
        }
      }
    } catch {
      // invalid file: URL — fall through to other strategies
    }
  }

  // 3) source.path — SDK FileSource.path (most likely home for Ctrl+V temp path).
  //    No existence check: trust the SDK; the system nudge tells the model to
  //    read it on-demand, and if the file is missing the MCP tool will report
  //    that — the chat still works.
  const srcPath = p.source?.path
  if (typeof srcPath === "string" && srcPath.trim()) {
    const filePath = srcPath.trim()
    if (pathIsImage(filePath)) {
      return {
        kind: "file",
        filePath,
        mimeType: partMime ?? `image/${extFromPath(filePath) || "x"}`,
      }
    }
  }

  // 4) url looks like an absolute path and exists on disk
  if (url && looksLikeAbsolutePath(url)) {
    try {
      if (existsSync(url) && pathIsImage(url)) {
        return {
          kind: "file",
          filePath: url,
          mimeType: partMime ?? `image/${extFromPath(url) || "x"}`,
        }
      }
    } catch {
      // existsSync can theoretically throw on some platforms — swallow
    }
  }

  // 5) filename → best-effort resolve in os.tmpdir() and saveDir
  const filename = typeof p.filename === "string" ? p.filename.trim() : null
  if (filename) {
    try {
      for (const dir of [tmpdir(), saveDir]) {
        const candidate = join(dir, filename)
        if (existsSync(candidate) && pathIsImage(candidate)) {
          return {
            kind: "file",
            filePath: candidate,
            mimeType: partMime ?? `image/${extFromPath(candidate) || "x"}`,
          }
        }
      }
    } catch {
      // swallow
    }
  }

  return null
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

export const GLMClipboardImagePlugin: Plugin = async () => {
  const saveDir = join(getOpenCodeCacheDir(), "pasted-images")
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

  /** Cheap gate used by BOTH hooks (no models.dev call — keeps it fast). */
  function isTextOnlyModel(providerID: string, modelID: string): boolean {
    if (!TEXT_ONLY_PROVIDERS.has(providerID) && !modelID.startsWith("glm-")) return false
    if (IMAGE_CAPABLE.has(`${providerID}/${modelID}`)) return false
    return true
  }

  return {
    // -----------------------------------------------------------------------
    // chat.message: non-blocking path injection.
    // Replaces image parts (data URL or file-path) with a text marker pointing
    // at the saved file. The model reads it on-demand via the MCP tools (see
    // the system nudge below). NO OCR happens here — the hook returns fast.
    // -----------------------------------------------------------------------
    "chat.message": async (input, output) => {
      const providerID = input.model?.providerID ?? ""
      const modelID = output.message.model?.modelID ?? input.model?.modelID ?? ""

      if (!isTextOnlyModel(providerID, modelID)) return

      // If the model supports images natively (via models.dev cache), bail.
      if (await supportsImages(providerID, modelID)) return

      try {
        await mkdir(saveDir, { recursive: true })
      } catch (e) {
        console.warn(
          "opencode-glm-clipboard: could not create save dir:",
          (e as Error).message,
        )
        return
      }
      await cleanupTempFiles(saveDir, maxAgeMs)

      const nextParts = await Promise.all(
        output.parts.map(async (part) => {
          // NEVER let a part escape. Any error returns the original part so
          // sibling parts survive.
          try {
            const p = part as MaybeFilePart

            const source = resolveImageSource(p, saveDir)
            if (!source) return part

            let filePath: string
            if (source.kind === "data") {
              // Inline data URL — save bytes to saveDir (writeFile try/catch)
              const ts = Date.now()
              const rand = Math.random().toString(36).slice(2, 8)
              const ext = extensionFromMime(source.mimeType)
              filePath = join(saveDir, `paste-${ts}-${rand}.${ext}`)
              try {
                await writeFile(filePath, source.bytes)
              } catch (e) {
                console.warn(
                  "opencode-glm-clipboard: could not write pasted image:",
                  (e as Error).message,
                )
                return part
              }
            } else {
              // File already exists on disk — use the path directly (no re-copy).
              filePath = source.filePath
            }

            return {
              ...p,
              type: "text" as const,
              text: `[Image saved to: ${filePath}]`,
            }
          } catch (e) {
            console.warn(
              "opencode-glm-clipboard: image part transform failed:",
              (e as Error).message,
            )
            return part
          }
        }),
      )

      output.parts.splice(0, output.parts.length, ...(nextParts as typeof output.parts))
    },

    // -----------------------------------------------------------------------
    // experimental.chat.system.transform: inject the image-reading nudge.
    // Tells the model to use zai-mcp-server MCP tools to read saved images
    // on-demand instead of the `read` tool (which fails for non-vision models).
    // -----------------------------------------------------------------------
    "experimental.chat.system.transform": async (input, output) => {
      const providerID = input.model?.providerID ?? ""
      const modelID = input.model?.id ?? ""

      if (!isTextOnlyModel(providerID, modelID)) return

      // Dedupe — don't push the nudge twice.
      if (output.system.includes(IMAGE_NUDGE)) return
      output.system.push(IMAGE_NUDGE)
    },
  }
}

export default GLMClipboardImagePlugin
