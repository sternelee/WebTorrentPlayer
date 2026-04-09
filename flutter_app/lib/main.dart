import 'package:flutter/material.dart';
import 'package:flutter_bloc/flutter_bloc.dart';
import 'package:media_kit/media_kit.dart';

import 'blocs/torrent/torrent.dart';
import 'screens/home_screen.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();

  // Initialize media_kit
  MediaKit.ensureInitialized();

  runApp(const TorPlayApp());
}

class TorPlayApp extends StatelessWidget {
  const TorPlayApp({super.key});

  @override
  Widget build(BuildContext context) {
    return BlocProvider(
      create: (_) => TorrentBloc(),
      child: MaterialApp(
        title: 'TorPlay',
        debugShowCheckedModeBanner: false,
        theme: ThemeData(
          colorScheme: ColorScheme.fromSeed(
            seedColor: const Color(0xFF0EA5E9),
            brightness: Brightness.dark,
          ),
          brightness: Brightness.dark,
          useMaterial3: true,
          scaffoldBackgroundColor: const Color(0xFF0F172A),
        ),
        home: const HomeScreen(),
      ),
    );
  }
}
