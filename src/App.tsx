import {
  createEffect,
  createMemo,
  createSignal,
  For,
  onCleanup,
  onMount,
  Show,
} from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  Activity,
  Captions,
  CirclePause,
  CirclePlay,
  Download,
  FileUp,
  LoaderCircle,
  Maximize,
  Minimize,
  Pause,
  Play,
  RefreshCcw,
  Search,
  Square,
  Video,
  Volume2,
  VolumeX,
  Wifi,
} from "lucide-solid";
import "vidstack/player";
import "vidstack/player/layouts/default";
import "vidstack/player/styles/default/theme.css";
import "vidstack/player/styles/default/layouts/video.css";
import "./App.css";
import {
  getAndroidNetworkStatus,
  hasAndroidBridge,
  listenToAndroidNetworkStatus,
  syncAndroidPlaybackOrientation,
  syncAndroidForegroundSession,
  type AndroidNetworkStatus,
} from "./lib/android";
import { i18nStore } from "./lib/i18n";
import { requiresExternalPlayer } from "./lib/video";
import { SearchPopup } from "./lib/SearchPopup";
import { searchStore, type SearchResult } from "./lib/search";
import { initializeSources } from "./lib/sources";
import {
  openWithNativePlayer,
  copyStreamUrl,
  getRecommendedPlayers,
} from "./lib/native-player";

type TorrentPlaybackState = "parsing" | "downloading" | "seeding" | "paused";

interface TorrentTickPayload {
  infoHash: string;
  downloadSpeedKbps: number;
  uploadSpeedKbps: number;
  peersConnected: number;
  progressPercent: number;
  state: TorrentPlaybackState;
}

interface TorrentMetadataFile {
  index: number;
  name: string;
  sizeBytes: number;
  isVideo: boolean;
}

interface TorrentMetadataPayload {
  infoHash: string;
  files: TorrentMetadataFile[];
}

type SubtitleTrackType = "vtt" | "srt" | "ssa" | "ass";

interface TorrentTextTrack {
  id: string;
  mode: "disabled" | "hidden" | "showing";
}

interface TorrentTextTrackList {
  clear(): void;
  add(track: {
    id: string;
    kind: "subtitles";
    label: string;
    language?: string;
    src: string;
    type?: SubtitleTrackType;
  }): void;
  getByKind(
    kind: "subtitles" | "captions" | Array<"subtitles" | "captions">,
  ): TorrentTextTrack[];
}

interface TorrentPlayerElement extends HTMLElement {
  src?: string | { src: string; type: string };
  currentTime: number;
  duration: number;
  volume: number;
  muted: boolean;
  paused: boolean;
  waiting: boolean;
  textTracks: TorrentTextTrackList;
  play(): Promise<void>;
  pause(): Promise<void>;
  enterFullscreen(
    target?: "prefer-media" | "media" | "provider",
    trigger?: Event,
  ): Promise<void>;
  exitFullscreen(
    target?: "prefer-media" | "media" | "provider",
    trigger?: Event,
  ): Promise<void>;
}

interface WebKitFullscreenVideoElement extends HTMLVideoElement {
  webkitEnterFullscreen?(): void;
  webkitExitFullscreen?(): void;
  webkitDisplayingFullscreen?: boolean;
}

interface NetworkNotice {
  tone: "warning" | "info" | "success";
  text: string;
}

const SUBTITLE_LANGUAGE_MAP: Record<string, string> = {
  zh: "zh",
  zho: "zh",
  chi: "zh",
  chs: "zh-CN",
  sc: "zh-CN",
  gb: "zh-CN",
  simplified: "zh-CN",
  cht: "zh-TW",
  tc: "zh-TW",
  big5: "zh-TW",
  traditional: "zh-TW",
  en: "en",
  eng: "en",
  english: "en",
  ja: "ja",
  jpn: "ja",
  japanese: "ja",
  ko: "ko",
  kor: "ko",
  korean: "ko",
  es: "es",
  spa: "es",
  spanish: "es",
  fr: "fr",
  fra: "fr",
  french: "fr",
  de: "de",
  deu: "de",
  ger: "de",
  german: "de",
};

function getFileExtension(name: string) {
  const extension = name.split(".").pop()?.toLowerCase();
  return extension ?? "";
}

function isSubtitleFile(name: string) {
  return ["srt", "vtt", "ass", "ssa", "sub"].includes(getFileExtension(name));
}

function inferVideoType(name: string) {
  switch (getFileExtension(name)) {
    case "mp4":
    case "m4v":
      return "video/mp4";
    case "mkv":
      return "video/x-matroska";
    case "webm":
      return "video/webm";
    case "mov":
      return "video/quicktime";
    case "avi":
      return "video/x-msvideo";
    case "ts":
      return "video/mp2t";
    case "m2ts":
      return "video/mp2t";
    default:
      return "video/mp4";
  }
}

function inferSubtitleType(name: string): SubtitleTrackType | undefined {
  const extension = getFileExtension(name);
  if (extension === "sub") return undefined;
  return ["vtt", "srt", "ssa", "ass"].includes(extension)
    ? (extension as SubtitleTrackType)
    : undefined;
}

function inferSubtitleLanguage(name: string) {
  const tokens = name
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  return tokens.map((token) => SUBTITLE_LANGUAGE_MAP[token]).find(Boolean);
}

function getBaseName(name: string) {
  const normalized = name.split(/[\\/]/).pop() ?? name;
  return normalized.replace(/\.[^.]+$/, "");
}

function createSubtitleLabel(file: TorrentMetadataFile) {
  const language = inferSubtitleLanguage(file.name);
  const baseName = getBaseName(file.name);
  return language ? `${baseName} (${language})` : baseName;
}

function buildSiblingStreamUrl(source: string, fileIndex: number) {
  return source.replace(/\/\d+(\?.*)?$/, `/${fileIndex}`);
}

function formatBytes(bytes: number) {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const exponent = Math.min(
    Math.floor(Math.log(bytes) / Math.log(1024)),
    units.length - 1,
  );
  const value = bytes / 1024 ** exponent;
  return `${value.toFixed(value >= 100 || exponent === 0 ? 0 : 1)} ${units[exponent]}`;
}

function formatSpeed(kbps: number) {
  if (kbps >= 1024) {
    return `${(kbps / 1024).toFixed(1)} MB/s`;
  }

  return `${kbps.toFixed(1)} KB/s`;
}

