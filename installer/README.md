# super-RLM for Windows

This directory contains the per-user Windows installer for the super-RLM ZIP
release. The current release version is **0.1.0**.

The installer does not need administrator rights. It installs below your user
profile, verifies the package checksums, installs runtime dependencies, and
creates a `super-rlm` command.

## Requirements

- 64-bit Windows 10 or Windows 11 on x64.
- Windows PowerShell 5.1 or newer (PowerShell 7 also works).
- Node.js **22.19 or newer**, available as `node` on `PATH`. Node is a host
  prerequisite and is **not** bundled.
- Network access during install for `npm ci` and the Worker Python
  dependencies (npm registry and PyPI). The release itself contains Prime Agent
  and `uv.exe`; they are not downloaded by the installer.

## Install

1. Download and extract the release ZIP, for example:

   ```powershell
   Expand-Archive .\super-rlm-v0.1.0-win-x64.zip -DestinationPath .
   ```

2. Run the installer from the extracted directory:

   ```powershell
   powershell -NoProfile -ExecutionPolicy Bypass -File .\super-rlm-v0.1.0-win-x64\installer\install.ps1
   ```

   If the ZIP came from a browser, you can preview first:

   ```powershell
   powershell -NoProfile -ExecutionPolicy Bypass -File .\installer\install.ps1 -WhatIf
   ```

3. Open a new terminal so the updated user `PATH` applies. From the project
   directory you want to use, run the first-run setup once, then start the UI:

   ```powershell
   cd C:\path\to\your-project
   super-rlm setup
   super-rlm
   ```

   `super-rlm setup` is provided by the application. It prepares the per-project
   kernel environment, Worker venv, and model configuration. The installer
   installs the application runtime, Worker venv, and command shim. Setup
   refuses to run from the installation directory itself.

### Install options

| Option | Meaning |
| --- | --- |
| `-InstallDir <path>` | Install root. Default: `%LOCALAPPDATA%\Programs\super-RLM`. |
| `-NoPath` | Do not add `<InstallDir>\bin` to the user `PATH`. |
| `-Force` | Reinstall the same version. |
| `-WhatIf` | Show the planned operation without changing anything. |
| `-LogPath <path>` | Write a plain-text installer log. No secrets are logged. |
| `-Uninstall` | Uninstall. See below. |
| `-PurgeData` | With `-Uninstall`, also delete local project data. |

## Install layout

```text
%LOCALAPPDATA%\Programs\super-RLM\
  current                 junction (or copy) to versions\0.1.0
  versions\
    0.1.0\                application, runtime, config, docs
      apps\
      packages\
      config\
      runtime\
        bin\uv.exe        bundled uv
        pi\               Pi dependency manifest and installed node_modules
        prime-agent\      Prime Agent binary, runtime, and skills
      version.json
      SHA256SUMS
  bin\
    super-rlm.cmd         shim: node --preserve-symlinks-main current\apps\cli\src\main.ts %*
```

`current` is normally a directory junction. If junction creation is not
available, the installer falls back to a directory copy. Versioned directories
are kept so an upgrade can retain the previous version.

## What the installer does

1. Checks Windows x64 and Node.js >= 22.19. It never installs or bundles Node.
2. Reads `version.json` and verifies every file listed in `SHA256SUMS` with
   SHA-256 before changing the installation.
3. Copies the package into `versions\<version>`.
4. Verifies the bundled `runtime\bin\uv.exe` runs.
5. Runs `npm ci` for Pi (`runtime\pi`) and for the application packages that
   need runtime dependencies (`apps\cli`, `apps\orchestrator`, `apps\router`,
   `apps\tui`). Pi must be installed first because `apps\tui` links to Pi.
   It then creates `apps\worker\.venv` with the bundled `uv.exe` and installs
   the Worker runtime (`apps\worker`).
6. Writes `bin\super-rlm.cmd`.
7. Switches `current` to the new version and verifies `super-rlm --version`.
8. Adds `<InstallDir>\bin` to the **user** `PATH` unless `-NoPath` is passed,
   and broadcasts the environment change on a best-effort basis.

