# Watchroom

Watch videos from your computer, or from YouTube, together with friends, in sync. You host; friends join from any
browser with a link.

- **Any common video file**: MKV, MP4, AVI, MOV, WebM, MPEG-TS and more. The file stays on your computer; friends receive a stream.
- **YouTube videos too**: paste a YouTube link on the home screen or in the room (video menu → *YouTube link…*), or
  post one in the chat and press **Watch together** on its card. Everyone watches in YouTube's own player, in sync;
  YouTube streams to each person directly, so your computer and upload aren't used. Watch, Shorts, live and `youtu.be`
  links work, including a start time (`&t=1m30s`). Clicking the picture plays and pauses for everyone.
- **Synchronized playback**: anyone can play, pause, seek or change speed; everyone follows within a few hundredths of a second.
- **Per-person quality**: each viewer picks their own quality (or Auto) without affecting anyone else. Multiple audio tracks are selectable per person. HEVC (x265) files are also sent untouched to devices that can play them, at no cost to your computer.
- **Chat** beside or below the video (drag the edge to resize): emoji picker, stickers, pictures (paste, drop or pick; resized and stripped of location data before sending), replies that quote the message they answer, typing indicators, and emoji reactions that float over everyone's video.
- **Chat while the video fills the screen**: new messages, arrivals and departures pop up as small cards in the bottom-right corner, stay long enough to read (longer for longer messages, paused while you hover), and can be answered right there. Press Enter to message the room. On phones: tap a card for Reply, swipe it away to dismiss.
- **Subtitles** from the video file or from `.srt`/`.vtt`/`.ass` files next to it (old Windows-1251 Russian files included). Styled `.ass` subtitles keep their positions, colours and styles (signs at the top, coloured text, fades). Each person turns them on and sizes them for themselves.
- **Seek-bar previews**: hover (or drag on a phone) to see where you'll land.
- **Continue watching**: the home screen lists recent videos with a picture and where you stopped; one click picks up there (or starts over). Switch videos from inside the room without anyone leaving.
- **Host controls**: a Room panel with live upload and per-viewer stats, host-only playback control, wait-or-continue when someone buffers, direct connections on/off, room lock, password, viewer limit, and removing people. Your choices are remembered.
- **Works across the internet** without router setup, through an automatic Cloudflare link, and video goes **directly** between computers when the networks allow it (friends watching the same quality also pass video on to each other, so your upload carries less).
- **Careful with your computer**: only the chosen video is reachable; ffmpeg runs in a sandbox that can't see your other files or the network. See [docs/SECURITY.md](docs/SECURITY.md).

The design and the reasoning behind it are in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## What you need

| Who | Needs |
|-----|-------|
| **Friends who join** | Nothing to install: a browser (Chrome, Edge, Firefox or Safari, on a computer or phone) and the invite link. |
| **Host on Linux** (Ubuntu 22.04/24.04 or similar, 64-bit) | The Watchroom `.deb` (it installs ffmpeg and bubblewrap if missing), or the AppImage plus `ffmpeg`. |
| **Host on Windows 10/11** (64-bit) | The Windows installer; ffmpeg and everything else are inside it. |
| **Building it yourself** | Linux, Git, Node.js 22 or newer, ffmpeg (for running and the media tests). For the Windows installer also `curl`, `unzip` and `zip`. |

The installers aren't stored in this repository (`release/` is ignored); build them as below, or take them from the
project's Releases page if they were uploaded there.

## Install

### 1. Tools (once, Ubuntu/Debian)

```bash
sudo apt install git ffmpeg bubblewrap curl unzip zip
# Node.js 22 or newer, if `node --version` shows something older or nothing:
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install nodejs
```

### 2. Get the code and its libraries

```bash
git clone <this repository's URL> watchroom
cd watchroom
npm install          # downloads the libraries (and Electron) into node_modules
```

### 3a. Linux: build and install the app

```bash
npm run package      # → release/Watchroom-0.2.0-amd64.deb and release/Watchroom-0.2.0-x86_64.AppImage
sudo apt install ./release/Watchroom-0.2.0-amd64.deb
```

Watchroom then appears in the applications menu and in "Open with" for video files. The AppImage runs without
installing: `./release/Watchroom-0.2.0-x86_64.AppImage` (on Ubuntu 24.04 it needs `sudo apt install libfuse2t64` once,
or start it with `APPIMAGE_EXTRACT_AND_RUN=1`).

### 3b. Windows: build the installer (on Linux) and send it

```bash
npm run package:win  # → release/Watchroom-Setup-0.2.0.exe and release/Watchroom-for-Windows-0.2.0.zip
```

Send the `.zip`: it holds the installer and step-by-step instructions in English and Russian
(`packaging/windows/`). On the Windows computer: unzip, double-click the installer (no administrator password needed;
it adds Desktop and Start menu shortcuts). The installer isn't code-signed, so Windows shows "Windows protected your
PC" once: More info → Run anyway.

The script downloads (resumably, cached in `.build-cache/`) and verifies by SHA-256 the Windows Electron, ffmpeg 9.0.2
("essentials" build from gyan.dev) and cloudflared. Differences on Windows: no ffmpeg sandbox (bubblewrap is
Linux-only), and encoding uses the software x264 encoder (hardware encoding is validated on Linux only; set
`WATCHROOM_HWACCEL=1` to try it). Logs: Alt → Help → Open Log Folder.

## Run from source

```bash
npm start            # builds everything and opens the Watchroom window
```

Click **Open video…** (or drop a file on the window, paste a YouTube link, or pick one from Continue watching), click
**Invite**, and send the link. After a code change, `npm run build` rebuilds; `npm run app` starts the window without
rebuilding. `scripts/install-desktop-entry.sh` adds this source checkout to the applications menu.

