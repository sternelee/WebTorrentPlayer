mod server;
mod state;

use std::{collections::HashSet, path::Path, sync::Arc, time::Duration};

use librqbit::{
    api::TorrentIdOrHash, AddTorrent, AddTorrentOptions, AddTorrentResponse, ManagedTorrent,
    TorrentStatsState,
};
use state::{AppState, TorrentMetadataFilePayload, TorrentMetadataPayload, TorrentTickPayload};
use tauri::{AppHandle, Emitter, Manager, State};

type TorrentHandle = Arc<ManagedTorrent>;

fn anyhow_to_string(error: anyhow::Error) -> String {
    error.to_string()
}

fn is_video_path(path: &Path) -> bool {
    let guessed = mime_guess::from_path(path).first();
    guessed.is_some_and(|mime| mime.type_() == mime_guess::mime::VIDEO)
        || path
            .extension()
            .and_then(|extension| extension.to_str())
            .map(|extension| {
                matches!(
                    extension.to_ascii_lowercase().as_str(),
                    "mp4" | "m4v" | "mkv" | "webm" | "mov" | "avi" | "ts" | "m2ts"
                )
            })
            .unwrap_or(false)
}

fn is_subtitle_path(path: &Path) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .map(|extension| {
            matches!(
                extension.to_ascii_lowercase().as_str(),
                "srt" | "vtt" | "ass" | "ssa" | "sub"
            )
        })
        .unwrap_or(false)
}

fn to_info_hash_hex(handle: &TorrentHandle) -> String {
    hex::encode(handle.info_hash().0)
}

fn build_tick_payload(info_hash: &str, handle: &TorrentHandle) -> TorrentTickPayload {
    let stats = handle.stats();
    let progress_percent = if stats.total_bytes == 0 {
        0.0
    } else {
        stats.progress_bytes as f64 / stats.total_bytes as f64 * 100.0
    };

    let (download_speed_kbps, upload_speed_kbps, peers_connected) = stats
        .live
        .as_ref()
        .map(|live| {
            (
                live.download_speed.mbps * 1024.0,
                live.upload_speed.mbps * 1024.0,
                live.snapshot.peer_stats.live,
            )
        })
        .unwrap_or((0.0, 0.0, 0));

    let state = match stats.state {
        TorrentStatsState::Initializing => "parsing",
        TorrentStatsState::Paused => "paused",
        TorrentStatsState::Live if stats.finished => "seeding",
        TorrentStatsState::Live => "downloading",
        TorrentStatsState::Error => "paused",
    };

    TorrentTickPayload {
        info_hash: info_hash.to_string(),
        download_speed_kbps,
        upload_speed_kbps,
        peers_connected,
        progress_percent,
        state: state.to_string(),
    }
}

fn emit_metadata_event(
    app: &AppHandle,
    info_hash: &str,
    handle: &TorrentHandle,
) -> Result<(), String> {
    let files = handle
        .with_metadata(|metadata| {
            metadata
                .file_infos
                .iter()
                .enumerate()
                .map(|(index, file)| TorrentMetadataFilePayload {
                    index,
                    name: file.relative_filename.to_string_lossy().into_owned(),
                    size_bytes: file.len,
                    is_video: is_video_path(&file.relative_filename),
                })
                .collect::<Vec<_>>()
        })
        .map_err(anyhow_to_string)?;

    app.emit(
        "torrent-metadata-ready",
        TorrentMetadataPayload {
            info_hash: info_hash.to_string(),
            files,
        },
    )
    .map_err(|error| error.to_string())
}

async fn wait_until_torrent_updatable(handle: &TorrentHandle) -> Result<(), String> {
    const MAX_ATTEMPTS: usize = 100;
    const RETRY_DELAY: Duration = Duration::from_millis(150);

    for _ in 0..MAX_ATTEMPTS {
        if !matches!(handle.stats().state, TorrentStatsState::Initializing) {
            return Ok(());
        }

        tokio::time::sleep(RETRY_DELAY).await;
    }

    Err("torrent is still initializing".to_string())
}

async fn start_torrent_inner(
    add_torrent: AddTorrent<'static>,
    state: State<'_, Arc<AppState>>,
    app: AppHandle,
) -> Result<String, String> {
    let response = state
        .session
        .add_torrent(
            add_torrent,
            Some(AddTorrentOptions {
                paused: true,
                overwrite: true,
                ..Default::default()
            }),
        )
        .await
        .map_err(anyhow_to_string)?;

    let handle = match response {
        AddTorrentResponse::AlreadyManaged(_, handle) | AddTorrentResponse::Added(_, handle) => {
            handle
        }
        AddTorrentResponse::ListOnly(_) => {
            return Err("list-only torrent responses are unsupported".to_string());
        }
    };
    let info_hash = to_info_hash_hex(&handle);

    emit_metadata_event(&app, &info_hash, &handle)?;
    app.emit("torrent-tick", build_tick_payload(&info_hash, &handle))
        .map_err(|error| error.to_string())?;

    if state.mark_monitored(&info_hash) {
        spawn_torrent_monitor(app, state.inner().clone(), info_hash.clone());
    }

    Ok(info_hash)
}

