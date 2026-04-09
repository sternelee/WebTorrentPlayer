# TorPlay - Flutter Edition

一个使用 Flutter + Rust 构建的 P2P 流媒体播放器，支持全格式视频播放（包括 MKV、HEVC/H.265 等）。

## 技术栈

- **前端**: Flutter + Dart
- **播放器**: media_kit (基于 libmpv) - 支持几乎所有视频格式
- **后端**: Rust + flutter_rust_bridge
- **P2P 引擎**: librqbit (BitTorrent)
- **流媒体代理**: axum HTTP 服务器

## 特性

- ✅ 支持全格式视频播放（MKV、HEVC/H.265、AVI、MP4、WebM 等）
- ✅ Magnet 链接和 .torrent 文件支持
- ✅ 实时播放统计（下载速度、Peer 数量、进度）
- ✅ 自定义播放控制界面
- ✅ 跨平台（Android、iOS、macOS、Windows、Linux）

## 项目结构

```
flutter_app/
├── lib/                    # Flutter Dart 代码
│   ├── blocs/torrent/      # BLoC 状态管理
│   ├── models/             # 数据模型
│   ├── screens/            # 页面
│   └── src/rust/           # 自动生成的 Rust 绑定
├── rust/                   # Rust 后端代码
│   └── src/
│       ├── api/torrent.rs  # Torrent API
│       ├── server.rs       # HTTP 流媒体服务器
│       └── state.rs        # 应用状态
└── pubspec.yaml
```

## 构建指南

### 前提条件

1. 安装 Flutter SDK (>= 3.11.4)
2. 安装 Rust toolchain
3. 安装 flutter_rust_bridge_codegen:
   ```bash
   cargo install flutter_rust_bridge_codegen
   ```

### 安装依赖

```bash
cd flutter_app
flutter pub get
```

### 生成 Rust 绑定

```bash
flutter_rust_bridge_codegen generate
```

### 构建应用

#### macOS
```bash
flutter build macos
```

#### iOS
```bash
flutter build ios
```

#### Android
```bash
flutter build apk
```

#### Windows
```bash
flutter build windows
```

#### Linux
```bash
flutter build linux
```

## 运行开发版本

```bash
flutter run
```

## 使用说明

1. 启动应用后，输入 magnet 链接或选择 .torrent 文件
2. 等待元数据解析完成，选择要播放的视频文件
3. 播放器将自动开始流式播放
4. 播放界面显示实时下载统计信息

## 与原 Tauri 版本的差异

| 特性 | Tauri 版本 | Flutter 版本 |
|------|-----------|-------------|
| 播放器 | Vidstack (WebView) | media_kit (libmpv) |
| 格式支持 | 受限（取决于 WebView） | 全格式支持 |
| 通信方式 | Tauri IPC | flutter_rust_bridge |
| UI 框架 | SolidJS | Flutter |

## 故障排除

### macOS 构建错误
如果遇到部署目标冲突错误，尝试：
```bash
flutter clean
flutter pub get
cd macos && pod deintegrate && pod install
```

### Android 构建错误
确保 NDK 已正确配置：
```bash
flutter config --android-sdk=<path_to_android_sdk>
```

## 许可证

MIT
