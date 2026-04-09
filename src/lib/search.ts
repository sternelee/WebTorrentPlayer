import { createSignal, createEffect } from "solid-js";

export interface SearchSource {
  id: string;
  name: string;
  url: string;
  searchFn?: (keyword: string) => Promise<SearchResult[]>;
}

export interface SearchResult {
  title: string;
  url: string;
  size?: string;
  peers?: number;
  source: string;
  hash?: string;
}

const SEARCH_HISTORY_KEY = "torplay.searchHistory";
const SEARCH_RESULTS_KEY = "torplay.searchResults";
const SELECTED_SOURCE_KEY = "torplay.selectedSource";
const MAX_HISTORY = 20;

const loadFromStorage = <T>(key: string, defaultValue: T): T => {
  if (typeof window === "undefined") return defaultValue;
  try {
    const stored = window.localStorage.getItem(key);
    return stored ? JSON.parse(stored) : defaultValue;
  } catch {
    return defaultValue;
  }
};

const saveToStorage = <T>(key: string, value: T): void => {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Ignore storage errors
  }
};

// Default search sources - user will provide custom ones
const defaultSources: SearchSource[] = [
  {
    id: "local",
    name: "Local",
    url: "",
  },
];

// Signals for global state
const [searchHistory, setSearchHistory] = createSignal<string[]>(
  loadFromStorage(SEARCH_HISTORY_KEY, [])
);

const [searchResults, setSearchResults] = createSignal<SearchResult[]>(
  loadFromStorage(SEARCH_RESULTS_KEY, [])
);

const [searchSources, setSearchSources] = createSignal<SearchSource[]>(defaultSources);

const [selectedSourceId, setSelectedSourceId] = createSignal<string | null>(
  loadFromStorage(SELECTED_SOURCE_KEY, null)
);

const [isSearching, setIsSearching] = createSignal(false);
const [searchError, setSearchError] = createSignal<string | null>(null);

// Auto-save to localStorage when state changes
createEffect(() => {
  saveToStorage(SEARCH_HISTORY_KEY, searchHistory());
});

createEffect(() => {
  saveToStorage(SEARCH_RESULTS_KEY, searchResults());
});

createEffect(() => {
  const sourceId = selectedSourceId();
  if (sourceId) {
    saveToStorage(SELECTED_SOURCE_KEY, sourceId);
  }
});

export const searchStore = {
  // Getters
  history: searchHistory,
  results: searchResults,
  sources: searchSources,
  selectedSourceId,
  isSearching,
  error: searchError,

  // Get the currently selected source object
  getSelectedSource(): SearchSource | undefined {
    const id = selectedSourceId();
    if (!id) return searchSources()[0];
    return searchSources().find((s) => s.id === id) || searchSources()[0];
  },

  // Set the current search source
  setSelectedSource(sourceId: string) {
    setSelectedSourceId(sourceId);
  },

  // Add a search keyword to history
  addToHistory(keyword: string) {
    if (!keyword.trim()) return;
    const trimmed = keyword.trim();
    const current = searchHistory();
    const filtered = current.filter((k) => k !== trimmed);
    const updated = [trimmed, ...filtered].slice(0, MAX_HISTORY);
    setSearchHistory(updated);
  },

  // Clear search history
  clearHistory() {
    setSearchHistory([]);
  },

  // Remove a single history item
  removeFromHistory(keyword: string) {
    setSearchHistory(searchHistory().filter((k) => k !== keyword));
  },

  // Set search results
  setResults(results: SearchResult[]) {
    setSearchResults(results);
  },

  // Clear search results
  clearResults() {
    setSearchResults([]);
  },

  // Add/update search sources
  setSources(sources: SearchSource[]) {
    setSearchSources(sources);
    // Auto-select first source if none selected
    if (!selectedSourceId() && sources.length > 0) {
      setSelectedSourceId(sources[0].id);
    }
  },

  // Add a single source
  addSource(source: SearchSource) {
    const current = searchSources();
    setSearchSources([...current, source]);
    // Auto-select if first source
    if (current.length === 0) {
      setSelectedSourceId(source.id);
    }
  },

  // Remove a source
  removeSource(sourceId: string) {
    const remaining = searchSources().filter((s) => s.id !== sourceId);
    setSearchSources(remaining);
    // If removed source was selected, switch to first available
    if (selectedSourceId() === sourceId && remaining.length > 0) {
      setSelectedSourceId(remaining[0].id);
    }
  },

  // Search with the currently selected source only
  async search(keyword: string): Promise<SearchResult[]> {
    if (!keyword.trim()) return [];

    setIsSearching(true);
    setSearchError(null);

    try {
      const source = searchStore.getSelectedSource();
      if (!source || !source.searchFn) {
        setSearchError("No search source configured");
        return [];
      }

      const results = await source.searchFn(keyword);
      const resultsWithSource = results.map((r) => ({ ...r, source: source.name }));

      // Add to history
      searchStore.addToHistory(keyword);

      // Save results
      setSearchResults(resultsWithSource);

      return resultsWithSource;
    } catch (e) {
      const errorMsg = e instanceof Error ? e.message : "Search failed";
      setSearchError(errorMsg);
      return [];
    } finally {
      setIsSearching(false);
    }
  },

  // Search all sources (parallel)
  async searchAll(keyword: string): Promise<SearchResult[]> {
    if (!keyword.trim()) return [];

    setIsSearching(true);
    setSearchError(null);

    try {
      const sources = searchSources();
      const allResults: SearchResult[] = [];

      // Execute all sources in parallel
      const searchPromises = sources.map(async (source) => {
        if (source.searchFn) {
          try {
            const results = await source.searchFn(keyword);
            return results.map((r) => ({ ...r, source: source.name }));
          } catch (e) {
            console.error(`Search source ${source.name} failed:`, e);
            return [];
          }
        }
        return [];
      });

      const resultsArrays = await Promise.all(searchPromises);
      resultsArrays.forEach((arr) => allResults.push(...arr));

      // Add to history
      searchStore.addToHistory(keyword);

      // Save results
      setSearchResults(allResults);

      return allResults;
    } catch (e) {
      const errorMsg = e instanceof Error ? e.message : "Search failed";
      setSearchError(errorMsg);
      return [];
    } finally {
      setIsSearching(false);
    }
  },
};