import 'package:equatable/equatable.dart';

import '../../models/torrent_models.dart';

abstract class TorrentState extends Equatable {
  const TorrentState();

  @override
  List<Object?> get props => [];
}

class TorrentInitial extends TorrentState {
  const TorrentInitial();
}

class SessionInitializing extends TorrentState {
  const SessionInitializing();
}

class SessionReady extends TorrentState {
  const SessionReady();
}

class TorrentLoading extends TorrentState {
  const TorrentLoading();
}

class TorrentMetadataReceived extends TorrentState {
  final TorrentMetadata metadata;

  const TorrentMetadataReceived(this.metadata);

  @override
  List<Object?> get props => [metadata];
}

class TorrentFileSelected extends TorrentState {
  final TorrentMetadata metadata;
  final int selectedFileIndex;
  final String streamUrl;
  final TorrentStats? stats;

  const TorrentFileSelected({
    required this.metadata,
    required this.selectedFileIndex,
    required this.streamUrl,
    this.stats,
  });

  @override
  List<Object?> get props => [metadata, selectedFileIndex, streamUrl, stats];

  TorrentFileSelected copyWith({
    TorrentMetadata? metadata,
    int? selectedFileIndex,
    String? streamUrl,
    TorrentStats? stats,
  }) {
    return TorrentFileSelected(
      metadata: metadata ?? this.metadata,
      selectedFileIndex: selectedFileIndex ?? this.selectedFileIndex,
      streamUrl: streamUrl ?? this.streamUrl,
      stats: stats ?? this.stats,
    );
  }
}

class TorrentPaused extends TorrentState {
  final TorrentMetadata metadata;
  final int selectedFileIndex;
  final String streamUrl;

  const TorrentPaused({
    required this.metadata,
    required this.selectedFileIndex,
    required this.streamUrl,
  });

  @override
  List<Object?> get props => [metadata, selectedFileIndex, streamUrl];
}

class TorrentError extends TorrentState {
  final String message;

  const TorrentError(this.message);

  @override
  List<Object?> get props => [message];
}
