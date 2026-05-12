import { createSignal, createMemo } from "solid-js";
import { invoke } from "@tauri-apps/api/core";

export interface FileInfo {
  index: number;
  name: string;
  sizeBytes: number;
  downloadedBytes: number;
  path: string | null;
  isVideo: boolean;
}

export interface DownloadTask {
  infoHash: string;
  name: string;
  progressPercent: number;
  downloadSpeedBps: number;
  uploadSpeedBps: number;
  peersConnected: number;
  state: "downloading" | "paused" | "seeding" | "complete" | "error";
  files: FileInfo[];
}

const [downloads, setDownloads] = createSignal<DownloadTask[]>([]);
const [downSpeedLimit, setDownSpeedLimit] = createSignal<number | null>(null);
const [upSpeedLimit, setUpSpeedLimit] = createSignal<number | null>(null);
const [downloadDir, setDownloadDir] = createSignal("");
const [isLoading, setIsLoading] = createSignal(false);

export { downloads, downSpeedLimit, upSpeedLimit, downloadDir, isLoading };

export async function refreshDownloads() {
  try {
    const tasks = await invoke<DownloadTask[]>("get_active_downloads");
    setDownloads(tasks);
  } catch (e) {
    console.error("Failed to refresh downloads:", e);
  }
}

export async function fetchDownloadDir() {
  try {
    const dir = await invoke<string>("get_download_dir");
    setDownloadDir(dir);
  } catch (e) {
    console.error("Failed to get download dir:", e);
  }
}

export async function setSpeedLimit(downKbps: number | null, upKbps: number | null) {
  try {
    await invoke("set_global_speed_limit", {
      downBps: downKbps ? Math.round(downKbps * 1024) : null,
      upBps: upKbps ? Math.round(upKbps * 1024) : null,
    });
    setDownSpeedLimit(downKbps);
    setUpSpeedLimit(upKbps);
  } catch (e) {
    console.error("Failed to set speed limit:", e);
  }
}

export async function pauseAll() {
  try {
    await invoke("pause_all_downloads");
    await refreshDownloads();
  } catch (e) {
    console.error("Failed to pause all:", e);
  }
}

export async function resumeAll() {
  try {
    await invoke("resume_all_downloads");
    await refreshDownloads();
  } catch (e) {
    console.error("Failed to resume all:", e);
  }
}

export async function openDownloadedFile(path: string) {
  try {
    await invoke("open_in_file_manager", { path });
  } catch (e) {
    console.error("Failed to open file:", e);
  }
}

export async function exportFile(infoHash: string, fileIndex: number) {
  try {
    const result = await invoke<string>("export_file", { infoHash, fileIndex });
    return result;
  } catch (e) {
    console.error("Failed to export file:", e);
    throw e;
  }
}

export async function pauseTorrent(infoHash: string) {
  try {
    await invoke("pause_torrent", { infoHash });
    await refreshDownloads();
  } catch (e) {
    console.error("Failed to pause torrent:", e);
  }
}

export async function resumeTorrent(infoHash: string) {
  try {
    await invoke("resume_torrent", { infoHash });
    await refreshDownloads();
  } catch (e) {
    console.error("Failed to resume torrent:", e);
  }
}

export async function stopTorrent(infoHash: string) {
  try {
    await invoke("stop_torrent", { infoHash });
    await refreshDownloads();
  } catch (e) {
    console.error("Failed to stop torrent:", e);
  }
}

export function formatSpeed(bps: number): string {
  if (bps < 1024) return `${bps} B/s`;
  if (bps < 1024 * 1024) return `${(bps / 1024).toFixed(1)} KB/s`;
  return `${(bps / 1024 / 1024).toFixed(1)} MB/s`;
}

export function formatSize(bytes: number): string {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export const activeDownloads = createMemo(() =>
  downloads().filter((d) => d.state !== "complete" && d.state !== "seeding")
);

export const completedDownloads = createMemo(() =>
  downloads().filter((d) => d.state === "complete" || d.state === "seeding")
);