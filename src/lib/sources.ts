import { invoke } from "@tauri-apps/api/core";
import type { SearchSource, SearchResult } from "./search";
import { searchStore } from "./search";

// ---------------------------------------------------------------------------
// HTTP helper – proxied through the Rust backend to avoid CORS restrictions
// ---------------------------------------------------------------------------
async function httpGet(url: string): Promise<string> {
  return invoke<string>("http_get", { url });
}

// ---------------------------------------------------------------------------
// Utility helpers
// ---------------------------------------------------------------------------
function formatBytes(bytes: number): string {
  if (!bytes || bytes <= 0) return "";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex++;
  }
  return `${value.toFixed(1)} ${units[unitIndex]}`;
}

// ---------------------------------------------------------------------------
// The Pirate Bay  –  https://apibay.org
// ---------------------------------------------------------------------------
async function searchTPB(keyword: string): Promise<SearchResult[]> {
  const url = `https://apibay.org/q.php?q=${encodeURIComponent(keyword)}&cat=0`;
  const body = await httpGet(url);

  const data = JSON.parse(body) as Array<{
    name: string;
    info_hash: string;
    seeders: string;
    leechers: string;
    size: string;
  }>;

  // API returns a single dummy entry when there are no results
  if (
    data.length === 1 &&
    data[0].info_hash === "0000000000000000000000000000000000000000"
  ) {
    return [];
  }

  return data.map((item) => ({
    title: item.name,
    url: `magnet:?xt=urn:btih:${item.info_hash}&dn=${encodeURIComponent(item.name)}&tr=udp%3A%2F%2Ftracker.opentrackr.org%3A1337%2Fannounce`,
    hash: item.info_hash,
    size: formatBytes(parseInt(item.size, 10)),
    seeders: parseInt(item.seeders, 10),
    peers: parseInt(item.leechers, 10),
    source: "The Pirate Bay",
  }));
}