The installer refuses an upgrade while the super-RLM stack is running. Stop it
first:

```powershell
super-rlm down
```

## Upgrade

Run the installer from the new release ZIP. The installer:

- refuses to continue if the super-RLM stack is running;
- installs the new version into `versions\<new-version>`;
- installs its Node dependencies;
- renames the old `current` entry aside, switches to the new one, and verifies
  the new CLI;
- keeps the previous version directory;
- rolls back `current` if the switch or verification fails.

## Uninstall

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\installer\install.ps1 -Uninstall
```

The uninstaller tries to stop a running stack with `super-rlm down`, removes
`current`, `versions`, and `bin`, and removes the `bin` entry from the user
`PATH` (unless `-NoPath` is passed). It does not require the release package.

Project data is kept by default. It lives under:

```text
%USERPROFILE%\.super-rlm\
```

That directory contains project homes, workspaces, sessions, and local API
secrets. To remove it as well:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\installer\install.ps1 -Uninstall -PurgeData
```

`-PurgeData` is destructive and is only valid with `-Uninstall`. Review
`%USERPROFILE%\.super-rlm` first if you have work you want to keep.

## Build a release package

From the repository root:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\package\windows.ps1 `
  -UvPath C:\Users\me\.local\bin\uv.exe
```

Preview the staging plan without writing anything:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\package\windows.ps1 `
  -UvPath C:\Users\me\.local\bin\uv.exe -DryRun
```

Output (default `dist\`):

```text
dist\super-rlm-v0.1.0-win-x64\
dist\super-rlm-v0.1.0-win-x64.zip
dist\super-rlm-v0.1.0-win-x64.zip.sha256
```

The packaging script:

- includes `apps`, `packages`, `config`, `scripts`, minimal `docs`, runtime
  manifests, `runtime\prime-agent` when present, `installer\install.ps1`, and
  the bundled `uv.exe`;
- excludes `.git`, `.tmp`, `node_modules`, `.venv`, `__pycache__`, tests,
  build output, logs, and common secret files;
- writes `version.json` and `SHA256SUMS`;
- never follows or bundles user project homes/secrets.

`-UvPath` is required. Copy the Windows x64 `uv.exe` you want to ship. Node is
only checked by the installer, never copied into the package.

## Verify a package manually

The installer verifies `SHA256SUMS` automatically. To check a package without
installing:

```powershell
$root = "C:\path\to\super-rlm-v0.1.0-win-x64"
Get-Content "$root\SHA256SUMS" | ForEach-Object {
  if ($_ -match '^([0-9a-f]{64})\s+\*?(.+)$') {
    $expected = $Matches[1]
    $file = Join-Path $root $Matches[2].Replace('/', '\')
    $actual = (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actual -ne $expected) { throw "checksum mismatch: $file" }
  }
}
"checksums OK"
```

The ZIP's own hash is in `super-rlm-v0.1.0-win-x64.zip.sha256`.

## Notes and limitations

- No MSI is produced in this phase. Distribution is ZIP plus `install.ps1`.
- `npm ci` needs network access unless the npm cache is already populated.
- `current` switching uses two directory renames. Windows has no true atomic
  directory swap, so the gap is small but not literally atomic. A failed switch
  restores the previous `current`.
- The shim passes `--preserve-symlinks-main` to Node. Without it, Node resolves
  a junctioned `current` to the real `versions\<version>` path, and the CLI's
  `import.meta.url === argv[1]` entry check does not fire. The flag keeps the
  `current` path as the entry URL. It is harmless when `current` is a copy.
- Stack detection parses `super-rlm status`. If the check itself fails, the
  installer logs a warning and continues; it cannot detect a running stack in
  that case.
- The uninstaller removes `%USERPROFILE%\.super-rlm` only when `-PurgeData` is
  given. A custom `SUPER_RLM_HOME` outside that directory is not removed.
- The installer never writes API keys or tokens. Local secrets are created by
  the application on first use.
