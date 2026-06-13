use std::{collections::HashSet, path::PathBuf, str::FromStr, sync::Arc};

#[cfg(any(target_os = "android", target_os = "ios"))]
use std::time::Duration;

use anyhow::{Context, Result};
use librqbit::{
    api::TorrentIdOrHash,
    dht::Id20,
    ManagedTorrent, Session, SessionOptions,
};

#[cfg(any(target_os = "android", target_os = "ios"))]
use librqbit::dht::PersistentDhtConfig;

use parking_lot::RwLock;
use serde::Serialize;

use crate::http_download::HttpDownloadManager;
use crate::proxy::detect_socks5_url;

pub struct AppState {
    pub session: Arc<Session>,
    pub server_port: RwLock<u16>,
    monitored_torrents: RwLock<HashSet<String>>,
    pub download_dir: RwLock<PathBuf>,
    pub speed_limit_down: RwLock<Option<u64>>,
    pub speed_limit_up: RwLock<Option<u64>>,
    pub http_download_manager: Arc<HttpDownloadManager>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TorrentTickPayload {
    pub info_hash: String,
    pub download_speed_kbps: f64,
    pub upload_speed_kbps: f64,
    pub peers_connected: usize,
    pub progress_percent: f64,
    pub state: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TorrentMetadataFilePayload {
    pub index: usize,
    pub name: String,
    pub size_bytes: u64,
    pub is_video: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TorrentMetadataPayload {
    pub info_hash: String,
    pub files: Vec<TorrentMetadataFilePayload>,
}

impl AppState {
    #[allow(clippy::field_reassign_with_default)]
    pub async fn new(_cache_dir: PathBuf, download_dir: PathBuf) -> Result<Self> {
        #[allow(unused_mut)]
        let mut session_options = SessionOptions::default();

        // Apply system SOCKS5 proxy to BT peer connections (env vars + macOS system proxy).
        session_options.socks_proxy_url = detect_socks5_url();

        #[cfg(any(target_os = "android", target_os = "ios"))]
        {
            let dht_dir = _cache_dir.join("dht");
            // 安全地尝试启用 DHT 持久化：使用应用缓存目录下的子目录。
            // 如果目录创建失败（如存储已满、权限异常），回退到禁用持久化，
            // 确保 DHT 仍可在内存中工作，应用不会因启动失败而崩溃。
            if std::fs::create_dir_all(&dht_dir).is_ok() {
                session_options.dht_config = Some(PersistentDhtConfig {
                    config_filename: Some(dht_dir.join("state.json")),
                    dump_interval: Some(Duration::from_secs(60)),
                });
            } else {
                session_options.disable_dht_persistence = true;
            }
        }

        #[cfg(not(any(target_os = "android", target_os = "ios")))]
        {
            // Desktop: use download_dir as librqbit's output directory
            let session = Session::new_with_opts(download_dir.clone(), session_options).await?;
            Ok(Self {
                session,
                server_port: RwLock::new(0),
                monitored_torrents: RwLock::new(HashSet::new()),
                download_dir: RwLock::new(download_dir.clone()),
                speed_limit_down: RwLock::new(None),
                speed_limit_up: RwLock::new(None),
                http_download_manager: Arc::new(HttpDownloadManager::new(download_dir)),
            })
        }

        #[cfg(any(target_os = "android", target_os = "ios"))]
        {
            // Mobile: librqbit stores pieces in cache_dir; completed files are
            // exported to download_dir via the export_file command.
            let session = Session::new_with_opts(_cache_dir.clone(), session_options).await?;
            Ok(Self {
                session,
                server_port: RwLock::new(0),
                monitored_torrents: RwLock::new(HashSet::new()),
                download_dir: RwLock::new(download_dir.clone()),
                speed_limit_down: RwLock::new(None),
                speed_limit_up: RwLock::new(None),
                http_download_manager: Arc::new(HttpDownloadManager::new(download_dir)),
            })
        }
    }

    pub fn torrent(&self, info_hash: &str) -> Result<Arc<ManagedTorrent>> {
        let id = Id20::from_str(info_hash).map(TorrentIdOrHash::Hash)?;

        self.session
            .get(id)
            .with_context(|| format!("torrent not found: {info_hash}"))
    }

    pub fn mark_monitored(&self, info_hash: &str) -> bool {
        self.monitored_torrents
            .write()
            .insert(info_hash.to_string())
    }

    pub fn unmark_monitored(&self, info_hash: &str) {
        self.monitored_torrents.write().remove(info_hash);
    }

    pub fn is_monitored(&self, info_hash: &str) -> bool {
        self.monitored_torrents.read().contains(info_hash)
    }

    pub fn get_monitored_info_hashes(&self) -> Vec<String> {
        self.monitored_torrents.read().iter().cloned().collect()
    }
}
