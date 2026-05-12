# 下载功能设计规格

**日期**: 2026-05-12
**项目**: TorPlay (WebTorrentPlayer) 下载功能
**状态**: 草稿

## 1. 目标

为 TorPlay 添加文件下载到磁盘功能，支持多任务队列管理、全局限速、暂停/恢复控制，覆写 Desktop / Android / iOS 三个平台。

## 2. 需求范围

- **基础落盘**: torrent 文件下载完成后保存到用户可访问的目录
- **下载队列**: 多任务并发状态管理、进度追踪、批量操作
- **存储路径**: 系统 Downloads 目录（桌面）/ MediaStore API（移动端）
- **平台支持**: Desktop (macOS/Windows/Linux) + Android + iOS

## 3. 架构概览

```
Frontend (SolidJS)
    │
    ├─► App.tsx         [新增 Downloads Tab]
    └─► lib/downloads.ts [前端状态/调用封装]
              │ invoke()
              ▼
Backend (Rust/Tauri)
    ├─► src/lib.rs      [新增 command 注册]
    ├─► src/download.rs [新增下载模块]
    └─► Platform Impl
          ├─ desktop: direct fs write to Downloads/
          ├─ android: MediaStore API via JNI
          └─ ios: App private dir + Files App share
```

## 4. 存储架构

### 4.1 平台差异

| 平台 | 存储方式 | 路径 |
|------|----------|------|
| Desktop | 直接写入文件系统 | `~/Downloads/TorPlay/` |
| Android | MediaStore API | `Downloads/TorPlay/` (媒体库) |
| iOS | App 私有目录 | `Documents/TorPlay/` + 系统分享 |

### 4.2 Desktop 改动

配置 librqbit session 的**输出目录**为 `Downloads/TorPlay/`，而非 cache_dir。文件下载时直接落盘，无需额外搬运。

需要配置 `out_dir` 在 `SessionOptions` 中（librqbit 支持）。

### 4.3 Mobile 改动

librqbit 保持在 cache_dir 下载，完成后：
- **Android**: 通过 JNI 调用 MediaStore ContentResolver 导出
- **iOS**: 导出到 App Documents 目录，提示用户通过 Files App 访问

## 5. 新增 IPC 命令

```rust
// 文件系统
get_download_dir() -> String
list_download_files(info_hash: String) -> Vec<FileInfo>

// 导出（移动端）
export_file(info_hash: String, file_index: usize) -> Result<String, String>

// 队列管理
get_active_downloads() -> Vec<DownloadTask>
set_global_speed_limit(down_kbps: Option<u64>, up_kbps: Option<u64>) -> Result<(), String>
pause_all_downloads() -> Result<(), String>
resume_all_downloads() -> Result<(), String>
```

## 6. 数据类型

```rust
#[derive(Serialize)]
pub struct FileInfo {
    pub index: usize,
    pub name: String,
    pub size_bytes: u64,
    pub downloaded_bytes: u64,
    pub path: Option<String>,  // 磁盘路径，完成后填充
    pub is_video: bool,
}

#[derive(Serialize)]
pub struct DownloadTask {
    pub info_hash: String,
    pub name: String,           // 从第一个 video 文件名推断
    pub progress_percent: f64,
    pub download_speed_bps: u64,
    pub upload_speed_bps: u64,
    pub peers_connected: usize,
    pub state: String,          // "downloading" | "paused" | "seeding" | "complete" | "error"
    pub files: Vec<FileInfo>,
}
```

## 7. Frontend UI 改动

在 App.tsx 中新增 **Downloads Tab**（与 Stream Tab 并列）：

```
┌─────────────────────────────────────────────┐
│  [ Stream ]  [ Downloads ]                  │
├─────────────────────────────────────────────┤
│ Global Speed: [▼ 5 MB/s] [▲ 1 MB/s]         │
│ [ ⏸ Pause All ] [ ▶ Resume All ]            │
├─────────────────────────────────────────────┤
│ Active Downloads (2)                        │
│ ┌─────────────────────────────────────────┐ │
│ │ ▶ Movie.mkv    80% ████████░░  3.2 MB/s  │ │
│ │                8 peers · 1.2 GB / 1.5 GB │ │
│ │                                 [⏸][✕]  │ │
│ ├─────────────────────────────────────────┤ │
│ │ ▶ S01E01.mp4  45% █████░░░░░  1.1 MB/s  │ │
│ │                                 [⏸][✕]  │ │
│ └─────────────────────────────────────────┘ │
├─────────────────────────────────────────────┤
│ Completed (1)                               │
│ ┌─────────────────────────────────────────┐ │
│ │ ✓ Doc.pdf      100%        完毕          │ │
│ │                           [📁][✕]       │ │
│ └─────────────────────────────────────────┘ │
└─────────────────────────────────────────────┘
```

### 7.1 交互行为

- **暂停/恢复**: 点击 ⏸ 切换单任务状态
- **停止**: 点击 ✕ 停止并删除任务
- **打开文件**: 点击 📁 在文件管理器中定位（Desktop）/ 分享（Mobile）
- **限速**: 输入框修改全局限速，实时生效

## 8. 后端模块设计

### 8.1 新增 `src-tauri/src/download.rs`

