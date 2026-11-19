# Watchroom security

Watchroom puts a small server on your computer and lets people on the internet reach it. This page explains what it
protects, how, what remains possible, and how each protection is tested.

The goal, from the original brief: *"The application should not expose my computer or local files unnecessarily. Only
the selected video should be accessible to participants in the room."*

## Who could try what

| Who | What they could try | Protected by |
|-----|---------------------|--------------|
| Someone with no invite | Find the link, join, read anything | Unguessable links, no file paths over the network |
| An invited friend (or someone they forwarded the link to) | Read other files, control the host, disrupt the room | Only segments of the current video are served; host powers aren't reachable over the network; rate limits; the host can lock, password-protect and remove people |
| A malicious video file (e.g. from a torrent) | Exploit a bug in ffmpeg to read your files or reach the network | ffmpeg runs in a sandbox |
| A malicious website a guest visits | Use the guest's browser to talk to your Watchroom | Session cookie `SameSite=Strict`, WebSocket origin check, joining needs the room key |
| Another viewer on direct connections | Send corrupted or fake video | Every segment from another viewer is checked against the host's SHA-256 fingerprint before it plays |

## Protections

### Links and sessions
- The invite link is `https://<random>.trycloudflare.com/join/<room>#<key>`. The 128-bit key sits in the URL fragment,
  which browsers never send to servers (not to Cloudflare either). Regenerating the link invalidates the old key.
- After joining, a viewer gets a per-session token; media requests carry it in an `HttpOnly; SameSite=Strict` cookie
  (`Secure` over HTTPS). A removed viewer's token stops working immediately, and their device is banned from the room.
- Optional room password (stored as a salted scrypt hash), room lock and viewer limit; failed joins are rate-limited.

### What the network can reach
- The server listens on `127.0.0.1` only (Cloudflare connects to it locally). Local-network mode additionally listens
  on port 47800 of your LAN interfaces; the room key is still required.
- HTTP serves only: the web app, the current video's playlists and segments, its subtitles and seek previews, and chat
  pictures, all for joined viewers only. Every identifier is checked against a strict pattern; a fuzz test throws
  path tricks (`..`, `%2f`, `%00`, …) at every route and requires a 4xx answer with no file contents.
- No file path, folder name or host setting ever goes over the network. Opening videos, the recent list (with its
  pictures), link settings and the ffmpeg location live behind the desktop app's private IPC channel, which accepts
  calls only from the app's own window.
- Direct (WebRTC) connections serve the same thing as HTTP and nothing else: segments of the current video, by key,
  checked like HTTP requests. Private network addresses aren't offered as connection candidates.

