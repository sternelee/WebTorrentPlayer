# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

TorPlay is a mobile-first P2P streaming video player built with **Tauri 2.0**, **SolidJS**, **Vidstack**, **Rust**, **axum**, and **librqbit**. It supports torrent streaming via magnet links or .torrent files, with video playback through a local HTTP proxy that handles Range requests for seeking.

## Build Commands

### Frontend (Vite + SolidJS)
```bash
pnpm dev          # Start dev server on port 1420
pnpm build        # Build for production (outputs to dist/)
pnpm serve        # Preview production build
```

### Desktop (Tauri)
```bash
pnpm tauri dev              # Run in development mode
pnpm tauri build --debug    # Build debug version
pnpm tauri build            # Build release version
```

### iOS
```bash
# Configure signing in src-tauri/tauri.conf.json first:
# "bundle": { "iOS": { "developmentTeam": "YOUR_TEAM_ID" } }

pnpm tauri ios build --export-method debugging

# Install to connected device (requires ios-deploy: brew install ios-deploy)
ios-deploy --bundle "src-tauri/gen/apple/build/torplay_iOS.xcarchive/Products/Applications/TorPlay.app" --justlaunch
```

### Android
```bash
pnpm tauri android build --debug
pnpm tauri android build
```

## Architecture

### Frontend-Backend Communication

The frontend (`src/`) and backend (`src-tauri/src/`) communicate via:

1. **Invoke commands** (frontend → backend): Defined in `lib.rs` with `#[tauri::command]`
2. **Events** (backend → frontend): Emitted via `app.emit()` with payloads defined in `state.rs`

Key commands:
- `start_torrent(magnet_uri)` - Add torrent from magnet link
- `start_torrent_file(torrent_bytes)` - Add torrent from file
- `select_torrent_file(info_hash, file_index)` - Select video file to play
- `pause_torrent/resume_torrent/stop_torrent(info_hash)` - Torrent lifecycle
- `get_stream_url(info_hash, file_index)` - Get HTTP stream URL

Key events:
- `torrent-metadata-ready` - Emitted when torrent metadata is parsed, contains file list
- `torrent-tick` - Emitted every second with download progress, speed, peers

### Streaming Architecture

1. Torrent data is stored in `app.path().cache_dir()/torrents` (platform-specific cache)
2. On app startup, an axum server binds to `127.0.0.1:0` (random port) and is stored in `AppState.server_port`
3. Video files are served via `http://127.0.0.1:{port}/stream/{info_hash}/{file_index}`
4. The proxy handles HTTP `Range` headers for seeking; rqbit prioritizes pieces around the playback window
5. Vidstack player loads the stream URL with native HTML5 video element

### Mobile Platform Integration

**Android Bridge** (`src/lib/android.ts`):
- `syncAndroidForegroundSession()` - Updates persistent notification with torrent status
- `syncAndroidPlaybackOrientation()` - Locks/unlocks landscape for fullscreen
- `listenToAndroidNetworkStatus()` - Reacts to network changes (metered, offline)

The bridge is injected by the Android native layer as `window.WebTorrentPlayerAndroid`.

**iOS**: Uses standard Tauri iOS setup. Configure team ID in `tauri.conf.json` under `bundle.iOS.developmentTeam`.

### State Management

`AppState` (`src-tauri/src/state.rs`):
- `session: Arc<Session>` - librqbit session for torrent management
- `server_port: RwLock<u16>` - Dynamic port for the HTTP proxy
- `monitored_torrents: RwLock<HashSet<String>>` - Track which torrents emit tick events

Torrent monitoring is spawned per-torrent in `spawn_torrent_monitor()` and runs until `stop_torrent()` is called.

### Subtitle Handling

When selecting a video file (`select_torrent_file`), the backend:
1. Identifies subtitle files in the same torrent (`.srt`, `.vtt`, `.ass`, `.ssa`, `.sub`)
2. Includes them in `only_files` so they are downloaded
3. Frontend loads subtitles via the same stream proxy with Vidstack's text track API

### i18n

Translation files are in `src/lib/i18n.ts`. Supported locales: `en`, `zh-CN`. Uses `@solid-primitives/i18n` with dictionary keys like `t('torrent.pasteMagnetHint')`.

## Key Files

| File | Purpose |
|------|---------|
| `src/App.tsx` | Main UI component with torrent input, file list, and Vidstack player |
| `src/lib/android.ts` | Android bridge for native features (notifications, orientation, network) |
| `src/lib/i18n.ts` | Translation dictionaries |
| `src-tauri/src/lib.rs` | Tauri commands, torrent lifecycle, event emission |
| `src-tauri/src/state.rs` | AppState, payload structs |
| `src-tauri/src/server.rs` | axum HTTP proxy with Range request handling |
| `src-tauri/tauri.conf.json` | Tauri config, CSP, iOS team ID |

## Development Notes

- The Vite dev server runs on port 1420; Tauri serves the WebView from this URL in dev mode
- Production builds output to `dist/` which Tauri bundles
- DHT persistence is disabled on mobile (`disable_dht_persistence: true` in `AppState::new`)
- The frontend never reads torrent files directly; all access is through the Rust proxy
- Video detection uses mime_guess and file extension checks (`.mp4`, `.mkv`, `.webm`, etc.)
