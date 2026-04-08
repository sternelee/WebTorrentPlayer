use std::{collections::HashSet, path::PathBuf, str::FromStr, sync::Arc};

use anyhow::{Context, Result};
use librqbit::{api::TorrentIdOrHash, dht::Id20, ManagedTorrent, Session, SessionOptions};
use parking_lot::RwLock;
use serde::Serialize;

pub struct AppState {
    pub session: Arc<Session>,
    pub server_port: RwLock<u16>,
    monitored_torrents: RwLock<HashSet<String>>,
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
    pub async fn new(cache_dir: PathBuf) -> Result<Self> {
        #[allow(unused_mut)]
        let mut session_options = SessionOptions::default();

        #[cfg(any(target_os = "android", target_os = "ios"))]
        {
            session_options.disable_dht_persistence = true;
        }

        let session = Session::new_with_opts(cache_dir.clone(), session_options).await?;
        Ok(Self {
            session,
            server_port: RwLock::new(0),
            monitored_torrents: RwLock::new(HashSet::new()),
        })
    }

    pub fn torrent(&self, info_hash: &str) -> Result<Arc<ManagedTorrent>> {
        let id = Id20::from_str(info_hash)
            .map(TorrentIdOrHash::Hash)
            .map_err(anyhow::Error::from)?;

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
}
