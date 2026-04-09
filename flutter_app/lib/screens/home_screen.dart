import 'dart:io';

import 'package:file_picker/file_picker.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_bloc/flutter_bloc.dart';

import '../blocs/torrent/torrent.dart';
import '../models/torrent_models.dart';
import 'player_screen.dart';

class HomeScreen extends StatefulWidget {
  const HomeScreen({super.key});

  @override
  State<HomeScreen> createState() => _HomeScreenState();
}

class _HomeScreenState extends State<HomeScreen> {
  final _magnetController = TextEditingController();
  bool _isLoading = false;

  @override
  void initState() {
    super.initState();
    context.read<TorrentBloc>().add(const InitializeSession());
  }

  @override
  void dispose() {
    _magnetController.dispose();
    super.dispose();
  }

  void _startTorrent() {
    final magnet = _magnetController.text.trim();
    if (magnet.isEmpty) return;

    if (!magnet.startsWith('magnet:?')) {
      _showError('Please enter a valid magnet link');
      return;
    }

    setState(() => _isLoading = true);
    context.read<TorrentBloc>().add(StartTorrent(magnet));
  }

  Future<void> _pickTorrentFile() async {
    final result = await FilePicker.platform.pickFiles(
      type: FileType.custom,
      allowedExtensions: ['torrent'],
      withData: true,
    );

    if (result != null && result.files.single.bytes != null) {
      setState(() => _isLoading = true);
      context.read<TorrentBloc>().add(
            StartTorrentFile(result.files.single.bytes!.toList()),
          );
    }
  }

  void _showError(String message) {
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(content: Text(message), backgroundColor: Colors.red),
    );
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: const Color(0xFF0F172A), // slate-950
      appBar: AppBar(
        backgroundColor: const Color(0xFF0F172A),
        elevation: 0,
        title: const Text(
          'TorPlay',
          style: TextStyle(
            color: Color(0xFF38BDF8), // sky-400
            fontSize: 14,
            letterSpacing: 2.8,
            fontWeight: FontWeight.w500,
          ),
        ),
        centerTitle: false,
      ),
      body: BlocConsumer<TorrentBloc, TorrentState>(
        listener: (context, state) {
          setState(() => _isLoading = false);

          if (state is TorrentError) {
            _showError(state.message);
          } else if (state is TorrentFileSelected) {
            _navigateToPlayer(state);
          }
        },
        builder: (context, state) {
          if (state is SessionInitializing) {
            return const Center(
              child: CircularProgressIndicator(color: Color(0xFF38BDF8)),
            );
          }

          if (state is TorrentMetadataReceived) {
            return _FileListView(
              metadata: state.metadata,
              onFileSelected: (index) {
                context.read<TorrentBloc>().add(SelectFile(index));
              },
              onStop: () {
                context.read<TorrentBloc>().add(const StopTorrent());
              },
            );
          }

          if (state is TorrentFileSelected || state is TorrentPaused) {
            // Will navigate to player, show loading while transitioning
            return const Center(
              child: CircularProgressIndicator(color: Color(0xFF38BDF8)),
            );
          }

          return _InputView(
            controller: _magnetController,
            isLoading: _isLoading,
            onStart: _startTorrent,
            onPickFile: _pickTorrentFile,
          );
        },
      ),
    );
  }

  void _navigateToPlayer(TorrentFileSelected state) {
    final videoFile = state.metadata.videoFiles.firstWhere(
      (f) => f.index == state.selectedFileIndex,
      orElse: () => state.metadata.files[state.selectedFileIndex],
    );

    Navigator.of(context).push(
      MaterialPageRoute(
        builder: (_) => PlayerScreen(
          streamUrl: state.streamUrl,
          fileName: videoFile.name,
          subtitleFiles: state.metadata.subtitleFiles
              .where((f) => f.name.startsWith(
                  videoFile.name.substring(0, videoFile.name.lastIndexOf('.'))))
              .toList(),
        ),
      ),
    );
  }
}

class _InputView extends StatelessWidget {
  final TextEditingController controller;
  final bool isLoading;
  final VoidCallback onStart;
  final VoidCallback onPickFile;

