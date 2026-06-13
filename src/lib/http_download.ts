/**
 * Aria2-style HTTP downloader — frontend store.
 *
 * Maintains a reactive list of {@link HttpDownloadInfo} updated by
 * `http-download-tick` events from the Rust backend.
 *
 * Usage:
 *   // Start listening once at app startup:
 *   const unlisten = await initHttpDownloadListener();
 *   onCleanup(unlisten);
 *
 *   // Add a download:
 *   const id = await httpDownloadAdd("https://example.com/file.mp4");
 *
 *   // Reactive list in JSX:
 *   <For each={httpDownloads()}>{(d) => <div>{d.filename}</div>}</For>
 */

import { createMemo, createSignal } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

// ── Types (mirror Rust HttpDownloadInfo) ─────────────────────────────────────

export type HttpDownloadStatus =
  | "Pending"
  | "Downloading"
  | "Paused"
  | "Complete"
  | "Error";

export interface HttpDownloadInfo {
  id: string;
  url: string;
  filename: string;
  totalBytes: number;
  downloadedBytes: number;
  speedBps: number;
  progressPercent: number;
  status: HttpDownloadStatus;
  error: string | null;
  /** Number of parallel segments currently active. */
  connections: number;
}

// ── Reactive state ────────────────────────────────────────────────────────────

const [httpDownloads, setHttpDownloads] = createSignal<HttpDownloadInfo[]>([]);

export { httpDownloads };

export const activeHttpDownloads = createMemo(() =>
  httpDownloads().filter(
    (d) => d.status === "Downloading" || d.status === "Paused",
  ),
);

export const completedHttpDownloads = createMemo(() =>
  httpDownloads().filter((d) => d.status === "Complete"),
);

// ── Event listener ────────────────────────────────────────────────────────────

/**
 * Subscribe to `http-download-tick` events from the backend.
 * Call once at app startup; use the returned function to unsubscribe.
 */
export async function initHttpDownloadListener(): Promise<() => void> {
  // Seed the store with any tasks that already exist (e.g. after a hot reload).
  try {
    const existing = await invoke<HttpDownloadInfo[]>("http_download_list");
    setHttpDownloads(existing);
  } catch {
    // Not fatal — store starts empty.
  }

  return listen<HttpDownloadInfo>("http-download-tick", ({ payload }) => {
    setHttpDownloads((prev) => {
      const idx = prev.findIndex((d) => d.id === payload.id);
      if (idx >= 0) {
        const next = [...prev];
        next[idx] = payload;
        return next;
      }
      return [...prev, payload];
    });
  });
}

// ── Commands ──────────────────────────────────────────────────────────────────

/**
 * Start a new HTTP download.
 * @param url      Full HTTP/HTTPS URL.
 * @param filename Optional override for the saved filename.
 * @returns        Opaque download ID.
 */
export async function httpDownloadAdd(
  url: string,
  filename?: string,
): Promise<string> {
  return invoke<string>("http_download_add", {
    url,
    filename: filename ?? null,
  });
}

/** Signal a running download to pause at the next chunk boundary. */
export async function httpDownloadPause(id: string): Promise<void> {
  return invoke("http_download_pause", { id });
}

/** Resume a paused download from where it left off. */
export async function httpDownloadResume(id: string): Promise<void> {
  return invoke("http_download_resume", { id });
}

/**
 * Stop and remove a download.
 * @param deleteFile Also delete the (partial) output file when `true`.
 */
export async function httpDownloadRemove(
  id: string,
  deleteFile = false,
): Promise<void> {
  return invoke("http_download_remove", { id, deleteFile });
}

/** Fetch the current list of all tracked downloads (one-off poll). */
export async function httpDownloadList(): Promise<HttpDownloadInfo[]> {
  const list = await invoke<HttpDownloadInfo[]>("http_download_list");
  setHttpDownloads(list);
  return list;
}

// ── Formatting helpers ────────────────────────────────────────────────────────

export function formatHttpSpeed(bps: number): string {
  if (bps < 1024) return `${bps.toFixed(0)} B/s`;
  if (bps < 1024 * 1024) return `${(bps / 1024).toFixed(1)} KB/s`;
  return `${(bps / 1024 / 1024).toFixed(1)} MB/s`;
}

export function formatHttpSize(bytes: number): string {
  if (bytes === 0) return "0 B";
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024)
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}
