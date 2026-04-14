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

/** Build a magnet link with standard announce trackers appended. */
function magnetLink(hash: string, name: string): string {
  return `magnet:?xt=urn:btih:${hash}&dn=${encodeURIComponent(name)}&tr=udp%3A%2F%2Ftracker.opentrackr.org%3A1337%2Fannounce&tr=udp%3A%2F%2Fopen.tracker.cl%3A1337%2Fannounce`;
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
    url: magnetLink(item.info_hash, item.name),
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
        url: magnetLink(torrent.hash, movie.title),
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
    url: item.magnet_url || magnetLink(item.hash, item.filename),
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

// ---------------------------------------------------------------------------
// AniDex  –  https://anidex.info  (anime / manga, JSON API)
// ---------------------------------------------------------------------------
async function searchAniDex(keyword: string): Promise<SearchResult[]> {
  const url = `https://anidex.info/api/?q=${encodeURIComponent(keyword)}&id=0&lang_id=0`;
  const body = await httpGet(url);

  const data = JSON.parse(body) as Array<{
    torrent_name: string;
    info_hash: string;
    magnet_uri: string;
    file_size: number;
    seeders: number;
    leechers: number;
  }>;

  if (!Array.isArray(data)) return [];

  return data.map((item) => ({
    title: item.torrent_name,
    url: item.magnet_uri || magnetLink(item.info_hash, item.torrent_name),
    hash: item.info_hash,
    size: formatBytes(item.file_size),
    seeders: item.seeders,
    peers: item.leechers,
    source: "AniDex",
  }));
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
    url: magnetLink(item.infoHash, item.title),
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
        url: item.magnetUrl ?? magnetLink(hash, title),
        hash,
        size: formatBytes(item.bytes ?? 0),
        seeders: item.seeders ?? 0,
        peers: item.leechers ?? 0,
        source: "Knaben",
      };
    });
}

// ---------------------------------------------------------------------------
// BT4G  –  https://bt4g.org  (DHT search engine, JSON API)
// ---------------------------------------------------------------------------
async function searchBT4G(keyword: string): Promise<SearchResult[]> {
  const url = `https://bt4g.org/api/search?q=${encodeURIComponent(keyword)}&category=all&page=1&orderby=seeders`;
  const body = await httpGet(url);

  const data = JSON.parse(body) as {
    rows?: Array<{
      info_hash?: string;
      name?: string;
      size?: number;
      seeders?: number;
      leechers?: number;
    }>;
  };

  return (data.rows ?? [])
    .filter((item) => item.info_hash)
    .map((item) => {
      const hash = item.info_hash!;
      const title = item.name ?? "";
      return {
        title,
        url: magnetLink(hash, title),
        hash,
        size: formatBytes(item.size ?? 0),
        seeders: item.seeders ?? 0,
        peers: item.leechers ?? 0,
        source: "BT4G",
      };
    });
}

// ---------------------------------------------------------------------------
// 1337x  –  https://1337x.to  (HTML search results page)
// ---------------------------------------------------------------------------
async function search1337x(keyword: string): Promise<SearchResult[]> {
  const url = `https://1337x.to/sort-search/${encodeURIComponent(keyword)}/seeders/desc/1/`;
  const body = await httpGet(url);

  const parser = new DOMParser();
  const doc = parser.parseFromString(body, "text/html");
  const rows = Array.from(doc.querySelectorAll("table.table-list tbody tr"));
  const results: SearchResult[] = [];

  for (const row of rows) {
    const nameEl = row.querySelector("td.name a:nth-child(2)");
    const seedEl = row.querySelector("td.seeds");
    const leechEl = row.querySelector("td.leeches");
    const sizeEl = row.querySelector("td.size");
    const magnetEl = row.querySelector('a[href^="magnet:"]');

    const title = nameEl?.textContent?.trim();
    const magnet = magnetEl?.getAttribute("href");
    if (!title) continue;

    const hashMatch = magnet?.match(/urn:btih:([a-fA-F0-9]{40})/i);
    const hash = hashMatch?.[1];

    results.push({
      title,
      url: magnet ?? (hash ? magnetLink(hash, title) : ""),
      hash,
      size: sizeEl?.firstChild?.textContent?.trim() ?? undefined,
      seeders: parseInt(seedEl?.textContent?.trim() ?? "0", 10),
      peers: parseInt(leechEl?.textContent?.trim() ?? "0", 10),
      source: "1337x",
    });
  }

  return results.filter((r) => r.url);
}

