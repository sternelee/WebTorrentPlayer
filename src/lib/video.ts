// Video format detection and codec support utilities

// Re-export functions from App.tsx for shared usage
export function getFileExtension(name: string): string {
  return name.split(".").pop()?.toLowerCase() || "";
}

/**
 * Browser-supported video formats (H.264 + AAC in MP4/WebM)
 */
export const BROWSER_SUPPORTED_CONTAINERS = [
  "mp4",
  "m4v",
  "webm",
  "mov",
] as const;

/**
 * Formats that require external player (MKV, HEVC, etc.)
 */
export const EXTERNAL_PLAYER_REQUIRED = [
  "mkv",
  "mk3d",
  "mka",
  "mks",
  "hevc",
  "265",
  "h265",
  "av1", // AV1 may not be supported on older devices
  "vp9", // VP9 may have issues on some mobile browsers
] as const;

/**
 * Check if video format is natively supported by the browser/WebView
 */
export function isBrowserSupported(filename: string): boolean {
  const ext = getFileExtension(filename);
  return BROWSER_SUPPORTED_CONTAINERS.includes(ext as typeof BROWSER_SUPPORTED_CONTAINERS[number]);
}

/**
 * Check if video requires external player
 */
export function requiresExternalPlayer(filename: string): boolean {
  const ext = getFileExtension(filename);
  return EXTERNAL_PLAYER_REQUIRED.includes(ext as typeof EXTERNAL_PLAYER_REQUIRED[number]);
}

/**
 * Check if running on mobile platform
 */
export function isMobilePlatform(): boolean {
  return /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
}

/**
 * Check if running on Android
 */
export function isAndroid(): boolean {
  return /Android/i.test(navigator.userAgent);
}

/**
 * Check if running on iOS
 */
export function isIOS(): boolean {
  return /iPhone|iPad|iPod/i.test(navigator.userAgent);
}
