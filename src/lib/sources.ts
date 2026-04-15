import { invoke } from "@tauri-apps/api/core";
import type { SearchSource, SearchResult } from "./search";
import { searchStore } from "./search";

async function httpGet(url: string): Promise<string> {
  return invoke<string>("http_get", { url });
}

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

function magnetLink(hash: string, name: string): string {
  return `magnet:?xt=urn:btih:${hash}&dn=${encodeURIComponent(name)}&tr=udp%3A%2F%2Ftracker.opentrackr.org%3A1337%2Fannounce&tr=udp%3A%2F%2Fopen.tracker.cl%3A1337%2Fannounce`;
}

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

  if (data.length === 1 && data[0].info_hash === "0000000000000000000000000000000000000000") {
    return [];
  }

  return data.map((item) => ({
    title: item.name,
    url: magnetLink(item.info_hash, item.name),
    hash: item.info_hash,
    size: formatBytes(parseInt(item.size, 10)),
    seeders: parseInt(item.seeders, 10),
    peers: parseInt(item.leechers, 10),
    source: "The Pirate Bay",
  }));
}

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
    url: item.magnet_url || magnetLink(item.hash, item.filename),
    hash: item.hash,
    size: formatBytes(item.size_bytes),
    seeders: item.seeds,
    peers: item.peers,
    source: "EZTV",
  }));
}

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
    const seeders = parseInt(getTextContent(item, "nyaa\\:seeders", "seeders") || "0", 10);
    const size = getTextContent(item, "nyaa\\:size", "size");

    results.push({
      title,
      url: infoHash
        ? `magnet:?xt=urn:btih:${infoHash}&dn=${encodeURIComponent(title)}&tr=https%3A%2F%2Fnyaa.tracker.wf%3A7777%2Fannounce`
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
    url: magnetLink(item.infoHash, item.title),
    hash: item.infoHash,
    size: formatBytes(item.size),
    seeders: item.swarm?.seeders ?? 0,
    peers: item.swarm?.leechers ?? 0,
    source: "SolidTorrents",
  }));
}

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
        url: item.magnetUrl ?? magnetLink(hash, title),
        hash,
        size: formatBytes(item.bytes ?? 0),
        seeders: item.seeders ?? 0,
        peers: item.leechers ?? 0,
        source: "Knaben",
      };
    });
}

async function searchTorrentsCSV(keyword: string): Promise<SearchResult[]> {
  const url = `https://torrents-csv.com/service/search?q=${encodeURIComponent(keyword)}&size=100&page=1&type=torrent`;
  const body = await httpGet(url);

  const json = JSON.parse(body) as { torrents?: Array<{
    name?: string;
    infohash?: string;
    size_bytes?: number;
    seeders?: number;
    leechers?: number;
  }> };

  const data = json.torrents;
  if (!Array.isArray(data)) return [];

  return data
    .filter((item) => item.infohash)
    .map((item) => {
      const hash = item.infohash!;
      const title = item.name ?? "";
      return {
        title,
        url: magnetLink(hash, title),
        hash,
        size: formatBytes(item.size_bytes ?? 0),
        seeders: item.seeders ?? 0,
        peers: item.leechers ?? 0,
        source: "Torrents.csv",
      };
    });
}

async function searchAnilibria(keyword: string): Promise<SearchResult[]> {
  const url = `https://aniliberty.top/api/v1/anime/torrents?search=${encodeURIComponent(keyword)}&limit=50`;
  const body = await httpGet(url);

  // Response: {"data": [...], "meta": {...}}
  const json = JSON.parse(body) as { data?: Array<{
    label?: string;
    magnet?: string;
    hash?: string;
    size?: number;
    seeders?: number;
    leechers?: number;
  }> };

  const data = json.data;
  if (!Array.isArray(data)) return [];

  return data.map((item) => {
    const hash = item.hash;
    const title = item.label ?? "";
    const magnet = item.magnet ?? (hash ? `magnet:?xt=urn:btih:${hash}&dn=${encodeURIComponent(title)}` : "");
    return {
      title,
      url: magnet,
      hash,
      size: formatBytes(item.size ?? 0),
      seeders: item.seeders ?? 0,
      peers: item.leechers ?? 0,
      source: "Anilibria",
    };
  });
}

