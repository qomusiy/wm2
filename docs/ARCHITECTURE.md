# Watchroom: Architecture & Implementation Plan

> **Status:** All three phases implemented and tested (2026-11-08). See §9 for what each phase delivered and
> [SECURITY.md](SECURITY.md) for the security model.
> "Watchroom" is a working title. It's trivial to rename.
>
> **Decisions (answered 2026-11-07):** internet access via Cloudflare quick tunnel now, direct peer-to-peer video in Phase 3 ·
> Linux host only (Windows/macOS not planned) · multiple audio tracks and subtitles handled even though they are rare in your files ·
> designed for 1–4 viewers on a very slow upload (about 2 Mbit/s measured), so low-bitrate quality levels matter most.

A self-hosted watch-party app. The host runs a desktop app, opens a local video file and shares a link. Friends open the link in any modern browser, enter a name, and watch in sync with shared controls, per-person quality and an integrated chat.

---

## 1. The hard problems (and how this design answers them)

| # | Problem | Why it's hard | Answer in this design |
|---|---------|---------------|-----------------------|
| 1 | **Formats & codecs** | Browsers can't play MKV reliably. Many MKVs carry AC3/DTS/TrueHD audio that no browser decodes. HEVC, 10-bit, VP9, AV1 and HDR support varies by device. | Never send the raw file. Convert on the fly to **HLS** (H.264 + AAC), the format every browser and phone can play. Copy the video stream untouched when it's already compatible. |
| 2 | **Per-viewer quality** | Each friend picks their own quality, so several versions of the video must exist. Pre-converting a 2-hour movie into 4 qualities takes a long time. | **On-demand (just-in-time) transcoding.** Segments are encoded only when someone actually requests that quality at that position. They are cached, so a second viewer at the same quality costs nothing extra. |
| 3 | **Reaching friends outside your network** | `localhost` and LAN IPs don't work over the internet. Many ISPs use CGNAT, so port forwarding is impossible. Browsers also need HTTPS for many features. | An automatic **tunnel** gives a public HTTPS link with zero router setup. Video can go **peer-to-peer** to keep bulk traffic off the relay. See §5.3 and the decision in §11. |
| 4 | **Your upload bandwidth** | Every viewer pulls their own stream from your computer. 4 friends at 720p is about 12 Mbit/s of upload. | Per-viewer adaptive quality ("Auto"). A live upload meter for the host. Host-side caps on the maximum quality offered. |
| 5 | **Sync over the internet** | Latency differs per person and changes over time. Naive "on pause event, send pause" designs cause feedback loops. Phones block autoplay and pause in the background. | A server-authoritative timeline, clock synchronisation, scheduled starts, gentle drift correction, and an **intent-based** control model that cannot echo. See §5.4. |
| 6 | **Security of a home machine** | You're exposing a server on your PC to the internet. Tunnel traffic arrives from `127.0.0.1`, so "trust localhost" checks are silently broken. | Capability links (secret never leaves the URL fragment), per-session tokens, no file paths over the network, and host powers only via the desktop app's private IPC. See §5.6. |
| 7 | **Host resources** | This laptop has 7.5 GB RAM and CPU-only encoding right now (see §2). | A bounded worker pool with throttling and caching, hardware-encoder auto-detection, and a disk cache size limit. |

---

## 2. What I measured on this machine

| Item | Finding | Consequence |
|------|---------|-------------|
| OS / CPU | Ubuntu 24.04, i7-13620H (10 cores / 16 threads) | Plenty for software H.264 encoding. |
| RAM | 7.5 GB total, about 2.7 GB free with your current apps | Cap concurrent encoders at about 3. Electron's footprint matters. |
| NVIDIA RTX 4050 | Kernel driver **not loaded**, so NVENC is unavailable | Optional: installing the proprietary NVIDIA driver would enable hardware encoding. Not required. |
| Intel iGPU (VAAPI / QSV) | VAAPI **works** when scaling happens on the CPU and frames are uploaded to the GPU (`format=nv12,hwupload`); GPU-side scaling fails with "Cannot allocate memory". QSV fails. | The pipeline uses VAAPI with CPU scaling (about 13× real time on 10-bit HEVC → 720p). The app auto-detects working encoders with a real test encode and falls back to x264. |
| ffmpeg | 6.1.1 (system) with libx264, AAC, all common decoders | Usable for development. The packaged app will bundle its own ffmpeg. |
| Node | v24.16 | Good. |
| Tailscale | Installed and logged in, Funnel not configured | Tailscale Funnel is a possible link provider (§5.3). |

**Feasibility spike for the transcoding design** (scripts in the session scratchpad, not in the repo):

- `libx264 -preset veryfast` on a 1080p test pattern ran at about 9× real time. Real film content is harder to encode than a test pattern, so expect less, but still comfortably faster than real time.
- After a seek, the **first segment is ready in 0.4 to 1.1 s** (480p, CPU only). That's the "seek latency" friends will feel on an uncached position.
- **Segment alignment across encoder restarts:** this is the core risk of on-demand transcoding. If the encoder restarts at segment 6 after a seek, its segments must line up with segments from an earlier run.
  - Plain restart: off by about 0.1 s, because ffmpeg shifts timestamps differently at t=0. ❌
  - `-copyts` approach: ffmpeg's HLS muxer produced 10-second segments instead of 4-second ones. ❌
  - Constant timestamp base offset on every run: aligned **within one frame** (under 42 ms). ✅

**What the shipped pipeline actually does** (refined while building; every point is covered by the media tests):