// ---------------------------------------------------------------------------
// Torrent Galaxy  –  https://torrentgalaxy.to  (HTML search results page)
// ---------------------------------------------------------------------------
async function searchTGx(keyword: string): Promise<SearchResult[]> {
  const url = `https://torrentgalaxy.to/torrents.php?search=${encodeURIComponent(keyword)}&sort=seeders&order=desc`;
  const body = await httpGet(url);

  const parser = new DOMParser();
  const doc = parser.parseFromString(body, "text/html");
  const rows = Array.from(doc.querySelectorAll("div.tgxtablerow"));
  const results: SearchResult[] = [];

  for (const row of rows) {
    const titleEl = row.querySelector("a.txlight");
    const magnetEl = row.querySelector('a[href^="magnet:"]');
    const sizeEl = row.querySelector("span.badge-secondary");
    const badges = Array.from(row.querySelectorAll("span.badge"));

    const title = titleEl?.textContent?.trim();
    const magnet = magnetEl?.getAttribute("href");
    if (!title || !magnet) continue;

    const hashMatch = magnet.match(/urn:btih:([a-fA-F0-9]{40})/i);
    const hash = hashMatch?.[1];

    // Seed/leech badges are the last two numeric badge elements
    const numericBadges = badges.filter((b) => /^\d+$/.test(b.textContent?.trim() ?? ""));
    const seeders = numericBadges.length >= 2 ? parseInt(numericBadges[numericBadges.length - 2].textContent ?? "0", 10) : 0;
    const leechers = numericBadges.length >= 1 ? parseInt(numericBadges[numericBadges.length - 1].textContent ?? "0", 10) : 0;

    results.push({
      title,
      url: magnet,
      hash,
      size: sizeEl?.textContent?.trim() ?? undefined,
      seeders: isNaN(seeders) ? 0 : seeders,
      peers: isNaN(leechers) ? 0 : leechers,
      source: "Torrent Galaxy",
    });
  }

  return results;
}

