# opencode-glm-clipboard

OpenCode plugin that fixes pasted clipboard image flow for text-only GLM models (GLM-5.x, GLM-4.6, etc.).

## What it does

When a clipboard image arrives on a model that can't read images natively, this plugin:

1. **Saves** the image to a temporary local file (instant, non-blocking)
2. **Replaces** the image part with a text marker: `[Image saved to: /path/to/file.png]`
3. **Injects a system-prompt instruction** telling the model to read the file on-demand via the configured `zai-mcp-server` MCP tools (`extract_text_from_screenshot` for text/code/errors, `analyze_image` for UI/diagrams/photos)

The model calls the vision MCP tools itself when it needs to understand the image — the plugin never blocks the chat to run OCR.

Handles pasted images delivered either as embedded data URLs (Cmd+V) or as file-path attachments (Ctrl+V / dragged files).

## Why

GLM models served via OpenCode reject direct image input. OpenCode's built-in `read` tool also hard-refuses images for non-vision models. This plugin bridges the gap: it saves the image and instructs the model to use the already-running `zai-mcp-server` MCP to read it on-demand.

## Prerequisite: `zai-mcp-server` MCP

The system nudge references `zai-mcp-server_extract_text_from_screenshot` and `zai-mcp-server_analyze_image`. You need a local stdio MCP server named `zai-mcp-server` in your OpenCode config:

```jsonc
{
  "mcp": {
    "zai-mcp-server": {
      "type": "local",
      "command": ["npx", "-y", "@z_ai/mcp-server"],
      "environment": {
        "Z_AI_API_KEY": "<your-key>",
        "Z_AI_MODE": "ZAI"
      }
    }
  }
}
```

If the MCP server is absent, the model will still see the `[Image saved to: ...]` marker but won't be able to read the image (the nudge will reference tools that don't exist).

## Install

```bash
npx -y opencode-glm-clipboard@latest
```

Then restart OpenCode.

## Uninstall

```bash
npx -y opencode-glm-clipboard@latest --uninstall
```

## Local development

```bash
npm install
npm run build
npm test
```

## Configuration

- `OPENCODE_GLM_CLIPBOARD_MAX_AGE_HOURS`
  - Optional. Default: `24`.
  - Controls temp image cleanup threshold.

Temp directory used: `~/.cache/opencode/pasted-images/` (or `$OPENCODE_GLM_CLIPBOARD_TEST_DIR` in tests).

## Compatibility

- Acts on models from providers that don't declare native image input support:
  - `CrofAI` provider (e.g. `deepseek-v4-pro`)
  - `zai-coding-plan` provider (e.g. `glm-5.2`)
  - Legacy `glm-*` model IDs
- Leaves image-capable models untouched (e.g. `CrofAI/kimi-k2.6`, `CrofAI/kimi-k2.6-precision`)
- Leaves other providers/models untouched

## Release flow

Recommended release order:

1. Bump version in `package.json`
2. Commit and push `main`
3. Create and push tag `vX.Y.Z`
4. Publish GitHub Release for that tag
5. GitHub Actions publishes to npm automatically

This repository includes a workflow that publishes to npm when a GitHub Release is published.

Recommended setup: npm Trusted Publishing (OIDC), no long-lived `NPM_TOKEN` required.

Add local plugin path in your OpenCode config if testing without publish:

```json
{
  "plugin": [
    "file:///absolute/path/to/opencode-glm-clipboard/dist/index.js"
  ]
}
```

## License

MIT
