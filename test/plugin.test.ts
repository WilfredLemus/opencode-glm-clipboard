import { mkdir, mkdtemp, readdir, stat, utimes, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import GLMClipboardImagePlugin from "../index"

function createInput(modelID: string, providerID?: string) {
  return {
    model: { modelID, providerID: providerID ?? "" },
  }
}

function createOutput(parts: unknown[], modelID?: string) {
  return {
    message: {
      model: modelID ? { modelID } : undefined,
    },
    parts,
  }
}

describe("GLMClipboardImagePlugin", () => {
  it("transforms pasted image data URL for GLM models", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "glm-clipboard-test-"))
    process.env.TMPDIR = tempRoot

    const plugin = await GLMClipboardImagePlugin({} as never)
    const hook = plugin["chat.message"]

    const output = createOutput([
      { type: "text", text: "read this" },
      {
        type: "image",
        image:
          "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wnq0JwAAAAASUVORK5CYII=",
      },
    ])

    await hook?.(createInput("glm-5") as never, output as never)

    const transformed = output.parts[1] as { type: string; text?: string }
    expect(transformed.type).toBe("text")
    expect(transformed.text).toContain("A pasted image is available at this local path:")

    const directory = join(tempRoot, "opencode-pasted-images")
    const files = await readdir(directory)
    expect(files.length).toBe(1)
  })

  it("transforms pasted image for CrofAI provider models", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "glm-clipboard-test-"))
    process.env.TMPDIR = tempRoot

    const plugin = await GLMClipboardImagePlugin({} as never)
    const hook = plugin["chat.message"]

    const output = createOutput([
      {
        type: "image",
        image:
          "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wnq0JwAAAAASUVORK5CYII=",
      },
    ])

    await hook?.(createInput("deepseek-v4-pro", "CrofAI") as never, output as never)

    const transformed = output.parts[0] as { type: string; text?: string }
    expect(transformed.type).toBe("text")
    expect(transformed.text).toContain("A pasted image is available at this local path:")
  })

  it("transforms pasted image for zai-coding-plan provider models", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "glm-clipboard-test-"))
    process.env.TMPDIR = tempRoot

    const plugin = await GLMClipboardImagePlugin({} as never)
    const hook = plugin["chat.message"]

    const output = createOutput([
      {
        type: "image",
        image:
          "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wnq0JwAAAAASUVORK5CYII=",
      },
    ])

    await hook?.(createInput("claude-sonnet-4", "zai-coding-plan") as never, output as never)

    const transformed = output.parts[0] as { type: string; text?: string }
    expect(transformed.type).toBe("text")
    expect(transformed.text).toContain("A pasted image is available at this local path:")
  })

  it("handles legacy parts with url field for backwards compatibility", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "glm-clipboard-test-"))
    process.env.TMPDIR = tempRoot

    const plugin = await GLMClipboardImagePlugin({} as never)
    const hook = plugin["chat.message"]

    const output = createOutput([
      {
        type: "file",
        mime: "image/png",
        filename: "paste.png",
        url: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wnq0JwAAAAASUVORK5CYII=",
      },
    ])

    await hook?.(createInput("glm-5") as never, output as never)

    const transformed = output.parts[0] as { type: string; text?: string }
    expect(transformed.type).toBe("text")
    expect(transformed.text).toContain("A pasted image is available at this local path:")
  })

  it("does not transform non-GLM models", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "glm-clipboard-test-"))
    process.env.TMPDIR = tempRoot

    const plugin = await GLMClipboardImagePlugin({} as never)
    const hook = plugin["chat.message"]

    const output = createOutput([
      {
        type: "image",
        image:
          "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wnq0JwAAAAASUVORK5CYII=",
      },
    ])

    await hook?.(createInput("gpt-5") as never, output as never)

    const part = output.parts[0] as { type: string; image?: string }
    expect(part.type).toBe("image")
    expect(part.image?.startsWith("data:image/png")).toBe(true)
  })

  it("cleans old temp files based on max age env var", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "glm-clipboard-test-"))
    process.env.TMPDIR = tempRoot
    process.env.OPENCODE_GLM_CLIPBOARD_MAX_AGE_HOURS = "0.0001"

    const saveDir = join(tempRoot, "opencode-pasted-images")
    await mkdir(saveDir, { recursive: true })
    await writeFile(join(saveDir, "placeholder"), "", { flag: "a" })

    const stalePath = join(saveDir, "paste-old.png")
    await writeFile(stalePath, Buffer.from([1, 2, 3]))
    const oldTime = new Date(Date.now() - 60_000)
    await utimes(stalePath, oldTime, oldTime)

    const plugin = await GLMClipboardImagePlugin({} as never)
    const hook = plugin["chat.message"]

    const output = createOutput([
      {
        type: "image",
        image:
          "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wnq0JwAAAAASUVORK5CYII=",
      },
    ])

    await hook?.(createInput("glm-4.7") as never, output as never)

    await expect(stat(stalePath)).rejects.toThrow()
  })
})
