# WebTorrentPlayer Context

WebTorrentPlayer is a mobile-first P2P streaming video player built with **Tauri 2.0**, **SolidJS**, and **Rust**. It enables streaming torrents directly by proxying P2P data through a local HTTP server.

## Architecture Overview

-   **Frontend**: Built with **SolidJS**, **TypeScript**, and **Vidstack** for video playback. It communicates with the Rust backend via Tauri IPC (commands and events).
-   **Backend**: A Rust-based Tauri application using **librqbit** as the P2P engine and **axum** as a local streaming proxy.
-   **Streaming Proxy**: The `axum` server (running on `127.0.0.1`) handles HTTP `Range` requests from the video player, fetching and prioritizing pieces from the BitTorrent swarm via `librqbit`.
-   **Mobile Support**: Includes specific integrations for Android (foreground services, orientation management) via a custom bridge (`window.WebTorrentPlayerAndroid`).

## Key Technologies

-   **Frontend**: SolidJS, Vidstack, TailwindCSS, Vite.
-   **Backend**: Rust, Tauri 2.0, librqbit (BitTorrent), axum (HTTP Proxy), tokio (Async Runtime).
-   **IPC**: Tauri `invoke` for commands and `emit`/`listen` for real-time torrent stats and metadata.

## Core Workflows

1.  **Torrent Initialization**: User provides a Magnet URI or `.torrent` file. The backend adds it to `librqbit` in a paused state to resolve metadata.
2.  **Metadata Discovery**: Once metadata is ready, the backend emits a `torrent-metadata-ready` event with the file list.
3.  **File Selection**: The user selects a video file. The backend updates `librqbit` to prioritize that file (and subtitles), unpauses the torrent, and returns a local proxy URL.
4.  **Streaming Playback**: Vidstack requests the proxy URL. The `axum` server translates `Range` requests into `librqbit` stream reads, ensuring sequential piece prioritization for smooth playback.

## Project Structure

-   `src/`: SolidJS frontend source code.
    -   `App.tsx`: Main UI logic, player integration, and IPC handling.
    -   `lib/android.ts`: Android-specific bridge for native features.
-   `src-tauri/`: Rust backend source code.
    -   `src/lib.rs`: Tauri command definitions and event emission.
    -   `src/server.rs`: The `axum` streaming proxy implementation with `Range` support.
    -   `src/state.rs`: Global application state (session, port, monitoring).
    -   `tauri.conf.json`: Tauri application configuration.
-   `src-tauri/gen/android`: Android-specific native code (Kotlin).

## Development Commands

-   `pnpm dev`: Starts the Vite frontend development server.
-   `pnpm tauri dev`: Runs the application in development mode (Desktop).
-   `pnpm tauri android dev`: Runs the application on a connected Android device/emulator.
-   `pnpm build`: Builds the frontend assets.
-   `pnpm tauri build`: Builds the production application bundles.

## IPC API Reference

### Commands
-   `start_torrent(magnet_uri: string)`: Adds a torrent from a magnet link.
-   `start_torrent_file(torrent_bytes: number[])`: Adds a torrent from file bytes.
-   `select_torrent_file(info_hash: string, file_index: number)`: Prepares a specific file for streaming.
-   `pause_torrent` / `resume_torrent` / `stop_torrent`: Torrent lifecycle management.
-   `get_stream_url(info_hash: string, file_index: number)`: Returns the local proxy URL for a file.

### Events (Backend to Frontend)
-   `torrent-metadata-ready`: Emitted when torrent files are resolved.
-   `torrent-tick`: Emitted every second with download speed, progress, and peer count.

## Design Patterns

-   **State Management**: App state is managed in Rust using `Arc<AppState>` and shared with Tauri commands via `State`.
-   **Async Runtime**: Heavy use of `tokio` and `tauri::async_runtime` for P2P and proxy operations.
-   **Styling**: Modern, dark-themed UI using TailwindCSS with a mobile-first focus.

## Known Limitations & Future Improvements

-   **Video Format Support**: Playback is limited by the system's **WebView engine** (WebKit/WebView2).
    -   **MKV Containers**: Currently unsupported by HTML5 video tags in most browsers; playback will fail.
    -   **HEVC/H.265**: Support varies by OS and hardware (requires native codec support).
-   **Potential Solutions**:
    -   **Transcoding/Remuxing**: Integrate FFmpeg in the Rust backend to remux MKV to MP4 or transcode HEVC to H.264 on the fly.
    -   **Native Player Integration**: Use Tauri plugins to invoke platform-native players (e.g., ExoPlayer on Android, AVPlayer on iOS) for better format support.
    -   **WASM Decoding**: Use FFmpeg.wasm for client-side decoding (performance intensive).
