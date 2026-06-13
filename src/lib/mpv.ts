import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export type MpvProbe = {
  available: boolean;
  binary: string | null;
  version: string | null;
  error: string | null;
};

export async function probeMpv(): Promise<MpvProbe> {
  try {
    return await invoke<MpvProbe>("mpv_probe");
  } catch (e) {
    return {
      available: false,
      binary: null,
      version: null,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

export type MpvSource = {
  url: string;
  subtitles?: { url: string; lang?: string }[];
  startAtSec?: number;
};

type MpvEvent =
  | {
      event: "property-change";
      id?: number;
      name: string;
      data: unknown;
    }
  | { event: "end-file"; reason?: string }
  | { event: "playback-restart" }
  | { event: "file-loaded" }
  | { event: "seek" }
  | { event: string; [k: string]: unknown };

export type MpvRect = {
  screenX: number;
  screenY: number;
  w: number;
  h: number;
};

export type MpvSnapshot = {
  status: "idle" | "loading" | "playing" | "paused" | "ended" | "error";
  positionSec: number;
  durationSec: number;
  volume: number;
  muted: boolean;
  paused: boolean;
  audioTracks: MpvTrackInfo[];
  subtitleTracks: MpvTrackInfo[];
  errorMessage: string | null;
};

export type MpvTrackInfo = {
  id: string;
  kind: "audio" | "subtitle";
  label: string;
  lang?: string;
  selected: boolean;
};

const emptySnapshot: MpvSnapshot = {
  status: "idle",
  positionSec: 0,
  durationSec: 0,
  volume: 1,
  muted: false,
  paused: true,
  audioTracks: [],
  subtitleTracks: [],
  errorMessage: null,
};

export type MpvBridge = {
  attach: (host: HTMLElement) => void;
  detach: () => void;
  load: (src: MpvSource) => Promise<void>;
  play: () => void;
  pause: () => void;
  seek: (sec: number) => void;
  setVolume: (v: number) => void;
  setMuted: (m: boolean) => void;
  setAudioTrack: (id: string) => void;
  setSubtitleTrack: (id: string | null) => void;
  requestFullscreen: () => void;
  exitFullscreen: () => void;
  subscribe: (listener: (snap: MpvSnapshot) => void) => () => void;
  destroy: () => void;
};

function getEmbedRect(host: HTMLElement): MpvRect | null {
  const rect = host.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return null;
  return {
    screenX: Math.round(rect.left + globalThis.scrollX),
    screenY: Math.round(rect.top + globalThis.scrollY),
    w: Math.round(rect.width),
    h: Math.round(rect.height),
  };
}

export function createMpvBridge(): MpvBridge {
  let host: HTMLElement | null = null;
  let snap: MpvSnapshot = { ...emptySnapshot };
  const listeners = new Set<(s: MpvSnapshot) => void>();
  let unlistenEvent: UnlistenFn | null = null;
  let geomTimer: number | null = null;
  let started = false;
  let suppressEndFileUntil = 0;

  const emit = () => {
    const next: MpvSnapshot = { ...snap };
    listeners.forEach((l) => l(next));
  };

  const handleEvent = (raw: MpvEvent) => {
    if (raw.event === "property-change") {
      const { name, data } = raw;
      if (name === "time-pos" && typeof data === "number") {
        snap.positionSec = data;
      }
      if (name === "duration" && typeof data === "number") {
        snap.durationSec = data;
      }
      if (name === "pause" && typeof data === "boolean") {
        snap.paused = data;
        snap.status = data ? "paused" : "playing";
      }
      if (name === "eof-reached" && data === true) {
        snap.status = "ended";
      }
      if (name === "volume" && typeof data === "number") {
        snap.volume = data / 100;
      }
      if (name === "mute" && typeof data === "boolean") {
        snap.muted = data;
      }
      if (name === "track-list" && Array.isArray(data)) {
        const audio: MpvTrackInfo[] = [];
        const subs: MpvTrackInfo[] = [];
        for (const t of data as Array<Record<string, unknown>>) {
          const type = String(t.type ?? "");
          const id = String(t.id ?? "");
          const lang = (t.lang ?? t.language) as string | undefined;
          const title = t.title as string | undefined;
          const selected = t.selected === true;
          const label = title || lang || `${type} ${id}`;
          if (type === "audio") {
            audio.push({ id, kind: "audio", label, lang, selected });
          } else if (type === "sub") {
            subs.push({ id, kind: "subtitle", label, lang, selected });
          }
        }
        snap.audioTracks = audio;
        snap.subtitleTracks = subs;
      }
      emit();
    } else if (raw.event === "end-file") {
      const reason = (raw as { reason?: string }).reason?.toLowerCase();
      if (reason === "stop" || reason === "quit" || reason === "redirect") return;
      if (Date.now() < suppressEndFileUntil) return;
      snap.status = reason && reason !== "eof" ? "error" : "ended";
      snap.errorMessage =
        reason && reason !== "eof" ? `mpv ended playback: ${reason}` : null;
      emit();
    } else if (raw.event === "file-loaded") {
      snap.status = snap.paused ? "paused" : "playing";
      snap.errorMessage = null;
      emit();
    }
  };

  const stopGeomLoop = () => {
    if (geomTimer != null) {
      window.clearInterval(geomTimer);
      geomTimer = null;
    }
  };

  const startGeomLoop = () => {
    stopGeomLoop();
    let lastRect: MpvRect | null = null;
    const tick = async () => {
      try {
        if (!host) return;
        const r = getEmbedRect(host);
        if (!r) return;
        if (
          lastRect &&
          lastRect.screenX === r.screenX &&
          lastRect.screenY === r.screenY &&
          lastRect.w === r.w &&
          lastRect.h === r.h
        ) {
          return;
        }
        lastRect = r;
        await invoke("mpv_set_geometry", { geom: r });
      } catch {
        /* noop */
      }
    };
    tick();
    geomTimer = window.setInterval(() => void tick(), 250);
  };

  return {
    attach(h) {
      host = h;
      const placeholder = document.createElement("div");
      placeholder.style.width = "100%";
      placeholder.style.height = "100%";
      placeholder.style.background = "transparent";
      h.appendChild(placeholder);
    },
    detach() {
      if (host) {
        while (host.firstChild) host.removeChild(host.firstChild);
      }
      host = null;
    },
    async load(src) {
      snap = { ...emptySnapshot, status: "loading" };
      emit();

      if (!unlistenEvent) {
        unlistenEvent = await listen<MpvEvent>("mpv://event", (ev) =>
          handleEvent(ev.payload),
        );
      }

      try {
        if (started) {
          suppressEndFileUntil = Date.now() + 1500;
          await invoke("mpv_command", { cmd: ["stop"] });
          const cmd: Array<string | number> = ["loadfile", src.url];
          if (typeof src.startAtSec === "number" && src.startAtSec > 0) {
            cmd.push("replace", 0, `start=${src.startAtSec}`);
          }
          await invoke("mpv_command", { cmd });
          window.dispatchEvent(new Event("torplay:mpv-refresh-geom"));
          return;
        }

        await invoke("mpv_start", {
          args: {
            url: src.url,
            startAtSec: src.startAtSec ?? null,
            subtitles: (src.subtitles ?? []).map((s) => ({
              url: s.url,
              lang: s.lang ?? null,
            })),
            embed: true,
          },
        });
        started = true;
        startGeomLoop();
      } catch (e) {
        snap.status = "error";
        snap.errorMessage = e instanceof Error ? e.message : String(e);
        emit();
      }
    },
    play() {
      invoke("mpv_set_property", { name: "pause", value: false }).catch(() => {});
    },
    pause() {
      invoke("mpv_set_property", { name: "pause", value: true }).catch(() => {});
    },
    seek(sec) {
      invoke("mpv_command", {
        cmd: ["seek", sec, "absolute", "exact"],
      }).catch(() => {});
    },
    setVolume(v) {
      invoke("mpv_set_property", { name: "volume", value: Math.round(v * 100) }).catch(
        () => {},
      );
    },
    setMuted(m) {
      invoke("mpv_set_property", { name: "mute", value: m }).catch(() => {});
    },
    setAudioTrack(id) {
      invoke("mpv_set_property", { name: "aid", value: Number(id) || id }).catch(
        () => {},
      );
    },
    setSubtitleTrack(id) {
      if (id == null) {
        invoke("mpv_set_property", { name: "sid", value: "no" }).catch(() => {});
      } else {
        invoke("mpv_set_property", { name: "sid", value: Number(id) || id }).catch(
          () => {},
        );
      }
    },
    requestFullscreen() {
      invoke("mpv_set_property", { name: "fullscreen", value: true }).catch(() => {});
    },
    exitFullscreen() {
      invoke("mpv_set_property", { name: "fullscreen", value: false }).catch(() => {});
    },
    subscribe(l) {
      listeners.add(l);
      l(snap);
      return () => {
        listeners.delete(l);
      };
    },
    destroy() {
      stopGeomLoop();
      started = false;
      invoke("mpv_stop").catch(() => {});
      if (unlistenEvent) {
        unlistenEvent();
        unlistenEvent = null;
      }
      if (host) {
        while (host.firstChild) host.removeChild(host.firstChild);
      }
      host = null;
      listeners.clear();
    },
  };
}