### Headless host (no window)

```bash
node packages/server/dist/cli.cjs --video ~/Videos/movie.mkv            # internet link (Cloudflare)
node packages/server/dist/cli.cjs --video ~/Videos/movie.mkv --link lan # same Wi-Fi only
node packages/server/dist/cli.cjs --video https://youtu.be/M7lc1UVf-VE  # a YouTube video
```

It prints a host link (open it in your browser to watch as the host) and the invite link.

## How friends connect

| Mode | When to use | Notes |
|------|-------------|-------|
| **Internet** (default) | Friends anywhere | Cloudflare quick tunnel: HTTPS, no account, no router changes, works behind CGNAT. The link changes each time Watchroom starts, and is shown only once it resolves at public DNS, so friends can open it straight away. The `cloudflared` program is downloaded once and its checksum verified. |
| **Same network** | Everyone on your Wi-Fi | Fastest. Serves on port 47800. |
| **Custom** | You run port forwarding, a reverse proxy or Tailscale Funnel | Enter your public address; it should forward to port 47800. |

**Direct connections** (on by default, Room panel → Connections): once a friend has joined through the link, their
browser tries to connect straight to your computer (WebRTC), and friends watching the same quality connect to each
other. Whatever can't go direct still comes through the link, automatically. Everything a friend receives from
another friend is checked against your computer's fingerprint of it before it plays. People in a room with direct
connections on can see each other's IP address; turn it off in the Room panel if that matters to you.

**Your upload speed limits quality for everyone combined.** Rough guide per viewer: 240p ≈ 0.5 Mbit/s, 360p ≈ 0.8, 480p ≈ 1.3, 720p ≈ 2.9, 1080p ≈ 5. "Auto" adapts to what each connection can carry.
(YouTube videos don't use your upload at all: each person streams from YouTube, and YouTube picks their quality.)

## YouTube videos

- Some videos can't be played outside YouTube: their owner turned embedding off, or they are private or age-restricted.
  Watchroom checks the link first and says so; a chat card shows "Can't be watched here".
- **Same-network links** (an address made of numbers, like `http://192.168.1.5:47800`): YouTube refuses many videos,
  music especially, in pages opened that way. Use the internet link for those. (The host's own window opens
  `localhost`, which YouTube accepts.)
- **Live streams** are shared as play/pause only (everyone watches live; seeking and speed are off).
- Subtitles are YouTube's own (CC button, per person). YouTube may show its own ads to a viewer; that viewer catches
  up when the ad ends.
- Who can switch the video: the host always; others only while "Who can play, pause and seek" is set to Everyone.

## Keyboard shortcuts

| Key | Action | Key | Action |
|-----|--------|-----|--------|
| Space / K | Play / pause | F | Full screen |
| ← / → | −5 s / +5 s | C | Show/hide chat |
| J / L | −10 s / +10 s | M | Mute |
| ↑ / ↓ | Volume | < / > | Speed (everyone) |
| 0–9 | Jump to 0–90% | Ctrl+O | Open video (host) |
| Enter | Message the room while the chat is hidden (full screen) | Esc | Close a menu, picker or reply |

## Troubleshooting

- **A friend's video stutters**: lower their quality (or leave it on Auto); check your *upload* speed (fast.com → "Show more info").
- **Direct connections**: the Room panel shows for each viewer whether they are connected directly. In a browser's
  console, `__watchroomP2P()` prints that viewer's connection details. A viewer can force a route on their own device
  with `localStorage.setItem('wr:p2p:route', '"link"')` (or `"direct"`, `"off"`; remove the item for automatic).
- **ffmpeg sandbox**: the home screen shows "Video tools sandboxed". If it says "Not sandboxed", install bubblewrap
  (`sudo apt install bubblewrap`). `WATCHROOM_SANDBOX=0` turns the sandbox off (not recommended).

## Tests

Run `npm run build` once first (the media, browser and desktop tests use the built app). The test videos are
generated with ffmpeg on the first media or browser test run (`packages/server/test/fixtures/generate.mjs`); they
aren't stored in git.

```bash
npm run typecheck    # TypeScript across all packages
npm test             # unit tests: sync math, protocol, room state machine (incl. random-action fuzzing), ASS parser
npm run test:media   # media pipeline on 10 generated formats (needs ffmpeg), sandbox, direct delivery, hostile traffic
npm run test:e2e     # real browsers: sync, chat cards, replies, subtitles, phones, direct connections, HEVC, bad networks, YouTube
npm run test:desktop # launches the real desktop app hidden and checks the host bridge
node scripts/loadtest.mjs --viewers 8 --seconds 60   # load test with simulated viewers
```

The browser tests need a Chromium with H.264 support; by default they use `/snap/bin/chromium`
(`sudo snap install chromium`; override with `WATCHROOM_CHROMIUM`).
The YouTube tests play real YouTube videos and need internet access; `WATCHROOM_E2E_OFFLINE=1` skips them.
`node e2e/desktop-smoke.mjs <outDir> https://youtu.be/M7lc1UVf-VE` checks YouTube in the real desktop app.

## Where things are

```
apps/desktop      Electron host app (window, native file dialog, starts the server), packaging config
apps/web          Browser client used by the host and by friends (React)
packages/server   Streaming server: rooms, sync, chat, on-demand transcoding, direct delivery, tunnel, sandbox
packages/protocol Shared message types, sync math, direct-delivery wire format
e2e               Multi-browser end-to-end tests
scripts           Load test, emoji/sticker generators
```

- Settings, the recent list and its pictures: `~/.config/watchroom`.
- Transcoded segments: `~/.cache/watchroom/media` (rewatching is instant; delete the folder any time to free space).
# wm2
