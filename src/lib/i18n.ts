import { createSignal } from "solid-js";
import { flatten, resolveTemplate, translator } from "@solid-primitives/i18n";

export type Locale = "en" | "zh-CN";

const LOCALE_STORAGE_KEY = "torplay.locale";

const dictionaries = {
  en: flatten({
    common: {
      selectFile: "Select File",
      pause: "Pause",
      resume: "Resume",
      stop: "Stop",
      close: "Close",
      cancel: "Cancel",
      confirm: "Confirm",
      retry: "Retry",
      standby: "Standby",
      status: "Status",
      network: "Network",
      currentTask: "Current Task",
      downloadSpeed: "Download Speed",
      peers: "Peers",
      unknown: "Unknown",
      offline: "Offline",
      connected: "Connected",
      connectedMetered: "Connected (Metered)",
      wifi: "Wi-Fi",
      wifiMetered: "Wi-Fi (Metered)",
      cellular: "Cellular",
      ethernet: "Ethernet",
      vpn: "VPN",
    },
    player: {
      parsing: "Parsing",
      downloading: "Downloading",
      seeding: "Seeding",
      paused: "Paused",
      buffering: "Buffering",
      playing: "Playing",
      waitingForFile: "Waiting for playable file",
      selectOrWait: "Please select or wait for video to be ready",
      enterMagnetLink: "Enter magnet link first",
      play: "Play",
      pause: "Pause",
      mute: "Mute",
      unmute: "Unmute",
      enterFullscreen: "Enter fullscreen",
      exitFullscreen: "Exit fullscreen",
      subtitleTrack: "Subtitle Track",
      subtitlesOff: "Subtitles off",
      turnOffSubtitles: "Turn off subtitles",
      current: "Current",
      toggleSubtitles: "Toggle subtitles",
      openSubtitleMenu: "Open subtitles menu",
      mediaFile: "Media File",
      waitingForMetadata: "Waiting for metadata",
      playableFiles: "Playable files",
      metadataHint: "File list will appear here after magnet metadata is parsed.",
      video: "Video",
      nonVideo: "Non-video",
      volume: "Volume",
      requiresExternalPlayer: "External player required",
      externalPlayerTitle: "External Player Required",
      externalPlayerDesc: "This video format is not supported by the browser's built-in player.",
      recommendedPlayers: "Recommended",
      openWithSystemPlayer: "Open with system player",
      copyStreamUrl: "Copy stream URL",
      noStreamAvailable: "No stream available",
      copyFailed: "Failed to copy link",
      noPlayerFound: "No video player found. Please install MX Player or VLC.",
      browserFallback: "Opening in browser...",
    },
    torrent: {
      pasteMagnetHint: "Paste magnet:?, .torrent address, or drag .torrent file",
      supportsMagnet: "Supports magnet links, remote .torrent addresses and local .torrent files.",
      dragToImport: "Release to import .torrent file.",
      invalidInput: "Please enter a valid magnet link or .torrent address.",
      invalidFile: "Please drag in a .torrent file.",
      meteredWarning: "Current network is metered, streaming may consume a lot of data.",
      networkUnavailable: "Network unavailable, BT connections paused; will auto-retry on recovery.",
      networkRestoredMetered: "Network restored, reconnecting; current is metered network.",
      networkRestored: "Network restored, reconnecting peers and streaming.",
    },
  }),
  "zh-CN": flatten({
    common: {
      selectFile: "选择文件",
      pause: "暂停",
      resume: "继续",
      stop: "停止",
      close: "关闭",
      cancel: "取消",
      confirm: "确认",
      retry: "重试",
      standby: "待机",
      status: "状态",
      network: "网络",
      currentTask: "当前任务",
      downloadSpeed: "下载速度",
      peers: "Peers",
      unknown: "未知",
      offline: "离线",
      connected: "已连接",
      connectedMetered: "已连接（计费）",
      wifi: "Wi-Fi",
      wifiMetered: "Wi-Fi（计费）",
      cellular: "蜂窝网络",
      ethernet: "以太网",
      vpn: "VPN",
    },
    player: {
      parsing: "解析中",
      downloading: "下载中",
      seeding: "做种中",
      paused: "已暂停",
      buffering: "缓冲中",
      playing: "播放中",
      waitingForFile: "等待可播放文件",
      selectOrWait: "请选择或等待视频文件准备完成",
      enterMagnetLink: "先输入磁力链接",
      play: "播放",
      pause: "暂停",
      mute: "静音",
      unmute: "取消静音",
      enterFullscreen: "进入全屏",
      exitFullscreen: "退出全屏",
      subtitleTrack: "字幕轨",
      subtitlesOff: "当前已关闭字幕",
      turnOffSubtitles: "关闭字幕",
      current: "当前",
      toggleSubtitles: "切换字幕",
      openSubtitleMenu: "打开字幕菜单",
      mediaFile: "媒体文件",
      waitingForMetadata: "等待元数据",
      playableFiles: "可播放文件",
      metadataHint: "磁力元数据解析完成后会在这里展示文件列表。",
      video: "视频",
      nonVideo: "非视频",
      volume: "音量",
      requiresExternalPlayer: "需外部播放器",
      externalPlayerTitle: "需要外部播放器",
      externalPlayerDesc: "此视频格式不被浏览器内置播放器支持。",
      recommendedPlayers: "推荐使用",
      openWithSystemPlayer: "使用系统播放器打开",
      copyStreamUrl: "复制播放链接",
      noStreamAvailable: "没有可用的视频流",
      copyFailed: "复制链接失败",
      noPlayerFound: "未找到视频播放器或浏览器",
      browserFallback: "正在使用浏览器打开...",
    },
    torrent: {
      pasteMagnetHint: "粘贴 magnet:?、.torrent 地址，或拖入 .torrent 文件",
      supportsMagnet: "支持 magnet 链接、远程 .torrent 地址和本地 .torrent 文件。",
      dragToImport: "松手即可导入 .torrent 文件。",
      invalidInput: "请输入有效的 magnet 链接或 .torrent 地址。",
      invalidFile: "请拖入 .torrent 文件。",
      meteredWarning: "当前网络为计费连接，边下边播可能消耗较多流量。",
      networkUnavailable: "当前网络不可用，BT 连接会暂停；恢复后会自动重试播放与下载。",
      networkRestoredMetered: "网络已恢复，正在重连；当前为计费网络。",
      networkRestored: "网络已恢复，正在重连 peers 与流媒体。",
    },
  }),
} as const;

const getStoredLocale = (): Locale => {
  if (typeof window === "undefined") return "en";
  const stored = window.localStorage.getItem(LOCALE_STORAGE_KEY);
  return stored === "zh-CN" ? "zh-CN" : "en";
};

const [locale, setLocaleSignal] = createSignal<Locale>(getStoredLocale());

if (typeof document !== "undefined") {
  document.documentElement.lang = locale();
}

export const t = translator(() => dictionaries[locale()], resolveTemplate);

export const i18nStore = {
  locale,
  setLocale: (next: Locale) => {
    setLocaleSignal(next);
    if (typeof window !== "undefined") {
      window.localStorage.setItem(LOCALE_STORAGE_KEY, next);
    }
    if (typeof document !== "undefined") {
      document.documentElement.lang = next;
    }
  },
  t,
};
