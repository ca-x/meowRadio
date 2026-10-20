import TransientCopy from "./TransientCopy";
import i18n, { tr } from "./i18n";
import { useTranslation } from "react-i18next";
import { useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { useQuery } from "@tanstack/react-query";
import { SlidersHorizontal, X } from "lucide-react";
import { api } from "./api";
export type Filters = {
  country: string;
  language: string;
  tag: string;
  sort: string;
  codec: string;
  bitrateMin: number;
};
export const DEFAULT_FILTERS: Filters = {
  country: "",
  language: "",
  tag: "",
  sort: "popular",
  codec: "",
  bitrateMin: 0,
};
type Facet = {
  value: string;
  label: string;
  count?: number;
};
type Directory = {
  countries: Facet[];
  languages: Facet[];
  tags: Facet[];
};
const fallback: Directory = {
  countries: ["CN", "US", "GB", "JP", "DE", "FR", "TW", "CA", "AU"].map(
    (value) => ({
      value,
      label: value,
    }),
  ),
  languages: [
    "chinese",
    "english",
    "japanese",
    "german",
    "french",
    "spanish",
  ].map((value) => ({
    value,
    label: value,
  })),
  tags: ["jazz", "classical", "ambient", "pop", "rock", "news"].map(
    (value) => ({
      value,
      label: value,
    }),
  ),
};
const countryNames = {
  zh: new Intl.DisplayNames(["zh-CN"], { type: "region" }),
  en: new Intl.DisplayNames(["en"], { type: "region" }),
};
const collators = {
  zh: new Intl.Collator("zh-CN"),
  en: new Intl.Collator("en"),
};
const labels: Record<string, string> = {
  chinese: "中文",
  mandarin: "普通话",
  english: "英语",
  japanese: "日语",
  german: "德语",
  french: "法语",
  spanish: "西班牙语",
  korean: "韩语",
  russian: "俄语",
  italian: "意大利语",
  portuguese: "葡萄牙语",
  jazz: "爵士",
  classical: "古典",
  ambient: "氛围",
  pop: "流行",
  rock: "摇滚",
  news: "新闻",
  talk: "谈话",
  electronic: "电子",
  dance: "舞曲",
  oldies: "经典老歌",
};
export function filterCount(filters: Filters) {
  return Object.entries(filters).filter(
    ([key, value]) => value !== DEFAULT_FILTERS[key as keyof Filters],
  ).length;
}
function title(item: Facet, kind: keyof Directory) {
  if (kind === "countries")
    return (
      countryNames[i18n.language === "en" ? "en" : "zh"].of(item.value) ||
      item.label
    );
  if (i18n.language === "en") return item.label;
  return labels[item.value.toLowerCase()]
    ? `${tr(labels[item.value.toLowerCase()])} · ${item.label}`
    : item.label;
}
export default function StationFilters({
  value,
  onApply,
  visibleCountries,
}: {
  value: Filters;
  onApply: (next: Filters) => void;
  visibleCountries?: string[];
}) {
  useTranslation();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(value);
  const directory = useQuery({
    queryKey: ["directory"],
    queryFn: ({ signal }) =>
      api<Directory>("/directory", "GET", undefined, signal),
    enabled: open,
    staleTime: 3600000,
  });
  const data = directory.data || fallback;
  const change = (key: keyof Filters, next: string | number) =>
    setDraft((previous) => ({
      ...previous,
      [key]: next,
    }));
  function options(kind: keyof Directory, current: string) {
    const items =
      kind === "countries" && visibleCountries !== undefined
        ? data[kind].filter((item) => visibleCountries.includes(item.value))
        : data[kind];
    const sorted = [...items].sort((a, b) =>
      collators[i18n.language === "en" ? "en" : "zh"].compare(
        title(a, kind),
        title(b, kind),
      ),
    );
    return (
      <>
        {current && !items.some((i) => i.value === current) && (
          <option value={current}>{current}</option>
        )}
        {sorted.map((item) => (
          <option key={item.value} value={item.value}>
            {title(item, kind)}
            {item.count === undefined
              ? ""
              : ` (${item.count.toLocaleString()})`}
          </option>
        ))}
      </>
    );
  }
  const count = filterCount(value);
  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        if (next)
          setDraft({
            ...value,
          });
        setOpen(next);
      }}
    >
      <Dialog.Trigger asChild>
        <button
          className={`filter-trigger ${count ? "has-filters" : ""}`}
          aria-label={
            count
              ? tr("筛选电台，已启用 {{v0}} 项", {
                  v0: count,
                })
              : tr("筛选电台")
          }
        >
          <SlidersHorizontal size={17} />
          <span>{tr("筛选")}</span>
          {count > 0 && (
            <span className="filter-count" aria-hidden="true">
              {count}
            </span>
          )}
        </button>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="modal-overlay" />
        <Dialog.Content className="modal filters-dialog">
          <Dialog.Title>{tr("筛选电台")}</Dialog.Title>
          <Dialog.Description>
            <TransientCopy>
              {tr("选一个地方，或一种想听的声音。")}
            </TransientCopy>
          </Dialog.Description>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              onApply({
                ...draft,
              });
              setOpen(false);
            }}
          >
            <div className="filter-fields">
              <label>
                {tr("国家 / 地区")}
                {visibleCountries !== undefined && (
                  <small id="country-viewport-help" aria-hidden="true">
                    {tr("仅列出当前视野内的国家 / 地区")}
                  </small>
                )}
                <select
                  aria-describedby={
                    visibleCountries !== undefined
                      ? "country-viewport-help"
                      : undefined
                  }
                  value={draft.country}
                  onChange={(e) => change("country", e.target.value)}
                >
                  <option value="">{tr("世界各地")}</option>
                  {options("countries", draft.country)}
                </select>
              </label>
              <label>
                {tr("语言")}
                <select
                  value={draft.language}
                  onChange={(e) => change("language", e.target.value)}
                >
                  <option value="">{tr("所有语言")}</option>
                  {options("languages", draft.language)}
                </select>
              </label>
              <label>
                {tr("节目类型")}
                <select
                  value={draft.tag}
                  onChange={(e) => change("tag", e.target.value)}
                >
                  <option value="">{tr("所有类型")}</option>
                  {options("tags", draft.tag)}
                </select>
              </label>
              <label>
                {tr("排序")}
                <select
                  value={draft.sort}
                  onChange={(e) => change("sort", e.target.value)}
                >
                  <option value="popular">{tr("人气最高")}</option>
                  <option value="votes">{tr("投票最多")}</option>
                  <option value="name">{tr("名称 A–Z")}</option>
                </select>
              </label>
            </div>
            <details className="more-filters">
              <summary>{tr("音频格式与音质")}</summary>
              <div className="filter-fields">
                <label>
                  {tr("音频编码")}
                  <select
                    value={draft.codec}
                    onChange={(e) => change("codec", e.target.value)}
                  >
                    <option value="">{tr("所有编码")}</option>
                    {["MP3", "AAC", "AAC+", "OGG", "FLAC"].map((codec) => (
                      <option key={codec}>{codec}</option>
                    ))}
                  </select>
                </label>
                <label>
                  {tr("最低音质")}
                  <select
                    value={draft.bitrateMin}
                    onChange={(e) =>
                      change("bitrateMin", Number(e.target.value))
                    }
                  >
                    <option value="0">{tr("不限码率")}</option>
                    <option value="64">64 kbps</option>
                    <option value="128">128 kbps</option>
                    <option value="192">192 kbps</option>
                    <option value="320">320 kbps</option>
                  </select>
                </label>
              </div>
            </details>
            <div className="directory-status" role="status">
              {directory.isFetching ? (
                tr("正在加载完整目录…")
              ) : directory.isError ? (
                <>
                  <span>{tr("完整目录暂不可用，仍可使用常见选项。")}</span>
                  <button
                    type="button"
                    onClick={() => void directory.refetch()}
                  >
                    {tr("重试")}
                  </button>
                </>
              ) : (
                tr("括号内为目录收录数量，组合筛选后的结果可能更少。")
              )}
            </div>
            <div className="filter-actions">
              <button
                className="text-button"
                type="button"
                onClick={() =>
                  setDraft({
                    ...DEFAULT_FILTERS,
                  })
                }
              >
                {tr("重置")}
              </button>
              <button className="primary" type="submit">
                {tr("应用筛选")}
              </button>
            </div>
          </form>
          <Dialog.Close
            className="modal-close icon-button"
            aria-label={tr("关闭筛选")}
          >
            <X size={20} />
          </Dialog.Close>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
