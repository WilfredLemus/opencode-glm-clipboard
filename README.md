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

Add local plugin path in your OpenCode config if testing without publish:

```json
{
  "plugin": [
    "file:///absolute/path/to/glm-clipboard-opencode/dist/index.js"
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
