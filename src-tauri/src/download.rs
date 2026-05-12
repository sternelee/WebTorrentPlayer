use std::path::PathBuf;
use std::sync::Arc;
use serde::Serialize;
use tauri::State;

use crate::state::AppState;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileInfo {
    pub index: usize,
    pub name: String,
    pub size_bytes: u64,
    pub downloaded_bytes: u64,
    pub path: Option<String>,
    pub is_video: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadTask {
    pub info_hash: String,
    pub name: String,
    pub progress_percent: f64,
    pub download_speed_bps: u64,
    pub upload_speed_bps: u64,
    pub peers_connected: usize,
    pub state: String,
    pub files: Vec<FileInfo>,
}

fn is_video_path(path: &std::path::Path) -> bool {
    let guessed = mime_guess::from_path(path).first();
    guessed.is_some_and(|mime| mime.type_() == mime_guess::mime::VIDEO)
        || path
            .extension()
            .and_then(|ext| ext.to_str())
            .map(|ext| {
                matches!(
                    ext.to_ascii_lowercase().as_str(),
                    "mp4" | "m4v" | "mkv" | "webm" | "mov" | "avi" | "ts" | "m2ts"
                )
            })
            .unwrap_or(false)
}

#[cfg(target_os = "macos")]
pub fn get_default_download_dir() -> PathBuf {
    dirs::download_dir()
        .unwrap_or_else(|| dirs::home_dir().unwrap().join("Downloads"))
        .join("TorPlay")
}

#[cfg(target_os = "windows")]
pub fn get_default_download_dir() -> PathBuf {
    dirs::download_dir()
        .map(|p| p.join("TorPlay"))
        .unwrap_or_else(|| {
            std::env::var("USERPROFILE")
                .map(PathBuf::from)
                .unwrap_or_else(|_| dirs::home_dir().unwrap())
                .join("Downloads")
                .join("TorPlay")
        })
}

#[cfg(target_os = "linux")]
pub fn get_default_download_dir() -> PathBuf {
    dirs::download_dir()
        .unwrap_or_else(|| dirs::home_dir().unwrap())
        .join("TorPlay")
}

#[cfg(target_os = "android")]
pub fn get_default_download_dir() -> PathBuf {
    PathBuf::from("/storage/emulated/0/Download/TorPlay")
}

#[cfg(target_os = "ios")]
pub fn get_default_download_dir() -> PathBuf {
    PathBuf::from("Documents/TorPlay")
}

#[tauri::command]
pub fn get_download_dir(state: State<'_, Arc<AppState>>) -> String {
    state.download_dir.read().to_string_lossy().into_owned()
}

#[tauri::command]
pub fn list_download_files(
    info_hash: String,
    state: State<'_, Arc<AppState>>,
) -> Result<Vec<FileInfo>, String> {
    let handle = state.torrent(&info_hash).map_err(|e| e.to_string())?;
    let download_dir = state.download_dir.read().clone();

    handle
        .with_metadata(|metadata| {
            metadata
                .file_infos
                .iter()
                .enumerate()
                .map(|(index, file)| {
                    let downloaded = handle
                        .stats()
                        .file_progress
                        .get(index)
                        .copied()
                        .unwrap_or(0);
                    FileInfo {
                        index,
                        name: file.relative_filename.to_string_lossy().into_owned(),
                        size_bytes: file.len,
                        downloaded_bytes: downloaded,
                        path: Some(
                            download_dir
                                .join(&file.relative_filename)
                                .to_string_lossy()
                                .into_owned(),
                        ),
                        is_video: is_video_path(&file.relative_filename),
                    }
                })
                .collect()
        })
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_active_downloads(state: State<'_, Arc<AppState>>) -> Vec<DownloadTask> {
    let info_hashes: Vec<String> = state.get_monitored_info_hashes();
    let download_dir = state.download_dir.read().clone();

    info_hashes
        .into_iter()
        .filter_map(|info_hash| {
            let handle = state.torrent(&info_hash).ok()?;
            let stats = handle.stats();

            let files: Vec<FileInfo> = handle
                .with_metadata(|metadata| {
                    metadata
                        .file_infos
                        .iter()
                        .enumerate()
                        .map(|(index, file)| {
                            let downloaded = stats.file_progress.get(index).copied().unwrap_or(0);
                            FileInfo {
                                index,
                                name: file.relative_filename.to_string_lossy().into_owned(),
                                size_bytes: file.len,
                                downloaded_bytes: downloaded,
                                path: Some(
                                    download_dir
                                        .join(&file.relative_filename)
                                        .to_string_lossy()
                                        .into_owned(),
                                ),
                                is_video: is_video_path(&file.relative_filename),
                            }
                        })
                        .collect()
                })
                .ok()?;

            let name = files
                .iter()
                .find(|f| f.is_video)
                .map(|f| f.name.clone())
                .unwrap_or_else(|| {
                    files
                        .first()
                        .map(|f| f.name.clone())
                        .unwrap_or_default()
                });

            Some(DownloadTask {
                info_hash,
                name,
                progress_percent: if stats.total_bytes == 0 {
                    0.0
                } else {
                    stats.progress_bytes as f64 / stats.total_bytes as f64 * 100.0
                },
                download_speed_bps: stats
                    .live
                    .as_ref()
                    .map(|l| (l.download_speed.mbps * 1024.0 * 1024.0) as u64)
                    .unwrap_or(0),
                upload_speed_bps: stats
                    .live
                    .as_ref()
                    .map(|l| (l.upload_speed.mbps * 1024.0 * 1024.0) as u64)
                    .unwrap_or(0),
                peers_connected: stats
                    .live
                    .as_ref()
                    .map(|l| l.snapshot.peer_stats.live)
                    .unwrap_or(0),
                state: match stats.state {
                    librqbit::TorrentStatsState::Paused => "paused".into(),
                    _ if stats.finished => "seeding".into(),
                    _ => "downloading".into(),
                },
                files,
            })
        })
        .collect()
}

#[tauri::command]
pub async fn set_global_speed_limit(
    down_bps: Option<u64>,
    up_bps: Option<u64>,
    state: State<'_, Arc<AppState>>,
) -> Result<(), String> {
    use std::num::NonZeroU32;

    if let Some(bps) = down_bps {
        if let Some(nz) = NonZeroU32::new(bps as u32) {
            state.session.ratelimits.set_download_bps(Some(nz));
        }
    }
    if let Some(bps) = up_bps {
        if let Some(nz) = NonZeroU32::new(bps as u32) {
            state.session.ratelimits.set_upload_bps(Some(nz));
        }
    }
    *state.speed_limit_down.write() = down_bps;
    *state.speed_limit_up.write() = up_bps;
    Ok(())
}

#[tauri::command]
pub async fn pause_all_downloads(state: State<'_, Arc<AppState>>) -> Result<(), String> {
    let info_hashes = state.get_monitored_info_hashes();
    for info_hash in info_hashes {
        if let Ok(handle) = state.torrent(&info_hash) {
            state.session.pause(&handle).await.ok();
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn resume_all_downloads(state: State<'_, Arc<AppState>>) -> Result<(), String> {
    let info_hashes = state.get_monitored_info_hashes();
    for info_hash in info_hashes {
        if let Ok(handle) = state.torrent(&info_hash) {
            state.session.clone().unpause(&handle).await.ok();
        }
    }
    Ok(())
}