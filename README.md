# opencode-glm-clipboard

OpenCode plugin that fixes pasted clipboard image flow for GLM models.

When a clipboard image arrives as a `data:image/...` part, this plugin:

- Saves the image to a temporary local file
- Rewrites the message part to text containing the local file path
- Keeps paste-first UX (`Cmd+V`) without manual file save steps
- Cleans old temp files automatically (24h default)

## Why

Some GLM model routes in OpenCode reject direct image input, even when MCP image tools are available. This plugin provides a transparent fallback so the model can still analyze pasted images through tools using a local file path.

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
```

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

## Configuration

- `OPENCODE_GLM_CLIPBOARD_MAX_AGE_HOURS`
  - Optional
  - Default: `24`
  - Controls temp image cleanup threshold

Temp directory used:

- `${TMPDIR:-/tmp}/opencode-pasted-images`

## Compatibility

- Acts only on models with `modelID` starting with `glm-`
- Leaves non-GLM models untouched

## License

MIT
