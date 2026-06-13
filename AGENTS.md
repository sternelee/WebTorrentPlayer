# AGENTS.md

Agent guidance for TorPlay (WebTorrentPlayer). Use this file to avoid common mistakes when working in this repository.

## Build Commands

```bash
# Frontend only
pnpm dev          # Vite dev server on port 1420
pnpm build        # Build to dist/
pnpm serve        # Preview production build

# Tauri desktop
pnpm tauri dev              # Dev mode (connects to Vite)
pnpm tauri build --debug    # Debug build
pnpm tauri build            # Release build

# Mobile (requires signing config in tauri.conf.json)
pnpm tauri ios build --export-method debugging
pnpm tauri android build
```

## Architecture

- **Frontend**: SolidJS + Vidstack + TailwindCSS (src/)
- **Backend**: Rust + Tauri 2.0 + librqbit + axum (src-tauri/src/)
- **Communication**: Tauri `invoke` (commands) + `emit` (events)

### Key IPC Commands
| Command | Purpose |
|---------|---------|
| `start_torrent(magnet_uri)` | Add torrent from magnet link |
| `start_torrent_file(torrent_bytes)` | Add from .torrent file |
| `select_torrent_file(info_hash, file_index)` | Select video + auto-download subtitles |
| `pause_torrent/resume_torrent/stop_torrent` | Lifecycle management |
| `get_stream_url(info_hash, file_index)` | Get localhost proxy URL |
| `mpv_probe` | Check if libmpv is available (desktop only) |
| `mpv_start(args)` | Start mpv playback (`url`, `embed`, `subtitles`, `startAtSec`) |
| `mpv_stop` | Stop mpv and tear down render context |
| `mpv_command(cmd)` | Send raw mpv command vector |
| `mpv_set_property(name, value)` | Set mpv property |
| `mpv_set_geometry(geom)` | Position embedded mpv surface (desktop only) |

### Key Events
- `torrent-metadata-ready`: Emitted when metadata parsed (file list)
- `torrent-tick`: Emitted every second (progress, speed, peers)
- `mpv://event`: Emitted by mpv with property changes (`time-pos`, `duration`, `pause`, etc.)

### Streaming Flow
1. Magnet → librqbit resolves metadata (paused)
2. User selects video file → backend updates `only_files` + unpauses
3. axum proxy on `127.0.0.1:{port}` serves file with Range header support
4. Vidstack plays proxy URL; rqbit prioritizes pieces around playback window

## Project Structure

```
src/                    # SolidJS frontend
  App.tsx               # Main UI + player integration
  lib/
    android.ts          # Android bridge (window.WebTorrentPlayerAndroid)
    mpv.ts              # Native libmpv bridge (desktop only)
    native-player.ts    # External player integration
    video.ts            # Format detection (MKV, HEVC, etc.)
    i18n.ts             # Translations (en, zh-CN)
    search.ts           # Search state + localStorage
    sources.ts          # Torrent search sources (16 public trackers)

src-tauri/src/          # Rust backend
  lib.rs                # Tauri commands, torrent lifecycle
  mpv.rs                # libmpv lifecycle and Tauri commands
  mpv_render_mac.rs     # macOS embedded OpenGL render layer
  state.rs              # AppState, payload structs
  server.rs             # axum proxy with Range handling

src-tauri/gen/          # Generated native code
  android/              # Kotlin Android code
```

## Mobile Platform Notes

### Android
- Bridge injected as `window.WebTorrentPlayerAndroid`
- Features: foreground service, orientation lock, network status
- Native code in `src-tauri/gen/android/app/src/main/java/`

### iOS
- Requires `developmentTeam` in `tauri.conf.json` (currently set)
- Build: `pnpm tauri ios build --export-method debugging`
- Install: `ios-deploy --bundle "path/to/TorPlay.app" --justlaunch`

## Platform-specific player behavior

| Platform | Player backend | Notes |
|----------|---------------|-------|
| macOS | libmpv + OpenGL render layer embedded below WebView | Requires `brew install mpv` at build/runtime |
| Windows | libmpv + HWND child window embedded below WebView | Requires `mpv.dll` / `libmpv-2.dll` next to binary or in PATH |
| Linux | libmpv (currently standalone window) | Could be embedded via GTK/OpenGL like harbor |
| Android | System/external player via `window.WebTorrentPlayerAndroid` | libmpv not integrated |
| iOS | System/external player | libmpv not integrated |

## Gotchas

1. **No test suite**: No tests found in this repo. Verify manually.
2. **Video format limits**: MKV/HEVC fall back to native libmpv on desktop when available; otherwise external player or copy URL
3. **CSP restricts media**: `media-src 'self' http://127.0.0.1:*` required for streaming
4. **DHT disabled on mobile**: `disable_dht_persistence: true` in AppState
5. **Subtitle auto-download**: Selected video's subtitles auto-included in `only_files`
6. **Search sources**: Initialized in `App.tsx` via `initializeSources()` from `lib/sources.ts`
7. **libmpv desktop only**: mpv commands are compiled out on Android/iOS

## Existing Documentation

- `CLAUDE.md` - Detailed architecture and IPC reference
- `README.md` - Build commands and flow overview
- `GEMINI.md` - Alternative context file