// ---------------------------------------------------------------------------
// Torrents.csv  –  https://torrents-csv.com  (self-hostable DHT search, JSON API)
// ---------------------------------------------------------------------------
async function searchTorrentsCSV(keyword: string): Promise<SearchResult[]> {
  const url = `https://torrents-csv.com/service/search?q=${encodeURIComponent(keyword)}&size=100&page=1&type=torrent`;
  const body = await httpGet(url);

  const data = JSON.parse(body) as Array<{
    name?: string;
    infohash?: string;
    size_bytes?: number;
    seeders?: number;
    leechers?: number;
  }>;

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

// ---------------------------------------------------------------------------
// TorrentKitty  –  https://www.torrentkitty.tv  (DHT search, HTML scraping)
// ---------------------------------------------------------------------------
async function searchTorrentKitty(keyword: string): Promise<SearchResult[]> {
  const url = `https://www.torrentkitty.tv/search/${encodeURIComponent(keyword)}`;
  const body = await httpGet(url);

  const parser = new DOMParser();
  const doc = parser.parseFromString(body, "text/html");
  const rows = Array.from(doc.querySelectorAll("table#archiveResult tr:not(:first-child)"));
  const results: SearchResult[] = [];

  for (const row of rows) {
    const cells = row.querySelectorAll("td");
    if (cells.length < 3) continue;

    const title = cells[0]?.textContent?.trim();
    const sizeText = cells[1]?.textContent?.trim();
    const magnetEl = row.querySelector('a[href^="magnet:"]');
    const magnet = magnetEl?.getAttribute("href");
    if (!title || !magnet) continue;

    const hashMatch = magnet.match(/urn:btih:([a-fA-F0-9]{40})/i);
    const hash = hashMatch?.[1];

    results.push({
      title,
      url: magnet,
      hash,
      size: sizeText ?? undefined,
      seeders: 0,
      peers: 0,
      source: "TorrentKitty",
    });
  }

  return results;
}

// ---------------------------------------------------------------------------
// TorrentProject2  –  https://torrentproject2.com  (general, HTML scraping)
// ---------------------------------------------------------------------------
async function searchTorrentProject2(keyword: string): Promise<SearchResult[]> {
  const url = `https://torrentproject2.com/?t=${encodeURIComponent(keyword)}`;
  const body = await httpGet(url);

  const parser = new DOMParser();
  const doc = parser.parseFromString(body, "text/html");
  const rows = Array.from(doc.querySelectorAll("#similarfiles tr:not(:first-child)"));
  const results: SearchResult[] = [];

  for (const row of rows) {
    const titleEl = row.querySelector("td a");
    const cells = row.querySelectorAll("td");
    const magnetEl = row.querySelector('a[href^="magnet:"]');
    const magnet = magnetEl?.getAttribute("href");
    const title = titleEl?.textContent?.trim();
    if (!title || !magnet) continue;

    const hashMatch = magnet.match(/urn:btih:([a-fA-F0-9]{40})/i);
    const hash = hashMatch?.[1];

    results.push({
      title,
      url: magnet,
      hash,
      size: cells[2]?.textContent?.trim() ?? undefined,
      seeders: parseInt(cells[3]?.textContent?.trim() ?? "0", 10),
      peers: parseInt(cells[4]?.textContent?.trim() ?? "0", 10),
      source: "TorrentProject2",
    });
  }

  return results;
}

// ---------------------------------------------------------------------------
// Torrent9  –  https://torrent9.vip  (French general tracker, HTML scraping)
//
// Note: Torrent9 frequently changes domains. The current base URL may need
// updating if the site moves again.
// ---------------------------------------------------------------------------
async function searchTorrent9(keyword: string): Promise<SearchResult[]> {
  const url = `https://www.torrent9.vip/search_torrent/${encodeURIComponent(keyword)}.html`;
  const body = await httpGet(url);

  const parser = new DOMParser();
  const doc = parser.parseFromString(body, "text/html");
  const rows = Array.from(doc.querySelectorAll("table.table tr:not(:first-child)"));
  const results: SearchResult[] = [];

  for (const row of rows) {
    const titleEl = row.querySelector("td.tdTitle a");
    const cells = row.querySelectorAll("td");
    const title = titleEl?.textContent?.trim();
    const href = titleEl?.getAttribute("href");
    if (!title || !href) continue;

    // Torrent9 result pages link to detail pages; extract hash from href slug
    const slugMatch = href.match(/torrent-([a-fA-F0-9]{40})/i);
    const hash = slugMatch?.[1];
    if (!hash) continue;

    const sizeText = cells[1]?.textContent?.trim();
    const seeders = parseInt(cells[2]?.textContent?.trim() ?? "0", 10);
    const leechers = parseInt(cells[3]?.textContent?.trim() ?? "0", 10);

    results.push({
      title,
      url: magnetLink(hash, title),
      hash,
      size: sizeText ?? undefined,
      seeders: isNaN(seeders) ? 0 : seeders,
      peers: isNaN(leechers) ? 0 : leechers,
      source: "Torrent9",
    });
  }

  return results;
}

// ---------------------------------------------------------------------------
// TorrentDownload  –  https://www.torrentdownload.info  (general, HTML scraping)
// ---------------------------------------------------------------------------
async function searchTorrentDownload(keyword: string): Promise<SearchResult[]> {
  const url = `https://www.torrentdownload.info/search?q=${encodeURIComponent(keyword)}`;
  const body = await httpGet(url);

  const parser = new DOMParser();
  const doc = parser.parseFromString(body, "text/html");
  const rows = Array.from(doc.querySelectorAll("table.table tr:not(:first-child)"));
  const results: SearchResult[] = [];

  for (const row of rows) {
    const titleEl = row.querySelector("td a");
    const cells = row.querySelectorAll("td");
    const title = titleEl?.textContent?.trim();
    const href = titleEl?.getAttribute("href");
    if (!title || !href) continue;

    // Detail page URL contains the info-hash: /torrent/{hash}/{name}
    const hashMatch = href.match(/\/torrent\/([a-fA-F0-9]{40})\//i);
    const hash = hashMatch?.[1];
    if (!hash) continue;

    const sizeText = cells[1]?.textContent?.trim();
    const seeders = parseInt(cells[2]?.textContent?.trim() ?? "0", 10);
    const leechers = parseInt(cells[3]?.textContent?.trim() ?? "0", 10);

    results.push({
      title,
      url: magnetLink(hash, title),
      hash,
      size: sizeText ?? undefined,
      seeders: isNaN(seeders) ? 0 : seeders,
      peers: isNaN(leechers) ? 0 : leechers,
      source: "TorrentDownload",
    });
  }

  return results;
}

// ---------------------------------------------------------------------------
// LimeTorrents  –  https://www.limetorrents.lol  (HTML search results page)
// ---------------------------------------------------------------------------
async function searchLimeTorrents(keyword: string): Promise<SearchResult[]> {
  const url = `https://www.limetorrents.lol/search/all/${encodeURIComponent(keyword)}/seeds/1/`;
  const body = await httpGet(url);

  const parser = new DOMParser();
  const doc = parser.parseFromString(body, "text/html");
  const rows = Array.from(
    doc.querySelectorAll("table.table2 tr:not(:first-child)"),
  );
  const results: SearchResult[] = [];

  for (const row of rows) {
    const titleEl = row.querySelector("td:first-child a:last-child");
    const cells = row.querySelectorAll("td");
    const sizeCell = cells[2];
    const seedCell = cells[3];
    const leechCell = cells[4];
    const magnetEl = row.querySelector('a[href^="magnet:"]');

    const title = titleEl?.textContent?.trim();
    const magnet = magnetEl?.getAttribute("href");
    if (!title || !magnet) continue;

    const hashMatch = magnet.match(/urn:btih:([a-fA-F0-9]{40})/i);
    const hash = hashMatch?.[1];

    results.push({
      title,
      url: magnet,
      hash,
      size: sizeCell?.textContent?.trim() ?? undefined,
      seeders: parseInt(seedCell?.textContent?.trim() ?? "0", 10),
      peers: parseInt(leechCell?.textContent?.trim() ?? "0", 10),
      source: "LimeTorrents",
    });
  }

  return results;
}

// ---------------------------------------------------------------------------
// Public source list  (all directly integrated – no intermediary server)
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
    id: "anidex",
    name: "AniDex",
    url: "https://anidex.info",
    searchFn: searchAniDex,
  },
  {
    id: "solidtorrents",
    name: "SolidTorrents",
    url: "https://solidtorrents.to",
    searchFn: searchSolidTorrents,
  },
  {
    id: "bt4g",
    name: "BT4G",
    url: "https://bt4g.org",
    searchFn: searchBT4G,
  },
  {
    id: "1337x",
    name: "1337x",
    url: "https://1337x.to",
    searchFn: search1337x,
  },
  {
    id: "tgx",
    name: "Torrent Galaxy",
    url: "https://torrentgalaxy.to",
    searchFn: searchTGx,
  },
  {
    id: "limetorrents",
    name: "LimeTorrents",
    url: "https://www.limetorrents.lol",
    searchFn: searchLimeTorrents,
  },
  {
    id: "torrentscsv",
    name: "Torrents.csv",
    url: "https://torrents-csv.com",
    searchFn: searchTorrentsCSV,
  },
  {
    id: "torrentkitty",
    name: "TorrentKitty",
    url: "https://www.torrentkitty.tv",
    searchFn: searchTorrentKitty,
  },
  {
    id: "torrentproject2",
    name: "TorrentProject2",
    url: "https://torrentproject2.com",
    searchFn: searchTorrentProject2,
  },
  {
    id: "torrent9",
    name: "Torrent9",
    url: "https://www.torrent9.vip",
    searchFn: searchTorrent9,
  },
  {
    id: "torrentdownload",
    name: "TorrentDownload",
    url: "https://www.torrentdownload.info",
    searchFn: searchTorrentDownload,
  },
];

/**
 * Register all built-in search sources with the search store.
 * Call once during application startup (e.g. in App.tsx onMount).
 */
export function initializeSources(): void {
  searchStore.setSources(BUILT_IN_SOURCES);
}