```rust
pub mod download;

use crate::state::AppState;
use tauri::{AppHandle, State};

// ── File System ──────────────────────────────

#[tauri::command]
pub fn get_download_dir(app: AppHandle) -> Result<String, String> { ... }

#[tauri::command]
pub fn list_download_files(
    info_hash: String,
    state: State<'_, Arc<AppState>>,
) -> Result<Vec<FileInfo>, String> { ... }

// ── Export (Mobile) ──────────────────────────

#[tauri::command]
pub async fn export_file(
    info_hash: String,
    file_index: usize,
    state: State<'_, Arc<AppState>>,
    app: AppHandle,
) -> Result<String, String> { ... }

// ── Queue Management ─────────────────────────

#[tauri::command]
pub fn get_active_downloads(state: State<'_, Arc<AppState>>) -> Vec<DownloadTask> { ... }

#[tauri::command]
pub async fn set_global_speed_limit(
    down_kbps: Option<u64>,
    up_kbps: Option<u64>,
    state: State<'_, Arc<AppState>>,
) -> Result<(), String> { ... }

#[tauri::command]
pub async fn pause_all_downloads(state: State<'_, Arc<AppState>>) -> Result<(), String> { ... }

#[tauri::command]
pub async fn resume_all_downloads(state: State<'_, Arc<AppState>>) -> Result<(), String> { ... }
```

### 8.2 Platform Impl

```rust
// Platform-specific file export
fn export_to_downloads(path: &Path, filename: &str) -> Result<String, String>;

#[cfg(target_os = "android")]
fn export_to_downloads(...) -> ... { /* MediaStore JNI */ }

#[cfg(target_os = "ios")]
fn export_to_downloads(...) -> ... { /* UIDocumentPicker + share */ }

#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn export_to_downloads(...) -> ... { /* direct fs copy */ }
```

## 9. Android MediaStore 实现

通过 JNI 调用 Java MediaStore API：

```kotlin
// gen/android/.../MediaStoreHelper.kt
object MediaStoreHelper {
    fun insertDownload(context: Context, path: String, filename: String): String {
        val values = ContentValues().apply {
            put(MediaStore.Downloads.DISPLAY_NAME, filename)
            put(MediaStore.Downloads.MIME_TYPE, "video/*")
            put(MediaStore.Downloads.RELATIVE_PATH, "Downloads/TorPlay")
        }
        val uri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values)
        // copy file content...
        return uri?.toString() ?: ""
    }
}
```

在 Rust 端通过 `tauri::android::invoke_method` 调用。

## 10. 全局限速

librqbit 的 `SessionOptions` 支持 `download_rate_limit` 和 `upload_rate_limit`（字节/秒），直接在 session 初始化时注入。

**后端实现** — 在 `AppState` 中保存限速值，添加命令 `set_global_speed_limit` 通过 `Session::set_download_rate_limit()` / `Session::set_upload_rate_limit()` 实时更新（如果 librqbit 提供 setter）。若不支持 setter，则在 session 重建时应用新限速。

**Fallback** — 如果 librqbit session 级别限速不可变，在 `server.rs` 的 `stream_response` 中通过 `tokio::io::AsyncReadExt` 的限速 wrapper（token bucket）做流控，精确到单连接。

## 11. 错误处理策略

| 场景 | 处理方式 |
|------|----------|
| 磁盘空间不足 | 下载自动暂停，emit `torrent-error` 事件，前端弹窗警告 |
| 网络中断 | librqbit 自动重连，前端显示 "正在重连..." 状态 |
| 文件名冲突 | 追加 `-1`, `-2` 后缀，告知用户 |
| 导出失败 (Android MediaStore) | 重试 1 次，仍失败则保存到 App cache 并提示通过文件管理器访问 |
| 下载损坏 | 停止任务，标记 error 状态，用户可选择重新开始 |

## 12. JNI 调用路径（Android MediaStore）

Rust 端通过 `tauri::android::invoke_method` 调用 Kotlin 方法：

```rust
#[cfg(target_os = "android")]
async fn export_to_downloads_impl(
    local_path: &Path,
    filename: &str,
) -> Result<String, String> {
    let result = tauri::android::invoke_method::<String>(
        "com.sternelee.torplay.MediaStoreHelper",
        "insertDownload",
        &(local_path.to_string_lossy().into_owned(), filename),
    ).await;
    result.map_err(|e| e.to_string())
}
```

Kotlin 端 `MediaStoreHelper.kt` 实现 MediaStore ContentResolver insert 逻辑。

## 13. 移动端 UX 差异说明

| 平台 | 落盘位置 | 用户访问方式 | 限制说明 |
|------|----------|--------------|----------|
| Android | Downloads/TorPlay (媒体库) | 系统 Downloads App / 文件管理器 | 需要存储权限 (Android < 10) |
| iOS | Documents/TorPlay (App 私有) | Files App / 分享 | iOS 沙盒限制，无法直接写入公共目录 |

iOS 导出后提示 "已在 TorPlay 中打开文件，可通过 Files App 分享"。

## 14. 新增 Tauri Plugins

```json
// Cargo.toml 新增依赖
tauri-plugin-dialog = "2"
tauri-plugin-fs = "2"
tauri-plugin-notification = "2"

// capabilities/default.json 新增权限
"fs:allow-read",
"fs:allow-write",
"fs:allow-exists",
"dialog:allow-open",
"notification:default"
```

## 15. 实现顺序

1. **后端基础**: 新增 `download.rs` 模块，注册命令，构建 platform impl
2. **Desktop 文件落盘**: 配置 librqbit out_dir 为 `~/Downloads/TorPlay/`
3. **Android MediaStore**: JNI 集成 `MediaStoreHelper.kt`
4. **iOS 导出**: UIDocumentPickerViewController 分享
5. **前端 Downloads Tab**: UI + 状态管理
6. **全局限速 + 批量操作**: 命令 + 前端绑定
7. **错误处理 + 通知**: 下载完成/失败通知

## 16. 遗漏命令补充

```rust
#[tauri::command]
pub fn delete_download_file(
    info_hash: String,
    file_index: usize,
    state: State<'_, Arc<AppState>>,
) -> Result<(), String> { ... }
// 从 Downloads 目录删除已导出文件，不影响 torrent 任务本身
```