fn spawn_torrent_monitor(app: AppHandle, state: Arc<AppState>, info_hash: String) {
    tauri::async_runtime::spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_secs(1));

        loop {
            interval.tick().await;

            if !state.is_monitored(&info_hash) {
                break;
            }

            let handle = match state.torrent(&info_hash) {
                Ok(handle) => handle,
                Err(_) => {
                    continue;
                }
            };

            let _ = app.emit("torrent-tick", build_tick_payload(&info_hash, &handle));
        }
    });
}

#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {name}! WebTorrentPlayer backend is ready.")
}

#[tauri::command]
async fn start_torrent(
    magnet_uri: String,
    state: State<'_, Arc<AppState>>,
    app: AppHandle,
) -> Result<String, String> {
    start_torrent_inner(AddTorrent::from_url(magnet_uri), state, app).await
}

#[tauri::command]
async fn start_torrent_file(
    torrent_bytes: Vec<u8>,
    state: State<'_, Arc<AppState>>,
    app: AppHandle,
) -> Result<String, String> {
    if torrent_bytes.is_empty() {
        return Err("torrent file is empty".to_string());
    }

    start_torrent_inner(AddTorrent::from_bytes(torrent_bytes), state, app).await
}

#[tauri::command]
async fn select_torrent_file(
    info_hash: String,
    file_index: usize,
    state: State<'_, Arc<AppState>>,
) -> Result<String, String> {
    let handle = state.torrent(&info_hash).map_err(anyhow_to_string)?;
    wait_until_torrent_updatable(&handle).await?;
    let file_count = handle
        .with_metadata(|metadata| metadata.file_infos.len())
        .map_err(anyhow_to_string)?;

    if file_index >= file_count {
        return Err(format!("file index out of bounds: {file_index}"));
    }

    let only_files = handle
        .with_metadata(|metadata| {
            metadata
                .file_infos
                .iter()
                .enumerate()
                .filter_map(|(index, file)| {
                    (index == file_index || is_subtitle_path(&file.relative_filename))
                        .then_some(index)
                })
                .collect::<HashSet<_>>()
        })
        .map_err(anyhow_to_string)?;

    state
        .session
        .update_only_files(&handle, &only_files)
        .await
        .map_err(anyhow_to_string)?;

    if handle.is_paused() {
        state
            .session
            .clone()
            .unpause(&handle)
            .await
            .map_err(anyhow_to_string)?;
    }

    Ok(get_stream_url(info_hash, file_index, state))
}

#[tauri::command]
async fn pause_torrent(info_hash: String, state: State<'_, Arc<AppState>>) -> Result<(), String> {
    let handle = state.torrent(&info_hash).map_err(anyhow_to_string)?;
    state.session.pause(&handle).await.map_err(anyhow_to_string)
}

#[tauri::command]
async fn resume_torrent(info_hash: String, state: State<'_, Arc<AppState>>) -> Result<(), String> {
    let handle = state.torrent(&info_hash).map_err(anyhow_to_string)?;
    state
        .session
        .clone()
        .unpause(&handle)
        .await
        .map_err(anyhow_to_string)
}

#[tauri::command]
async fn stop_torrent(info_hash: String, state: State<'_, Arc<AppState>>) -> Result<(), String> {
    let torrent = state.torrent(&info_hash).map_err(anyhow_to_string)?;

    state
        .session
        .delete(TorrentIdOrHash::Hash(torrent.info_hash()), true)
        .await
        .map_err(anyhow_to_string)?;

    state.unmark_monitored(&info_hash);
    Ok(())
}

#[tauri::command]
fn get_stream_url(info_hash: String, file_index: usize, state: State<'_, Arc<AppState>>) -> String {
    let port = *state.server_port.read();
    format!("http://127.0.0.1:{port}/stream/{info_hash}/{file_index}")
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            let cache_dir = app.path().cache_dir()?.join("torrents");

            std::fs::create_dir_all(&cache_dir)?;

            let state = Arc::new(tauri::async_runtime::block_on(AppState::new(cache_dir))?);
            let port = tauri::async_runtime::block_on(server::start_server(state.clone()))?;

            *state.server_port.write() = port;
            app.manage(state);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            greet,
            start_torrent,
            start_torrent_file,
            select_torrent_file,
            pause_torrent,
            resume_torrent,
            stop_torrent,
            get_stream_url
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