function formatPlaybackTime(seconds: number) {
  if (!Number.isFinite(seconds) || seconds < 0) return "--:--";

  const totalSeconds = Math.floor(seconds);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const remainingSeconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}:${minutes.toString().padStart(2, "0")}:${remainingSeconds
      .toString()
      .padStart(2, "0")}`;
  }

  return `${minutes}:${remainingSeconds.toString().padStart(2, "0")}`;
}

function stateLabel(state: TorrentPlaybackState | undefined) {
  switch (state) {
    case "parsing":
      return i18nStore.t("player.parsing");
    case "downloading":
      return i18nStore.t("player.downloading");
    case "seeding":
      return i18nStore.t("player.seeding");
    case "paused":
      return i18nStore.t("player.paused");
    default:
      return i18nStore.t("common.standby");
  }
}

function fallbackNetworkStatus(): AndroidNetworkStatus {
  const connected = navigator.onLine;

  return {
    connected,
    validated: connected,
    internetCapable: connected,
    metered: false,
    transports: [],
  };
}

function isNetworkUnavailable(status: AndroidNetworkStatus | null) {
  return status
    ? !status.connected || !status.validated || !status.internetCapable
    : false;
}

function formatNetworkLabel(status: AndroidNetworkStatus | null) {
  if (!status) return i18nStore.t("common.unknown");
  if (isNetworkUnavailable(status)) return i18nStore.t("common.offline");

  const [primaryTransport] = status.transports;
  switch (primaryTransport) {
    case "wifi":
      return status.metered
        ? i18nStore.t("common.wifiMetered")
        : i18nStore.t("common.wifi");
    case "cellular":
      return i18nStore.t("common.cellular");
    case "ethernet":
      return i18nStore.t("common.ethernet");
    case "vpn":
      return i18nStore.t("common.vpn");
    default:
      return status.metered
        ? i18nStore.t("common.connectedMetered")
        : i18nStore.t("common.connected");
  }
}

function isTorrentFile(file: File) {
  return file.name.toLowerCase().endsWith(".torrent");
}

function hasDraggedFiles(event: DragEvent) {
  const types = event.dataTransfer?.types;
  return types ? Array.from(types).includes("Files") : false;
}

function isSupportedTorrentInput(value: string) {
  if (value.startsWith("magnet:?")) {
    return true;
  }

  try {
    const url = new URL(value);
    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      url.pathname.toLowerCase().endsWith(".torrent")
    );
  } catch {
    return false;
  }
}

function App() {
  const [magnet, setMagnet] = createSignal("");
  const [currentInfoHash, setCurrentInfoHash] = createSignal<string | null>(
    null,
  );
  const [metadata, setMetadata] = createSignal<TorrentMetadataPayload | null>(
    null,
  );
  const [stats, setStats] = createSignal<TorrentTickPayload | null>(null);
  const [videoSrc, setVideoSrc] = createSignal("");
  const [selectedFileIndex, setSelectedFileIndex] = createSignal<number | null>(
    null,
  );
  const [selectedSubtitleIndex, setSelectedSubtitleIndex] = createSignal<
    number | null
  >(null);
  const [needsExternalPlayer, setNeedsExternalPlayer] = createSignal(false);
  const [externalPlayerError, setExternalPlayerError] = createSignal<
    string | null
  >(null);
  const [error, setError] = createSignal<string | null>(null);
  const [isSubmitting, setIsSubmitting] = createSignal(false);
  const [isSelecting, setIsSelecting] = createSignal(false);
  const [isDraggingTorrent, setIsDraggingTorrent] = createSignal(false);
  const [networkStatus, setNetworkStatus] =
    createSignal<AndroidNetworkStatus | null>(null);
  const [networkNotice, setNetworkNotice] = createSignal<NetworkNotice | null>(
    null,
  );
  const [shouldRecoverOnReconnect, setShouldRecoverOnReconnect] =
    createSignal(false);
  const [playerCurrentTime, setPlayerCurrentTime] = createSignal(0);
  const [playerDuration, setPlayerDuration] = createSignal(0);
  const [playerVolume, setPlayerVolume] = createSignal(1);
  const [playerMuted, setPlayerMuted] = createSignal(false);
  const [playerPaused, setPlayerPaused] = createSignal(true);
  const [playerWaiting, setPlayerWaiting] = createSignal(false);
  const [playerFullscreen, setPlayerFullscreen] = createSignal(false);
  const [isSubtitleMenuOpen, setIsSubtitleMenuOpen] = createSignal(false);
  const [showPlayerChrome, setShowPlayerChrome] = createSignal(true);
  const [pendingAutoPlaySource, setPendingAutoPlaySource] = createSignal("");
  const [lastAudibleVolume, setLastAudibleVolume] = createSignal(1);
  const [isSearchPopupOpen, setIsSearchPopupOpen] = createSignal(false);
  let player: TorrentPlayerElement | undefined;
  let playerSurface: HTMLDivElement | undefined;
  let torrentFileInput: HTMLInputElement | undefined;
  let subtitleMenuRef: HTMLDivElement | undefined;
  let networkNoticeTimeout: number | undefined;
  let playerChromeTimeout: number | undefined;

  const videoFiles = createMemo(
    () => metadata()?.files.filter((file) => file.isVideo) ?? [],
  );
  const subtitleFiles = createMemo(
    () => metadata()?.files.filter((file) => isSubtitleFile(file.name)) ?? [],
  );
  const selectedFile = createMemo(() =>
    metadata()?.files.find((file) => file.index === selectedFileIndex()),
  );
  const selectedSubtitleFile = createMemo(
    () =>
      metadata()?.files.find(
        (file) => file.index === selectedSubtitleIndex(),
      ) ?? null,
  );
  const visiblePlayerVolume = createMemo(() =>
    playerMuted() ? 0 : playerVolume(),
  );
  const selectedVideoSource = createMemo(() => {
    const source = videoSrc();
    const file = selectedFile();

    if (!source || !file) {
      return null;
    }

    return {
      src: source,
      type: inferVideoType(file.name),
    };
  });
  const shouldAutoPlaySelectedSource = createMemo(
    () => videoFiles().length === 1 && Boolean(selectedVideoSource()),
  );
  const playbackProgressPercent = createMemo(() => {
    const duration = playerDuration();
    if (duration <= 0) return 0;

    return Math.min(100, (playerCurrentTime() / duration) * 100);
  });

  async function recoverFromReconnect() {
    const infoHash = currentInfoHash();
    if (!infoHash) return;

    try {
      if (stats()?.state === "paused") {
        await invoke("resume_torrent", { infoHash });
      }

      if (videoSrc()) {
        retryStream();
      }
    } catch (invokeError) {
      setError(String(invokeError));
    }
  }

  function setTemporaryNetworkNotice(notice: NetworkNotice, durationMs = 4000) {
    if (networkNoticeTimeout) {
      window.clearTimeout(networkNoticeTimeout);
    }

    setNetworkNotice(notice);
    networkNoticeTimeout = window.setTimeout(() => {
      const latestStatus = networkStatus();
      if (latestStatus?.metered && !isNetworkUnavailable(latestStatus)) {
        setNetworkNotice({
          tone: "info",
          text: i18nStore.t("torrent.meteredWarning"),
        });
      } else {
        setNetworkNotice(null);
      }
    }, durationMs);
  }

  function handleNetworkStatusChange(status: AndroidNetworkStatus) {
    const hadOfflineNetwork = isNetworkUnavailable(networkStatus());
    const hasOfflineNetwork = isNetworkUnavailable(status);
    const hasActiveTorrent = Boolean(currentInfoHash());

    setNetworkStatus(status);

    if (hasOfflineNetwork) {
      if (hasActiveTorrent) {
        setShouldRecoverOnReconnect(true);
      }

      setNetworkNotice({
        tone: "warning",
        text: i18nStore.t("torrent.networkUnavailable"),
      });
      return;
    }

    if (hadOfflineNetwork && shouldRecoverOnReconnect() && hasActiveTorrent) {
      setShouldRecoverOnReconnect(false);
      setTemporaryNetworkNotice({
        tone: "success",
        text: status.metered
          ? i18nStore.t("torrent.networkRestoredMetered")
          : i18nStore.t("torrent.networkRestored"),
      });
      void recoverFromReconnect();
      return;
    }

    setShouldRecoverOnReconnect(false);
    setNetworkNotice(
      status.metered
        ? {
            tone: "info",
            text: i18nStore.t("torrent.meteredWarning"),
          }
        : null,
    );
  }

  async function handleStart() {
    const rawInput = magnet().trim();
    if (!isSupportedTorrentInput(rawInput)) {
      setError(i18nStore.t("torrent.invalidInput"));
      return;
    }

    await launchTorrent(async () =>
      invoke<string>("start_torrent", { magnetUri: rawInput }),
    );
  }

  async function handleSearchResultSelect(result: SearchResult) {
    // Set the magnet URL from the search result
    const url = result.url || (result.hash ? `magnet:?xt=urn:btih:${result.hash}` : "");
    if (!url) {
      setError(i18nStore.t("torrent.invalidInput"));
      return;
    }

    // Set the magnet input field
    setMagnet(url);

    // Start the torrent
    await launchTorrent(async () =>
      invoke<string>("start_torrent", { magnetUri: url }),
    );
  }

  async function launchTorrent(start: () => Promise<string>) {
    setIsSubmitting(true);
    setError(null);
    setMetadata(null);
    setStats(null);
    setVideoSrc("");
    setSelectedFileIndex(null);
    setSelectedSubtitleIndex(null);

    const previousInfoHash = currentInfoHash();
    if (previousInfoHash) {
      try {
        await invoke("stop_torrent", { infoHash: previousInfoHash });
      } catch {
        // Keep going and let the new torrent start.
      }
    }

    try {
      const infoHash = await start();
      setCurrentInfoHash(infoHash);
    } catch (invokeError) {
      setCurrentInfoHash(null);
      setError(String(invokeError));
    } finally {
      setIsSubmitting(false);
    }
  }

  async function handleTorrentFile(file: File) {
    if (!isTorrentFile(file)) {
      setError(i18nStore.t("torrent.invalidFile"));
      return;
    }

    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      setMagnet("");
      await launchTorrent(async () =>
        invoke<string>("start_torrent_file", {
          torrentBytes: Array.from(bytes),
        }),
      );
    } catch (dropError) {
      setError(String(dropError));
    }
  }

  async function handleTorrentDrop(event: DragEvent) {
    event.preventDefault();
    setIsDraggingTorrent(false);

    const file = event.dataTransfer?.files?.[0];
    if (!file) {
      return;
    }

    await handleTorrentFile(file);
  }

  async function handleTorrentFileSelection(event: Event) {
    const input = event.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) {
      return;
    }

    await handleTorrentFile(file);
    input.value = "";
  }

  async function handleSelectFile(infoHash: string, fileIndex: number) {
    setIsSelecting(true);
    setError(null);
    setExternalPlayerError(null);

    try {
      const url = await invoke<string>("select_torrent_file", {
        infoHash,
        fileIndex,
      });

      setSelectedFileIndex(fileIndex);
      setVideoSrc(url);

      // Detect if this file needs external player
      const file = metadata()?.files.find((f) => f.index === fileIndex);
      if (file) {
        const needsExternal = requiresExternalPlayer(file.name);
        setNeedsExternalPlayer(needsExternal);
        if (needsExternal) {
          console.log(`[Video] ${file.name} requires external player`);
        }
      } else {
        setNeedsExternalPlayer(false);
      }
    } catch (invokeError) {
      setError(String(invokeError));
      setNeedsExternalPlayer(false);
    } finally {
      setIsSelecting(false);
    }
  }

  async function handlePause() {
    const infoHash = currentInfoHash();
    if (!infoHash) return;

    try {
      await invoke("pause_torrent", { infoHash });
    } catch (invokeError) {
      setError(String(invokeError));
    }
  }

  async function handleResume() {
    const infoHash = currentInfoHash();
    if (!infoHash) return;

    try {
      await invoke("resume_torrent", { infoHash });
    } catch (invokeError) {
      setError(String(invokeError));
    }
  }

  async function handleStop() {
    const infoHash = currentInfoHash();
    if (!infoHash) return;

    try {
      await invoke("stop_torrent", { infoHash });
      setCurrentInfoHash(null);
      setMetadata(null);
      setStats(null);
      setVideoSrc("");
      setSelectedFileIndex(null);
      setSelectedSubtitleIndex(null);
      setNeedsExternalPlayer(false);
      setExternalPlayerError(null);
    } catch (invokeError) {
      setError(String(invokeError));
    }
  }

  function retryStream() {
    const source = videoSrc();
    if (!source) return;

    setVideoSrc("");
    window.setTimeout(() => setVideoSrc(source), 100);
  }

  async function handleOpenExternalPlayer() {
    const source = videoSrc();
    const file = selectedFile();
    if (!source || !file) {
      setExternalPlayerError(i18nStore.t("player.noStreamAvailable"));
      return;
    }

    const result = await openWithNativePlayer(source, file.name);
    if (!result.success) {
      setExternalPlayerError(result.error || i18nStore.t("player.noPlayerFound"));
    } else {
      // Clear any previous error
      setExternalPlayerError(null);
    }
  }

  async function handleCopyStreamUrl() {
    const source = videoSrc();
    if (!source) {
      setExternalPlayerError(i18nStore.t("player.noStreamAvailable"));
      return;
    }

    const success = await copyStreamUrl(source);
    if (!success) {
      setExternalPlayerError(i18nStore.t("player.copyFailed"));
    }
  }

  function syncPlayerState(playerElement: TorrentPlayerElement) {
    const duration =
      Number.isFinite(playerElement.duration) && playerElement.duration > 0
        ? playerElement.duration
        : 0;
    const currentTime = Number.isFinite(playerElement.currentTime)
      ? Math.min(
          Math.max(playerElement.currentTime, 0),
          duration || playerElement.currentTime,
        )
      : 0;
    const volume = Math.min(Math.max(playerElement.volume ?? 1, 0), 1);

    if (volume > 0) {
      setLastAudibleVolume(volume);
    }

    setPlayerDuration(duration);
    setPlayerCurrentTime(currentTime);
    setPlayerVolume(volume);
    setPlayerMuted(Boolean(playerElement.muted));
    setPlayerPaused(Boolean(playerElement.paused));
    setPlayerWaiting(Boolean(playerElement.waiting));
  }

  function resetPlayerState() {
    setPlayerCurrentTime(0);
    setPlayerDuration(0);
    setPlayerVolume(1);
    setPlayerMuted(false);
    setPlayerPaused(true);
    setPlayerWaiting(false);
    setPlayerFullscreen(false);
  }

  async function handleTogglePlayback() {
    const playerElement = player;
    if (!playerElement) return;

    try {
      if (playerElement.paused) {
        await playerElement.play();
      } else {
        await playerElement.pause();
      }
    } catch (playbackError) {
      setError(String(playbackError));
    }
  }

  function handleSeek(event: Event) {
    const playerElement = player;
    if (!playerElement) return;

    const nextTime = Number((event.currentTarget as HTMLInputElement).value);
    playerElement.currentTime = nextTime;
    setPlayerCurrentTime(nextTime);
  }

  function handleVolumeChange(event: Event) {
    const playerElement = player;
    if (!playerElement) return;

    const nextVolume =
      Number((event.currentTarget as HTMLInputElement).value) / 100;

    if (nextVolume > 0) {
      setLastAudibleVolume(nextVolume);
    }

    playerElement.volume = nextVolume;
    playerElement.muted = nextVolume === 0;

    setPlayerVolume(nextVolume);
    setPlayerMuted(nextVolume === 0);
  }

  function handleToggleMute() {
    const playerElement = player;
    if (!playerElement) return;

    if (playerElement.muted || playerElement.volume === 0) {
      const restoredVolume = Math.max(lastAudibleVolume(), 0.1);
      playerElement.volume = restoredVolume;
      playerElement.muted = false;
    } else {
      playerElement.muted = true;
    }

    syncPlayerState(playerElement);
  }

  function handleSelectSubtitle(subtitleIndex: number | null) {
    setSelectedSubtitleIndex(subtitleIndex);
    setIsSubtitleMenuOpen(false);
  }

  function clearPlayerChromeTimeout() {
    if (playerChromeTimeout) {
      window.clearTimeout(playerChromeTimeout);
      playerChromeTimeout = undefined;
    }
  }

  function schedulePlayerChromeHide(delayMs = 2200) {
    clearPlayerChromeTimeout();

    if (
      !videoSrc() ||
      playerPaused() ||
      playerWaiting() ||
      isSubtitleMenuOpen()
    ) {
      setShowPlayerChrome(true);
      return;
    }

    playerChromeTimeout = window.setTimeout(() => {
      if (!playerPaused() && !playerWaiting() && !isSubtitleMenuOpen()) {
        setShowPlayerChrome(false);
      }
    }, delayMs);
  }

  function revealPlayerChrome(delayMs = 2200) {
    setShowPlayerChrome(true);
    schedulePlayerChromeHide(delayMs);
  }

  async function syncPlaybackOrientation(isFullscreen: boolean) {
    if (syncAndroidPlaybackOrientation(isFullscreen)) {
      return;
    }

    const orientation = globalThis.screen?.orientation;
    if (!orientation?.lock) {
      return;
    }

    try {
      await orientation.lock(isFullscreen ? "landscape" : "portrait");
    } catch (orientationError) {
      console.warn("Failed to update playback orientation", orientationError);
    }
  }

  async function handleToggleFullscreen() {
    setPlayerFullscreen((value) => !value);
    revealPlayerChrome(3200);
  }

  function handleToggleSubtitleMenu() {
    if (subtitleFiles().length === 0) return;
    setIsSubtitleMenuOpen((open) => !open);
  }

  function handlePlayerSurfaceInteract() {
    if (!videoSrc()) return;
    revealPlayerChrome();
  }

  function applySubtitleMode(
    playerElement: TorrentPlayerElement,
    subtitleIndex: number | null,
  ) {
    const tracks = playerElement.textTracks.getByKind([
      "subtitles",
      "captions",
    ]);

    for (const track of tracks) {
      track.mode =
        track.id === `torrent-subtitle-${subtitleIndex}`
          ? "showing"
          : "disabled";
    }
  }

  createEffect(() => {
    const playerElement = player;
    const source = selectedVideoSource();

    if (!playerElement) return;

    playerElement.src = source ?? "";
  });

  createEffect(() => {
    const source = selectedVideoSource()?.src ?? "";

    if (!source || !shouldAutoPlaySelectedSource()) {
      setPendingAutoPlaySource("");
      return;
    }

    setPendingAutoPlaySource(source);
  });

  createEffect(() => {
    const playerElement = player;

    if (!playerElement) return;

    const sync = () => syncPlayerState(playerElement);
    const handleWaiting = () => setPlayerWaiting(true);
    const handlePlaying = () => {
      setPlayerWaiting(false);
      syncPlayerState(playerElement);
    };
    const handlePause = () => {
      setPlayerPaused(true);
      syncPlayerState(playerElement);
    };
    const handleReadyToAutoPlay = () => {
      const currentSource = selectedVideoSource()?.src ?? "";

      if (
        player !== playerElement ||
        !currentSource ||
        pendingAutoPlaySource() !== currentSource ||
        !shouldAutoPlaySelectedSource()
      ) {
        return;
      }

      setPendingAutoPlaySource("");
      queueMicrotask(() => {
        if (player === playerElement) {
          void playerElement.play().catch((playbackError) => {
            setError(String(playbackError));
          });
        }
      });
    };
    const mediaSyncEvents = [
      "can-play",
      "canplay",
      "duration-change",
      "durationchange",
      "loadedmetadata",
      "time-update",
      "timeupdate",
      "seeking",
      "seeked",
      "volume-change",
      "volumechange",
    ] as const;
    const playingEvents = ["play", "playing"] as const;
    const pauseEvents = ["pause", "ended"] as const;

    sync();

    for (const eventName of mediaSyncEvents) {
      playerElement.addEventListener(eventName, sync);
    }
    for (const eventName of playingEvents) {
      playerElement.addEventListener(eventName, handlePlaying);
    }
    for (const eventName of pauseEvents) {
      playerElement.addEventListener(eventName, handlePause);
    }
    playerElement.addEventListener("waiting", handleWaiting);
    playerElement.addEventListener("can-play", handleReadyToAutoPlay);
    playerElement.addEventListener("canplay", handleReadyToAutoPlay);
    playerElement.addEventListener("loadedmetadata", handleReadyToAutoPlay);

    onCleanup(() => {
      for (const eventName of mediaSyncEvents) {
        playerElement.removeEventListener(eventName, sync);
      }
      for (const eventName of playingEvents) {
        playerElement.removeEventListener(eventName, handlePlaying);
      }
      for (const eventName of pauseEvents) {
        playerElement.removeEventListener(eventName, handlePause);
      }
      playerElement.removeEventListener("waiting", handleWaiting);
      playerElement.removeEventListener("can-play", handleReadyToAutoPlay);
      playerElement.removeEventListener("canplay", handleReadyToAutoPlay);
      playerElement.removeEventListener(
        "loadedmetadata",
        handleReadyToAutoPlay,
      );
    });
  });

  createEffect(() => {
    const playerElement = player;
    const source = videoSrc();

    if (!playerElement || !source) return;

    syncPlayerState(playerElement);

    const intervalId = window.setInterval(() => {
      if (player === playerElement && videoSrc() === source) {
        syncPlayerState(playerElement);
      }
    }, 250);

    onCleanup(() => {
      window.clearInterval(intervalId);
    });
  });

  createEffect(() => {
    const playerElement = player;
    const source = videoSrc();
    const subtitleTrackFiles = subtitleFiles();

    if (!playerElement) return;

    playerElement.textTracks.clear();

    if (!source || subtitleTrackFiles.length === 0) return;

    for (const file of subtitleTrackFiles) {
      playerElement.textTracks.add({
        id: `torrent-subtitle-${file.index}`,
        kind: "subtitles",
        label: createSubtitleLabel(file),
        language: inferSubtitleLanguage(file.name),
        src: buildSiblingStreamUrl(source, file.index),
        type: inferSubtitleType(file.name),
      });
    }

    queueMicrotask(() => {
      if (playerElement === player) {
        applySubtitleMode(playerElement, selectedSubtitleIndex());
      }
    });
  });

  createEffect(() => {
    const playerElement = player;
    const subtitleIndex = selectedSubtitleIndex();

    if (!playerElement) return;

    queueMicrotask(() => {
      if (playerElement === player) {
        applySubtitleMode(playerElement, subtitleIndex);
      }
    });
  });

  createEffect(() => {
    const infoHash = currentInfoHash();
    const file = selectedFile();
    const currentStats = stats();

    if (!infoHash || !file) {
      syncAndroidForegroundSession(null);
      return;
    }

    syncAndroidForegroundSession({
      title: file.name,
      state: currentStats?.state ?? "parsing",
      progressPercent: currentStats?.progressPercent ?? 0,
      downloadSpeedKbps: currentStats?.downloadSpeedKbps ?? 0,
      uploadSpeedKbps: currentStats?.uploadSpeedKbps ?? 0,
      peersConnected: currentStats?.peersConnected ?? 0,
      isPlaying: Boolean(videoSrc()),
    });
  });

  createEffect(() => {
    if (!videoSrc()) {
      resetPlayerState();
    }
  });

  createEffect(() => {
    const source = videoSrc();
    const paused = playerPaused();
    const waiting = playerWaiting();
    const subtitleMenuOpen = isSubtitleMenuOpen();

    if (!source) {
      clearPlayerChromeTimeout();
      setShowPlayerChrome(true);
      return;
    }

    if (paused || waiting || subtitleMenuOpen) {
      clearPlayerChromeTimeout();
      setShowPlayerChrome(true);
      return;
    }

    schedulePlayerChromeHide();
  });

  createEffect(() => {
    if (playerFullscreen()) {
      document.body.style.overflow = "hidden";
    } else {
      document.body.style.overflow = "";
    }

    onCleanup(() => {
      document.body.style.overflow = "";
    });
  });

  let previousFullscreen = playerFullscreen();
  createEffect(() => {
    const fullscreen = playerFullscreen();

    if (fullscreen === previousFullscreen) {
      return;
    }

    previousFullscreen = fullscreen;
    void syncPlaybackOrientation(fullscreen);
  });

  onCleanup(() => {
    void syncPlaybackOrientation(false);
  });

  createEffect(() => {
    if (!videoSrc() || subtitleFiles().length === 0) {
      setIsSubtitleMenuOpen(false);
    }
  });

  createEffect(() => {
    if (!isSubtitleMenuOpen()) return;

    const handlePointerDown = (event: PointerEvent) => {
      const menu = subtitleMenuRef;
      if (!menu) return;

      if (!event.composedPath().includes(menu)) {
        setIsSubtitleMenuOpen(false);
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setIsSubtitleMenuOpen(false);
      }
    };

    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);

    onCleanup(() => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    });
  });

  onMount(async () => {
    // Register built-in public torrent search sources (TPB, Knaben, YTS, EZTV, Nyaa, etc.)
    initializeSources();

    const stopTick = await listen<TorrentTickPayload>(
      "torrent-tick",
      (event) => {
        if (event.payload.infoHash === currentInfoHash()) {
          setStats(event.payload);
        }
      },
    );

    const stopMetadata = await listen<TorrentMetadataPayload>(
      "torrent-metadata-ready",
      (event) => {
        setMetadata(event.payload);
        setCurrentInfoHash(event.payload.infoHash);
        setSelectedSubtitleIndex(null);

        const nextDefaultFile =
          event.payload.files.find((file) => file.isVideo) ??
          event.payload.files[0];

        if (nextDefaultFile) {
          void handleSelectFile(event.payload.infoHash, nextDefaultFile.index);
        }
      },
    );

    const nativeNetwork = hasAndroidBridge();
    const stopAndroidNetwork = nativeNetwork
      ? listenToAndroidNetworkStatus(handleNetworkStatusChange)
      : () => {};
    const syncBrowserNetwork = () =>
      handleNetworkStatusChange(fallbackNetworkStatus());

    if (nativeNetwork) {
      handleNetworkStatusChange(
        getAndroidNetworkStatus() ?? fallbackNetworkStatus(),
      );
    } else {
      syncBrowserNetwork();
      window.addEventListener("online", syncBrowserNetwork);
      window.addEventListener("offline", syncBrowserNetwork);
    }

    onCleanup(() => {
      if (!nativeNetwork) {
        window.removeEventListener("online", syncBrowserNetwork);
        window.removeEventListener("offline", syncBrowserNetwork);
      }
      if (networkNoticeTimeout) {
        window.clearTimeout(networkNoticeTimeout);
      }
      clearPlayerChromeTimeout();
      stopAndroidNetwork();
      syncAndroidForegroundSession(null);
      void stopTick();
      void stopMetadata();
    });
  });

  return (
    <div class="mx-auto flex min-h-screen w-full flex-col bg-slate-950 text-white">
      <Show when={!playerFullscreen()}>
        <header class="border-b border-white/10 bg-slate-950/90 px-4 pb-4 backdrop-blur">
          <div class="flex items-center justify-between pt-4">
            <p class="text-xs uppercase tracking-[0.28em] text-sky-400">
              WebTorrentPlayer
            </p>
            <div class="flex items-center gap-2">
              <button
                type="button"
                class="rounded-xl border border-white/10 bg-white/5 p-2 text-slate-300 transition hover:bg-white/10"
                onClick={() => setIsSearchPopupOpen(true)}
                aria-label="Search torrents"
              >
                <Search class="h-4 w-4" />
              </button>
              <button
                type="button"
                class="rounded-xl border border-white/10 bg-white/5 px-2 py-1 text-xs text-slate-300 transition hover:bg-white/10"
                onClick={() =>
                  i18nStore.setLocale(
                    i18nStore.locale() === "en" ? "zh-CN" : "en",
                  )
                }
              >
                {i18nStore.locale() === "en" ? "中文" : "EN"}
              </button>
            </div>
          </div>

          <div
            class={`mt-4 rounded-[1.5rem] border border-dashed p-2 transition ${
              isDraggingTorrent()
                ? "border-sky-400 bg-sky-500/10"
                : "border-white/10 bg-slate-900/30"
            }`}
            onDragEnter={(event) => {
              if (hasDraggedFiles(event)) {
                setIsDraggingTorrent(true);
              }
            }}
            onDragOver={(event) => {
              if (hasDraggedFiles(event)) {
                event.preventDefault();
                event.dataTransfer!.dropEffect = "copy";
                setIsDraggingTorrent(true);
              }
            }}
            onDragLeave={() => setIsDraggingTorrent(false)}
            onDrop={(event) => void handleTorrentDrop(event)}
          >
            <div class="flex items-center gap-2">
              <input
                class="min-w-0 flex-1 rounded-2xl border border-white/10 bg-slate-900 px-4 py-3 text-sm text-white outline-none transition focus:border-sky-400"
                placeholder={i18nStore.t("torrent.pasteMagnetHint")}
                value={magnet()}
                onInput={(event) => setMagnet(event.currentTarget.value)}
                onKeyDown={(event) =>
                  event.key === "Enter" && void handleStart()
                }
              />
              <button
                type="button"
                class="inline-flex h-12 w-12 items-center justify-center rounded-2xl bg-sky-500 text-slate-950 transition hover:bg-sky-400 disabled:cursor-not-allowed disabled:opacity-60"
                onClick={() => void handleStart()}
                disabled={isSubmitting()}
                aria-label="Start torrent"
              >
                <Show
                  when={isSubmitting()}
                  fallback={<Play class="h-5 w-5 fill-current" />}
                >
                  <LoaderCircle class="h-5 w-5 animate-spin" />
                </Show>
              </button>
            </div>

            <div class="mt-2 flex items-center justify-between gap-2">
              <p class="text-xs text-slate-400">
                {i18nStore.t("torrent.supportsMagnet")}
              </p>
              <button
                type="button"
                class="inline-flex items-center shrink-0 gap-2 rounded-2xl border border-white/10 bg-white/5 px-3 py-2 text-sm text-slate-200 transition hover:bg-white/10 disabled:opacity-60"
                onClick={() => torrentFileInput?.click()}
                disabled={isSubmitting()}
              >
                <FileUp class="h-4 w-4" />
                {i18nStore.t("common.selectFile")}
              </button>
              <input
                ref={torrentFileInput}
                type="file"
                accept=".torrent,application/x-bittorrent"
                class="hidden"
                onChange={(event) => void handleTorrentFileSelection(event)}
              />
            </div>
          </div>

          <Show when={isDraggingTorrent()}>
            <p class="mt-2 text-xs text-sky-300">
              {i18nStore.t("torrent.dragToImport")}
            </p>
          </Show>

          <Show when={error()}>
            <div class="mt-3 rounded-2xl border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-200">
              {error()}
            </div>
          </Show>

          <Show when={networkNotice()}>
            <div
              class={`mt-3 rounded-2xl px-3 py-2 text-sm ${
                networkNotice()?.tone === "warning"
                  ? "border border-amber-500/30 bg-amber-500/10 text-amber-100"
                  : networkNotice()?.tone === "success"
                    ? "border border-emerald-500/30 bg-emerald-500/10 text-emerald-100"
                    : "border border-sky-500/30 bg-sky-500/10 text-sky-100"
              }`}
            >
              {networkNotice()?.text}
            </div>
          </Show>
        </header>
      </Show>

      <main
        class={`flex flex-1 flex-col ${playerFullscreen() ? "" : "gap-4 px-4 py-4"}`}
      >
        <section
          class={`overflow-hidden bg-black shadow-2xl shadow-black/30 ${
            playerFullscreen()
              ? "fixed inset-0 z-40 rounded-none border-0"
              : "player-sticky-top sticky z-30 rounded-xl border border-white/10"
          }`}
        >
          <div
            ref={playerSurface}
            class={`relative bg-gradient-to-br from-slate-900 to-black ${
              playerFullscreen() ? "h-full w-full" : "aspect-video w-full"
            }`}
            onPointerDown={handlePlayerSurfaceInteract}
            onPointerMove={handlePlayerSurfaceInteract}
          >
            <media-player
              ref={(element) => {
                player = element as TorrentPlayerElement;
              }}
              title={selectedFile()?.name ?? "P2P Stream"}
              class="h-full w-full"
              autoplay
              playsinline
              crossorigin
            >
              <media-provider />
            </media-player>

            {/* External Player Overlay */}
            <Show when={needsExternalPlayer() && videoSrc()}>
              <div class="absolute inset-0 z-20 flex flex-col items-center justify-center bg-slate-950/95 backdrop-blur-sm">
                <div class="flex max-w-md flex-col items-center gap-5 p-6 text-center">
                  <div class="flex h-16 w-16 items-center justify-center rounded-full bg-amber-500/20 text-amber-400">
                    <svg
                      xmlns="http://www.w3.org/2000/svg"
                      width="32"
                      height="32"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      stroke-width="2"
                      stroke-linecap="round"
                      stroke-linejoin="round"
                    >
                      <path d="m12 8-9.04 9.06a2.82 2.82 0 1 0 3.98 3.98L16 12" />
                      <circle cx="17" cy="7" r="5" />
                    </svg>
                  </div>
                  <div>
                    <h3 class="text-lg font-semibold text-white">
                      {i18nStore.t("player.externalPlayerTitle")}
                    </h3>
                    <p class="mt-2 text-sm text-slate-400">
                      {i18nStore.t("player.externalPlayerDesc")}
                    </p>
                    <p class="mt-1 text-xs text-slate-500">
                      {i18nStore.t("player.recommendedPlayers")}:{" "}
                      {getRecommendedPlayers().join(", ")}
                    </p>
                  </div>
                  <Show when={externalPlayerError()}>
                    <div class="w-full rounded-xl border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-200">
                      {externalPlayerError()}
                    </div>
                  </Show>
                  <div class="flex w-full flex-col gap-2">
                    <button
                      type="button"
                      class="inline-flex w-full items-center justify-center gap-2 rounded-xl bg-sky-500 px-4 py-3 text-sm font-medium text-white transition hover:bg-sky-600"
                      onClick={() => void handleOpenExternalPlayer()}
                    >
                      <svg
                        xmlns="http://www.w3.org/2000/svg"
                        width="16"
                        height="16"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        stroke-width="2"
                        stroke-linecap="round"
                        stroke-linejoin="round"
                      >
                        <polygon points="5 3 19 12 5 21 5 3" />
                      </svg>
                      {i18nStore.t("player.openWithSystemPlayer")}
                    </button>
                    <button
                      type="button"
                      class="inline-flex w-full items-center justify-center gap-2 rounded-xl border border-white/10 bg-white/5 px-4 py-3 text-sm font-medium text-slate-300 transition hover:bg-white/10"
                      onClick={() => void handleCopyStreamUrl()}
                    >
                      <svg
                        xmlns="http://www.w3.org/2000/svg"
                        width="16"
                        height="16"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        stroke-width="2"
                        stroke-linecap="round"
                        stroke-linejoin="round"
                      >
                        <rect
                          width="14"
                          height="14"
                          x="8"
                          y="8"
                          rx="2"
                          ry="2"
                        />
                        <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />
                      </svg>
                      {i18nStore.t("player.copyStreamUrl")}
                    </button>
                  </div>
                </div>
              </div>
            </Show>

            <Show when={!videoSrc()}>
              <div class="absolute inset-0 flex items-center justify-center bg-gradient-to-br from-slate-900 to-black text-slate-500">
                <div class="flex flex-col items-center justify-center gap-3">
                  <Video class="h-10 w-10" />
                  <div class="text-center">
                    <p class="text-sm font-medium text-slate-300">
                      {i18nStore.t("player.waitingForFile")}
                    </p>
                    <p class="mt-1 text-xs text-slate-500">
                      {metadata()
                        ? i18nStore.t("player.selectOrWait")
                        : i18nStore.t("player.enterMagnetLink")}
                    </p>
                  </div>
                </div>
              </div>
            </Show>
            <Show when={videoSrc()}>
              <div
                class={`absolute inset-0 z-10 flex flex-col justify-between transition-opacity duration-300 ${
                  showPlayerChrome()
                    ? "pointer-events-auto opacity-100"
                    : "pointer-events-none opacity-0"
                }`}
              >
                <div
                  class="flex items-start justify-between bg-gradient-to-b from-black/70 via-black/20 to-transparent px-4 py-3"
                  onPointerDown={(event) => event.stopPropagation()}
                >
                  <div class="min-w-0 flex-1" />
                  <p class="mx-3 truncate text-center text-xs font-medium text-white/90">
                    {selectedFile()?.name}
                  </p>
                  <button
                    type="button"
                    class="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-white/10 bg-black/30 text-slate-200 backdrop-blur transition hover:bg-black/50"
                    onClick={retryStream}
                    aria-label="Retry stream"
                  >
                    <RefreshCcw class="h-4 w-4" />
                  </button>
                </div>

                <div
                  class="px-4 py-2"
                  onPointerDown={(event) => event.stopPropagation()}
                >
                  <div class="mb-3 flex items-center justify-between gap-3 text-[11px] text-slate-300">
                    <span>
                      {playerWaiting()
                        ? i18nStore.t("player.buffering")
                        : playerPaused()
                          ? i18nStore.t("player.paused")
                          : i18nStore.t("player.playing")}
                    </span>
                    <span>
                      {formatPlaybackTime(playerCurrentTime())} /{" "}
                      {formatPlaybackTime(playerDuration())}
                    </span>
                  </div>

                  <div class="relative mt-2 h-4">
                    <div class="absolute inset-x-0 top-1/2 h-1.5 -translate-y-1/2 overflow-hidden rounded-full bg-white/10">
                      <div
                        class="h-full rounded-full bg-white/25 transition-all"
                        style={{ width: `${stats()?.progressPercent ?? 0}%` }}
                      />
                    </div>
                    <div
                      class="absolute inset-y-0 left-0 top-1/2 h-1.5 -translate-y-1/2 rounded-full bg-sky-400 transition-all"
                      style={{ width: `${playbackProgressPercent()}%` }}
                    />
                    <div
                      class="absolute top-1/2 h-3 w-3 -translate-y-1/2 rounded-full bg-sky-300 shadow-[0_0_0_2px_rgba(15,23,42,0.6)] transition-all"
                      style={{
                        left: `clamp(0px, calc(${playbackProgressPercent()}% - 6px), calc(100% - 12px))`,
                      }}
                    />
                    <input
                      type="range"
                      min="0"
                      max={Math.max(playerDuration(), 0)}
                      step="0.1"
                      value={Math.min(
                        playerCurrentTime(),
                        playerDuration() || 0,
                      )}
                      class="absolute inset-0 z-10 h-full w-full cursor-pointer opacity-0 disabled:cursor-not-allowed"
                      onInput={handleSeek}
                      onPointerDown={() => revealPlayerChrome(3200)}
                      disabled={playerDuration() <= 0}
                    />
                  </div>
                  <div class="relative mt-4 flex items-center gap-3">
                    <button
                      type="button"
                      class="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-white text-slate-950 transition hover:bg-slate-200 disabled:cursor-not-allowed disabled:opacity-60"
                      onClick={() => {
                        revealPlayerChrome(3200);
                        void handleTogglePlayback();
                      }}
                      disabled={!selectedVideoSource()}
                      aria-label={
                        playerPaused()
                          ? i18nStore.t("player.play")
                          : i18nStore.t("player.pause")
                      }
                    >
                      <Show
                        when={playerPaused()}
                        fallback={<Pause class="h-4 w-4 fill-current" />}
                      >
                        <Play class="h-4 w-4 fill-current" />
                      </Show>
                    </button>

                    <button
                      type="button"
                      class="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-white/10 bg-white/10 text-slate-200 transition hover:bg-white/20"
                      onClick={() => {
                        revealPlayerChrome(3200);
                        handleToggleMute();
                      }}
                      aria-label={
                        playerMuted()
                          ? i18nStore.t("player.unmute")
                          : i18nStore.t("player.mute")
                      }
                    >
                      <Show
                        when={playerMuted() || visiblePlayerVolume() === 0}
                        fallback={<Volume2 class="h-3.5 w-3.5" />}
                      >
                        <VolumeX class="h-3.5 w-3.5" />
                      </Show>
                    </button>

                    <div class="flex flex-1 items-center gap-3">
                      <input
                        type="range"
                        min="0"
                        max="100"
                        step="1"
                        value={Math.round(visiblePlayerVolume() * 100)}
                        class="h-1.5 w-full cursor-pointer accent-sky-400"
                        onInput={(event) => {
                          revealPlayerChrome(3200);
                          handleVolumeChange(event);
                        }}
                        aria-label={i18nStore.t("player.volume")}
                      />
                      <span class="w-10 shrink-0 text-right text-[10px] text-slate-300">
                        {Math.round(visiblePlayerVolume() * 100)}%
                      </span>
                    </div>

                    <div ref={subtitleMenuRef} class="relative shrink-0">
                      <button
                        type="button"
                        class={`inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full border text-slate-200 transition disabled:cursor-not-allowed disabled:opacity-60 ${
                          isSubtitleMenuOpen() || selectedSubtitleFile()
                            ? "border-sky-400/50 bg-sky-500/20 text-sky-100 hover:bg-sky-500/30"
                            : "border-white/10 bg-white/10 hover:bg-white/20"
                        }`}
                        onClick={() => {
                          revealPlayerChrome(3200);
                          handleToggleSubtitleMenu();
                        }}
                        disabled={subtitleFiles().length === 0}
                        aria-label={
                          selectedSubtitleFile()
                            ? i18nStore.t("player.toggleSubtitles")
                            : i18nStore.t("player.openSubtitleMenu")
                        }
                        aria-haspopup="menu"
                        aria-expanded={isSubtitleMenuOpen()}
                      >
                        <Captions class="h-3.5 w-3.5" />
                      </button>

                      <Show when={isSubtitleMenuOpen()}>
                        <div class="absolute bottom-full right-0 z-10 mb-3 w-56 overflow-hidden rounded-2xl border border-white/10 bg-slate-950/95 shadow-2xl shadow-black/40 backdrop-blur">
                          <div class="border-b border-white/10 px-4 py-3">
                            <p class="text-xs uppercase tracking-[0.2em] text-slate-500">
                              {i18nStore.t("player.subtitleTrack")}
                            </p>
                            <p class="mt-1 text-sm text-slate-300">
                              {selectedSubtitleFile()?.name ??
                                i18nStore.t("player.subtitlesOff")}
                            </p>
                          </div>
                          <div class="max-h-64 overflow-y-auto p-2">
                            <button
                              type="button"
                              class={`flex w-full items-center justify-between rounded-xl px-3 py-3 text-left text-sm transition ${
                                selectedSubtitleIndex() === null
                                  ? "bg-sky-500/15 text-sky-100"
                                  : "text-slate-200 hover:bg-white/5"
                              }`}
                              onClick={() => handleSelectSubtitle(null)}
                            >
                              <span>
                                {i18nStore.t("player.turnOffSubtitles")}
                              </span>
                              <Show when={selectedSubtitleIndex() === null}>
                                <span class="text-xs text-sky-300">
                                  {i18nStore.t("player.current")}
                                </span>
                              </Show>
                            </button>
                            <For each={subtitleFiles()}>
                              {(file) => (
                                <button
                                  type="button"
                                  class={`mt-1 flex w-full items-center justify-between gap-3 rounded-xl px-3 py-3 text-left text-sm transition ${
                                    selectedSubtitleIndex() === file.index
                                      ? "bg-sky-500/15 text-sky-100"
                                      : "text-slate-200 hover:bg-white/5"
                                  }`}
                                  onClick={() =>
                                    handleSelectSubtitle(file.index)
                                  }
                                >
                                  <span class="min-w-0 flex-1 truncate">
                                    {createSubtitleLabel(file)}
                                  </span>
                                  <Show
                                    when={
                                      selectedSubtitleIndex() === file.index
                                    }
                                  >
                                    <span class="shrink-0 text-xs text-sky-300">
                                      {i18nStore.t("player.current")}
                                    </span>
                                  </Show>
                                </button>
                              )}
                            </For>
                          </div>
                        </div>
                      </Show>
                    </div>

                    <button
                      type="button"
                      class="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-white/10 bg-white/10 text-slate-200 transition hover:bg-white/20 disabled:cursor-not-allowed disabled:opacity-60"
                      onClick={() => {
                        revealPlayerChrome(3200);
                        void handleToggleFullscreen();
                      }}
                      disabled={!selectedVideoSource()}
                      aria-label={
                        playerFullscreen()
                          ? i18nStore.t("player.exitFullscreen")
                          : i18nStore.t("player.enterFullscreen")
                      }
                    >
                      <Show
                        when={playerFullscreen()}
                        fallback={<Maximize class="h-3.5 w-3.5" />}
                      >
                        <Minimize class="h-3.5 w-3.5" />
                      </Show>
                    </button>
                  </div>
                </div>
              </div>
            </Show>
          </div>
        </section>

        <Show when={!playerFullscreen()}>
          <section class="rounded-3xl border border-white/10 bg-slate-900/80 p-4">
            <div class="flex items-center justify-between gap-3">
              <div>
                <p class="text-xs uppercase tracking-[0.2em] text-slate-400">
                  {i18nStore.t("player.mediaFile")}
                </p>
                <h2 class="mt-1 text-base font-semibold">
                  <Show
                    when={videoFiles().length > 0}
                    fallback={i18nStore.t("player.waitingForMetadata")}
                  >
                    {i18nStore.t("player.playableFiles")}
                  </Show>
                </h2>
              </div>
              <Show when={isSelecting()}>
                <LoaderCircle class="h-4 w-4 animate-spin text-sky-400" />
              </Show>
            </div>

            <div class="mt-4 space-y-2">
              <Show
                when={metadata()}
                fallback={
                  <p class="text-sm text-slate-500">
                    {i18nStore.t("player.metadataHint")}
                  </p>
                }
              >
                <For each={metadata()?.files ?? []}>
                  {(file) => {
                    const isSelected = () => selectedFileIndex() === file.index;

                    return (
                      <button
                        type="button"
                        class={`flex w-full items-start justify-between rounded-2xl border px-3 py-3 text-left transition ${
                          isSelected()
                            ? "border-sky-400 bg-sky-500/10"
                            : "border-white/8 bg-white/5 hover:bg-white/10"
                        } ${file.isVideo ? "" : "opacity-60"}`}
                        onClick={() =>
                          file.isVideo && currentInfoHash()
                            ? void handleSelectFile(
                                currentInfoHash()!,
                                file.index,
                              )
                            : undefined
                        }
                        disabled={!file.isVideo || isSelecting()}
                      >
                        <div class="min-w-0">
                          <p class="truncate text-sm font-medium text-white">
                            {file.name}
                          </p>
                          <div class="mt-1 flex items-center gap-2 text-xs text-slate-400">
                            <span>{formatBytes(file.sizeBytes)}</span>
                            <span>#{file.index}</span>
                            <span
                              class={`ml-auto shrink-0 rounded-full px-2 py-1 text-[11px] ${
                                file.isVideo
                                  ? "bg-emerald-500/15 text-emerald-300"
                                  : "bg-slate-700 text-slate-300"
                              }`}
                            >
                              {file.isVideo
                                ? i18nStore.t("player.video")
                                : i18nStore.t("player.nonVideo")}
                            </span>
                            <Show
                              when={
                                file.isVideo &&
                                requiresExternalPlayer(file.name)
                              }
                            >
                              <span class="shrink-0 rounded-full bg-amber-500/15 px-2 py-1 text-[11px] text-amber-300">
                                {i18nStore.t("player.requiresExternalPlayer")}
                              </span>
                            </Show>
                          </div>
                        </div>
                      </button>
                    );
                  }}
                </For>
              </Show>
            </div>
          </section>

          <section class="grid grid-cols-2 gap-3">
            <div class="rounded-3xl border border-white/10 bg-slate-900/80 p-4">
              <div class="flex items-center gap-2 text-sky-400">
                <Download class="h-4 w-4" />
                <span class="text-xs uppercase tracking-[0.2em]">
                  {i18nStore.t("common.downloadSpeed")}
                </span>
              </div>
              <p class="mt-3 text-lg font-semibold">
                {formatSpeed(stats()?.downloadSpeedKbps ?? 0)}
              </p>
            </div>

            <div class="rounded-3xl border border-white/10 bg-slate-900/80 p-4">
              <div class="flex items-center gap-2 text-emerald-400">
                <Wifi class="h-4 w-4" />
                <span class="text-xs uppercase tracking-[0.2em]">Peers</span>
              </div>
              <p class="mt-3 text-lg font-semibold">
                {stats()?.peersConnected ?? 0}
              </p>
            </div>
          </section>

          <section class="rounded-3xl border border-white/10 bg-slate-900/80 p-4">
            <div class="flex items-center justify-between gap-4">
              <div>
                <p class="text-xs uppercase tracking-[0.2em] text-slate-400">
                  {i18nStore.t("common.status")}
                </p>
                <p class="mt-2 text-lg font-semibold">
                  {stateLabel(stats()?.state)}
                </p>
                <p class="mt-1 text-xs text-slate-400">
                  {i18nStore.t("common.network")}:{" "}
                  {formatNetworkLabel(networkStatus())}
                </p>
              </div>
              <div class="rounded-full border border-sky-500/30 bg-sky-500/10 px-3 py-1 text-xs font-medium text-sky-300">
                {(stats()?.progressPercent ?? 0).toFixed(1)}%
              </div>
            </div>

            <div class="mt-4 flex gap-2">
              <button
                type="button"
                class="inline-flex flex-1 items-center justify-center gap-2 rounded-2xl border border-white/10 bg-white/5 px-2 py-2 text-sm transition hover:bg-white/10 disabled:opacity-60"
                onClick={() => void handlePause()}
                disabled={!currentInfoHash() || stats()?.state === "paused"}
              >
                <CirclePause class="h-4 w-4" />
                {i18nStore.t("common.pause")}
              </button>
              <button
                type="button"
                class="inline-flex flex-1 items-center justify-center gap-2 rounded-2xl border border-white/10 bg-white/5 px-2 py-2 text-sm transition hover:bg-white/10 disabled:opacity-60"
                onClick={() => void handleResume()}
                disabled={!currentInfoHash() || stats()?.state !== "paused"}
              >
                <CirclePlay class="h-4 w-4" />
                {i18nStore.t("common.resume")}
              </button>
              <button
                type="button"
                class="inline-flex flex-1 items-center justify-center gap-2 rounded-2xl border border-red-500/20 bg-red-500/10 px-2 py-2 text-sm text-red-200 transition hover:bg-red-500/20 disabled:opacity-60"
                onClick={() => void handleStop()}
                disabled={!currentInfoHash()}
              >
                <Square class="h-4 w-4 fill-current" />
                {i18nStore.t("common.stop")}
              </button>
            </div>
          </section>

          <Show when={currentInfoHash()}>
            <section class="rounded-3xl border border-white/10 bg-slate-900/80 p-4 text-xs text-slate-400">
              <div class="flex items-center gap-2 text-slate-300">
                <Activity class="h-4 w-4 text-sky-400" />
                {i18nStore.t("common.currentTask")}
              </div>
              <p class="mt-2 break-all font-mono">{currentInfoHash()}</p>
            </section>
          </Show>
        </Show>
      </main>

      <SearchPopup
        isOpen={isSearchPopupOpen()}
        onClose={() => setIsSearchPopupOpen(false)}
        onSelectResult={handleSearchResultSelect}
      />
    </div>
  );
}

export default App;
