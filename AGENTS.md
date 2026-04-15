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

### Key Events
- `torrent-metadata-ready`: Emitted when metadata parsed (file list)
- `torrent-tick`: Emitted every second (progress, speed, peers)

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
    native-player.ts    # External player integration
    video.ts            # Format detection (MKV, HEVC, etc.)
    i18n.ts             # Translations (en, zh-CN)
    search.ts           # Search state + localStorage
    sources.ts          # Torrent search sources (16 public trackers)

src-tauri/src/          # Rust backend
  lib.rs                # Tauri commands, torrent lifecycle
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

## Gotchas

1. **No test suite**: No tests found in this repo. Verify manually.
2. **Video format limits**: MKV/HEVC may need external player (native bridge or copy URL)
3. **CSP restricts media**: `media-src 'self' http://127.0.0.1:*` required for streaming
4. **DHT disabled on mobile**: `disable_dht_persistence: true` in AppState
5. **Subtitle auto-download**: Selected video's subtitles auto-included in `only_files`
6. **Search sources**: Initialized in `App.tsx` via `initializeSources()` from `lib/sources.ts`

## Existing Documentation

- `CLAUDE.md` - Detailed architecture and IPC reference
- `README.md` - Build commands and flow overview
- `GEMINI.md` - Alternative context file