// ---------------------------------------------------------------------------
// YTS  –  https://yts.mx  (movies)
// ---------------------------------------------------------------------------
async function searchYTS(keyword: string): Promise<SearchResult[]> {
  const url = `https://yts.mx/api/v2/list_movies.json?query_term=${encodeURIComponent(keyword)}&limit=50&sort_by=seeds`;
  const body = await httpGet(url);

  const data = JSON.parse(body) as {
    data: {
      movies?: Array<{
        title: string;
        year: number;
        torrents?: Array<{
          hash: string;
          quality: string;
          type: string;
          size: string;
          seeds: number;
          peers: number;
        }>;
      }>;
    };
  };

  const movies = data.data?.movies ?? [];
  const results: SearchResult[] = [];

  for (const movie of movies) {
    for (const torrent of movie.torrents ?? []) {
      results.push({
        title: `${movie.title} (${movie.year}) [${torrent.quality} ${torrent.type}]`,
        url: `magnet:?xt=urn:btih:${torrent.hash}&dn=${encodeURIComponent(movie.title)}&tr=udp%3A%2F%2Ftracker.opentrackr.org%3A1337%2Fannounce`,
        hash: torrent.hash,
        size: torrent.size,
        seeders: torrent.seeds,
        peers: torrent.peers,
        source: "YTS",
      });
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// EZTV  –  https://eztv.re  (TV shows)
// ---------------------------------------------------------------------------
async function searchEZTV(keyword: string): Promise<SearchResult[]> {
  const url = `https://eztv.re/api/get-torrents?limit=50&page=1&Keywords=${encodeURIComponent(keyword)}`;
  const body = await httpGet(url);

  const data = JSON.parse(body) as {
    torrents?: Array<{
      hash: string;
      filename: string;
      magnet_url: string;
      size_bytes: number;
      seeds: number;
      peers: number;
    }>;
  };

  return (data.torrents ?? []).map((item) => ({
    title: item.filename,
    url:
      item.magnet_url ||
      `magnet:?xt=urn:btih:${item.hash}&dn=${encodeURIComponent(item.filename)}`,
    hash: item.hash,
    size: formatBytes(item.size_bytes),
    seeders: item.seeds,
    peers: item.peers,
    source: "EZTV",
  }));
}

// ---------------------------------------------------------------------------
// Nyaa.si  –  https://nyaa.si  (anime / manga, via RSS)
// ---------------------------------------------------------------------------
function getTextContent(item: Element, ...selectors: string[]): string {
  for (const sel of selectors) {
    const el = item.querySelector(sel);
    if (el?.textContent) return el.textContent.trim();
  }
  return "";
}

async function searchNyaa(keyword: string): Promise<SearchResult[]> {
  const url = `https://nyaa.si/?page=rss&q=${encodeURIComponent(keyword)}&c=0_0&f=0`;
  const body = await httpGet(url);

  const parser = new DOMParser();
  const doc = parser.parseFromString(body, "text/xml");
  const items = Array.from(doc.querySelectorAll("item"));

  const results: SearchResult[] = [];
  for (const item of items) {
    const title = getTextContent(item, "title");
    if (!title) continue;

    const link = getTextContent(item, "link");
    const infoHash = getTextContent(item, "nyaa\\:infoHash", "infoHash");
    const seeders = parseInt(
      getTextContent(item, "nyaa\\:seeders", "seeders") || "0",
      10,
    );
    const size = getTextContent(item, "nyaa\\:size", "size");

    results.push({
      title,
      url: infoHash
        ? `magnet:?xt=urn:btih:${infoHash}&dn=${encodeURIComponent(title)}&tr=http%3A%2F%2Fnyaa.tracker.wf%3A7777%2Fannounce`
        : link,
      hash: infoHash || undefined,
      size: size || undefined,
      seeders,
      peers: 0,
      source: "Nyaa",
    });
  }
  return results;
}

// ---------------------------------------------------------------------------
// SolidTorrents  –  https://solidtorrents.to  (general, multiple categories)
// ---------------------------------------------------------------------------
async function searchSolidTorrents(keyword: string): Promise<SearchResult[]> {
  const url = `https://solidtorrents.to/api/v1/search?q=${encodeURIComponent(keyword)}&fuv=yes&sort=seeders`;
  const body = await httpGet(url);

  const data = JSON.parse(body) as {
    results?: Array<{
      title: string;
      infoHash: string;
      size: number;
      swarm?: { seeders: number; leechers: number };
    }>;
  };

  return (data.results ?? []).map((item) => ({
    title: item.title,
    url: `magnet:?xt=urn:btih:${item.infoHash}&dn=${encodeURIComponent(item.title)}&tr=udp%3A%2F%2Ftracker.opentrackr.org%3A1337%2Fannounce`,
    hash: item.infoHash,
    size: formatBytes(item.size),
    seeders: item.swarm?.seeders ?? 0,
    peers: item.swarm?.leechers ?? 0,
    source: "SolidTorrents",
  }));
}

// ---------------------------------------------------------------------------
// Knaben  –  https://knaben.eu  (aggregator indexing many public trackers)
// ---------------------------------------------------------------------------
async function searchKnaben(keyword: string): Promise<SearchResult[]> {
  const url = `https://knaben.eu/api/v1?search=${encodeURIComponent(keyword)}&size=100&from=0&orderBy=seeders&orderDirection=desc`;
  const body = await httpGet(url);

  const data = JSON.parse(body) as {
    hits?: Array<{
      name?: string;
      title?: string;
      infoHash?: string;
      bytes?: number;
      seeders?: number;
      leechers?: number;
      magnetUrl?: string;
    }>;
  };

  return (data.hits ?? [])
    .filter((item) => item.infoHash)
    .map((item) => {
      const title = item.name ?? item.title ?? "";
      const hash = item.infoHash!;
      return {
        title,
        url:
          item.magnetUrl ??
          `magnet:?xt=urn:btih:${hash}&dn=${encodeURIComponent(title)}&tr=udp%3A%2F%2Ftracker.opentrackr.org%3A1337%2Fannounce`,
        hash,
        size: formatBytes(item.bytes ?? 0),
        seeders: item.seeders ?? 0,
        peers: item.leechers ?? 0,
        source: "Knaben",
      };
    });
}

// ---------------------------------------------------------------------------
// Jackett  –  self-hosted indexer aggregator  (https://github.com/Jackett/Jackett)
//
// Users must run a local Jackett instance and provide their API key in the
// app settings.  Jackett connects to hundreds of public and private trackers,
// making it the most comprehensive search source when available.
// ---------------------------------------------------------------------------
const JACKETT_URL_KEY = "torplay.jackettUrl";
const JACKETT_API_KEY_KEY = "torplay.jackettApiKey";

export interface JackettConfig {
  url: string;
  apiKey: string;
}

export function getJackettConfig(): JackettConfig {
  return {
    url:
      (typeof window !== "undefined"
        ? localStorage.getItem(JACKETT_URL_KEY)
        : null) ?? "http://localhost:9117",
    apiKey:
      (typeof window !== "undefined"
        ? localStorage.getItem(JACKETT_API_KEY_KEY)
        : null) ?? "",
  };
}

export function saveJackettConfig(url: string, apiKey: string): void {
  if (typeof window === "undefined") return;
  localStorage.setItem(JACKETT_URL_KEY, url.trim());
  localStorage.setItem(JACKETT_API_KEY_KEY, apiKey.trim());
}

async function searchJackett(keyword: string): Promise<SearchResult[]> {
  const { url, apiKey } = getJackettConfig();
  if (!apiKey) {
    throw new Error("Jackett API key is not configured");
  }

  const searchUrl = `${url}/api/v2.0/indexers/all/results?apikey=${encodeURIComponent(apiKey)}&Query=${encodeURIComponent(keyword)}`;
  const body = await httpGet(searchUrl);

  const data = JSON.parse(body) as {
    Results?: Array<{
      Title: string;
      InfoHash?: string;
      MagnetUri?: string;
      Size?: number;
      Seeders?: number;
      Peers?: number;
      Tracker?: string;
    }>;
  };

  return (data.Results ?? [])
    .filter((r) => r.InfoHash || r.MagnetUri)
    .map((item) => ({
      title: item.Title,
      url:
        item.MagnetUri ??
        `magnet:?xt=urn:btih:${item.InfoHash}&dn=${encodeURIComponent(item.Title)}`,
      hash: item.InfoHash,
      size: formatBytes(item.Size ?? 0),
      seeders: item.Seeders ?? 0,
      peers: item.Peers ?? 0,
      source: `Jackett/${item.Tracker ?? "all"}`,
    }));
}

// ---------------------------------------------------------------------------
// Public source list
// ---------------------------------------------------------------------------
export const BUILT_IN_SOURCES: SearchSource[] = [
  {
    id: "piratebay",
    name: "The Pirate Bay",
    url: "https://apibay.org",
    searchFn: searchTPB,
  },
  {
    id: "knaben",
    name: "Knaben",
    url: "https://knaben.eu",
    searchFn: searchKnaben,
  },
  {
    id: "yts",
    name: "YTS",
    url: "https://yts.mx",
    searchFn: searchYTS,
  },
  {
    id: "eztv",
    name: "EZTV",
    url: "https://eztv.re",
    searchFn: searchEZTV,
  },
  {
    id: "nyaa",
    name: "Nyaa",
    url: "https://nyaa.si",
    searchFn: searchNyaa,
  },
  {
    id: "solidtorrents",
    name: "SolidTorrents",
    url: "https://solidtorrents.to",
    searchFn: searchSolidTorrents,
  },
  {
    id: "jackett",
    name: "Jackett",
    url: "http://localhost:9117",
    searchFn: searchJackett,
  },
];

/**
 * Register all built-in search sources with the search store.
 * Call once during application startup (e.g. in App.tsx onMount).
 */
export function initializeSources(): void {
  searchStore.setSources(BUILT_IN_SOURCES);
}
