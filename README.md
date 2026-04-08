# WebTorrentPlayer

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
- **Player**: Vidstack custom elements
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

## Development

```bash
pnpm build
pnpm tauri build --debug --no-bundle
```

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
