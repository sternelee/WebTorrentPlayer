import 'dart:async';
import 'dart:io';

import 'package:flutter_bloc/flutter_bloc.dart';
import 'package:path_provider/path_provider.dart';

import '../../models/torrent_models.dart';
import '../../src/rust/api/torrent.dart' as rust;
import 'torrent_event.dart';
import 'torrent_state.dart';

class TorrentBloc extends Bloc<TorrentEvent, TorrentState> {
  String? _currentInfoHash;
  String? _currentStreamUrl;
  int? _currentFileIndex;
  Timer? _statsTimer;

  TorrentBloc() : super(const TorrentInitial()) {
    on<InitializeSession>(_onInitializeSession);
    on<StartTorrent>(_onStartTorrent);
    on<StartTorrentFile>(_onStartTorrentFile);
    on<SelectFile>(_onSelectFile);
    on<PauseTorrent>(_onPauseTorrent);
    on<ResumeTorrent>(_onResumeTorrent);
    on<StopTorrent>(_onStopTorrent);
    on<UpdateStats>(_onUpdateStats);
    on<StatsUpdated>(_onStatsUpdated);
  }

  Future<void> _onInitializeSession(
    InitializeSession event,
    Emitter<TorrentState> emit,
  ) async {
    emit(const SessionInitializing());
    try {
      final cacheDir = await _getCacheDirectory();
      await rust.initTorrentSession(cacheDir: cacheDir);
      emit(const SessionReady());
    } catch (e) {
      emit(TorrentError('Failed to initialize: $e'));
    }
  }

  Future<void> _onStartTorrent(
    StartTorrent event,
    Emitter<TorrentState> emit,
  ) async {
    emit(const TorrentLoading());
    try {
      final metadata = await rust.startTorrent(magnetUri: event.magnetUri);
      final torrentMetadata = TorrentMetadata.fromRust(metadata);
      _currentInfoHash = torrentMetadata.infoHash;
      emit(TorrentMetadataReceived(torrentMetadata));
      _startStatsTimer();
    } catch (e) {
      emit(TorrentError('Failed to start torrent: $e'));
    }
  }

  Future<void> _onStartTorrentFile(
    StartTorrentFile event,
    Emitter<TorrentState> emit,
  ) async {
    emit(const TorrentLoading());
    try {
      final metadata = await rust.startTorrentFile(torrentBytes: event.torrentBytes);
      final torrentMetadata = TorrentMetadata.fromRust(metadata);
      _currentInfoHash = torrentMetadata.infoHash;
      emit(TorrentMetadataReceived(torrentMetadata));
      _startStatsTimer();
    } catch (e) {
      emit(TorrentError('Failed to start torrent: $e'));
    }
  }

  Future<void> _onSelectFile(
    SelectFile event,
    Emitter<TorrentState> emit,
  ) async {
    if (_currentInfoHash == null) return;

    try {
      _currentFileIndex = event.fileIndex;
      final streamUrl = await rust.selectTorrentFile(
        infoHash: _currentInfoHash!,
        fileIndex: BigInt.from(event.fileIndex),
      );
      _currentStreamUrl = streamUrl;

      if (state is TorrentMetadataReceived) {
        final metadata = (state as TorrentMetadataReceived).metadata;
        emit(TorrentFileSelected(
          metadata: metadata,
          selectedFileIndex: event.fileIndex,
          streamUrl: streamUrl,
        ));
      }
    } catch (e) {
      emit(TorrentError('Failed to select file: $e'));
    }
  }

  Future<void> _onPauseTorrent(
    PauseTorrent event,
    Emitter<TorrentState> emit,
  ) async {
    if (_currentInfoHash == null) return;

    try {
      await rust.pauseTorrent(infoHash: _currentInfoHash!);
      if (state is TorrentFileSelected) {
        final current = state as TorrentFileSelected;
        emit(TorrentPaused(
          metadata: current.metadata,
          selectedFileIndex: current.selectedFileIndex,
          streamUrl: current.streamUrl,
        ));
      }
    } catch (e) {
      emit(TorrentError('Failed to pause: $e'));
    }
  }

  Future<void> _onResumeTorrent(
    ResumeTorrent event,
    Emitter<TorrentState> emit,
  ) async {
    if (_currentInfoHash == null) return;

    try {
      await rust.resumeTorrent(infoHash: _currentInfoHash!);
      if (state is TorrentPaused) {
        final current = state as TorrentPaused;
        emit(TorrentFileSelected(
          metadata: current.metadata,
          selectedFileIndex: current.selectedFileIndex,
          streamUrl: current.streamUrl,
        ));
      }
    } catch (e) {
      emit(TorrentError('Failed to resume: $e'));
    }
  }

  Future<void> _onStopTorrent(
    StopTorrent event,
    Emitter<TorrentState> emit,
  ) async {
    if (_currentInfoHash == null) return;

    _stopStatsTimer();

    try {
      await rust.stopTorrent(infoHash: _currentInfoHash!);
      _currentInfoHash = null;
      _currentStreamUrl = null;
      _currentFileIndex = null;
      emit(const SessionReady());
    } catch (e) {
      emit(TorrentError('Failed to stop: $e'));
    }
  }

  Future<void> _onUpdateStats(
    UpdateStats event,
    Emitter<TorrentState> emit,
  ) async {
    if (_currentInfoHash == null) return;

    try {
      final stats = await rust.getTorrentTick(infoHash: _currentInfoHash!);
      if (stats != null) {
        add(StatsUpdated(stats));
      }
    } catch (e) {
      // Silently ignore stats errors
    }
  }

  Future<void> _onStatsUpdated(
    StatsUpdated event,
    Emitter<TorrentState> emit,
  ) async {
    if (state is TorrentFileSelected) {
      final current = state as TorrentFileSelected;
      final stats = TorrentStats.fromRust(event.stats);
      emit(current.copyWith(stats: stats));
    }
  }

  void _startStatsTimer() {
    _statsTimer?.cancel();
    _statsTimer = Timer.periodic(const Duration(seconds: 1), (_) {
      add(const UpdateStats());
    });
  }

  void _stopStatsTimer() {
    _statsTimer?.cancel();
    _statsTimer = null;
  }

  Future<String> _getCacheDirectory() async {
    if (Platform.isAndroid || Platform.isIOS) {
      final dir = await getTemporaryDirectory();
      return '${dir.path}/torrents';
    } else if (Platform.isMacOS || Platform.isLinux) {
      final dir = await getApplicationCacheDirectory();
      return '${dir.path}/torrents';
    } else if (Platform.isWindows) {
      final dir = await getApplicationCacheDirectory();
      return '${dir.path}\\torrents';
    }
    return './torrents';
  }

  @override
  Future<void> close() {
    _stopStatsTimer();
    return super.close();
  }
}
