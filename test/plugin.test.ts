import { mkdir, mkdtemp, readdir, stat, utimes, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { beforeEach, describe, expect, it, vi } from "vitest"
import GLMClipboardImagePlugin from "../index"

const SAMPLE_PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wnq0JwAAAAASUVORK5CYII="

function createInput(modelID: string, providerID?: string) {
  return { model: { modelID, providerID: providerID ?? "" } }
}

function createOutput(parts: unknown[], modelID?: string) {
  return {
    message: { model: modelID ? { modelID } : undefined },
    parts,
  }
}

describe("GLMClipboardImagePlugin", () => {
  let tempRoot: string

  beforeEach(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "glm-clipboard-test-"))
    process.env.TMPDIR = tempRoot
  })

  // -------------------------------------------------------------------------
  // Text-only models → convert image to file path
  // -------------------------------------------------------------------------

  it("converts pasted image for GLM model IDs", async () => {
    const plugin = await GLMClipboardImagePlugin({} as never)
    const output = createOutput([
      { type: "text", text: "read this" },
      { type: "image", image: SAMPLE_PNG },
    ])

    await plugin["chat.message"]?.(createInput("glm-5") as never, output as never)

    const transformed = output.parts[1] as { type: string; text?: string }
    expect(transformed.type).toBe("text")
    expect(transformed.text).toMatch(/ — OCR$/)
    expect(transformed.text).not.toContain("A pasted image is available")

    const files = await readdir(join(tempRoot, "opencode-pasted-images"))
    expect(files.length).toBe(1)
  })

  it("converts pasted image for CrofAI text-only models", async () => {
    const plugin = await GLMClipboardImagePlugin({} as never)
    const output = createOutput([{ type: "image", image: SAMPLE_PNG }])

    await plugin["chat.message"]?.(
      createInput("deepseek-v4-pro", "CrofAI") as never,
      output as never,
    )

    const transformed = output.parts[0] as { type: string; text?: string }
    expect(transformed.type).toBe("text")
    expect(transformed.text).toMatch(/ — OCR$/)
    expect(transformed.text).not.toContain("A pasted image is available")
  })

  it("converts pasted image for zai-coding-plan text-only models", async () => {
    const plugin = await GLMClipboardImagePlugin({} as never)
    const output = createOutput([{ type: "image", image: SAMPLE_PNG }])

    await plugin["chat.message"]?.(
      createInput("glm-5.1", "zai-coding-plan") as never,
      output as never,
    )

    const transformed = output.parts[0] as { type: string; text?: string }
    expect(transformed.type).toBe("text")
    expect(transformed.text).toMatch(/ — OCR$/)
    expect(transformed.text).not.toContain("A pasted image is available")
  })

  // -------------------------------------------------------------------------
  // Image-capable models → pass-through (no conversion)
  // -------------------------------------------------------------------------

  it("keeps image for CrofAI kimi-k2.6 (image-capable)", async () => {
    const plugin = await GLMClipboardImagePlugin({} as never)
    const output = createOutput([{ type: "image", image: SAMPLE_PNG }])

    await plugin["chat.message"]?.(
      createInput("kimi-k2.6", "CrofAI") as never,
      output as never,
    )

    const part = output.parts[0] as { type: string; image?: string }
    expect(part.type).toBe("image")
    expect(part.image?.startsWith("data:image/png")).toBe(true)
  })

  it("keeps image for CrofAI kimi-k2.6-precision (image-capable)", async () => {
    const plugin = await GLMClipboardImagePlugin({} as never)
    const output = createOutput([{ type: "image", image: SAMPLE_PNG }])

    await plugin["chat.message"]?.(
      createInput("kimi-k2.6-precision", "CrofAI") as never,
      output as never,
    )

    const part = output.parts[0] as { type: string; image?: string }
    expect(part.type).toBe("image")
    expect(part.image?.startsWith("data:image/png")).toBe(true)
  })

  // -------------------------------------------------------------------------
  // Providers not in scope → no interception
  // -------------------------------------------------------------------------

  it("does not intercept non-target providers", async () => {
    const plugin = await GLMClipboardImagePlugin({} as never)
    const output = createOutput([{ type: "image", image: SAMPLE_PNG }])

    await plugin["chat.message"]?.(createInput("gpt-4o", "openai") as never, output as never)

    const part = output.parts[0] as { type: string; image?: string }
    expect(part.type).toBe("image")
    expect(part.image?.startsWith("data:image/png")).toBe(true)
  })

  // -------------------------------------------------------------------------
  // Backwards compatibility
  // -------------------------------------------------------------------------

  it("handles legacy parts with url field", async () => {
    const plugin = await GLMClipboardImagePlugin({} as never)
    const output = createOutput([
      {
        type: "file",
        mime: "image/png",
        filename: "paste.png",
        url: SAMPLE_PNG,
      },
    ])

    await plugin["chat.message"]?.(createInput("glm-5") as never, output as never)

    const transformed = output.parts[0] as { type: string; text?: string }
    expect(transformed.type).toBe("text")
    expect(transformed.text).toMatch(/ — OCR$/)
    expect(transformed.text).not.toContain("A pasted image is available")
  })

  // -------------------------------------------------------------------------
  // Temp file cleanup
  // -------------------------------------------------------------------------

  it("cleans old temp files based on max age env var", async () => {
    process.env.OPENCODE_GLM_CLIPBOARD_MAX_AGE_HOURS = "0.0001"

    const saveDir = join(tempRoot, "opencode-pasted-images")
    await mkdir(saveDir, { recursive: true })
    await writeFile(join(saveDir, "placeholder"), "", { flag: "a" })

    const stalePath = join(saveDir, "paste-old.png")
    await writeFile(stalePath, Buffer.from([1, 2, 3]))
    const oldTime = new Date(Date.now() - 60_000)
    await utimes(stalePath, oldTime, oldTime)

    const plugin = await GLMClipboardImagePlugin({} as never)
    const output = createOutput([{ type: "image", image: SAMPLE_PNG }])

    await plugin["chat.message"]?.(createInput("glm-4.7") as never, output as never)

    await expect(stat(stalePath)).rejects.toThrow()
  })
})