### ffmpeg sandbox
Video files are complex input, and ffmpeg (which reads them) has had security bugs. Every ffmpeg/ffprobe run that
touches a video or subtitle file happens inside a [bubblewrap](https://github.com/containers/bubblewrap) sandbox:

- it sees the system's programs and libraries read-only, and the GPU (for hardware encoding);
- it sees exactly one input (the video or subtitle file) read-only and one output folder (that video's cache);
- your home folder and every other file don't exist inside;
- it has no network and no inherited environment variables.

The app proves the sandbox works at startup (a sandboxed tool must run and must not see your home folder) and shows
"Video tools sandboxed" on the home screen. Without bubblewrap it still works, unsandboxed, and says so.

**On Windows there is no ffmpeg sandbox** (bubblewrap is Linux-only). Every other protection on this page applies
there too. Open video files you trust.

### YouTube videos
A YouTube video never passes through your computer: each viewer's browser plays it in YouTube's embedded player.

- **The player is isolated.** It runs in a frame from `www.youtube-nocookie.com` (YouTube's privacy-enhanced mode),
  a different origin, sandboxed (it may run its own scripts and open YouTube in a new tab, nothing more). It can't
  read the page, the room key or the chat. Our page loads no YouTube script: it exchanges plain messages with the
  frame, accepts them only from that origin and that frame, and reads them as data.
- **What YouTube learns:** viewers' browsers fetch the player, the video and its thumbnails from YouTube, so YouTube
  sees their IP addresses (as with any embedded YouTube video). The frame is told which site embeds it (the origin
  only, e.g. `https://abc.trycloudflare.com`; never the path or the `#key`): YouTube refuses to play without it.
- **What your computer asks YouTube:** the title and channel of a linked video (YouTube's public oEmbed service), and
  one small thumbnail for your recent list. Only the 11-character video id from a link goes into those requests,
  inside fixed `https://www.youtube.com/…` and `https://i.ytimg.com/…` addresses: a link from a guest can never make
  your computer fetch an address of their choosing. Redirects are refused, answers are size-limited, the text is
  cleaned, and the thumbnail must be a real JPEG.
- **Links are checked strictly:** YouTube's own host names only (look-alike domains, `javascript:` and `file:` links
  are rejected), and an id of exactly 11 allowed characters.
- **Who may switch the video:** the host, and guests only while the host lets everyone control playback; switching
  is rate-limited. A chat link only shows a card; nothing opens until someone presses **Watch together**.

### Browser-side protections
- Strict Content-Security-Policy: scripts from the app only; connections to the same host only; no plugins; the only
  frame allowed is YouTube's privacy-enhanced player (`frame-src https://www.youtube-nocookie.com`), and images only from
  the app and YouTube's thumbnail server (`i.ytimg.com`); our pages can't be framed (`frame-ancestors 'none'`,
  `X-Frame-Options: DENY`). Plus `nosniff`, `no-referrer` (the YouTube frame alone gets the origin, see above), and a
  restrictive Permissions-Policy.
- Chat, names, subtitles (including `.ass` styling) are rendered as text by React; nothing user-supplied becomes HTML.
  Text is cleaned of control and bidirectional-override characters.
- Chat pictures are resized and re-encoded in the sender's browser (which drops location data), identified by their
  bytes on the server (PNG/JPEG/GIF/WebP only, size-limited), served only to room members, and sandboxed with their
  own CSP. They are deleted when the video is closed.

### Abuse and overload
- Every message is validated against a schema; malformed messages get a short answer, and a client that keeps
  sending them is disconnected and loses its seat at once (instead of keeping it for the reconnect grace).
- Per-person limits on messages, playback actions, chat, reactions, connection-setup messages, picture uploads; a
  sustained flooder is disconnected. Per-address connection limits; a client that can't keep up with what it's sent
  is dropped rather than buffered without limit.
- Direct connections: at most a few transfers per viewer at a time; extra requests are refused.
- Encoders are capped (about 3 on this laptop); extra work queues instead of piling up.

### Desktop app
- Electron with context isolation, sandboxed renderer, no Node.js in the page, navigation locked to the local app,
  new windows opened in the system browser, permissions limited to full screen and clipboard writes.
- The `.deb` installs Electron's AppArmor profile so Chromium's own sandbox works on Ubuntu 24.04.

## What remains possible (by design or out of scope)

- **People in the room can see each other's IP address** while direct connections are on (that is how direct
  connections work). Turn them off in the Room panel to route everything through Cloudflare.
- **Cloudflare carries the traffic** of the internet link (encrypted to Cloudflare, which terminates TLS). Direct
  connections are encrypted end to end (DTLS) and don't pass through Cloudflare.
- **Anyone with the link can join** until you lock the room, set a password, or create a new link. Links are meant to
  be shared with friends only.
- **Viewers can save what they watch** (a browser can always record what it plays). Only the selected video is ever
  sent, and only as stream segments, never the file itself.
- The app trusts your computer's own user account: anything already running as you could read the app's settings.
- The build tool (electron-builder) has moderate advisories in its own file-pattern matching (`minimatch`); it runs
  only when packaging, on our own configuration, and is not part of the app. Runtime dependencies: no known
  vulnerabilities (`npm audit --omit=dev`).

## How it's tested

| Area | Test |
|------|------|
| Path tricks, junk URLs, security headers | `packages/server/test/media/hardening.test.ts`, `server.test.ts` |
| Garbage and floods on the room connection (24 hostile connections while an honest viewer keeps playing) | `hardening.test.ts` |
| Room state machine under 15,000 random actions | `packages/server/test/fuzz.test.ts` |
| Direct-connection requests outside the current video, floods, junk frames | `p2p.test.ts`, `hardening.test.ts` |
| Tampered video from another viewer is rejected and that viewer ignored | `e2e/p2p.spec.ts` |
| Sandbox: other files invisible, no writes outside the cache, no network | `packages/server/test/media/sandbox.test.ts` |
| Cross-site WebSocket attempts | `server.test.ts` |
| Removed viewers lose media access | `server.test.ts` |
| Hostile `.ass` subtitles stay text | `apps/web/src/player/ass.test.ts` |
| Malformed peer messages | `packages/protocol/test/peerwire.test.ts` |
| YouTube links (look-alike hosts, junk), lookups (only the id is sent, errors, caching), who may switch videos, chat cards | `packages/protocol/test/youtube.test.ts`, `packages/server/test/youtube.test.ts` |
| YouTube player in real browsers: isolated frame, sync, clicks in the picture, host-only mode | `e2e/youtube.spec.ts` |
