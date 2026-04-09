import { createSignal, For, Show, createEffect, onMount, onCleanup } from "solid-js";
import { Search, X, Clock, Trash2, Play, ExternalLink, ChevronDown } from "lucide-solid";
import { i18nStore } from "./i18n";
import { searchStore, type SearchResult } from "./search";

interface SearchPopupProps {
  isOpen: boolean;
  onClose: () => void;
  onSelectResult: (result: SearchResult) => void;
}

export function SearchPopup(props: SearchPopupProps) {
  const [keyword, setKeyword] = createSignal("");
  const [localResults, setLocalResults] = createSignal<SearchResult[]>([]);
  const [isSourceDropdownOpen, setIsSourceDropdownOpen] = createSignal(false);
  let dropdownRef: HTMLDivElement | undefined;

  // Close dropdown when clicking outside
  onMount(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (dropdownRef && !dropdownRef.contains(e.target as Node)) {
        setIsSourceDropdownOpen(false);
      }
    };
    document.addEventListener("click", handleClickOutside);
    onCleanup(() => document.removeEventListener("click", handleClickOutside));
  });

  // Sync with global store
  createEffect(() => {
    if (props.isOpen) {
      setLocalResults(searchStore.results());
    }
  });

  const handleSearch = async () => {
    const kw = keyword().trim();
    if (!kw) return;

    const results = await searchStore.search(kw);
    setLocalResults(results);
  };

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Enter") {
      handleSearch();
    }
  };

  const handleSelectResult = (result: SearchResult) => {
    props.onSelectResult(result);
    props.onClose();
  };

  const handleHistoryClick = (historyKeyword: string) => {
    setKeyword(historyKeyword);
    searchStore.search(historyKeyword).then(setLocalResults);
  };

  return (
    <Show when={props.isOpen}>
      <div class="fixed inset-0 z-50 flex items-start justify-center pt-[10vh]">
        {/* Backdrop */}
        <div
          class="absolute inset-0 bg-black/60 backdrop-blur-sm"
          onClick={props.onClose}
        />

        {/* Modal */}
        <div class="relative z-10 w-full max-w-2xl mx-4 rounded-2xl border border-white/10 bg-slate-900/95 shadow-2xl backdrop-blur-xl">
          {/* Header */}
          <div class="flex items-center gap-3 border-b border-white/10 p-4">
            <Search class="h-5 w-5 text-slate-400" />
            <input
              class="flex-1 bg-transparent text-white outline-none placeholder:text-slate-500"
              placeholder={i18nStore.t("search.placeholder")}
              value={keyword()}
              onInput={(e) => setKeyword(e.currentTarget.value)}
              onKeyDown={handleKeyDown}
              autofocus
            />

            {/* Search Source Dropdown */}
            <div class="relative" ref={dropdownRef}>
              <button
                type="button"
                class="flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/5 px-2 py-1.5 text-xs text-slate-300 transition hover:bg-white/10"
                onClick={(e) => {
                  e.stopPropagation();
                  setIsSourceDropdownOpen(!isSourceDropdownOpen());
                }}
              >
                <span class="max-w-[60px] truncate">
                  {searchStore.getSelectedSource()?.name || "Source"}
                </span>
                <ChevronDown
                  class={`h-3 w-3 transition ${
                    isSourceDropdownOpen() ? "rotate-180" : ""
                  }`}
                />
              </button>
              <Show when={isSourceDropdownOpen()}>
                <div class="absolute right-0 top-full z-10 mt-1 min-w-[120px] rounded-lg border border-white/10 bg-slate-800 py-1 shadow-lg">
                  <For each={searchStore.sources()}>
                    {(source) => (
                      <button
                        type="button"
                        class={`flex w-full items-center px-3 py-2 text-left text-xs transition ${
                          searchStore.selectedSourceId() === source.id
                            ? "bg-sky-500/20 text-sky-300"
                            : "text-slate-300 hover:bg-white/5"
                        }`}
                        onClick={(e) => {
                          e.stopPropagation();
                          searchStore.setSelectedSource(source.id);
                          setIsSourceDropdownOpen(false);
                        }}
                      >
                        {source.name}
                      </button>
                    )}
                  </For>
                </div>
              </Show>
            </div>

            <button
              type="button"
              class="rounded-lg p-1 text-slate-400 transition hover:bg-white/10 hover:text-white"
              onClick={props.onClose}
            >
              <X class="h-5 w-5" />
            </button>
          </div>

          {/* Content */}
          <div class="max-h-[60vh] overflow-y-auto p-4">
            {/* Loading/Error States */}
            <Show when={searchStore.isSearching()}>
              <div class="flex items-center justify-center py-8 text-slate-400">
                <div class="h-6 w-6 animate-spin rounded-full border-2 border-slate-600 border-t-sky-400" />
              </div>
            </Show>

            <Show when={searchStore.error()}>
              <div class="rounded-xl border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-200">
                {searchStore.error()}
              </div>
            </Show>

            {/* Search Results */}
            <Show when={!searchStore.isSearching() && localResults().length > 0}>
              <div class="mb-4">
                <h3 class="mb-2 text-xs font-medium uppercase tracking-wider text-slate-400">
                  {i18nStore.t("search.results")} ({localResults().length})
                </h3>
                <div class="space-y-2">
                  <For each={localResults()}>
                    {(result) => (
                      <button
                        type="button"
                        class="group flex w-full items-center gap-3 rounded-xl border border-white/5 bg-white/5 p-3 text-left transition hover:border-sky-500/50 hover:bg-sky-500/10"
                        onClick={() => handleSelectResult(result)}
                      >
                        <div class="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-sky-500/20 text-sky-400">
                          <Play class="h-4 w-4 fill-current" />
                        </div>
                        <div class="min-w-0 flex-1">
                          <p class="truncate text-sm font-medium text-white group-hover:text-sky-300">
                            {result.title}
                          </p>
                          <div class="mt-1 flex items-center gap-2 text-xs text-slate-400">
                            <span>{result.source}</span>
                            <Show when={result.size}>
                              <span>•</span>
                              <span>{result.size}</span>
                            </Show>
                          </div>
                        </div>
                        <ExternalLink class="h-4 w-4 shrink-0 text-slate-500 transition group-hover:text-sky-400" />
                      </button>
                    )}
                  </For>
                </div>
              </div>
            </Show>

            {/* No Results */}
            <Show
              when={
                !searchStore.isSearching() &&
                !searchStore.error() &&
                localResults().length === 0 &&
                keyword().trim()
              }
            >
              <div class="py-8 text-center text-slate-400">
                {i18nStore.t("search.noResults")}
              </div>
            </Show>

            {/* Search History (shown when no keyword) */}
            <Show when={!keyword().trim() && searchStore.history().length > 0}>
              <div>
                <div class="mb-2 flex items-center justify-between">
                  <h3 class="text-xs font-medium uppercase tracking-wider text-slate-400">
                    {i18nStore.t("search.history")}
                  </h3>
                  <button
                    type="button"
                    class="flex items-center gap-1 text-xs text-slate-500 transition hover:text-slate-300"
                    onClick={() => searchStore.clearHistory()}
                  >
                    <Trash2 class="h-3 w-3" />
                    {i18nStore.t("search.clearHistory")}
                  </button>
                </div>
                <div class="flex flex-wrap gap-2">
                  <For each={searchStore.history().slice(0, 10)}>
                    {(historyKeyword) => (
                      <button
                        type="button"
                        class="flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-sm text-slate-300 transition hover:border-sky-500/50 hover:bg-sky-500/10"
                        onClick={() => handleHistoryClick(historyKeyword)}
                      >
                        <Clock class="h-3 w-3" />
                        <span class="max-w-[150px] truncate">{historyKeyword}</span>
                      </button>
                    )}
                  </For>
                </div>
              </div>
            </Show>

            {/* Empty State */}
            <Show
              when={
                !searchStore.isSearching() &&
                !searchStore.error() &&
                localResults().length === 0 &&
                !keyword().trim() &&
                searchStore.history().length === 0
              }
            >
              <div class="py-8 text-center text-slate-500">
                <Search class="mx-auto mb-2 h-8 w-8" />
                <p class="text-sm">{i18nStore.t("search.placeholder")}</p>
              </div>
            </Show>
          </div>
        </div>
      </div>
    </Show>
  );
}