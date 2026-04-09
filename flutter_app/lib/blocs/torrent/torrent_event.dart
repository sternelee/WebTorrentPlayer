import 'package:equatable/equatable.dart';

abstract class TorrentEvent extends Equatable {
  const TorrentEvent();

  @override
  List<Object?> get props => [];
}

class InitializeSession extends TorrentEvent {
  const InitializeSession();
}

class StartTorrent extends TorrentEvent {
  final String magnetUri;

  const StartTorrent(this.magnetUri);

  @override
  List<Object?> get props => [magnetUri];
}

class StartTorrentFile extends TorrentEvent {
  final List<int> torrentBytes;

  const StartTorrentFile(this.torrentBytes);

  @override
  List<Object?> get props => [torrentBytes];
}

class SelectFile extends TorrentEvent {
  final int fileIndex;

  const SelectFile(this.fileIndex);

  @override
  List<Object?> get props => [fileIndex];
}

class PauseTorrent extends TorrentEvent {
  const PauseTorrent();
}

class ResumeTorrent extends TorrentEvent {
  const ResumeTorrent();
}

class StopTorrent extends TorrentEvent {
  const StopTorrent();
}

class UpdateStats extends TorrentEvent {
  const UpdateStats();
}

class StatsUpdated extends TorrentEvent {
  final dynamic stats;

  const StatsUpdated(this.stats);

  @override
  List<Object?> get props => [stats];
}

class PlaybackStarted extends TorrentEvent {
  final String streamUrl;
  final String fileName;

  const PlaybackStarted(this.streamUrl, this.fileName);

  @override
  List<Object?> get props => [streamUrl, fileName];
}

class PlaybackStopped extends TorrentEvent {
  const PlaybackStopped();
}