  const _InputView({
    required this.controller,
    required this.isLoading,
    required this.onStart,
    required this.onPickFile,
  });

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.all(16),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Container(
            padding: const EdgeInsets.all(16),
            decoration: BoxDecoration(
              color: const Color(0xFF1E293B), // slate-800
              borderRadius: BorderRadius.circular(24),
              border: Border.all(
                color: Colors.white.withOpacity(0.1),
                style: BorderStyle.solid,
              ),
            ),
            child: Column(
              children: [
                Row(
                  children: [
                    Expanded(
                      child: TextField(
                        controller: controller,
                        style: const TextStyle(color: Colors.white),
                        decoration: InputDecoration(
                          hintText: 'Paste magnet link or .torrent URL',
                          hintStyle: TextStyle(
                            color: Colors.white.withOpacity(0.5),
                          ),
                          border: OutlineInputBorder(
                            borderRadius: BorderRadius.circular(16),
                            borderSide: BorderSide.none,
                          ),
                          filled: true,
                          fillColor: const Color(0xFF0F172A),
                          contentPadding: const EdgeInsets.symmetric(
                            horizontal: 16,
                            vertical: 16,
                          ),
                        ),
                        onSubmitted: (_) => onStart(),
                      ),
                    ),
                    const SizedBox(width: 12),
                    SizedBox(
                      width: 48,
                      height: 48,
                      child: ElevatedButton(
                        onPressed: isLoading ? null : onStart,
                        style: ElevatedButton.styleFrom(
                          backgroundColor: const Color(0xFF0EA5E9), // sky-500
                          foregroundColor: const Color(0xFF0F172A),
                          shape: RoundedRectangleBorder(
                            borderRadius: BorderRadius.circular(16),
                          ),
                          padding: EdgeInsets.zero,
                        ),
                        child: isLoading
                            ? const SizedBox(
                                width: 20,
                                height: 20,
                                child: CircularProgressIndicator(
                                  strokeWidth: 2,
                                  color: Color(0xFF0F172A),
                                ),
                              )
                            : const Icon(Icons.play_arrow, size: 24),
                      ),
                    ),
                  ],
                ),
                const SizedBox(height: 12),
                Row(
                  mainAxisAlignment: MainAxisAlignment.spaceBetween,
                  children: [
                    Text(
                      'Supports magnet links and .torrent files',
                      style: TextStyle(
                        color: Colors.white.withOpacity(0.5),
                        fontSize: 12,
                      ),
                    ),
                    TextButton.icon(
                      onPressed: onPickFile,
                      icon: const Icon(Icons.file_upload, size: 16),
                      label: const Text('Select File'),
                      style: TextButton.styleFrom(
                        foregroundColor: Colors.white.withOpacity(0.8),
                        padding: const EdgeInsets.symmetric(
                          horizontal: 12,
                          vertical: 8,
                        ),
                        shape: RoundedRectangleBorder(
                          borderRadius: BorderRadius.circular(16),
                          side: BorderSide(
                            color: Colors.white.withOpacity(0.1),
                          ),
                        ),
                      ),
                    ),
                  ],
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

class _FileListView extends StatelessWidget {
  final TorrentMetadata metadata;
  final ValueChanged<int> onFileSelected;
  final VoidCallback onStop;

  const _FileListView({
    required this.metadata,
    required this.onFileSelected,
    required this.onStop,
  });

  @override
  Widget build(BuildContext context) {
    final videoFiles = metadata.videoFiles;

    return Column(
      children: [
        Container(
          padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
          decoration: BoxDecoration(
            color: const Color(0xFF1E293B),
            border: Border(
              bottom: BorderSide(color: Colors.white.withOpacity(0.1)),
            ),
          ),
          child: Row(
            children: [
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      'Select a file to play',
                      style: TextStyle(
                        color: Colors.white.withOpacity(0.8),
                        fontSize: 14,
                      ),
                    ),
                    const SizedBox(height: 4),
                    Text(
                      '${videoFiles.length} video files found',
                      style: TextStyle(
                        color: Colors.white.withOpacity(0.5),
                        fontSize: 12,
                      ),
                    ),
                  ],
                ),
              ),
              IconButton(
                onPressed: onStop,
                icon: const Icon(Icons.stop, color: Colors.red),
              ),
            ],
          ),
        ),
        Expanded(
          child: ListView.builder(
            itemCount: videoFiles.length,
            itemBuilder: (context, index) {
              final file = videoFiles[index];
              return ListTile(
                leading: const Icon(
                  Icons.video_file,
                  color: Color(0xFF38BDF8),
                ),
                title: Text(
                  file.name,
                  style: const TextStyle(color: Colors.white, fontSize: 14),
                  maxLines: 2,
                  overflow: TextOverflow.ellipsis,
                ),
                subtitle: Text(
                  file.sizeFormatted,
                  style: TextStyle(
                    color: Colors.white.withOpacity(0.5),
                    fontSize: 12,
                  ),
                ),
                trailing: const Icon(
                  Icons.play_circle_outline,
                  color: Color(0xFF38BDF8),
                ),
                onTap: () => onFileSelected(file.index),
              );
            },
          ),
        ),
      ],
    );
  }
}
