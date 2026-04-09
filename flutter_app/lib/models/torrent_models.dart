import 'package:equatable/equatable.dart';

class TorrentFile extends Equatable {
  final int index;
  final String name;
  final int sizeBytes;
  final bool isVideo;

  const TorrentFile({
    required this.index,
    required this.name,
    required this.sizeBytes,
    required this.isVideo,
  });

  factory TorrentFile.fromRust(dynamic file) {
    return TorrentFile(
      index: file.index.toInt(),
      name: file.name,
      sizeBytes: file.sizeBytes.toInt(),
      isVideo: file.isVideo,
    );
  }

  String get sizeFormatted {
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    if (sizeBytes == 0) return '0 B';
    final exp = (sizeBytes.toString().length - 1) ~/ 3;
    final unitIndex = exp.clamp(0, units.length - 1);
    final value = sizeBytes / (1 << (unitIndex * 10));
    return '${value.toStringAsFixed(1)} ${units[unitIndex]}';
  }

  @override
  List<Object?> get props => [index, name, sizeBytes, isVideo];
}

class TorrentMetadata extends Equatable {
  final String infoHash;
  final List<TorrentFile> files;

  const TorrentMetadata({
    required this.infoHash,
    required this.files,
  });

  factory TorrentMetadata.fromRust(dynamic payload) {
    return TorrentMetadata(
      infoHash: payload.infoHash,
      files: (payload.files as List)
          .map((f) => TorrentFile.fromRust(f))
          .toList(),
    );
  }

  List<TorrentFile> get videoFiles =>
      files.where((f) => f.isVideo).toList();

  List<TorrentFile> get subtitleFiles =>
      files.where((f) => _isSubtitleFile(f.name)).toList();

  static bool _isSubtitleFile(String name) {
    final ext = name.split('.').lastOrNull?.toLowerCase() ?? '';
    return ['srt', 'vtt', 'ass', 'ssa', 'sub'].contains(ext);
  }

  @override
  List<Object?> get props => [infoHash, files];
}

class TorrentStats extends Equatable {
  final String infoHash;
  final double downloadSpeedKbps;
  final double uploadSpeedKbps;
  final int peersConnected;
  final double progressPercent;
  final String state;

  const TorrentStats({
    required this.infoHash,
    required this.downloadSpeedKbps,
    required this.uploadSpeedKbps,
    required this.peersConnected,
    required this.progressPercent,
    required this.state,
  });

  factory TorrentStats.fromRust(dynamic payload) {
    return TorrentStats(
      infoHash: payload.infoHash,
      downloadSpeedKbps: payload.downloadSpeedKbps,
      uploadSpeedKbps: payload.uploadSpeedKbps,
      peersConnected: payload.peersConnected.toInt(),
      progressPercent: payload.progressPercent,
      state: payload.state,
    );
  }

  String get downloadSpeedFormatted {
    if (downloadSpeedKbps >= 1024) {
      return '${(downloadSpeedKbps / 1024).toStringAsFixed(1)} MB/s';
    }
    return '${downloadSpeedKbps.toStringAsFixed(1)} KB/s';
  }

  String get uploadSpeedFormatted {
    if (uploadSpeedKbps >= 1024) {
      return '${(uploadSpeedKbps / 1024).toStringAsFixed(1)} MB/s';
    }
    return '${uploadSpeedKbps.toStringAsFixed(1)} KB/s';
  }

  String get stateLabel {
    switch (state) {
      case 'parsing':
        return 'Parsing';
      case 'downloading':
        return 'Downloading';
      case 'seeding':
        return 'Seeding';
      case 'paused':
        return 'Paused';
      default:
        return 'Unknown';
    }
  }

  bool get isPaused => state == 'paused';
  bool get isDownloading => state == 'downloading';
  bool get isSeeding => state == 'seeding';

  @override
  List<Object?> get props => [
        infoHash,
        downloadSpeedKbps,
        uploadSpeedKbps,
        peersConnected,
        progressPercent,
        state,
      ];
}