async function searchACGRIP(keyword: string): Promise<SearchResult[]> {
  const url = `https://acg.rip/page/1?term=${encodeURIComponent(keyword)}`;
  const body = await httpGet(url);

  const parser = new DOMParser();
  const doc = parser.parseFromString(body, "text/html");
  const rows = Array.from(doc.querySelectorAll("tr:not(:first-child)"));

  const results: SearchResult[] = [];
  for (const row of rows) {
    const linkEl = row.querySelector('a[href^="/t/"]');
    const title = linkEl?.textContent?.trim();
    if (!title) continue;

    const torrentEl = row.querySelector('a[href$=".torrent"]');
    const torrentHref = torrentEl?.getAttribute("href");
    if (!torrentHref) continue;

    const torrentUrl = torrentHref.startsWith("http")
      ? torrentHref
      : `https://acg.rip${torrentHref}`;

    const sizeEl = row.querySelector("td:nth-child(4)");
    const size = sizeEl?.textContent?.trim();

    results.push({
      title,
      url: torrentUrl,
      size,
      seeders: 0,
      peers: 0,
      source: "ACG.RIP",
    });
  }

  return results;
}

async function searchMikanani(keyword: string): Promise<SearchResult[]> {
  const url = `https://mikanani.me/Home/Search?searchstr=${encodeURIComponent(keyword)}`;
  const body = await httpGet(url);

  const parser = new DOMParser();
  const doc = parser.parseFromString(body, "text/html");
  const items = Array.from(doc.querySelectorAll("div.m-search-item"));

  const results: SearchResult[] = [];
  for (const item of items) {
    const titleEl = item.querySelector("div.text");
    const title = titleEl?.textContent?.trim();
    if (!title) continue;

    const magnetEl = item.querySelector("div.right a");
    const magnet = magnetEl?.getAttribute("href");
    if (!magnet) continue;

    const hashMatch = magnet.match(/urn:btih:([a-fA-F0-9]{40})/i);
    const hash = hashMatch?.[1];

    results.push({
      title,
      url: magnet,
      hash,
      size: undefined,
      seeders: 0,
      peers: 0,
      source: "Mikanani",
    });
  }

  return results;
}

async function searchDMHY(keyword: string): Promise<SearchResult[]> {
  const url = `https://share.dmhy.org/topics/list?keyword=${encodeURIComponent(keyword)}`;
  const body = await httpGet(url);

  const parser = new DOMParser();
  const doc = parser.parseFromString(body, "text/html");
  const rows = Array.from(doc.querySelectorAll("#topic_list tbody tr"));

  const results: SearchResult[] = [];
  for (const row of rows) {
    const titleEl = row.querySelector("td.title a[href^=\"/topics/view/\"]");
    const title = titleEl?.textContent?.trim();
    if (!title) continue;

    const magnetEl = row.querySelector("a.download-arrow[href^=\"magnet:\"]");
    const magnet = magnetEl?.getAttribute("href");
    if (!magnet) continue;

    const hashMatch = magnet.match(/urn:btih:([a-fA-F0-9]{40})/i);
    const hash = hashMatch?.[1];

    const sizeEl = row.querySelector("td:nth-child(5)");
    const size = sizeEl?.textContent?.trim();

    results.push({
      title,
      url: magnet,
      hash,
      size,
      seeders: 0,
      peers: 0,
      source: "DMHY",
    });
  }

  return results;
}

export const BUILT_IN_SOURCES: SearchSource[] = [
  { id: "dmhy", name: "DMHY", url: "https://share.dmhy.org", searchFn: searchDMHY },
  { id: "mikanani", name: "Mikanani", url: "https://mikanani.me", searchFn: searchMikanani },
  { id: "acgrip", name: "ACG.RIP", url: "https://acg.rip", searchFn: searchACGRIP },
  { id: "anilibria", name: "Anilibria", url: "https://aniliberty.top", searchFn: searchAnilibria },
  { id: "nyaa", name: "Nyaa", url: "https://nyaa.si", searchFn: searchNyaa },
  { id: "knaben", name: "Knaben", url: "https://knaben.eu", searchFn: searchKnaben },
  { id: "piratebay", name: "The Pirate Bay", url: "https://apibay.org", searchFn: searchTPB },
  { id: "eztv", name: "EZTV", url: "https://eztv.re", searchFn: searchEZTV },
  { id: "solidtorrents", name: "SolidTorrents", url: "https://solidtorrents.to", searchFn: searchSolidTorrents },
  { id: "torrentscsv", name: "Torrents.csv", url: "https://torrents-csv.com", searchFn: searchTorrentsCSV },
];

export function initializeSources(): void {
  searchStore.setSources(BUILT_IN_SOURCES);
}