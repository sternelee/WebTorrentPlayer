import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_bloc/flutter_bloc.dart';
import 'package:media_kit/media_kit.dart';
import 'package:media_kit_video/media_kit_video.dart';
import 'package:path_provider/path_provider.dart';
import 'package:wakelock_plus/wakelock_plus.dart';

import '../blocs/torrent/torrent.dart';
import '../models/torrent_models.dart';

class PlayerScreen extends StatefulWidget {
  final String streamUrl;
  final String fileName;
  final List<TorrentFile> subtitleFiles;

  const PlayerScreen({
    super.key,
    required this.streamUrl,
    required this.fileName,
    this.subtitleFiles = const [],
  });

  @override
  State<PlayerScreen> createState() => _PlayerScreenState();
}

class _PlayerScreenState extends State<PlayerScreen> {
  late final Player _player;
  late final VideoController _videoController;
  bool _isFullScreen = false;
  bool _showControls = true;
  Timer? _controlsTimer;

  @override
  void initState() {
    super.initState();
    _initializePlayer();
    WakelockPlus.enable();
  }

  void _initializePlayer() {
    _player = Player();
    _videoController = VideoController(_player);

    // Configure player for streaming
    _player.setVolume(100);
    _player.open(Media(widget.streamUrl));
    _player.play();

    // Add subtitle tracks if available
    _loadSubtitles();

    // Auto-hide controls
    _scheduleControlsHide();
  }

  Future<void> _loadSubtitles() async {
    if (widget.subtitleFiles.isEmpty) return;

    // For now, we'll load the first subtitle file
    // In a full implementation, you'd let the user choose
    for (final subtitle in widget.subtitleFiles.take(1)) {
      // Extract base URL and construct subtitle URL
      final uri = Uri.parse(widget.streamUrl);
      final pathSegments = uri.pathSegments;
      if (pathSegments.length >= 3) {
        final baseUrl =
            '${uri.scheme}://${uri.host}:${uri.port}/stream/${pathSegments[1]}';
        final subtitleUrl = '$baseUrl/${subtitle.index}';

        // Download subtitle to temp file for media_kit
        try {
          final tempDir = await getTemporaryDirectory();
          final subtitleExt = subtitle.name.split('.').last;
          final subtitleFile = '${tempDir.path}/subtitle_${subtitle.index}.$subtitleExt';

          // Note: In a real implementation, you'd download the subtitle file
          // and then add it to the player. For now, we skip this complexity.
          debugPrint('Subtitle URL: $subtitleUrl -> $subtitleFile');
        } catch (e) {
          debugPrint('Failed to load subtitle: $e');
        }
      }
    }
  }

  void _scheduleControlsHide() {
    _controlsTimer?.cancel();
    _controlsTimer = Timer(const Duration(seconds: 3), () {
      if (mounted && !_player.state.completed) {
        setState(() => _showControls = false);
      }
    });
  }

  void _toggleControls() {
    setState(() => _showControls = !_showControls);
    if (_showControls) {
      _scheduleControlsHide();
    }
  }

  void _toggleFullScreen() {
    setState(() => _isFullScreen = !_isFullScreen);
    if (_isFullScreen) {
      SystemChrome.setEnabledSystemUIMode(SystemUiMode.immersiveSticky);
      SystemChrome.setPreferredOrientations([
        DeviceOrientation.landscapeLeft,
        DeviceOrientation.landscapeRight,
      ]);
    } else {
      SystemChrome.setEnabledSystemUIMode(SystemUiMode.edgeToEdge);
      SystemChrome.setPreferredOrientations([
        DeviceOrientation.portraitUp,
        DeviceOrientation.portraitDown,
        DeviceOrientation.landscapeLeft,
        DeviceOrientation.landscapeRight,
      ]);
    }
  }

  Future<void> _stopAndGoBack() async {
    await _player.dispose();
    if (mounted) {
      context.read<TorrentBloc>().add(const StopTorrent());
      Navigator.of(context).pop();
    }
  }

