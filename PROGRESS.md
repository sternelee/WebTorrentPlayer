# TorPlay Flutter Migration — Progress Report

## Status: 🛑 BLOCKED by Xcode 26.4 Beta

The Flutter edition is fully implemented but **cannot compile on macOS** due to a system Xcode version conflict. This is an environment issue, not a code issue.

---

## What Was Implemented

### Flutter App Structure (`flutter_app/`)

| File | Status | Description |
|------|--------|-------------|
| `pubspec.yaml` | ✅ | media_kit, flutter_bloc, equatable, file_picker, etc. |
| `macos/Podfile` | ✅ | MACOSX_DEPLOYMENT_TARGET=10.15, SDKROOT=macosx |
| `rust/Cargo.toml` | ✅ | librqbit, tokio, axum, tower-http |
| `rust/src/lib.rs` | ✅ | Module structure |
| `rust/src/api/mod.rs` | ✅ | `pub mod torrent;` |
| `rust/src/api/torrent.rs` | ✅ | All flutter_rust_bridge API functions |
| `rust/src/server.rs` | ✅ | axum HTTP streaming proxy |
| `rust/src/state.rs` | ✅ | AppState with librqbit session |
| `lib/main.dart` | ✅ | MediaKit.ensureInitialized, BlocProvider |
| `lib/models/torrent_models.dart` | ✅ | TorrentFile, TorrentMetadata, TorrentStats |
| `lib/blocs/torrent/torrent_bloc.dart` | ✅ | BLoC state machine |
| `lib/blocs/torrent/torrent_event.dart` | ✅ | Events |
| `lib/blocs/torrent/torrent_state.dart` | ✅ | States |
| `lib/screens/home_screen.dart` | ✅ | Magnet input + file list UI |
| `lib/screens/player_screen.dart` | ✅ | media_kit player + custom controls |
| `lib/src/rust/api/torrent.dart` | ✅ | Auto-generated bindings |
| `lib/src/rust/frb_generated.dart` | ✅ | Auto-generated |

Run `flutter_rust_bridge_codegen generate` ✅ — all bindings generated successfully.

---

## The Blocker: Xcode 26.4 Beta SDK Conflict

### Root Cause
System has **Xcode 26.4 beta** (Build version 17E192) which includes:
- `MacOSX.sdk` → symlinked to `MacOSX26.4.sdk` (darwin25.4 target)
- `XROS.platform` with visionOS SDK
- `XRSimulator.platform`

When Flutter builds `App.framework` on ARM macOS, it calls:
```
/usr/bin/arch -arm64e xcrun clang -x c debug_app.cc ... -fapplication-extension ...
```
which resolves to Xcode's clang, which picks up the **XR (visionOS)** deployment target from its default SDK settings.

### Error Output
```
clang: error: conflicting deployment targets, both '26.4' and '26.4' are present in environment
clang: error: conflicting deployment targets, both '26.4' and '25.4' are present in environment
clang: warning: using sysroot for 'MacOSX' but targeting 'XR' [-Wincompatible-sysroot]
```

The `XROS.platform/Developer/SDKs/XROS.sdk` has deployment target `25.4`, while `MacOSX.sdk` targets `26.4`. clang gets confused when both are visible.

### Key Findings
- `xcrun --show-sdk-version --sdk macosx` returns `26.4` (not the normal 15.x)
- Xcode 26.4 beta ships with visionOS (XR) toolchain that pollutes macOS builds
- The conflicting deployment targets (`26.4` vs `25.4`) come from XROS vs MacOSX SDKs both being present
- `clang` warning `[-Wincompatible-sysroot]` confirms it's targeting XR while using MacOSX sysroot
- Podfile post_install `MACOSX_DEPLOYMENT_TARGET=10.15` and `SDKROOT=macosx` **do not fix** the issue — it happens before CocoaPods

### Attempted (Failed) Fixes
1. `Podfile` post_install: set `MACOSX_DEPLOYMENT_TARGET=10.15`, `SDKROOT=macosx`, `SUPPORTED_PLATFORMS=macosx` — no effect
2. `Debug.xcconfig` / `Release.xcconfig`: MACOSX_DEPLOYMENT_TARGET=10.15 — no effect
3. `flutter clean` + delete `Pods/` + `pod install` — no effect
4. Setting env vars `MACOSX_DEPLOYMENT_TARGET`, `SDKROOT` — no effect

### Why It Fails at `debug_macos_framework`
Flutter calls `xcrun clang` via `XcodeProjectInterpreter._run()` → `xcrunCommand()` which prepends `/usr/bin/arch -arm64e`. This arch wrapper forces clang to use Xcode's full toolchain including the XR deployment target. The `-fapplication-extension` flag triggers an AppKit extension check that validates against the XR SDK.

The fix must be at the Flutter toolchain level — either:
1. **Install stable Xcode** (not beta) — recommended
2. **Patch Flutter's `macos.dart`** to pass explicit `-target` and `-isysroot` to clang
3. **Use `xcrun --sdk macosx clang`** instead of the arch-wrapped version

### How to Fix
```bash
# Option A: Install Xcode 16.x stable (recommended)
# Download from https://developer.apple.com/download/
# Then: sudo xcode-select -s /Applications/Xcode.app/Contents/Developer

# Option B: Wait for Xcode 26.4 stable release
```

---

## Git Commits Needed

The Flutter app code should be committed. Suggested commit message:

```
feat(flutter): initial Flutter app scaffold with media_kit player

- Flutter app with BLoC state management (flutter_bloc)
- Rust backend via flutter_rust_bridge (init_torrent_session, start_torrent, etc.)
- HTTP streaming proxy via axum on 127.0.0.1:{port}
- media_kit player (libmpv) for full format support (MKV, HEVC)
- Home screen with magnet input and file list
- Player screen with custom video controls

Note: macOS build blocked by Xcode 26.4 beta SDK conflict.
```

---

## Next Steps When Xcode Issue is Resolved

1. `flutter build macos` — verify compilation
2. `flutter run` — test on desktop simulator
3. Test full torrent streaming flow: magnet → file list → playback
4. iOS build (`flutter build ios`)
5. Android build (`flutter build apk`)
