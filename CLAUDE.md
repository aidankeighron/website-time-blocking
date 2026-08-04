# Website Time Blocking — Build Notes

## Version scheme
`major.minor` — minor = new features / test infrastructure, major = fundamental behaviour changes.
Current: see `manifest.json` → `"version"`.

## Build

Run from the project root:
```powershell
.\build.ps1
```

### What it produces

| Output | Location | Contents |
|---|---|---|
| `wtb-chrome-v{ver}.zip` | **one level up** (`../`) | `website-time-blocking/` folder with `manifest.json` (Chrome MV3) |
| `wtb-firefox-v{ver}.zip` | **project root** (`./`) | flat file contents; `manifest-firefox.json` → `manifest.json` |

### Excluded from both zips
`node_modules/`, `.git/`, `playwright-report/`, `test-results/`, `tests/`

### Version bump workflow
1. Update `"version"` in both `manifest.json` and `manifest-firefox.json`.
2. Run `.\build.ps1` — version is read from `manifest.json` automatically.

### Firefox submission note
AMO requires the zip to contain files at the root (no wrapper folder) and the manifest
must be named `manifest.json`. `build.ps1` handles both automatically.
