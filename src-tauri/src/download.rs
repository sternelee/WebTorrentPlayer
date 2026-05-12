use std::path::PathBuf;
use serde::Serialize;

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