//! Aria2-style HTTP multi-segment downloader.
//!
//! Each download splits the file into up to [`DEFAULT_CONNECTIONS`] parallel
//! byte-range requests. Segment progress is persisted to a hidden sidecar file
//! so downloads can be paused and resumed across app restarts.
//!
//! Frontend receives `http-download-tick` events (same cadence as
//! `torrent-tick`) with [`HttpDownloadInfo`] payloads.

use std::{
    collections::HashMap,
    io::SeekFrom,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc,
    },
    time::{Duration, Instant},
};

use anyhow::{Context, Result};
use futures::StreamExt;
use parking_lot::RwLock;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};
use tokio::io::{AsyncSeekExt, AsyncWriteExt};

use crate::state::AppState;

/// Maximum parallel connections per download (mirrors aria2 default max).
const DEFAULT_CONNECTIONS: usize = 16;
/// Minimum segment size. Files smaller than 2× this download single-threaded.
const MIN_SEGMENT_SIZE: u64 = 512 * 1024; // 512 KiB

// ── Public payload (serialised to frontend) ──────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum HttpDownloadStatus {
    Pending,
    Downloading,
    Paused,
    Complete,
    Error,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HttpDownloadInfo {
    pub id: String,
    pub url: String,
    pub filename: String,
    pub total_bytes: u64,
    pub downloaded_bytes: u64,
    pub speed_bps: f64,
    pub progress_percent: f64,
    pub status: HttpDownloadStatus,
    pub error: Option<String>,
    pub connections: usize,
}

// ── Resume state (written to disk on pause) ──────────────────────────────────

#[derive(Debug, Serialize, Deserialize)]
struct ResumeState {
    url: String,
    filename: String,
    total_bytes: u64,
    supports_range: bool,
    segments: Vec<SegmentState>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct SegmentState {
    start: u64,
    end: u64,
    downloaded: u64,
}

// ── Internal segment ─────────────────────────────────────────────────────────

struct Segment {
    start: u64,
    end: u64,
    /// Bytes downloaded for *this* segment only.
    downloaded: Arc<AtomicU64>,
}

// ── Task ─────────────────────────────────────────────────────────────────────

pub struct HttpDownloadTask {
    pub id: String,
    pub url: String,
    pub filename: String,
    pub output_path: PathBuf,
    /// Hidden sidecar for pause/resume: `.{filename}.torplay-dl`
    resume_path: PathBuf,
    total_bytes: AtomicU64,
    /// Aggregate across all segments; updated by every segment concurrently.
    downloaded_bytes: AtomicU64,
    pub status: RwLock<HttpDownloadStatus>,
    pub error: RwLock<Option<String>>,
    /// Set to true by `pause` / user cancel. Each segment checks this in its
    /// chunk loop and returns early so `run_download` can save resume state.
    cancelled: AtomicBool,
    segments: RwLock<Vec<Segment>>,
    connections: RwLock<usize>,
    speed_bps: RwLock<f64>,
    /// (snapshot_time, snapshot_downloaded_bytes) for speed calculation.
    speed_checkpoint: RwLock<(Instant, u64)>,
}

impl HttpDownloadTask {
    fn new(id: String, url: String, filename: String, output_path: PathBuf) -> Self {
        let resume_path = output_path
            .parent()
            .map(|p| p.join(format!(".{filename}.torplay-dl")))
            .unwrap_or_else(|| PathBuf::from(format!(".{filename}.torplay-dl")));

        Self {
            id,
            url,
            filename,
            output_path,
            resume_path,
            total_bytes: AtomicU64::new(0),
            downloaded_bytes: AtomicU64::new(0),
            status: RwLock::new(HttpDownloadStatus::Pending),
            error: RwLock::new(None),
            cancelled: AtomicBool::new(false),
            segments: RwLock::new(Vec::new()),
            connections: RwLock::new(0),
            speed_bps: RwLock::new(0.0),
            speed_checkpoint: RwLock::new((Instant::now(), 0)),
        }
    }

    pub fn info(&self) -> HttpDownloadInfo {
        let total = self.total_bytes.load(Ordering::Relaxed);
        let done = self.downloaded_bytes.load(Ordering::Relaxed);
        HttpDownloadInfo {
            id: self.id.clone(),
            url: self.url.clone(),
            filename: self.filename.clone(),
            total_bytes: total,
            downloaded_bytes: done,
            speed_bps: *self.speed_bps.read(),
            progress_percent: if total > 0 {
                (done as f64 / total as f64 * 100.0).min(100.0)
            } else {
                0.0
            },
            status: self.status.read().clone(),
            error: self.error.read().clone(),
            connections: *self.connections.read(),
        }
    }

