import { DEFAULT_FILTERS } from "./StationFilters";
import type { Filters } from "./StationFilters";
export type BrowseState = { query: string; filters: Filters; page: number };
const text = (value: unknown, limit: number) =>
  typeof value === "string" && new TextEncoder().encode(value).length <= limit
    ? value
    : "";
export function readBrowseState(): BrowseState {
  const result: BrowseState = {
    query: "",
    filters: { ...DEFAULT_FILTERS },
    page: 0,
  };
  try {
    const data = JSON.parse(localStorage.getItem("meow-browse") || "null");
    if (!data || typeof data !== "object") return result;
    result.query = text(data.query, 100);
    const f = data.filters;
    if (f && typeof f === "object") {
      result.filters.country =
        typeof f.country === "string" && /^[A-Z]{2}$/.test(f.country)
          ? f.country
          : "";
      result.filters.language = text(f.language, 80);
      result.filters.tag = text(f.tag, 60);
      if (["popular", "votes", "name"].includes(f.sort))
        result.filters.sort = f.sort;
      if (["", "MP3", "AAC", "AAC+", "OGG", "FLAC"].includes(f.codec))
        result.filters.codec = f.codec;
      if ([0, 64, 128, 192, 320].includes(f.bitrateMin))
        result.filters.bitrateMin = f.bitrateMin;
    }
    if (Number.isInteger(data.page) && data.page >= 0 && data.page <= 416)
      result.page = data.page;
  } catch {
    /* storage may be disabled or from an older format */
  }
  return result;
}
export function saveBrowseState(state: BrowseState) {
  try {
    localStorage.setItem("meow-browse", JSON.stringify(state));
  } catch {
    /* keep in-memory state */
  }
}
