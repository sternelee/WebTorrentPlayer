# TorPlay – Copilot Instructions

## Build & Dev Commands

```bash
# Frontend dev server (port 1420)
pnpm dev

# Desktop app (Tauri wraps the Vite dev server)
pnpm tauri dev

# Production builds
pnpm build                        # Frontend only (dist/)
pnpm tauri build --debug          # Debug desktop build
pnpm tauri build                  # Release desktop build

# Mobile
pnpm tauri ios build --export-method debugging
pnpm tauri android build
```

No test suite exists. Verify changes manually by running the app.

## Architecture

TorPlay is a **Tauri 2.0 desktop/mobile app** with a **SolidJS frontend** and a **Rust backend**. The two sides communicate exclusively through Tauri IPC — the WebView never reads torrent data directly.

### Streaming Flow (end-to-end)

1. User pastes a magnet URI or drops a `.torrent` file.
2. Frontend calls `invoke("start_torrent", ...)` → Rust adds the torrent to `librqbit` **paused** (metadata-only).
3. Rust emits `torrent-metadata-ready` with the file list; frontend renders the file picker.
4. User selects a video file → `invoke("select_torrent_file", ...)`.
5. Rust sets `only_files` (selected video + any subtitle files in the same torrent), unpauses the torrent, returns the proxy URL: `http://127.0.0.1:{port}/stream/{info_hash}/{file_index}`.
6. Vidstack loads the proxy URL. The **axum server** (`server.rs`) handles HTTP `Range` requests, seeked via `handle.stream(file_index)`, letting rqbit prioritize pieces around the playback head.
7. A per-torrent monitor loop (spawned in `lib.rs`) emits `torrent-tick` every second with progress/speed/peers.

### Key Source Files

| File | Role |
|------|------|
| `src/App.tsx` | Main UI: all IPC `invoke`/`listen` calls, Vidstack wiring, state signals |
| `src/lib/android.ts` | Android native bridge (`window.WebTorrentPlayerAndroid`) |
| `src/lib/video.ts` | Format detection — what plays in-browser vs. needs external player |
| `src/lib/sources.ts` | Torrent search sources (TPB, Nyaa, EZTV, etc.) |
| `src/lib/search.ts` | Search state store (SolidJS signals + localStorage persistence) |
| `src/lib/downloads.ts` | Download management wrappers (invoke-based) |
| `src-tauri/src/lib.rs` | All Tauri commands; torrent lifecycle; monitor loop |
| `src-tauri/src/server.rs` | axum proxy: `GET /stream/{info_hash}/{file_index}` with Range support |
| `src-tauri/src/state.rs` | `AppState`: librqbit `Session`, server port, monitored-torrent set |
| `src-tauri/src/download.rs` | Download dir, `export_file`, speed limits, file manager integration |

## Key Conventions

### Rust ↔ TypeScript IPC Payloads

All Rust payload structs are `#[serde(rename_all = "camelCase")]`. The TypeScript side mirrors this without any manual conversion. When adding a new field in a Rust payload struct, use snake_case in Rust and camelCase in TypeScript automatically.

```rust
// Rust (state.rs)
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TorrentTickPayload { pub download_speed_kbps: f64, ... }
```

### Tauri Commands Return Pattern

All `#[tauri::command]` functions return `Result<T, String>` (never custom error types). Errors are surfaced with `anyhow_to_string()` in `lib.rs`. New commands must be registered in the `invoke_handler!(tauri::generate_handler![...])` list in `lib.rs::run()`.

### Video & Subtitle Detection (Rust)

`is_video_path()` and `is_subtitle_path()` in `lib.rs` are the authoritative Rust-side detectors (mime_guess + extension fallback). A **duplicate** `is_video_path` also exists in `download.rs`. When adding new extensions, update both.

Subtitle types auto-included on `select_torrent_file`: `.srt`, `.vtt`, `.ass`, `.ssa`, `.sub`.

### Video Format Detection (Frontend)

`src/lib/video.ts` defines which containers play in-browser (`BROWSER_SUPPORTED_CONTAINERS`) vs. require an external player (`EXTERNAL_PLAYER_REQUIRED`). MKV and HEVC always require external player; MP4/WebM/MOV play natively.

### Android Bridge

Feature-detect before calling the bridge; never call bridge methods unconditionally:

```ts
import { hasAndroidBridge } from "./lib/android";
if (hasAndroidBridge()) { syncAndroidPlaybackOrientation(true); }
```

All bridge methods pass JSON strings, not objects, over the native boundary.

### Search Sources

Search sources (`src/lib/sources.ts`) implement `SearchSource.searchFn(keyword): Promise<SearchResult[]>`. They call the backend `http_get` command to bypass browser CORS. Add new sources to the `BUILT_IN_SOURCES` array and call `initializeSources()` once at app startup (already done in `App.tsx`).

### CSP Constraint

`tauri.conf.json` CSP allows `media-src 'self' http://127.0.0.1:* blob:`. The streaming proxy must stay on `127.0.0.1` (not `localhost`) for media to load. Do not change the proxy bind address without updating CSP.

### Platform-Conditional Rust Code

Use `#[cfg(target_os = "...")]` for platform-specific logic. DHT persistence is disabled on mobile (`#[cfg(any(target_os = "android", target_os = "ios"))]`). Desktop uses the user's Downloads folder; mobile uses the app cache dir for librqbit storage.

### State Access in Rust

`AppState` uses `parking_lot::RwLock` (not std). All reads are `.read()`, writes are `.write()`. The `session` field is `Arc<Session>` — clone the Arc when passing to async tasks, don't hold a lock across await points.

### Torrent Storage

- Desktop: librqbit downloads to `~/Downloads/TorPlay/` (platform-adjusted in `download.rs::get_default_download_dir`)
- Mobile: librqbit uses `cache_dir/torrents`; final export goes to device Downloads via `export_file` command
- All data lives under `app.path().cache_dir()/torrents` for session persistence