    /// Recalculate speed from the last checkpoint; called by the reporter task.
    fn update_speed(&self) {
        let now = Instant::now();
        let current = self.downloaded_bytes.load(Ordering::Relaxed);
        let mut cp = self.speed_checkpoint.write();
        let elapsed = now.duration_since(cp.0).as_secs_f64();
        if elapsed >= 0.5 {
            *self.speed_bps.write() = current.saturating_sub(cp.1) as f64 / elapsed;
            *cp = (now, current);
        }
    }

    fn cancel(&self) {
        self.cancelled.store(true, Ordering::SeqCst);
    }

    fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::SeqCst)
    }

    fn reset_cancel(&self) {
        self.cancelled.store(false, Ordering::SeqCst);
    }

    /// Replace segments, updating `downloaded_bytes` and `connections` counters.
    fn set_segments(&self, segs: Vec<Segment>) {
        let already: u64 = segs
            .iter()
            .map(|s| s.downloaded.load(Ordering::Relaxed))
            .sum();
        *self.connections.write() = segs.len();
        self.downloaded_bytes.store(already, Ordering::Relaxed);
        *self.segments.write() = segs;
    }

    fn save_resume_state(&self, supports_range: bool) {
        let guard = self.segments.read();
        let state = ResumeState {
            url: self.url.clone(),
            filename: self.filename.clone(),
            total_bytes: self.total_bytes.load(Ordering::Relaxed),
            supports_range,
            segments: guard
                .iter()
                .map(|s| SegmentState {
                    start: s.start,
                    end: s.end,
                    downloaded: s.downloaded.load(Ordering::Relaxed),
                })
                .collect(),
        };
        if let Ok(json) = serde_json::to_string_pretty(&state) {
            let _ = std::fs::write(&self.resume_path, json);
        }
    }

    fn load_resume_state(&self) -> Option<ResumeState> {
        let data = std::fs::read_to_string(&self.resume_path).ok()?;
        serde_json::from_str(&data).ok()
    }

    fn clean_resume_state(&self) {
        let _ = std::fs::remove_file(&self.resume_path);
    }
}

// ── Manager ──────────────────────────────────────────────────────────────────

pub struct HttpDownloadManager {
    tasks: RwLock<HashMap<String, Arc<HttpDownloadTask>>>,
    pub download_dir: PathBuf,
}

impl HttpDownloadManager {
    pub fn new(download_dir: PathBuf) -> Self {
        Self {
            tasks: RwLock::new(HashMap::new()),
            download_dir,
        }
    }

    pub fn all_info(&self) -> Vec<HttpDownloadInfo> {
        self.tasks.read().values().map(|t| t.info()).collect()
    }

    pub fn get_task(&self, id: &str) -> Option<Arc<HttpDownloadTask>> {
        self.tasks.read().get(id).cloned()
    }

    fn insert(&self, task: Arc<HttpDownloadTask>) {
        self.tasks.write().insert(task.id.clone(), task);
    }

    pub fn remove(&self, id: &str) {
        self.tasks.write().remove(id);
    }
}

// ── Engine helpers ────────────────────────────────────────────────────────────

fn build_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .user_agent(concat!("TorPlay/", env!("CARGO_PKG_VERSION")))
        .connect_timeout(Duration::from_secs(20))
        .build()
        .map_err(|e| e.to_string())
}

/// Extract a filename from `Content-Disposition` or fall back to the URL path.
fn extract_filename(url: &str, content_disposition: Option<&str>) -> String {
    if let Some(cd) = content_disposition {
        for part in cd.split(';') {
            let part = part.trim();
            if let Some(enc) = part.strip_prefix("filename*=UTF-8''") {
                return percent_decode(enc.trim_matches('"'));
            }
            if let Some(raw) = part.strip_prefix("filename=") {
                let name = raw.trim_matches('"');
                if !name.is_empty() {
                    return percent_decode(name);
                }
            }
        }
    }
    url.split('?')
        .next()
        .unwrap_or(url)
        .split('/')
        .next_back()
        .filter(|s| !s.is_empty())
        .map(percent_decode)
        .unwrap_or_else(|| "download".to_string())
}

