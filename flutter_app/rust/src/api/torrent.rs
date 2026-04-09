use std::{collections::HashSet, path::Path, sync::Arc, time::Duration};

use flutter_rust_bridge::frb;
use librqbit::{
    api::TorrentIdOrHash, AddTorrent, AddTorrentOptions, AddTorrentResponse, ManagedTorrent,
    TorrentStatsState,
};

use crate::state::{
    AppState, TorrentMetadataFilePayload, TorrentMetadataPayload, TorrentTickPayload,
};

pub type TorrentHandle = Arc<ManagedTorrent>;

// Global state
static mut APP_STATE: Option<Arc<AppState>> = None;
static mut SERVER_PORT: u16 = 0;

fn get_state() -> anyhow::Result<Arc<AppState>> {
    unsafe {
        APP_STATE
            .clone()
            .ok_or_else(|| anyhow::anyhow!("App state not initialized"))
    }
}

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

fn build_metadata_payload(
    info_hash: &str,
    handle: &TorrentHandle,
) -> Result<TorrentMetadataPayload, String> {
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

    Ok(TorrentMetadataPayload {
        info_hash: info_hash.to_string(),
        files,
    })
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

/// Initialize the torrent session and start the HTTP server
#[frb]
pub async fn init_torrent_session(cache_dir: String) -> Result<u16, String> {
    let cache_path = std::path::PathBuf::from(cache_dir);
    std::fs::create_dir_all(&cache_path).map_err(|e| e.to_string())?;

    let state = Arc::new(
        AppState::new(cache_path)
            .await
            .map_err(anyhow_to_string)?,
    );

    let port = crate::server::start_server(state.clone())
        .await
        .map_err(anyhow_to_string)?;

    unsafe {
        APP_STATE = Some(state);
        SERVER_PORT = port;
    }

    Ok(port)
}

/// Start a torrent from a magnet URI
#[frb]
pub async fn start_torrent(magnet_uri: String) -> Result<TorrentMetadataPayload, String> {
    let state = get_state().map_err(|e| e.to_string())?;

    let add_torrent = AddTorrent::from_url(magnet_uri);

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

    // Mark as monitored for tick updates
    state.mark_monitored(&info_hash);

    build_metadata_payload(&info_hash, &handle)
}

/// Start a torrent from .torrent file bytes
#[frb]
pub async fn start_torrent_file(torrent_bytes: Vec<u8>) -> Result<TorrentMetadataPayload, String> {
    if torrent_bytes.is_empty() {
        return Err("torrent file is empty".to_string());
    }

    let state = get_state().map_err(|e| e.to_string())?;

    let add_torrent = AddTorrent::from_bytes(torrent_bytes);

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

    // Mark as monitored for tick updates
    state.mark_monitored(&info_hash);

    build_metadata_payload(&info_hash, &handle)
}

/// Select a file to play and return the stream URL
#[frb]
pub async fn select_torrent_file(info_hash: String, file_index: usize) -> Result<String, String> {
    let state = get_state().map_err(|e| e.to_string())?;

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

    let port = unsafe { SERVER_PORT };
    Ok(format!(
        "http://127.0.0.1:{port}/stream/{info_hash}/{file_index}"
    ))
}

/// Pause a torrent
#[frb]
pub async fn pause_torrent(info_hash: String) -> Result<(), String> {
    let state = get_state().map_err(|e| e.to_string())?;
    let handle = state.torrent(&info_hash).map_err(anyhow_to_string)?;
    state.session.pause(&handle).await.map_err(anyhow_to_string)
}

/// Resume a torrent
#[frb]
pub async fn resume_torrent(info_hash: String) -> Result<(), String> {
    let state = get_state().map_err(|e| e.to_string())?;
    let handle = state.torrent(&info_hash).map_err(anyhow_to_string)?;
    state
        .session
        .clone()
        .unpause(&handle)
        .await
        .map_err(anyhow_to_string)
}

/// Stop and remove a torrent
#[frb]
pub async fn stop_torrent(info_hash: String) -> Result<(), String> {
    let state = get_state().map_err(|e| e.to_string())?;
    let torrent = state.torrent(&info_hash).map_err(anyhow_to_string)?;

    state
        .session
        .delete(TorrentIdOrHash::Hash(torrent.info_hash()), true)
        .await
        .map_err(anyhow_to_string)?;

    state.unmark_monitored(&info_hash);
    Ok(())
}

/// Get the current tick stats for a torrent
#[frb]
pub fn get_torrent_tick(info_hash: String) -> Result<Option<TorrentTickPayload>, String> {
    let state = get_state().map_err(|e| e.to_string())?;

    if !state.is_monitored(&info_hash) {
        return Ok(None);
    }

    let handle = match state.torrent(&info_hash) {
        Ok(handle) => handle,
        Err(_) => return Ok(None),
    };

    Ok(Some(build_tick_payload(&info_hash, &handle)))
}

/// Get the stream URL for a file (without selecting it)
#[frb]
pub fn get_stream_url(info_hash: String, file_index: usize) -> Result<String, String> {
    let port = unsafe { SERVER_PORT };
    if port == 0 {
        return Err("Server not initialized".to_string());
    }
    Ok(format!(
        "http://127.0.0.1:{port}/stream/{info_hash}/{file_index}"
    ))
}
