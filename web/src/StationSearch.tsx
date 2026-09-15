import { tr } from "./i18n";
import { useTranslation } from "react-i18next";
import { useCallback, useEffect, useRef, useState } from "react";
import { Search, X } from "lucide-react";

// Treat common FM frequency notation as a station-name keyword, never as RF tuning.
export function normalizeSearch(value: string): string {
  const text = value.normalize("NFKC").trim().replace(/\s+/g, " ");
  const match = text.match(
    /^(?:fm\s*)?(\d{2,3}(?:\.\d{1,2})?)(?:\s*(?:mhz|fm))?$/i,
  );
  if (match && Number(match[1]) >= 64 && Number(match[1]) <= 108)
    return String(Number(match[1]));
  return text;
}
export default function StationSearch({
  value,
  onChange,
  onCommit,
  committedValue,
}: {
  value: string;
  committedValue: string;
  onChange: (value: string) => void;
  onCommit: (value: string) => void;
}) {
  useTranslation();
  const [composing, setComposing] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const commit = useCallback(
    (raw: string) => {
      clearTimeout(timer.current);
      const normalized = normalizeSearch(raw);
      onCommit(normalized);
    },
    [onCommit],
  );
  useEffect(() => {
    clearTimeout(timer.current);
    if (composing || normalizeSearch(value) === committedValue) return;
    timer.current = setTimeout(() => commit(value), 350);
    return () => clearTimeout(timer.current);
  }, [value, composing, commit, committedValue]);
  const clear = () => {
    onChange("");
    commit("");
  };
  return (
    <form
      className="search-field"
      role="search"
      aria-label={tr("电台搜索")}
      onSubmit={(e) => {
        e.preventDefault();
        if (!composing) commit(value);
      }}
    >
      <input
        aria-label={tr("搜索电台")}
        aria-describedby="search-help"
        placeholder={tr("电台名、FM 或频率…")}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onCompositionStart={() => setComposing(true)}
        onCompositionEnd={() => setComposing(false)}
        onKeyDown={(e) => {
          if (e.key === "Escape" && !composing && !e.nativeEvent.isComposing)
            clear();
          if (e.key === "Enter" && (composing || e.nativeEvent.isComposing))
            e.preventDefault();
        }}
        maxLength={100}
        autoComplete="off"
        spellCheck={false}
      />
      {value && (
        <button type="button" aria-label={tr("清空搜索")} onClick={clear}>
          <X size={16} />
        </button>
      )}
      <button
        className="search-submit"
        type="submit"
        aria-label={tr("立即搜索")}
        disabled={composing}
      >
        <Search size={18} />
      </button>
    </form>
  );
}