fn percent_decode(s: &str) -> String {
    urlencoding::decode(s)
        .map(|cow| cow.into_owned())
        .unwrap_or_else(|_| s.to_string())
}

/// Return a unique `(output_path, filename)` inside `dir`, appending `(1)`, `(2)`… if needed.
fn unique_filename(dir: &Path, filename: &str) -> (PathBuf, String) {
    let base_path = dir.join(filename);
    if !base_path.exists() {
        return (base_path, filename.to_string());
    }

    let path = Path::new(filename);
    let stem = path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or(filename);
    let ext = path
        .extension()
        .and_then(|s| s.to_str())
        .map(|e| format!(".{e}"))
        .unwrap_or_default();

    let mut n = 1;
    loop {
        let candidate = format!("{stem} ({n}){ext}");
        let candidate_path = dir.join(&candidate);
        if !candidate_path.exists() {
            return (candidate_path, candidate);
        }
        n += 1;
        if n > 10000 {
            // Fall back to a UUID suffix to avoid an infinite loop on pathological inputs.
            let candidate = format!("{stem} - {}{ext}", uuid::Uuid::new_v4());
            return (dir.join(&candidate), candidate);
        }
    }
}

/// Divide `total_bytes` into `connections` non-overlapping `(start, end)` pairs.
fn compute_segments(total_bytes: u64, connections: usize) -> Vec<(u64, u64)> {
    if connections <= 1 || total_bytes == 0 {
        return vec![(0, total_bytes.saturating_sub(1))];
    }
    let seg = total_bytes / connections as u64;
    (0..connections)
        .map(|i| {
            let start = i as u64 * seg;
            let end = if i + 1 == connections {
                total_bytes - 1
            } else {
                start + seg - 1
            };
            (start, end)
        })
        .collect()
}

// ── Download flow ─────────────────────────────────────────────────────────────

/// Create a new download task and start it immediately.
pub async fn add_download(
    manager: Arc<HttpDownloadManager>,
    app: AppHandle,
    url: String,
    filename_hint: Option<String>,
) -> Result<String, String> {
    let client = build_client()?;

    // Deduplicate against active/paused downloads for the same URL.
    for info in manager.all_info() {
        if info.url == url
            && matches!(
                info.status,
                HttpDownloadStatus::Pending
                    | HttpDownloadStatus::Downloading
                    | HttpDownloadStatus::Paused
            )
        {
            return Ok(info.id);
        }
    }

    let id = uuid::Uuid::new_v4().to_string();

    // Probe the server (HEAD) to discover size and range support.
    let head = client
        .head(&url)
        .send()
        .await
        .map_err(|e| format!("HEAD {url}: {e}"))?;

    if !head.status().is_success() {
        return Err(format!("Server error: {}", head.status()));
    }

    let total_bytes = head
        .headers()
        .get(reqwest::header::CONTENT_LENGTH)
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.parse::<u64>().ok())
        .unwrap_or(0);

    let supports_range = head
        .headers()
        .get(reqwest::header::ACCEPT_RANGES)
        .map(|v| v.as_bytes() != b"none")
        .unwrap_or(false)
        && total_bytes > 0;

    let filename = filename_hint.unwrap_or_else(|| {
        let cd = head
            .headers()
            .get(reqwest::header::CONTENT_DISPOSITION)
            .and_then(|v| v.to_str().ok())
            .map(str::to_owned);
        extract_filename(&url, cd.as_deref())
    });

    let (output_path, filename) = unique_filename(&manager.download_dir, &filename);
    let task = Arc::new(HttpDownloadTask::new(
        id.clone(),
        url,
        filename,
        output_path,
    ));
    task.total_bytes.store(total_bytes, Ordering::Relaxed);

    // Compute segment count: use up to DEFAULT_CONNECTIONS, one per MIN_SEGMENT_SIZE.
    let n_conn = if supports_range && total_bytes >= MIN_SEGMENT_SIZE * 2 {
        ((total_bytes / MIN_SEGMENT_SIZE) as usize).clamp(1, DEFAULT_CONNECTIONS)
    } else {
        1
    };
    let segs: Vec<Segment> = compute_segments(total_bytes, n_conn)
        .into_iter()
        .map(|(s, e)| Segment {
            start: s,
            end: e,
            downloaded: Arc::new(AtomicU64::new(0)),
        })
        .collect();
    task.set_segments(segs);

    manager.insert(task.clone());

    tauri::async_runtime::spawn(async move {
        run_download(task, app, client, supports_range).await;
    });

    Ok(id)
}

