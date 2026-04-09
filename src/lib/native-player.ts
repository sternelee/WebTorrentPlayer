import { invoke } from "@tauri-apps/api/core";
import { isAndroid, isIOS } from "./video";

// Window.WebTorrentPlayerAndroid is defined in ./android.ts

export interface OpenPlayerResult {
  success: boolean;
  player?: string;
  error?: string;
}

/**
 * Open video with system native player
 * Uses different methods based on platform
 */
export async function openWithNativePlayer(
  streamUrl: string,
  title: string = "Video"
): Promise<OpenPlayerResult> {
  // Try Android bridge first
  if (isAndroid() && window.WebTorrentPlayerAndroid?.openVideoPlayer) {
    const result = window.WebTorrentPlayerAndroid.openVideoPlayer(streamUrl, title);

    if (result.startsWith("started:") || result.startsWith("error:")) {
      // Just return success - the system will handle opening the player/browser
      return { success: true };
    }
    return { success: false, error: result || "未知错误" };
  }

  // Try Tauri shell command (desktop)
  try {
    await invoke("open_with_system_player", { streamUrl });
    return { success: true };
  } catch (error) {
    console.error("Failed to open with system player:", error);
    return {
      success: false,
      error: String(error),
    };
  }
}

/**
 * Check if native player is available
 */
export function isNativePlayerAvailable(): boolean {
  if (isAndroid() && window.WebTorrentPlayerAndroid?.openVideoPlayer) {
    return true;
  }

  // Desktop always available via Tauri command
  return !isAndroid() && !isIOS();
}

/**
 * Copy stream URL to clipboard for external player use
 */
export async function copyStreamUrl(streamUrl: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(streamUrl);
    return true;
  } catch (error) {
    console.error("Failed to copy URL:", error);
    return false;
  }
}

/**
 * Get external player recommendations based on platform
 */
export function getRecommendedPlayers(): string[] {
  if (isAndroid()) {
    return ["MX Player", "VLC for Android", "nPlayer"];
  }
  if (isIOS()) {
    return ["nPlayer", "VLC for iOS", "Infuse"];
  }
  return ["VLC", "PotPlayer", "IINA"];
}