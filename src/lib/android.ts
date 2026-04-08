export interface AndroidForegroundSession {
  title: string;
  state: "parsing" | "downloading" | "seeding" | "paused";
  progressPercent: number;
  downloadSpeedKbps: number;
  uploadSpeedKbps: number;
  peersConnected: number;
  isPlaying: boolean;
}

export interface AndroidNetworkStatus {
  connected: boolean;
  validated: boolean;
  internetCapable: boolean;
  metered: boolean;
  transports: string[];
}

interface AndroidBridge {
  upsertForegroundSession(payloadJson: string): void;
  stopForegroundSession(): void;
  getNetworkStatus(): string;
  enterLandscapeFullscreen(): void;
  exitLandscapeFullscreen(): void;
}

declare global {
  interface Window {
    WebTorrentPlayerAndroid?: AndroidBridge;
  }
}

const NETWORK_EVENT_NAME = "webtorrentplayer:android-network-change";

function bridge() {
  return typeof window === "undefined" ? undefined : window.WebTorrentPlayerAndroid;
}

export function hasAndroidBridge() {
  return Boolean(bridge());
}

export function getAndroidNetworkStatus() {
  const nativeBridge = bridge();
  if (!nativeBridge) {
    return null;
  }

  try {
    return JSON.parse(nativeBridge.getNetworkStatus()) as AndroidNetworkStatus;
  } catch {
    return null;
  }
}

export function listenToAndroidNetworkStatus(
  listener: (status: AndroidNetworkStatus) => void,
) {
  if (typeof window === "undefined") {
    return () => {};
  }

  const handler = (event: Event) => {
    const detail = (event as CustomEvent<AndroidNetworkStatus>).detail;
    if (detail) {
      listener(detail);
    }
  };

  window.addEventListener(NETWORK_EVENT_NAME, handler as EventListener);
  return () => window.removeEventListener(NETWORK_EVENT_NAME, handler as EventListener);
}

export function syncAndroidForegroundSession(
  session: AndroidForegroundSession | null,
) {
  const nativeBridge = bridge();
  if (!nativeBridge) {
    return;
  }

  if (session) {
    nativeBridge.upsertForegroundSession(JSON.stringify(session));
  } else {
    nativeBridge.stopForegroundSession();
  }
}

export function syncAndroidPlaybackOrientation(isLandscape: boolean) {
  const nativeBridge = bridge();
  if (!nativeBridge) {
    return false;
  }

  if (isLandscape) {
    nativeBridge.enterLandscapeFullscreen();
  } else {
    nativeBridge.exitLandscapeFullscreen();
  }

  return true;
}