/// Drive all segment downloads for a task, then set the final status.
async fn run_download(
    task: Arc<HttpDownloadTask>,
    app: AppHandle,
    client: reqwest::Client,
    supports_range: bool,
) {
    *task.status.write() = HttpDownloadStatus::Downloading;

    // Ensure output directory exists.
    if let Some(parent) = task.output_path.parent() {
        if let Err(e) = tokio::fs::create_dir_all(parent).await {
            *task.error.write() = Some(format!("mkdir: {e}"));
            *task.status.write() = HttpDownloadStatus::Error;
            let _ = app.emit("http-download-tick", task.info());
            return;
        }
    }

    // Open (or create) the output file and pre-allocate it when size is known.
    // A shared Mutex<File> lets multiple segment tasks seek+write without
    // opening extra handles, which is safe across all target platforms.
    // Non-range servers cannot resume, so truncate any partial file to start clean.
    let file = match tokio::fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(!supports_range)
        .open(&task.output_path)
        .await
    {
        Ok(f) => f,
        Err(e) => {
            *task.error.write() = Some(format!("open file: {e}"));
            *task.status.write() = HttpDownloadStatus::Error;
            let _ = app.emit("http-download-tick", task.info());
            return;
        }
    };
    let total = task.total_bytes.load(Ordering::Relaxed);
    if total > 0 {
        // Pre-allocation avoids fragmentation and gives seeking a valid range.
        let _ = file.set_len(total).await;
    }
    let shared_file = Arc::new(tokio::sync::Mutex::new(file));

    // Progress reporter: emits a tick every second while downloading.
    let rep_task = task.clone();
    let rep_app = app.clone();
    let reporter = tauri::async_runtime::spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_secs(1));
        loop {
            interval.tick().await;
            rep_task.update_speed();
            let info = rep_task.info();
            let terminal = !matches!(info.status, HttpDownloadStatus::Downloading);
            let _ = rep_app.emit("http-download-tick", &info);
            if terminal {
                break;
            }
        }
    });

    // Snapshot segment parameters before spawning (avoids holding the RwLock).
    let seg_params: Vec<(u64, u64, Arc<AtomicU64>)> = task
        .segments
        .read()
        .iter()
        .map(|s| (s.start, s.end, s.downloaded.clone()))
        .collect();

    let mut handles = Vec::with_capacity(seg_params.len());
    for (start, end, seg_dl) in seg_params {
        let client = client.clone();
        let task_ref = task.clone();
        let file_ref = shared_file.clone();
        handles.push(tauri::async_runtime::spawn(async move {
            download_segment(task_ref, client, start, end, seg_dl, supports_range, file_ref).await
        }));
    }

    // Collect results.
    let mut all_ok = true;
    let mut first_error: Option<String> = None;
    for h in handles {
        match h.await {
            Ok(Ok(())) => {}
            Ok(Err(e)) if !task.is_cancelled() => {
                if all_ok {
                    first_error = Some(e.to_string());
                }
                all_ok = false;
            }
            Err(join_err) if !task.is_cancelled() => {
                if all_ok {
                    first_error = Some(join_err.to_string());
                }
                all_ok = false;
            }
            _ => {} // cancelled — ignore segment errors
        }
    }

    // Flush before deciding final status.
    {
        let mut f = shared_file.lock().await;
        let _ = f.flush().await;
    }

    if task.is_cancelled() {
        task.save_resume_state(supports_range);
        *task.status.write() = HttpDownloadStatus::Paused;
    } else if all_ok {
        task.clean_resume_state();
        *task.status.write() = HttpDownloadStatus::Complete;
    } else {
        *task.error.write() = first_error;
        *task.status.write() = HttpDownloadStatus::Error;
    }

    // Stop reporter and emit the definitive final state.
    reporter.abort();
    task.update_speed();
    let _ = app.emit("http-download-tick", task.info());
}

