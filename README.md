# TorPlay

Mobile-first P2P streaming player built with **Tauri 2.0**, **SolidJS**, **Vidstack**, **Rust**, **axum**, and **librqbit**.

## Current flow

1. Paste a magnet URI in the Solid frontend.
2. The Tauri backend resolves torrent metadata with `librqbit` and emits:
   - `torrent-metadata-ready`
   - `torrent-tick`
3. The frontend selects a playable file.
4. Rust updates `only_files`, resumes the torrent, and serves the selected file through a local `axum` proxy on `127.0.0.1`.
5. The proxy handles HTTP `Range` requests and streams the file through rqbit's file stream, which prioritizes pieces around the active playback window.

## Stack

- **Frontend**: SolidJS + TypeScript + Vite + TailwindCSS
- **Player**: Vidstack custom elements (browser-supported formats)
- **Native player**: libmpv (desktop fallback for MKV/HEVC/AV1)
- **Desktop/Mobile shell**: Tauri 2.0
- **Backend**: Rust 2021
- **P2P engine**: librqbit 8.1.1
- **Streaming proxy**: axum + tokio

## Architecture notes

- All torrent data is rooted under `app.path().cache_dir()/torrents`.
- The WebView never reads torrent files directly.
- Playback always goes through the Rust localhost proxy.
- File metadata and progress are synchronized through Tauri events.
- Seeking works through `Range` handling in the proxy plus rqbit's stream-based sequential prioritization.

## Native player backend

TorPlay uses **libmpv** as the desktop fallback when a torrent file requires a native player (MKV, HEVC, AV1, etc.). Browser-supported formats (MP4, WebM, MOV) still play through Vidstack.

### Platform support

| Platform | Backend | Embedding approach |
|----------|---------|-------------------|
| macOS | libmpv | OpenGL render layer inserted below the WKWebView |
| Windows | libmpv | HWND child window positioned below the WebView with mouse passthrough |
| Linux | libmpv | Standalone window (GTK/OpenGL embedding can be added later) |
| Android | System/external player | `window.WebTorrentPlayerAndroid.openVideoPlayer()` bridge |
| iOS | System/external player | Open stream URL with system player |

Mobile platforms keep the external-player bridge because libmpv has no official Android/iOS bindings and integrating it would require large amounts of JNI/ObjC rendering glue.

## Development

```bash
pnpm build
pnpm tauri build --debug --no-bundle
```

### Desktop build prerequisites

- **macOS**: install mpv so the libmpv headers/library are available.
  ```bash
  brew install mpv
  export LIBRARY_PATH=/opt/homebrew/lib:$LIBRARY_PATH
  export PKG_CONFIG_PATH=/opt/homebrew/lib/pkgconfig:$PKG_CONFIG_PATH
  ```
- **Windows**: place `mpv.dll` or `libmpv-2.dll` where the linker can find it (e.g. next to the project or in `PATH`). On MSYS2 you can install `mingw-w64-x86_64-mpv`.
- **Linux**: install `libmpv-dev` (Debian/Ubuntu) or `mpv-devel` (Fedora).

### iOS Build & Install

**Prerequisites:**
- Xcode installed
- Apple Developer account with signing certificate
- iOS device connected via USB (or simulator)

**Configure signing:**
Update `src-tauri/tauri.conf.json` with your development team ID:
```json
"bundle": {
  "iOS": {
    "developmentTeam": "YOUR_TEAM_ID"
  }
}
```

**Build for iOS device:**
```bash
pnpm tauri ios build --export-method debugging
```

This generates an `.xcarchive` in `src-tauri/gen/apple/build/`.

**Install to connected device:**
```bash
# Using ios-deploy (install via: brew install ios-deploy)
ios-deploy --bundle "src-tauri/gen/apple/build/torplay_iOS.xcarchive/Products/Applications/TorPlay.app" --justlaunch
```

Or open `src-tauri/gen/apple/torplay.xcodeproj` in Xcode and run from there.

**First launch:** Trust the developer certificate in Settings → General → VPN & Device Management.

## IPC payloads

```ts
interface TorrentTickPayload {
  infoHash: string;
  downloadSpeedKbps: number;
  uploadSpeedKbps: number;
  peersConnected: number;
  progressPercent: number;
  state: "parsing" | "downloading" | "seeding" | "paused";
}

interface TorrentMetadataPayload {
  infoHash: string;
  files: { index: number; name: string; sizeBytes: number; isVideo: boolean }[];
}
```

### libmpv events (desktop only)

When mpv is active, the backend emits `mpv://event` with property changes:

```ts
type MpvEvent =
  | { event: "property-change"; name: string; data: unknown }
  | { event: "file-loaded" }
  | { event: "end-file"; reason?: string }
  | { event: "seek" };
```

Observed properties include `time-pos`, `duration`, `pause`, `volume`, `mute`, and `track-list`.