- All encoder runs use `-copyts`, so timestamps stay on the source's own clock, plus one offset computed by us: output = (source time − file start) + 10 s. Copied, transcoded and audio segments therefore share one timeline by construction, even on MPEG-TS sources where ffmpeg's notion of the start time differs.
- A job starting mid-file seeks 2 s early and trims exactly with an output-side seek. Some demuxers drop about half a second of audio after any seek (seen on AC-3 in MKV); the pre-roll hides that.
- Segments are cut by ffmpeg's segment muxer at explicit times (the HLS muxer mis-cuts after restarts). Video cuts get half a frame of tolerance (`-segment_time_delta`), because forced keyframes can land a rounding error before the requested time and ffmpeg would otherwise skip the cut.
- Stream-copied "Original" segments are cut from a keyframe index, one tiny ffmpeg run per segment, with an exact packet count, so they start on the exact keyframe regardless of how accurately the container seeks.
- A segment becomes visible only after ffmpeg has opened the next one (or exited), then it is atomically renamed into the cache, so viewers never receive a half-written file.

---

## 3. Recommended technology stack

| Layer | Choice | Why | Alternatives considered |
|-------|--------|-----|-------------------------|
| Desktop host app | **Electron** | Native "Open Video" dialog, tray, keeps the PC awake while hosting. Runs the same React UI as the web client. Chromium has built-in H.264/AAC and WebRTC. Mature packaging for Linux, Windows and macOS. | **Tauri:** smaller binary, but needs a Rust backend or a Node sidecar, so slower to build and less shared code. **Plain server + browser tab:** no native file dialog, feels like a dev tool, not a product. |
| Server | **Node.js + Fastify + `ws`**, TypeScript | One language end to end. Fast static/segment serving. `ws` is lean, with a custom typed protocol and my own reconnect/resume logic for full control. | Socket.IO (heavier, adds a long-polling fallback we don't need). Go (fast, but splits the codebase). |
| Validation | **zod** schemas shared by client and server | Every network message is validated at the boundary. | |
| Media | **ffmpeg / ffprobe**, bundled static builds | The only practical way to handle every container and codec. Hardware encoders when available. | GStreamer (harder to bundle and script). |
| Streaming format | **HLS**, MPEG-TS segments (4 s), demuxed audio | Plays everywhere (hls.js on desktop/Android, native or ManagedMediaSource on iOS). Gives per-viewer quality and audio-track choice for free. | DASH (no native iOS). Progressive MP4 (no quality switching, no MKV). WebRTC media tracks (real-time quality, poor for seeking movies). |
| Web client | **React + TypeScript + Vite**, **hls.js**, **Zustand** | Robust player engine with ABR and custom loaders (needed for peer-to-peer delivery). Small state library. | Video.js/Plyr (fighting their UI to build our own). |
| Styling | CSS Modules + design tokens (CSS variables), **lucide** icons, self-hosted Inter font | Precise control for a VS Code-like structure. No runtime CSS-in-JS cost. Nothing loaded from third-party CDNs (privacy, works offline on LAN). | Tailwind (fine too; tokens + modules give tighter control over a small design system). |
| Remote access | **cloudflared** quick tunnel (managed by the app), plus optional Tailscale Funnel or a custom URL | See §5.3 and decision Q1. | ngrok free tier: 1 GB/month cap, useless for video. |
| P2P video (Phase 3) | **WebRTC data channels**: libdatachannel in the server via `node-datachannel` (as built) | Direct, encrypted host-to-friend video; the same code serves the desktop app and the headless host, and it is testable without a browser. Prebuilt N-API binary, loaded lazily (the app still works over the link if it can't load). | Chromium's WebRTC in a hidden Electron window (the original plan: no native dependency, but desktop-only and a second renderer's memory). |
| Tests | Vitest (unit/integration), Playwright (multi-browser sync end-to-end) | Sync bugs only show up with several real browsers. | |
| Packaging | electron-builder: AppImage + .deb (Linux), NSIS (Windows), dmg (macOS) | | |

---

## 4. High-level architecture

```
                                 HOST COMPUTER
 ┌──────────────────────────────────────────────────────────────────────────┐
 │  Electron app                                                            │
 │                                                                          │
 │  Main process ─── native "Open Video" dialog · tray · keep-awake         │
 │       │  private IPC (host-only powers: open video, kick, settings)      │
 │       ▼                                                                  │
 │  Host window (React) ── same player/chat UI as friends + host panel      │
 │                                                                          │
 │  Server (Electron utility process, Node + Fastify)                       │
 │    ├─ Rooms · sessions · sync engine · chat ◄──── WebSocket (WSS)        │
 │    ├─ HLS endpoints: playlists, segments, subtitles, chat images ◄─ HTTPS│
 │    └─ Media pipeline ─ ffprobe / ffmpeg worker pool ─► segment cache     │
 │                                                       (~/.cache/…)       │
 │  cloudflared (child process) ── outbound tunnel ───────────────┐         │
 │  Server's WebRTC peer (libdatachannel) [Phase 3] ────────┐     │         │
 └──────────────────────────────────────────────────────────┼─────┼─────────┘
                                                            │     ▼
                                     direct P2P (DTLS)      │  Cloudflare edge
                                     video segments         │     │ HTTPS / WSS
                                                            ▼     ▼
                                         Friends' browsers (desktop / phone)
                                         hls.js player · sync client · chat
```

The **video file itself never leaves your computer as a file**. Friends receive short encoded segments of the selected video only, fetched just ahead of where they're watching.

---

## 5. Component design

### 5.1 Processes

| Process | Responsibility | Notes |
|---------|----------------|-------|
| Electron main | Window lifecycle, native dialogs, tray, power-save blocker, spawns the server and tunnel | Holds the host's privileged API and exposes it to the host UI through a hardened preload bridge. |
| Server (utility process) | HTTP + WebSocket, rooms, sync, chat, media pipeline | Isolated from the UI, so a crash in serving doesn't freeze the window and can be restarted. |
| ffmpeg workers | Probing, transcoding, subtitle extraction, thumbnail sprites | Bounded pool. Paused, killed or prioritised by the pipeline scheduler. |
| cloudflared | Public HTTPS link | Auto-downloaded on first use with checksum verification, or bundled. Health-monitored and restarted on failure. |
| WebRTC peer (Phase 3) | Data channels to friends, inside the server process | libdatachannel (`node-datachannel`). Viewers also connect to each other directly. |

### 5.2 Media pipeline

**On "Open Video":**

1. **Probe** with ffprobe: container, duration, video codec/profile/bit depth/HDR metadata, every audio track (codec, channels, language, title), every subtitle track (text vs image-based), and chapters.
2. **Decide the compatibility path** per stream (table below).
3. **Build the quality ladder** from the source resolution, never upscaling.
4. **Write HLS playlists immediately.** Segment boundaries are deterministic (every 4 s for transcoded levels), so complete VOD playlists exist before a single frame is encoded. Friends can seek anywhere instantly.
5. **Background jobs at low priority:** keyframe index for the "Original" level (if copyable), subtitle extraction to WebVTT, and the scrubber thumbnail sprite sheet.

| Source | Video | Audio |
|--------|-------|-------|
| H.264 8-bit 4:2:0 (most MP4/MKV/MOV) | **Original = stream copy**: zero CPU, true source quality. Lower levels transcoded on demand. | AAC stereo is copied. Everything else (AC3, E-AC3, DTS, TrueHD, FLAC, Opus, MP3…) is transcoded to AAC stereo with a proper 5.1→2.0 downmix. Audio is cheap. |
| HEVC, 10-bit, VP9, AV1, MPEG-4 ASP (old AVI), VC-1/WMV, etc. | All levels transcoded to H.264 on demand. HEVC Main/Main 10 SDR additionally gets an untouched "Original" level that only HEVC-capable browsers pick (Phase 3). | Same as above. |
| HDR10 / HLG / Dolby Vision | Transcode with tone mapping to SDR (zscale + tonemap), otherwise colours look washed out. No untouched original. | Same as above. |

**Quality ladder** (only levels at or below the source resolution are offered):

| Level | Resolution | Target video bitrate | Notes |
|-------|-----------|----------------------|-------|
| Original | source | source (copy) or high-quality transcode | Default for the host and for viewers on fast links. |
| 1080p | 1920×1080 | about 5 Mbit/s | |
| 720p | 1280×720 | about 2.8 Mbit/s | Good default for most remote viewers. |
| 480p | 854×480 | about 1.2 Mbit/s | |
| 360p | 640×360 | about 0.7 Mbit/s | Weak mobile connections. |
| Audio | | AAC stereo, about 160 kbit/s | One rendition per audio track, shared by all qualities. |

**Demuxed audio:** video and audio are separate HLS renditions. Audio is encoded once and shared by every quality level. **Each viewer can pick their own audio track** (dubbed vs original language) through standard HLS alternate audio, without affecting anyone else.

**Just-in-time encoding and scheduling:**

- An *encoder job* is `(rendition, start segment)`: one ffmpeg process producing consecutive segments from that point, with a constant timestamp base offset so segments from different jobs align (validated in §2).
- On a segment request: if it's cached, serve it. If an active job will reach it within a few segments, wait for it. Otherwise, start a new job at that segment, which is a seek.
- Jobs that run far ahead of every viewer's playhead (more than about 2 minutes) are **paused**, then resumed when viewers approach. Idle jobs are stopped. This keeps CPU and RAM flat during a movie.
- **Concurrency cap** is derived from cores and RAM (about 3 on this machine). Priority goes to renditions with the most active viewers. Thumbnails and subtitle extraction run at the lowest priority.
- **Hardware encoder detection** runs at startup with a real 1-frame test encode for NVENC, QSV, VAAPI, VideoToolbox (macOS) and AMF (Windows), falling back to libx264. Detection uses a real test because, as seen on this machine, "the encoder exists" doesn't mean "the encoder works".
- **Cache:** `~/.cache/watchroom/media/<file-fingerprint>/…`, reused when the same file is opened again (instant rewatching and seeking), with a size cap (default 10 GB, `WATCHROOM_CACHE_GB`); the least recently opened videos are removed first.

**Subtitles (per viewer):** embedded text subtitles (SRT, ASS, mov_text, WebVTT) and external files next to the video (`movie.srt`, `movie.en.ass`) are converted to WebVTT and offered as tracks. Each viewer chooses independently. Image-based subtitles (PGS/VobSub from Blu-ray rips) can only be burned in, which would force everyone into the same rendition. They're listed as a known limitation, with an optional host-wide "burn in" mode later.

### 5.3 Delivery and remote access

Two independent choices:

**A. How friends reach the app (the link):**

| Provider | Setup | Link | Throughput | Caveats |
|----------|-------|------|------------|---------|
| **Cloudflare quick tunnel** (default) | None. No account, no router changes. Works behind CGNAT. | Random `https://….trycloudflare.com`, new on every app launch | Generally good | No uptime guarantee. Max 200 in-flight requests (plenty for this). **Cloudflare's terms restrict serving video through its free CDN/tunnel**, so bulk video through it may be throttled or blocked. |
| Tailscale Funnel | Already installed here; enable Funnel once | Stable `https://jarvis.<tailnet>.ts.net` | **Capped, limit unpublished.** Some users report about 1 Mbit/s for video. | Fine for page, chat and sync. Risky for HD video. |
| Custom URL / port forwarding | Router port-forward + public IP (not CGNAT) + HTTPS | Your own | Best: your full upload | Needs router access and certificate handling. Offered as an advanced option. |
| LAN only | None | `http://192.168.x.x:port` | Best | Same network only. |

**B. How video bytes travel:**

- **HTTP through the link** (Phase 1): simple, works everywhere.
- **Peer-to-peer over WebRTC data channels** (Phase 3, built): the page, chat and sync still come through the link, which is small traffic. Video segments flow **directly** from your computer to each friend, encrypted (DTLS), and off Cloudflare. A custom hls.js loader fetches segments over the data channel and reports timings, so Auto quality still works. When a direct connection can't be made, that viewer silently uses HTTP through the link. As built (see §9, Phase 3): the host's peer lives in the server (libdatachannel via `node-datachannel`), viewers also share recently played segments with each other (verified against the host's SHA-256 fingerprint), and sync/chat stay on the WebSocket (it proved robust; reconnects resume the seat).

**Recommendation:** Cloudflare quick tunnel for the link + P2P for video, with HTTP fallback. Tailscale Funnel and a custom URL are available as settings. → **Decision Q1.**

### 5.4 Synchronisation engine

**Room timeline (server-authoritative):**

```
state = { status: playing | paused | waiting, position, anchorServerTime, rate, version, actor }
expectedPosition(now) = paused ? position : position + (now − anchorServerTime) × rate
```

1. **Clock sync.** Each client measures its offset to the server clock with NTP-style WebSocket pings. It keeps the lowest-RTT samples and re-measures every 15 s and after reconnects. Typical error is well under 20 ms.
2. **Intents, not events (no echo loops).** The `<video>` element only *renders* room state. Only explicit user actions (our buttons, keyboard shortcuts, scrubber release, gestures) send intents: `play / pause / seek / rate` with the actor's current position and the state version they saw. The server orders intents, bumps `version` and broadcasts. Clients ignore anything older than what they have. Programmatic `play()`/`seek` never re-triggers a broadcast. Backgrounded phones or autoplay blocks therefore can't pause the room by accident. (On iPhone native fullscreen, where native controls are unavoidable, DOM events are mapped to intents with a guard window.)
3. **Scheduled start.** "Play" is broadcast with an anchor slightly in the future (about 200 to 800 ms, based on participants' latency). Every client pre-seeks, buffers, and starts at the same instant instead of "as soon as the message arrives".
4. **Drift correction.** About twice per second each client compares its position to `expectedPosition`:
   - under ~0.1 s: do nothing;
   - ~0.1 s to 1 s: nudge `playbackRate` by up to ±8% (pitch-preserved, inaudible) until converged;
   - over ~1 s: hard seek (with seek-latency compensation).
5. **Buffering policy** (host setting):
   - **"Wait for everyone"** (default): if someone stalls for more than 1.5 s, the room pauses with "Waiting for Aziz…". It resumes with a scheduled start once everyone is ready, or after a 10 s cap. A chronically slow viewer is then marked "catching up" and stops holding the room.
   - **"Don't wait"**: slow viewers catch up on their own.
6. **Late join.** The join snapshot includes the state. The new client starts loading at the expected position (plus estimated load time), then the drift loop fine-tunes it.
7. **Unstable connections.** Auto-reconnect with jittered backoff. A 30 s resume window keeps your name and session (no join/leave spam) and replays missed chat. "Auto" quality steps down under poor bandwidth. A status indicator shows "Reconnecting…".
8. **Autoplay.** Clicking **Join** is the user gesture that unlocks audio playback. If a browser still refuses, a one-tap "Tap to sync" overlay appears.
9. **Playback speed is room-wide.** Different speeds would make sync impossible. Volume, quality, subtitles and audio track are per person.
10. **Control permissions:** everyone by default (your requirement). The host can switch to "host only" if things get chaotic. Rapid repeated seeks are coalesced. Every action is attributed in the UI ("Dilnoza jumped to 41:12").

**Target:** participants within about 50 to 150 ms of each other on stable connections, continuously corrected.

### 5.5 Chat and social

- **Message types:** text, emoji, sticker, image, and system messages (joins, leaves, playback actions, host actions). System messages are visually distinct: centred, muted, with an icon, and never mistakable for user messages. Rapid playback actions are collapsed.
- **Delivery:** over the same WebSocket, with server-assigned order and IDs. The last 500 messages are kept in memory, and late joiners receive the history.
- **Images:** pick, paste or drag-drop. The browser downscales and re-encodes before upload (max 2560 px, strips EXIF/GPS metadata, typically 200 KB to 1 MB). GIFs pass through unchanged up to a size limit. The server validates real file type and dimensions, stores under a random ID, and serves with safe headers. Click opens a lightbox.
- **Emoji:** full picker with categories, search, skin tones and recents (bundled emoji data, rendered with the OS emoji font).
- **Stickers:** bundled sticker packs built from Microsoft's MIT-licensed Fluent Emoji 3D artwork. No external services and no API keys.
- **Presence:** online list with colour avatars, host badge, per-person status (watching / buffering / reconnecting), plus a host-only connection-quality view.
- **Extras:** typing indicator, unread badge and tab-title counter, floating emoji **reactions** over the video, optional sound on new message.
- **Retention:** everything lives in memory and temp files and is deleted when the room ends.

### 5.6 Security model

- **Capability link:** `https://<public-host>/join/<roomId>#<roomKey>`. The 128-bit key sits in the URL **fragment**, which browsers never send to servers, proxies or logs (including Cloudflare's). The page's script sends it over the encrypted WebSocket to join, and the server compares it in constant time.
- **Optional room password,** with rate-limited attempts. **Lock room** stops new joins. **Kick/ban** works per session and device. **Regenerate link** invalidates the old one. Max-participants limit.
- **Sessions:** joining issues a random 256-bit session token, stored as an HttpOnly, Secure, SameSite=Strict cookie. Every playlist, segment, subtitle and image request requires a valid session for the current room.
- **No filesystem exposure:** the network API has **no way to name a file**. The video is chosen only through the native dialog in the host app. Media URLs carry only rendition names and numeric segment indexes (regex-validated) and map to files the pipeline generated itself.
- **Host powers live only in the desktop app** (Electron IPC), never in HTTP endpoints. Requests through cloudflared arrive from `127.0.0.1`, so nothing in the server treats localhost as trusted.
- **Network binding:** the server binds to `127.0.0.1` in tunnel mode and to the LAN interface only when you explicitly enable LAN mode.
- **Hardening:** zod validation on every WebSocket message, size limits and per-session rate limits, strict Content-Security-Policy, `Referrer-Policy: no-referrer`, `nosniff`, no framing. Electron with context isolation, sandbox, no Node in renderers, and blocked navigation.
- **No third-party calls from viewers' browsers:** fonts, emoji and stickers are bundled. Friends' browsers talk only to your host, except for YouTube videos, which they play from YouTube in its isolated, privacy-enhanced player (see the YouTube section in 9).
- **Room end** invalidates all tokens and deletes chat images and (by default) cached segments.
- *Honest caveat:* the link is a bearer secret. Anyone you forward it to can join unless a password is set. You get join notifications and can kick.

### 5.7 Bandwidth and resources

- A live **host dashboard** shows total upload rate, each viewer's quality/bitrate, latency, buffer health and connection type (P2P or relay).
- **Warnings** appear when the estimated demand exceeds your measured upload. There's an option to cap the maximum quality offered to remote viewers.
- Segments are cached and shared: N viewers at 720p cost **one** 720p encode.
- Keep-awake while a room is active. Clean shutdown kills all workers and the tunnel.

---

## 6. UI/UX structure

**Design direction:** VS Code's structure (title bar, resizable panels, tabs, status bar, density, keyboard-first) combined with Netflix's video stage (black stage, cinematic controls overlay that gets out of the way). Dark-first, one accent colour, Inter for UI text with tabular numerals for timecodes, a 4 px spacing grid, 150 to 200 ms transitions only where they aid understanding.

**Screens:**

1. **Host start screen** (desktop app): large *Open Video* button + drag-and-drop zone, recent videos with thumbnails, system check (ffmpeg, hardware encoder, link status).
2. **Room ready card** (host): video info (codec, resolution, audio/subtitle tracks, "Direct" vs "Transcoding"), share link with *Copy* button and **QR code** (for phones), link status.
3. **Join page** (friends): blurred poster frame from the video, title, duration, who's inside, name field (remembered), *Join*. Clear error states: invalid link, room locked, wrong password, host offline, room ended.
4. **Room** (everyone):

```
+- Title bar: [logo] Watchroom - Movie title     (avatars)  [Share] [Layout] [Settings] -+
|                                                     | [Chat] [People]                  |
|                                                     |                                  |
|                    VIDEO STAGE                      |  messages...                     |
|                                                     |                                  |
|  [>] [-10] [+10] [vol ===]   41:12 / 2:03:55        |                                  |
|  ======================o------------------------    |                                  |
|            [CC] [Audio] [720p] [1x] [Chat] [Full]   |  [emoji] [image]  Type message.. |
+-----------------------------------------------------+----------------------------------+
| Status bar: * Connected 38 ms | In sync +-40 ms | 720p Auto | 4 watching | up 9.8 Mb/s  |
+----------------------------------------------------------------------------------------+```

**Layouts** (per person, remembered):

- **Side-by-side:** video left, chat right, with a draggable divider.
- **Stacked:** video top, chat below. Default on phones in portrait.
- **Full screen:** the whole stage goes full screen (not just the `<video>`), so chat stays available as a translucent **overlay drawer** (toggle with `C`) or in **compact mode**, where new messages appear briefly as subtle toasts and `Enter` opens a minimal input.
- Phones in landscape get the full-screen video with the chat drawer. iPhone's native full screen can't show custom overlays, so the app uses an in-page full-viewport mode there.

**Player:** auto-hiding controls (about 3 s idle, cursor hidden); scrubber with buffered ranges, hover time and **thumbnail preview**; a brief centred action indicator with attribution ("Aziz paused"); menus for quality (Auto + levels, showing the current Auto pick), speed (room-wide, labelled as such), subtitles and audio track; double-tap left/right to skip ±10 s on touch; aspect ratio always preserved (letterboxed), with an optional "fill" mode.

**Keyboard shortcuts** (disabled while typing in chat):

| Key | Action | Key | Action |
|-----|--------|-----|--------|
| Space / K | Play / pause | F | Full screen |
| ← / → | −5 s / +5 s | C | Toggle chat |
| J / L | −10 s / +10 s | Shift + ← / → | Previous / next chapter (if any) |
| ↑ / ↓ | Volume | M | Mute |
| < / > | Speed down/up (room-wide) | 0–9 | Jump to 0–90% |
| S | Cycle subtitles | ? | Shortcut help |

**Responsive targets:** desktop ≥1280 px, tablets 768 to 1279 px, phones down to 360 px, with touch targets of at least 44 px.

---

## 7. Other essentials

- **Change video without ending the room.** Everyone switches together and the chat is preserved.
- **Host leaves or closes the app.** Friends see "The host ended the session" instead of a frozen player.
- **Accessibility:** keyboard navigation, visible focus, ARIA labels on all controls, sufficient contrast.
- **Diagnostics panel** (host): pipeline jobs, cache usage, per-viewer stats, logs. Useful when a friend says "it's laggy".
- **Persistence:** display name and preferences per browser. On the host: recent files and settings.

---

## 8. Known limitations (stated up front)

- **Your upload speed is the ceiling.** Total viewers × quality must fit in it. Auto quality and the dashboard help, but they can't create bandwidth.
- **Perfect frame-level sync over the internet isn't possible.** Expect about 50 to 150 ms between people, continuously corrected.
- **Quick-tunnel links change every time the app starts**, and the tunnel has no uptime guarantee. A permanent link needs Tailscale Funnel, a Cloudflare account with a domain, or port forwarding.
- **Your computer must stay on and online.** The app keeps it awake while hosting.
- **Image-based subtitles (PGS/VobSub)** can't be per-viewer. Burn-in would be room-wide.
- **iPhone:** no custom overlay in native full screen (handled by the in-page full-screen mode). iOS older than 17.1 uses Safari's native HLS. Quality picking still works there by switching playlists, but P2P delivery isn't available, so those viewers fall back to the link.
- **Hardware encoding uses the Intel GPU (VAAPI)**; NVENC needs the NVIDIA driver. 4K/HDR sources are still heavy.
- **Direct connections reveal IP addresses** to the others in the room, and need networks that allow UDP hole punching (no TURN relay is run). Both are why they can be switched off and why the link always remains as fallback.
- **YouTube videos** play only where their owner allows embedding; YouTube refuses many (music especially) on pages opened by an IP address (same-network links); live streams are play/pause only; YouTube may show a viewer an ad, after which that viewer catches up.
- **Styled subtitles** are drawn by our own renderer: positions, colours, outlines, fades, rotation and movement are supported; karaoke animation, clipping and vector drawings are not (karaoke text shows plainly). Fonts embedded in MKV files aren't used.

---

## 9. Implementation phases

Each phase ends with a working, tested app, not a half-built layer.

### Phase 1: Watching together works, for real (✅ done)

Delivered as planned, plus: hardware encoding via VAAPI, a 240p level for very slow uploads, chat in full screen,
a local-network mode, and persistence of the link mode. Not in Phase 1 as planned: subtitles (Phase 2), P2P (Phase 3).
Test status: 33 unit tests, 49 media/server tests (10 formats, software and hardware encoding), 10 multi-browser end-to-end tests,
and a live test through a real Cloudflare tunnel (remote viewer within 6 ms of the host).

- Monorepo, Electron shell, server in a utility process, host start screen with native *Open Video* and drag-drop.
- Media pipeline: probe, compatibility paths, quality ladder, JIT HLS with demuxed audio, scheduler (pause/resume/kill), cache, hardware-encoder detection.
- Rooms, capability links, sessions, media auth, security headers, IPC-only host powers.
- Link providers: Cloudflare quick tunnel (managed), LAN, custom URL. Live link status and copy/QR.
- Sync engine: complete §5.4 (clock sync, intents, scheduled start, drift correction, buffering policy, late join, reconnect/resume, autoplay unlock).
- Player: all controls from §6, per-viewer quality (incl. native-HLS fallback), room-wide speed, full screen, shortcuts, per-viewer audio track.
- Basic chat (text + system messages) and online list, so Phase 1 is genuinely usable.
- Tests: sync math and protocol unit tests; pipeline integration tests over a generated format matrix (MKV H.264+AC3, MKV HEVC 10-bit+DTS, MP4 H.264+AAC, WebM VP9+Opus, AVI MPEG-4+MP3, MOV); Playwright end-to-end with several browsers checking play/pause/seek from different participants and positions within tolerance.

**Exit criteria:** open an MKV, send the link, a friend on another network joins from a phone, anyone can play/pause/seek and everyone stays in sync, and each person picks their own quality.

### Phase 2: Social features and the full UX (✅ done)

Delivered as planned. Notable decisions and fixes made along the way:
- Chat pictures are resized to 1600 px and re-encoded in the browser (WebP where supported), which also drops EXIF/GPS. The server
  identifies the type from the bytes (PNG/JPEG/GIF/WebP only), serves pictures only to room members, and sandboxes them with CSP.
- Subtitles: embedded text tracks are extracted in one low-priority pass; files next to the video are matched by name and language;
  legacy Windows-1251/1252 files are converted to UTF-8 before conversion to WebVTT. Rendering is our own (size and background
  per viewer), so it works the same inside full screen.
- Seek-bar previews decode keyframes only (a 2-hour film takes well under a minute, at low CPU priority) and are cached.
- Phones: tapping the picture toggles the controls (a touch `pointerleave` bug that hid them instantly was fixed); narrow players get a
  compact bar with a More sheet; menus become bottom sheets; phones in landscape fill the screen with floating chat.
- Read-ahead is capped at 2 minutes so low-bitrate viewers don't hoard the host's upload; the room pauses itself at the end of the video.
- A class of focus bugs was fixed: popovers and dialogs now install their listeners once, so frequent re-renders (player time, host
  status) never steal focus from what someone is typing.
Test status after Phase 2: 45 unit, 56 media/server, 22 browser end-to-end tests (stable across repeated runs), plus a desktop smoke test.

- Complete chat: emoji picker, sticker packs, images (paste/drag/upload, compression, lightbox), grouping, unread, typing, reactions over video.
- Layouts: side-by-side (resizable), stacked, full screen with overlay drawer and compact mode, all remembered per person.
- Responsive phone/tablet layouts, touch gestures, bottom-sheet menus.
- Host dashboard: participants with quality/latency/buffer/connection type, upload meter, room settings (password, lock, control permissions, buffering policy, max viewers), kick/ban, regenerate link.
- Scrubber thumbnail previews, subtitles (embedded text + external files, per viewer, size/background options).
- Visual polish pass: loading/empty/error states, accessibility, consistency audit.

### Phase 3: Delivery, media depth, hardening, packaging (✅ done)

Delivered as planned, plus a request made after Phase 2: **chat cards over the video** when the chat is out of sight
(full screen, phone landscape, hidden panel). New messages, arrivals and departures slide in at the bottom right,
stay for a readable time (4.5–15 s by length, merged per sender, paused while hovered or answered), can be answered
in place (the reply quotes the message), dismissed, or opened in the chat. Room notices make way before messages when
space runs out; phones get fewer, compact cards (tap for actions, swipe to dismiss). Quoted replies work in the
normal chat panel too.

Notable decisions and findings:
- **Direct delivery.** The host side runs in the server process (libdatachannel through `node-datachannel`, N-API, no
  Electron-specific code), so it works for the desktop app and the headless host alike. A swarm in each browser picks
  the source per segment: its own memory cache, another viewer who has it (only with ≥6 s buffered; bytes verified
  against `/media/…/<n>.ts.sha256` before use, and a viewer who sends wrong bytes is ignored for the session), the host
  directly, or HTTP. Host-direct vs link is chosen by measured throughput with occasional exploration. Measured live
  through a real Cloudflare link: direct connections form on this network; segments through the link travel host →
  Cloudflare → viewer at about 1.5 Mbit/s on this upload.
- **Link readiness.** A new quick-tunnel name resolved locally ~15 s before it resolved in a browser; the link is now
  announced only once Cloudflare's and Google's public resolvers (queried over HTTPS by IP) answer for it.
- **HEVC original.** HEVC Main/Main 10 SDR sources get an untouched "Original" level (MPEG-TS, `hvc1` codec string)
  in addition to a full H.264 ladder. hls.js drops it where the browser can't decode HEVC; native-HLS players get a
  playlist without it. Open-GOP x265 streams put leading frames before each keyframe; segments still start exactly on
  the keyframe and decode on their own. The desktop app (Chromium 156) decodes HEVC, so the host watches HEVC files
  with no encoding at all.
- **Styled ASS subtitles** without a WebAssembly renderer (keeps the first load light on a slow upload): the original
  script is kept next to the WebVTT fallback and drawn by our renderer inside the picture area (letterbox-aware).
- **Recent videos and settings** live in `~/.config/watchroom` (not the cache); posters are made once per video in the
  sandbox and delivered only over the desktop IPC. Positions are saved every 10 s and on close; a video reopened
  resumes paused where it was left (not near the start or the credits).
- **Hardening.** ffmpeg runs in a bubblewrap sandbox (see SECURITY.md); encoders are paused and stopped through the
  whole process tree. Fuzzing found and fixed: misbehaving clients kept their seat for the reconnect grace (a flood
  could fill the room), and a joined client could draw an error reply for every flooded message. The load test
  found that requests beyond the encoder cap evicted busy encoders (thrashing); they now queue. Bad-network tests
  showed the old "offline" test never actually dropped the WebSocket; drops are now real (Playwright WebSocket routing).
- **Packaging.** electron-builder AppImage + .deb using the already installed Electron. ffmpeg comes from the system
  (the .deb depends on it): the distribution build has VAAPI, typical static builds don't.

Test status after Phase 3: 73 unit (including 15,000 random room actions), 75 media/server (10 formats with software
and VAAPI encoding, all sandboxed; direct delivery; hostile traffic; encoder queueing), 33 browser end-to-end tests
(sync, chat cards, replies, styled subtitles, phones, direct connections incl. tampering, HEVC fallback, slow and
dropping networks), the desktop smoke test, and the packaged app and AppImage smoke-tested on this machine.
Load test (8 viewers, 5 qualities, 1080p, 1.5× real time for 60 s): 368 segments, 0 errors, median 18 ms, p95 0.6 s,
server process 8% CPU and 134 MB.

Planned but deliberately not done: sync and chat over WebRTC (the WebSocket with seat resume proved robust in the
drop tests), a bundled ffmpeg on Linux (see above), macOS builds.

**Windows host (added 2026-11-10, on request).** `npm run package:win` builds a per-user NSIS installer on Linux:
Windows Electron, ffmpeg 9.0.2 (gyan.dev essentials, GPL, libx264) and cloudflared are downloaded and SHA-256
verified, then bundled; the server finds them through `WATCHROOM_FFMPEG/FFPROBE/CLOUDFLARED`. The NSIS uninstaller
is extracted with electron-builder's own pure-JS reader instead of running the installer under Wine
(`scripts/electron-builder-no-wine.cjs`). Windows specifics in the code: AppData folders, a log file, file renames
retried while Windows briefly locks a fresh file, stale-tunnel cleanup via `tasklist`, software x264 by default
(hardware encoders are only validated on Linux), no ffmpeg sandbox. The installer's payload was checked file by file
against the packaged app; the Windows-only code paths have unit tests run with the platform switched to Windows.
It has not been run on a real Windows machine here (no Windows available, and running Windows programs under Wine
was not permitted in this environment).

**YouTube videos (added 2026-11-19, on request).** A YouTube link plays in every viewer's browser in YouTube's own
embedded player, kept in sync by the same room timeline. Nothing is downloaded or re-streamed: that would be against
YouTube's terms, fragile, and limited by the host's ~2 Mbit/s upload; this way YouTube's servers feed each viewer and
the host's upload is unused, on Linux and Windows alike.

- *Player abstraction.* The sync engine drives a `MediaSurface` (`apps/web/src/player/surface.ts`): the `<video>` +
  hls.js player for files, or `YouTubeSurface` (`youtube.ts`) for YouTube. The latter talks to the player only through
  its `postMessage` channel (the protocol YouTube's IFrame API script uses), so no YouTube script runs in our page and
  the CSP stays strict; only `frame-src https://www.youtube-nocookie.com` is added.
- *Measured behaviour it relies on* (probed with real players before building): ready in ~4 s; state reports every
  ~260 ms with a timestamp (positions are interpolated between them); speeds only in 0.05 steps (1.02 becomes 1.0);
  a seek from the initial "cued" state starts playback; a click in the picture toggles playback (paused → buffering →
  playing); unplayable videos answer error 150.
- *Priming.* Each player plays a moment muted behind a poster, then pauses: afterwards pauses, seeks and starts behave
  like a normal paused video, and the first shared start is near-instant. Until then the surface reports "not ready".
- *Sync tuning* (`YOUTUBE_SYNC`): nudges rounded away from the base speed to 0.05 steps, a 0.1 s dead band, hard seeks
  only above 1.5 s and at most every 4 s (each costs a moment of loading), and the play command issued 150 ms early
  (YouTube's start latency). Measured: three browsers within 0.15 to 0.3 s of each other, steady.
- *Clicks inside YouTube's frame* can't be intercepted (cross-origin), and covering the player is against YouTube's
  rules, so our control bar sits below the picture and the frame keeps its clicks. A state change counts as the
  viewer's when it goes against what we last commanded, right after the page lost focus to the frame (or while the
  frame has focus); it becomes the same play/pause intent as our buttons, and is undone in host-only rooms. Browser-
  initiated pauses (no click) are simply corrected.
- *The length* isn't available to the host (oEmbed has no duration), so viewers' players report it (`media-info`);
  the first report wins and the host's own player corrects it. Until then the scrubber is disabled.
- *Opening* goes over the room connection (`open-youtube` → `open-result`), so the desktop app, the command-line host
  and guests (chat cards) share one path; the host checks the link with oEmbed first (not found, private, embedding
  off). Recent videos, resume points and posters work as for files.
- *`localhost`, not 127.0.0.1.* YouTube refuses label/music videos in pages whose address is a bare IP (probed: same
  video plays on `localhost` and any host name, fails with "auth"/150 on 127.0.0.1). The host window and local links
  therefore use `http://localhost:<port>`; same-network (LAN IP) links carry that limitation and say so on error.

> If subtitles and multiple audio tracks matter a lot for your files, they move into Phase 1 (decision Q3).

---

## 10. Testing strategy

| Level | What | How |
|-------|------|-----|
| Unit | Timeline math, clock-sync estimator, drift controller, intent ordering, playlist generation, ladder selection, zod schemas | Vitest |
| Media integration | Every format in the matrix produces valid, aligned, playable HLS. Seeks and restarts align. Audio/subtitle tracks are exposed. | Generated fixtures + ffprobe assertions |
| End-to-end sync | 3 to 4 browsers in one room: play/pause/seek/rate from different people, late join, reconnect, throttled network, stalled viewer | Playwright with network emulation, asserting position deltas |
| Security | Unauthorized media access, path traversal attempts, oversized/malformed messages, rate limits, kicked-session reuse | Automated tests + manual review |
| Manual | Real phones (Android Chrome, iPhone Safari) over mobile data through the tunnel | Checklist per phase |

---

## 11. Decisions needed from you

| # | Question | Options | My recommendation |
|---|----------|---------|-------------------|
| Q1 | How should friends outside your network connect? | (a) Cloudflare tunnel link + P2P video with fallback; (b) Cloudflare tunnel for everything; (c) port forwarding / own domain; (d) Tailscale Funnel | **(a)**. Phase 1 ships (b) as the working base. Phase 3 adds P2P on top. (c) and (d) are also offered as settings. |
| Q2 | Which computers must the host app run on? | Linux only / + Windows / + macOS | Code stays cross-platform. I build and test Linux here. Windows/macOS installers can be built, but I can't test them on this machine. |
| Q3 | Do your videos often have multiple audio tracks or subtitles? | Yes, often / Rarely | If yes, per-viewer subtitles move into Phase 1 (audio tracks are already there). |
| Q4 | How many friends at once, and what's your upload speed? | e.g. "2–4 friends, 30 Mbit/s up" | Sets default quality caps and the participant limit. The default is up to 8 viewers. |

---

## 12. Repository layout (planned)

```
wm2/
├─ apps/
│  ├─ desktop/          Electron main + preload, packaging config
│  └─ web/              React client (viewer UI + host UI), Vite
├─ packages/
│  ├─ server/           Fastify + ws: rooms, sync, chat, media pipeline, tunnel manager
│  ├─ protocol/         Shared zod schemas, message types, sync math
│  └─ test-media/       Scripts that generate the format test matrix
├─ e2e/                 Playwright multi-browser sync tests
├─ docs/ARCHITECTURE.md
└─ package.json         npm workspaces
```