/// Download one byte-range segment, writing to the shared file handle.
async fn download_segment(
    task: Arc<HttpDownloadTask>,
    client: reqwest::Client,
    start: u64,
    end: u64,
    seg_downloaded: Arc<AtomicU64>,
    supports_range: bool,
    file: Arc<tokio::sync::Mutex<tokio::fs::File>>,
) -> Result<()> {
    let already = seg_downloaded.load(Ordering::Relaxed);
    let resume_from = start + already;

    if resume_from > end {
        return Ok(()); // Segment already complete.
    }

    let req = if supports_range {
        client
            .get(&task.url)
            .header("Range", format!("bytes={resume_from}-{end}"))
    } else {
        client.get(&task.url)
    };

    let response = req.send().await.context("HTTP request failed")?;
    let status = response.status();
    if !status.is_success() && status.as_u16() != 206 {
        return Err(anyhow::anyhow!("HTTP {status}"));
    }

    let mut stream = response.bytes_stream();
    let mut write_pos = resume_from;

    while let Some(result) = stream.next().await {
        if task.is_cancelled() {
            return Ok(());
        }
        let chunk = result.context("Stream error")?;
        let n = chunk.len() as u64;

        // Acquire the shared file handle, seek to position, write chunk.
        {
            let mut f = file.lock().await;
            if supports_range {
                f.seek(SeekFrom::Start(write_pos))
                    .await
                    .context("Seek failed")?;
            }
            f.write_all(&chunk).await.context("Write failed")?;
        }

        write_pos += n;
        seg_downloaded.fetch_add(n, Ordering::Relaxed);
        task.downloaded_bytes.fetch_add(n, Ordering::Relaxed);
    }

    Ok(())
}

// ── Tauri commands ────────────────────────────────────────────────────────────

/// Start a new HTTP download. Returns the opaque download ID.
#[tauri::command]
pub async fn http_download_add(
    url: String,
    filename: Option<String>,
    state: State<'_, Arc<AppState>>,
    app: AppHandle,
) -> Result<String, String> {
    add_download(state.http_download_manager.clone(), app, url, filename).await
}

/// Signal a running download to pause. The segment tasks will stop at the next
/// chunk boundary and write a resume sidecar. Status becomes `Paused`.
#[tauri::command]
pub fn http_download_pause(
    id: String,
    state: State<'_, Arc<AppState>>,
) -> Result<(), String> {
    state
        .http_download_manager
        .get_task(&id)
        .ok_or_else(|| format!("download not found: {id}"))?
        .cancel();
    Ok(())
}

/// Resume a paused download. Reads the resume sidecar and restarts only the
/// incomplete segments.
#[tauri::command]
pub async fn http_download_resume(
    id: String,
    state: State<'_, Arc<AppState>>,
    app: AppHandle,
) -> Result<(), String> {
    let task = state
        .http_download_manager
        .get_task(&id)
        .ok_or_else(|| format!("download not found: {id}"))?;

    if *task.status.read() != HttpDownloadStatus::Paused {
        return Err("download is not paused".to_string());
    }

    let supports_range = if let Some(rs) = task.load_resume_state() {
        let segs = rs
            .segments
            .into_iter()
            .map(|s| Segment {
                start: s.start,
                end: s.end,
                downloaded: Arc::new(AtomicU64::new(s.downloaded)),
            })
            .collect();
        task.total_bytes.store(rs.total_bytes, Ordering::Relaxed);
        task.set_segments(segs);
        rs.supports_range
    } else {
        // No sidecar — restart from scratch.
        let total = task.total_bytes.load(Ordering::Relaxed);
        task.set_segments(vec![Segment {
            start: 0,
            end: total.saturating_sub(1),
            downloaded: Arc::new(AtomicU64::new(0)),
        }]);
        false
    };

    task.reset_cancel();
    let client = build_client()?;
    let task_clone = task.clone();
    tauri::async_runtime::spawn(async move {
        run_download(task_clone, app, client, supports_range).await;
    });

    Ok(())
}

/// Stop and remove a download. Pass `delete_file: true` to also delete the
/// partial output file.
#[tauri::command]
pub async fn http_download_remove(
    id: String,
    delete_file: bool,
    state: State<'_, Arc<AppState>>,
) -> Result<(), String> {
    if let Some(task) = state.http_download_manager.get_task(&id) {
        task.cancel();
        task.clean_resume_state();

        // Wait briefly for `run_download` to stop writing before deleting the file,
        // so we don't delete the file out from under an active segment task.
        for _ in 0..50 {
            if !matches!(*task.status.read(), HttpDownloadStatus::Downloading) {
                break;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }

        if delete_file {
            let _ = tokio::fs::remove_file(&task.output_path).await;
        }
    }
    state.http_download_manager.remove(&id);
    Ok(())
}

/// Return info for all tracked downloads (active, paused, completed, errored).
#[tauri::command]
pub fn http_download_list(state: State<'_, Arc<AppState>>) -> Vec<HttpDownloadInfo> {
    state.http_download_manager.all_info()
}
