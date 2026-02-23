import type { Plugin } from "@opencode-ai/plugin"
import { mkdir, readdir, stat, unlink, writeFile } from "node:fs/promises"
import { join } from "node:path"

type MaybeFilePart = {
  type?: string
  url?: string
  mediaType?: string
  filename?: string
  text?: string
  [key: string]: unknown
}

const DATA_URL_REGEX = /^data:([^;,]+)?(?:;charset=[^;,]+)?(;base64)?,([\s\S]*)$/i
const DEFAULT_MAX_AGE_MS = 24 * 60 * 60 * 1000

function parseDataUrl(url: string) {
  const match = DATA_URL_REGEX.exec(url)
  if (!match) return null

  const mimeType = (match[1] || "application/octet-stream").toLowerCase()
  const isBase64 = Boolean(match[2])
  const payload = match[3] || ""

  if (isBase64) {
    return {
      mimeType,
      bytes: Buffer.from(payload, "base64"),
    }
  }

  return {
    mimeType,
    bytes: Buffer.from(decodeURIComponent(payload), "utf8"),
  }
}

function extensionFromMime(mimeType: string) {
  if (mimeType === "image/jpeg") return "jpg"
  if (mimeType === "image/svg+xml") return "svg"
  const slash = mimeType.indexOf("/")
  if (slash === -1) return "bin"
  return mimeType.slice(slash + 1).replace(/[^a-z0-9.+-]/gi, "") || "bin"
}

function resolveCleanupMaxAgeMs() {
  const raw = process.env.OPENCODE_GLM_CLIPBOARD_MAX_AGE_HOURS
  if (!raw) return DEFAULT_MAX_AGE_MS
  const hours = Number(raw)
  if (!Number.isFinite(hours) || hours <= 0) return DEFAULT_MAX_AGE_MS
  return hours * 60 * 60 * 1000
}

async function cleanupOldTempImages(saveDir: string, maxAgeMs: number, now = Date.now()) {
  const entries = await readdir(saveDir).catch(() => [])

  await Promise.all(
    entries
      .filter((name) => name.startsWith("paste-") && name.includes("."))
      .map(async (name) => {
        const filePath = join(saveDir, name)
        const info = await stat(filePath).catch(() => undefined)
        if (!info?.isFile()) return
        if (now - info.mtimeMs <= maxAgeMs) return
        await unlink(filePath).catch(() => {})
      }),
  )
}

export const GLMClipboardImagePlugin: Plugin = async () => {
  const tmpRoot = process.env.TMPDIR || "/tmp"
  const saveDir = join(tmpRoot, "opencode-pasted-images")
  const maxAgeMs = resolveCleanupMaxAgeMs()

  return {
    "chat.message": async (input, output) => {
      const modelID = output.message.model?.modelID ?? input.model?.modelID ?? ""
      if (!modelID.startsWith("glm-")) return

      await mkdir(saveDir, { recursive: true })
      await cleanupOldTempImages(saveDir, maxAgeMs)

      const nextParts = await Promise.all(
        output.parts.map(async (part) => {
          const maybePart = part as MaybeFilePart
          if (!maybePart || typeof maybePart.url !== "string") return part
          if (!maybePart.url.startsWith("data:")) return part

          const parsed = parseDataUrl(maybePart.url)
          if (!parsed) return part
          if (!parsed.mimeType.startsWith("image/")) return part

          const timestamp = Date.now()
          const random = Math.random().toString(36).slice(2, 10)
          const ext = extensionFromMime(parsed.mimeType)
          const fileName = `paste-${timestamp}-${random}.${ext}`
          const filePath = join(saveDir, fileName)

          await writeFile(filePath, parsed.bytes)

          return {
            ...maybePart,
            type: "text",
            text:
              `A pasted image is available at this local path: ${filePath}. ` +
              `Do not say image input is unsupported. Use available image-analysis tools with this file path and answer the user request.`,
          }
        }),
      )

      output.parts.splice(0, output.parts.length, ...(nextParts as typeof output.parts))
    },
  }
}

export default GLMClipboardImagePlugin
