import { chmod, mkdir, mkdtemp, readdir, stat, utimes, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
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
    process.env.OPENCODE_GLM_CLIPBOARD_TEST_DIR = tempRoot
  })

  afterEach(() => {
    delete process.env.OPENCODE_GLM_CLIPBOARD_MAX_AGE_HOURS
    vi.restoreAllMocks()
  })

  // -------------------------------------------------------------------------
  // 1. data-URL image → path marker text
  // -------------------------------------------------------------------------

  it("converts data-URL image to [Image saved to: ...] marker for GLM model", async () => {
    const plugin = await GLMClipboardImagePlugin({} as never)
    const output = createOutput([{ type: "image", image: SAMPLE_PNG }])

    await plugin["chat.message"]?.(createInput("glm-5") as never, output as never)

    const transformed = output.parts[0] as { type: string; text?: string }
    expect(transformed.type).toBe("text")
    expect(transformed.text).toMatch(/^\[Image saved to: .+paste-[\w-]+\.png\]$/)
    expect(transformed.text).not.toContain(" — OCR")
    expect(transformed.text).not.toContain("Image content (via")

    const files = await readdir(join(tempRoot, "pasted-images"))
    expect(files.length).toBe(1)
  })

  // -------------------------------------------------------------------------
  // 2. file-path FilePart via source.path → path marker (no re-save)
  // -------------------------------------------------------------------------

  it("converts file-path FilePart via source.path to marker without re-saving", async () => {
    const tempFile = join(tempRoot, "clipboard-ctrl-v-001.png")
    await writeFile(tempFile, Buffer.from([0x89, 0x50, 0x4e, 0x47]))

    const plugin = await GLMClipboardImagePlugin({} as never)
    const output = createOutput([
      {
        type: "file",
        mime: "image/png",
        url: "clipboard-x.png",
        source: {
          type: "file",
          path: tempFile,
          text: { value: "", start: 0, end: 0 },
        },
      },
    ])

    await plugin["chat.message"]?.(createInput("glm-5") as never, output as never)

    const transformed = output.parts[0] as { type: string; text?: string }
    expect(transformed.type).toBe("text")
    expect(transformed.text).toBe(`[Image saved to: ${tempFile}]`)

    // No file should have been written to saveDir (file-kind uses the path
    // directly).
    const savedFiles = await readdir(join(tempRoot, "pasted-images")).catch(
      () => [] as string[],
    )
    expect(savedFiles.length).toBe(0)
  })

  // -------------------------------------------------------------------------
  // 3. non-image FilePart skipped
  // -------------------------------------------------------------------------

  it("skips non-image FileParts (text/plain data URL)", async () => {
    const plugin = await GLMClipboardImagePlugin({} as never)
    const output = createOutput([
      { type: "file", mime: "text/plain", url: "data:text/plain;base64,AAA" },
    ])

    await plugin["chat.message"]?.(createInput("glm-5") as never, output as never)

    const part = output.parts[0] as { type: string; url?: string }
    expect(part.type).toBe("file")
    expect(part.url).toBe("data:text/plain;base64,AAA")
  })

  // -------------------------------------------------------------------------
  // 4. image-capable model passthrough
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

  // -------------------------------------------------------------------------
  // 5. non-target provider passthrough
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
  // 6. never-throw guarantees
  // -------------------------------------------------------------------------

  it("preserves the part and does not throw when writeFile fails", async () => {
    if (process.getuid && process.getuid() === 0) {
      console.warn("Skipping writeFile-failure test: running as root.")
      return
    }

    const saveDir = join(tempRoot, "pasted-images")
    await mkdir(saveDir, { recursive: true })
    await chmod(saveDir, 0o555)

    vi.spyOn(console, "warn").mockImplementation(() => {})

    try {
      const plugin = await GLMClipboardImagePlugin({} as never)
      const output = createOutput([{ type: "image", image: SAMPLE_PNG }])

      await expect(
        plugin["chat.message"]?.(createInput("glm-5") as never, output as never),
      ).resolves.toBeUndefined()

      const part = output.parts[0] as { type: string; image?: string }
      expect(part.type).toBe("image")
      expect(part.image).toBe(SAMPLE_PNG)
    } finally {
      await chmod(saveDir, 0o755).catch(() => {})
    }
  })

  it("preserves the part and does not throw on malformed data URL", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {})

    const plugin = await GLMClipboardImagePlugin({} as never)
    const output = createOutput([{ type: "image", image: "data:image/png,%zz" }])

    await expect(
      plugin["chat.message"]?.(createInput("glm-5") as never, output as never),
    ).resolves.toBeUndefined()

    const part = output.parts[0] as { type: string; image?: string }
    expect(part.type).toBe("image")
    expect(part.image).toBe("data:image/png,%zz")
  })

  it("does not let a single bad image kill sibling parts in one message", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {})

    const plugin = await GLMClipboardImagePlugin({} as never)
    const output = createOutput([
      { type: "text", text: "hello" },
      { type: "image", image: "data:image/png,%zz" },
      { type: "text", text: "world" },
    ])

    await expect(
      plugin["chat.message"]?.(createInput("glm-5") as never, output as never),
    ).resolves.toBeUndefined()

    expect(output.parts.length).toBe(3)

    const first = output.parts[0] as { type: string; text?: string }
    expect(first.text).toBe("hello")

    const middle = output.parts[1] as { type: string; image?: string }
    expect(middle.type).toBe("image")
    expect(middle.image).toBe("data:image/png,%zz")

    const last = output.parts[2] as { type: string; text?: string }
    expect(last.text).toBe("world")
  })

  // -------------------------------------------------------------------------
  // 7. system.transform injects the nudge for text-only GLM models
  // -------------------------------------------------------------------------

  it("injects the image-reading nudge via system.transform for a text-only GLM model", async () => {
    const plugin = await GLMClipboardImagePlugin({} as never)

    const sysOutput = { system: [] as string[] }
    await plugin["experimental.chat.system.transform"]?.(
      {
        sessionID: "s1",
        model: {
          id: "glm-5.2",
          providerID: "zai-coding-plan",
        } as never,
      },
      sysOutput as never,
    )

    expect(sysOutput.system.length).toBe(1)
    expect(sysOutput.system[0]).toContain("zai-mcp-server_extract_text_from_screenshot")
    expect(sysOutput.system[0]).toContain("[Image saved to:")
    expect(sysOutput.system[0]).toContain("zai-mcp-server_analyze_image")
  })

  // -------------------------------------------------------------------------
  // 8. system.transform SKIPS for image-capable model
  // -------------------------------------------------------------------------

  it("does NOT inject the nudge for image-capable models", async () => {
    const plugin = await GLMClipboardImagePlugin({} as never)

    const sysOutput = { system: [] as string[] }
    await plugin["experimental.chat.system.transform"]?.(
      {
        model: {
          id: "kimi-k2.6",
          providerID: "CrofAI",
        } as never,
      },
      sysOutput as never,
    )

    expect(sysOutput.system.length).toBe(0)
  })

  // -------------------------------------------------------------------------
  // 9. system.transform dedupes
  // -------------------------------------------------------------------------

  it("does not push the nudge twice if already present in system", async () => {
    const plugin = await GLMClipboardImagePlugin({} as never)

    // Pre-fill with the nudge (simulating a second call in the same session).
    const NUDGE_TEXT =
      "## Reading pasted images\n\nYou cannot read images directly."
    const sysOutput = { system: [NUDGE_TEXT] }
    // The dedupe uses exact-string equality, so a different prefix won't match.
    // But the real nudge constant is the same string — let's test that path.

    const sysOutput2 = { system: [] as string[] }
    await plugin["experimental.chat.system.transform"]?.(
      {
        model: { id: "glm-5.2", providerID: "zai-coding-plan" } as never,
      },
      sysOutput2 as never,
    )
    expect(sysOutput2.system.length).toBe(1)

    // Call again on the same output — must NOT push a duplicate.
    await plugin["experimental.chat.system.transform"]?.(
      {
        model: { id: "glm-5.2", providerID: "zai-coding-plan" } as never,
      },
      sysOutput2 as never,
    )
    expect(sysOutput2.system.length).toBe(1)
  })

  // -------------------------------------------------------------------------
  // 10. temp file cleanup (existing)
  // -------------------------------------------------------------------------

  it("cleans old temp files based on max age env var", async () => {
    process.env.OPENCODE_GLM_CLIPBOARD_MAX_AGE_HOURS = "0.0001"

    const saveDir = join(tempRoot, "pasted-images")
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

  // -------------------------------------------------------------------------
  // Extra: file-path via absolute url
  // -------------------------------------------------------------------------

  it("converts file-path FilePart when url is an absolute path", async () => {
    const tempFile = join(tempRoot, "clipboard-abs.png")
    await writeFile(tempFile, Buffer.from([0x89, 0x50, 0x4e, 0x47]))

    const plugin = await GLMClipboardImagePlugin({} as never)
    const output = createOutput([
      { type: "file", mime: "image/png", url: tempFile },
    ])

    await plugin["chat.message"]?.(createInput("glm-5") as never, output as never)

    const transformed = output.parts[0] as { type: string; text?: string }
    expect(transformed.type).toBe("text")
    expect(transformed.text).toBe(`[Image saved to: ${tempFile}]`)
  })
})