  @override
  void dispose() {
    _controlsTimer?.cancel();
    _player.dispose();
    WakelockPlus.disable();
    SystemChrome.setEnabledSystemUIMode(SystemUiMode.edgeToEdge);
    SystemChrome.setPreferredOrientations([
      DeviceOrientation.portraitUp,
      DeviceOrientation.portraitDown,
      DeviceOrientation.landscapeLeft,
      DeviceOrientation.landscapeRight,
    ]);
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: Colors.black,
      body: WillPopScope(
        onWillPop: () async {
          await _stopAndGoBack();
          return false;
        },
        child: Stack(
          children: [
            // Video
            GestureDetector(
              onTap: _toggleControls,
              child: Video(
                controller: _videoController,
                fit: BoxFit.contain,
                controls: NoVideoControls,
              ),
            ),

            // Controls overlay
            if (_showControls)
              Container(
                decoration: BoxDecoration(
                  gradient: LinearGradient(
                    begin: Alignment.topCenter,
                    end: Alignment.bottomCenter,
                    colors: [
                      Colors.black.withOpacity(0.7),
                      Colors.transparent,
                      Colors.transparent,
                      Colors.black.withOpacity(0.7),
                    ],
                  ),
                ),
              ),

            // Top controls
            if (_showControls)
              SafeArea(
                child: Column(
                  children: [
                    Padding(
                      padding: const EdgeInsets.all(16),
                      child: Row(
                        children: [
                          IconButton(
                            onPressed: _stopAndGoBack,
                            icon: const Icon(Icons.arrow_back, color: Colors.white),
                          ),
                          const SizedBox(width: 8),
                          Expanded(
                            child: Text(
                              widget.fileName,
                              style: const TextStyle(
                                color: Colors.white,
                                fontSize: 16,
                                fontWeight: FontWeight.w500,
                              ),
                              maxLines: 1,
                              overflow: TextOverflow.ellipsis,
                            ),
                          ),
                          // Stats display
                          BlocBuilder<TorrentBloc, TorrentState>(
                            builder: (context, state) {
                              if (state is TorrentFileSelected &&
                                  state.stats != null) {
                                final stats = state.stats!;
                                return Container(
                                  padding: const EdgeInsets.symmetric(
                                    horizontal: 12,
                                    vertical: 6,
                                  ),
                                  decoration: BoxDecoration(
                                    color: Colors.black.withOpacity(0.5),
                                    borderRadius: BorderRadius.circular(8),
                                  ),
                                  child: Row(
                                    mainAxisSize: MainAxisSize.min,
                                    children: [
                                      Icon(
                                        Icons.download,
                                        size: 14,
                                        color: Colors.white.withOpacity(0.8),
                                      ),
                                      const SizedBox(width: 4),
                                      Text(
                                        stats.downloadSpeedFormatted,
                                        style: TextStyle(
                                          color: Colors.white.withOpacity(0.8),
                                          fontSize: 12,
                                        ),
                                      ),
                                      const SizedBox(width: 12),
                                      Icon(
                                        Icons.people,
                                        size: 14,
                                        color: Colors.white.withOpacity(0.8),
                                      ),
                                      const SizedBox(width: 4),
                                      Text(
                                        '${stats.peersConnected}',
                                        style: TextStyle(
                                          color: Colors.white.withOpacity(0.8),
                                          fontSize: 12,
                                        ),
                                      ),
                                      const SizedBox(width: 12),
                                      Text(
                                        '${stats.progressPercent.toStringAsFixed(1)}%',
                                        style: TextStyle(
                                          color: Colors.white.withOpacity(0.8),
                                          fontSize: 12,
                                        ),
                                      ),
                                    ],
                                  ),
                                );
                              }
                              return const SizedBox.shrink();
                            },
                          ),
                        ],
                      ),
                    ),

                    const Spacer(),

                    // Bottom controls
                    Padding(
                      padding: const EdgeInsets.all(16),
                      child: Row(
                        children: [
                          // Play/Pause
                          StreamBuilder<bool>(
                            stream: _player.stream.playing,
                            builder: (context, snapshot) {
                              final isPlaying = snapshot.data ?? false;
                              return IconButton(
                                onPressed: () {
                                  if (isPlaying) {
                                    _player.pause();
                                    context.read<TorrentBloc>().add(const PauseTorrent());
                                  } else {
                                    _player.play();
                                    context.read<TorrentBloc>().add(const ResumeTorrent());
                                  }
                                },
                                icon: Icon(
                                  isPlaying ? Icons.pause : Icons.play_arrow,
                                  color: Colors.white,
                                  size: 32,
                                ),
                              );
                            },
                          ),

                          const SizedBox(width: 16),

                          // Progress
                          Expanded(
                            child: StreamBuilder<Duration>(
                              stream: _player.stream.position,
                              builder: (context, positionSnapshot) {
                                return StreamBuilder<Duration>(
                                  stream: _player.stream.duration,
                                  builder: (context, durationSnapshot) {
                                    final position =
                                        positionSnapshot.data?.inSeconds ?? 0;
                                    final duration =
                                        durationSnapshot.data?.inSeconds ?? 0;

                                    return Column(
                                      mainAxisSize: MainAxisSize.min,
                                      children: [
                                        Slider(
                                          value: duration > 0
                                              ? position.toDouble()
                                              : 0,
                                          max: duration.toDouble(),
                                          onChanged: (value) {
                                            _player.seek(
                                                Duration(seconds: value.toInt()));
                                          },
                                          activeColor: const Color(0xFF38BDF8),
                                          inactiveColor:
                                              Colors.white.withOpacity(0.3),
                                        ),
                                        Row(
                                          mainAxisAlignment:
                                              MainAxisAlignment.spaceBetween,
                                          children: [
                                            Text(
                                              _formatDuration(position),
                                              style: TextStyle(
                                                color: Colors.white
                                                    .withOpacity(0.8),
                                                fontSize: 12,
                                              ),
                                            ),
                                            Text(
                                              _formatDuration(duration),
                                              style: TextStyle(
                                                color: Colors.white
                                                    .withOpacity(0.8),
                                                fontSize: 12,
                                              ),
                                            ),
                                          ],
                                        ),
                                      ],
                                    );
                                  },
                                );
                              },
                            ),
                          ),

                          const SizedBox(width: 16),

                          // Volume
                          StreamBuilder<double>(
                            stream: _player.stream.volume,
                            builder: (context, snapshot) {
                              final volume = snapshot.data ?? 100;
                              return Row(
                                mainAxisSize: MainAxisSize.min,
                                children: [
                                  IconButton(
                                    onPressed: () {
                                      _player.setVolume(volume > 0 ? 0 : 100);
                                    },
                                    icon: Icon(
                                      volume > 0
                                          ? Icons.volume_up
                                          : Icons.volume_off,
                                      color: Colors.white,
                                    ),
                                  ),
                                  SizedBox(
                                    width: 100,
                                    child: Slider(
                                      value: volume,
                                      max: 100,
                                      onChanged: (value) {
                                        _player.setVolume(value);
                                      },
                                      activeColor: const Color(0xFF38BDF8),
                                      inactiveColor:
                                          Colors.white.withOpacity(0.3),
                                    ),
                                  ),
                                ],
                              );
                            },
                          ),

                          // Fullscreen
                          IconButton(
                            onPressed: _toggleFullScreen,
                            icon: Icon(
                              _isFullScreen
                                  ? Icons.fullscreen_exit
                                  : Icons.fullscreen,
                              color: Colors.white,
                            ),
                          ),
                        ],
                      ),
                    ),
                  ],
                ),
              ),
          ],
        ),
      ),
    );
  }

  String _formatDuration(int seconds) {
    final hours = seconds ~/ 3600;
    final minutes = (seconds % 3600) ~/ 60;
    final secs = seconds % 60;

    if (hours > 0) {
      return '$hours:${minutes.toString().padLeft(2, '0')}:${secs.toString().padLeft(2, '0')}';
    }
    return '${minutes.toString().padLeft(2, '0')}:${secs.toString().padLeft(2, '0')}';
  }
}
