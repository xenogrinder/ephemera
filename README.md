# Ephemera

A serverless, peer-to-peer, ephemeral chat client with a Discord-style interface.

There is no central server. Clients on the same network find each other
automatically, and messages travel directly between peers. Nothing is written to
disk — every message, channel, and identity lives only in memory and is gone the
moment the last client closes.

## How it works

- **Discovery (LAN):** each client announces itself on a UDP multicast group
  (`239.255.42.98:41848`). Any client on the same network segment discovers the
  others with zero configuration.
- **Discovery (manual):** you can also connect to a peer on another network by
  entering its IP address and port (the **+** button on the server rail). Peers
  gossip their connections, so connecting to one member can pull you into the
  rest of the mesh.
- **Messaging:** peers hold direct TCP connections to one another. Messages are
  newline-delimited JSON and are relayed across the mesh with de-duplication, so
  delivery works even when the network is only partially connected.
- **Ephemeral by design:** there is no database and no file storage. State is
  held in RAM only.

## Requirements

- **Node.js 18+** (includes npm). Download: https://nodejs.org/

## Setup

From this folder:

```bash
npm install
npm start
```

`npm install` downloads Electron (first run only). `npm start` launches the app.

To try it out, run `npm start` in two terminals on the same machine, or run the
app on two machines on the same Wi‑Fi/LAN — they will discover each other
automatically.

## Building a shareable installer

To produce a single Windows installer that recipients can double-click — no
Node.js, npm, or other setup required on their machine:

```bash
npm run dist
```

This generates `dist/Ephemera-Setup-<version>.exe`. Share that one file. When a
recipient runs it, it installs Ephemera per-user (no admin prompt), adds Start-menu
and desktop shortcuts, and launches the app — the Electron runtime and all
dependencies are bundled inside.

Notes:

- The installer is **unsigned**. On first run, Windows SmartScreen may show a
  "Windows protected your PC" warning; the recipient clicks **More info →
  Run anyway**. Removing this requires a paid code-signing certificate.
- First-time builds download NSIS helper binaries from GitHub (a few MB).
- **Just after building, Windows Defender scans the new unsigned `.exe`** and
  briefly locks it. If you run the installer immediately and it crashes on launch
  (exit code `0xC0000005`), wait ~30 seconds for the scan to finish and run it
  again. This only affects the machine that built it; recipients are unaffected.
- On Windows, if the build fails while extracting `winCodeSign` with a symbolic
  link privilege error, either enable Windows **Developer Mode** (Settings →
  For developers) or pre-extract that cached archive excluding its `darwin`
  folder — those files are macOS-only and unused for a Windows build.

## Auto-update

Installed clients update themselves. On launch (and every 6 hours), the app checks
its GitHub release feed; when a newer version is available it downloads in the
background and shows a small **"Update ready — Restart now"** banner. Clicking it
relaunches into the new version; otherwise the update is applied automatically the
next time the app quits. This is per-user, so no admin prompt is involved.

Auto-update is powered by `electron-updater` and only runs in an installed build
(it's a no-op during `npm start`).

### One-time setup

1. Create a GitHub repo to host releases and push this project to it.
2. Set the publish target in `package.json` → `build.publish` to match:

   ```json
   { "provider": "github", "owner": "<your-user-or-org>", "repo": "<repo>" }
   ```

   (Currently set to `xenogrinder/ephemera`.)
3. Create a GitHub **Personal Access Token** with `repo` scope and expose it as an
   environment variable named `GH_TOKEN` in the shell you build from.

### Shipping an update

1. Bump `version` in `package.json` (e.g. `1.0.0` → `1.0.1`).
2. Publish:

   ```bash
   npm run release
   ```

   This builds the installer and uploads it — along with `latest.yml` and the
   block map — to a GitHub Release for that version.
3. Every installed client picks it up automatically on its next launch/check.

`npm run dist` still builds locally **without** publishing (for testing or sharing
a one-off file). Only `npm run release` uploads.

Notes:

- The GitHub release must contain `Ephemera-Setup-<version>.exe`, `latest.yml`, and
  the `.blockmap` — `npm run release` produces all three. A release created by hand
  without `latest.yml` will not be detected.
- Because the installer is unsigned, the *first* install still shows SmartScreen,
  but subsequent auto-updates install silently in the background.

## Uninstalling

Ephemera ships with a dedicated deep uninstaller — a single double-click file that
removes **everything**: the installed program, the Electron user-data folders,
every shortcut, and the registry entries. It works like a Revo-style sweep scoped
to Ephemera.

Two ways to run it:

- **Bundled:** after installing, open the install folder
  (`%LOCALAPPDATA%\Programs\Ephemera`) and double-click **`Uninstall Ephemera.cmd`**.
- **Standalone:** keep `installer/Uninstall Ephemera.cmd` from this project. It is
  fully self-contained (the PowerShell logic is embedded) — double-click it on any
  machine to hunt down and remove an Ephemera install, even a broken one.

It prompts for administrator rights (for the deepest clean), stops any running
instance, runs the registered uninstaller, then sweeps leftovers. What it removes:

- Install folder (`%LOCALAPPDATA%\Programs\Ephemera`, or a custom install dir found
  via the registry).
- User data: `%APPDATA%\Ephemera`, `%LOCALAPPDATA%\Ephemera`, and the updater cache.
- Desktop and Start-menu shortcuts (matched by name *and* by target, so renamed
  shortcuts are caught too).
- Registry: the Windows uninstall entry and any `HKCU\Software\Ephemera` keys.

The uninstaller is regenerated from `installer/uninstall-ephemera.ps1` by
`npm run build:uninstaller` (also run automatically as part of `npm run dist`).

## Using it

- **Send a message:** type in the box and press Enter.
- **Create a channel:** the **+** next to "Text Channels". New channels are
  shared with everyone currently connected.
- **Change your name:** the pencil icon next to your name at the bottom left.
- **Connect across networks:** the **+** on the far-left rail, then enter the
  peer's IP and port.

## Notes and limits

- Multicast discovery works within a single LAN segment. Across subnets or the
  internet, use manual connect (and forward the TCP port if there's a NAT/firewall).
- Some corporate or guest Wi‑Fi networks block multicast and/or peer-to-peer
  traffic ("client isolation"); manual connect by IP is the fallback there.
- Firewalls: on first launch Windows may prompt to allow Node/Electron network
  access — allow it on private networks for discovery to work.
- There is no encryption or authentication. This is a local-network toy/demo,
  not a secure messenger.

## Project layout

| File | Role |
| --- | --- |
| `main.js` | Electron main process; wires the P2P node to the window over IPC. |
| `network.js` | The peer-to-peer engine: multicast discovery, TCP mesh, gossip, relay. |
| `preload.js` | Safe IPC bridge exposed to the UI as `window.net`. |
| `renderer/` | The Discord-style UI (HTML/CSS/JS). |
