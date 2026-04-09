# AGENTS.md — TorPlay

Mobile-first P2P streaming player. Now available in two editions: Tauri (WebView-based) and Flutter (Native).

## Two Editions

### 1. Tauri Edition (`/`)
- **Frontend**: SolidJS + Vidstack
- **Backend**: Tauri 2.0 + Rust
- **Player**: WebView HTML5 (limited format support)

### 2. Flutter Edition (`/flutter_app`) ⭐ Recommended
- **Frontend**: Flutter + Dart
- **Backend**: flutter_rust_bridge + Rust
- **Player**: media_kit (libmpv) - **Full format support (MKV, HEVC, etc.)**

---

## Flutter Edition (Recommended)

### Build Commands

```bash
cd flutter_app

# Install dependencies
flutter pub get

# Generate Rust bindings (after modifying Rust API)
flutter_rust_bridge_codegen generate

# Run development
flutter run

# Build for platforms
flutter build macos
flutter build ios
flutter build apk
flutter build windows
flutter build linux
```

### Architecture

**Flutter** (`lib/`):
- `blocs/torrent/` — BLoC state management
- `screens/` — Home, Player pages
- `models/` — Torrent metadata, stats models

**Rust** (`rust/src/`):
- `api/torrent.rs` — flutter_rust_bridge API
- `server.rs` — axum HTTP proxy on `127.0.0.1:{random_port}`
- `state.rs` — `AppState` with librqbit session

**Player**: media_kit (based on libmpv) supports all video formats including MKV and HEVC/H.265.

### Key Rust APIs (via flutter_rust_bridge)

```rust
// Initialize session and HTTP server
init_torrent_session(cache_dir: String) -> Result<u16>

// Start torrent
start_torrent(magnet_uri: String) -> Result<TorrentMetadataPayload>
start_torrent_file(torrent_bytes: Vec<u8>) -> Result<TorrentMetadataPayload>

// File selection
select_torrent_file(info_hash: String, file_index: usize) -> Result<String> // Returns stream URL

// Control
pause_torrent(info_hash: String) -> Result<()>
resume_torrent(info_hash: String) -> Result<()>
stop_torrent(info_hash: String) -> Result<()>

// Stats polling (1Hz recommended)
get_torrent_tick(info_hash: String) -> Result<Option<TorrentTickPayload>>
```

---

## Tauri Edition

### Build Commands

```bash
# Frontend only (Vite on :1420)
pnpm dev

# Desktop dev
pnpm tauri dev

# Desktop debug build
pnpm tauri build --debug

# iOS (configure team ID in tauri.conf.json first)
pnpm tauri ios build --export-method debugging

# Android
pnpm tauri android build --debug
```

### Architecture

**Frontend** (`src/`): SolidJS + Vidstack player + Tailwind. Communicates with Rust via Tauri IPC.

**Backend** (`src-tauri/src/`):
- `lib.rs` — Tauri commands (`start_torrent`, `select_torrent_file`, etc.)
- `server.rs` — axum HTTP proxy on `127.0.0.1:{random_port}`
- `state.rs` — `AppState` with librqbit session, server port, monitored torrents

### Key Commands & Events

**Invoke (frontend → backend)**:
- `start_torrent(magnet_uri)`, `start_torrent_file(torrent_bytes)`
- `select_torrent_file(info_hash, file_index)` — returns stream URL
- `pause_torrent/resume_torrent/stop_torrent(info_hash)`
- `get_stream_url(info_hash, file_index)`

**Events (backend → frontend)**:
- `torrent-metadata-ready` — file list available
- `torrent-tick` — 1Hz stats (speed, progress, peers)

### Mobile Platform Notes

**iOS**: Set `bundle.iOS.developmentTeam` in `tauri.conf.json`. Build exports to `src-tauri/gen/apple/build/`.

**Android Bridge** (`src/lib/android.ts`): Native layer injects `window.WebTorrentPlayerAndroid` with methods for:
- Foreground session notifications (`upsertForegroundSession`)
- Orientation lock (`enterLandscapeFullscreen`)
- Network status (`getNetworkStatus`)

DHT persistence disabled on mobile (`disable_dht_persistence: true` in `AppState::new`).

---

## Common Backend (Both Editions)

**Streaming Flow**:
1. Torrent added paused → metadata resolved
2. User selects file → `only_files` updated → torrent unpaused
3. Stream URL: `http://127.0.0.1:{port}/stream/{info_hash}/{file_index}`
4. Proxy handles HTTP `Range` requests; rqbit prioritizes pieces near playback window

---

## Video Format Support

| Format | Tauri (WebView) | Flutter (media_kit) |
|--------|-----------------|---------------------|
| MP4 | ✅ | ✅ |
| MKV | ❌ | ✅ |
| HEVC/H.265 | ❌ (varies) | ✅ |
| AVI | ❌ | ✅ |
| WebM | ✅ | ✅ |

---

## Files to Know (Tauri)

| File | Purpose |
|------|---------|
| `src/App.tsx` | Main UI, player integration, IPC listeners |
| `src/lib/android.ts` | Android native bridge |
| `src/lib/i18n.ts` | Translations (en, zh-CN) |
| `src-tauri/src/lib.rs` | Tauri commands, torrent lifecycle |
| `src-tauri/src/server.rs` | axum proxy with Range support |
| `src-tauri/tauri.conf.json` | CSP, iOS team ID, bundle config |

## Files to Know (Flutter)

| File | Purpose |
|------|---------|
| `lib/screens/home_screen.dart` | Main UI with magnet input and file list |
| `lib/screens/player_screen.dart` | Video player with custom controls |
| `lib/blocs/torrent/` | State management (BLoC) |
| `rust/src/api/torrent.rs` | Rust API exposed to Flutter |
| `rust/src/server.rs` | HTTP streaming proxy |
