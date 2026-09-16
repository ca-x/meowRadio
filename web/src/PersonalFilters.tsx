import "./sources.css";
import { useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { useQuery } from "@tanstack/react-query";
import { SlidersHorizontal, X } from "lucide-react";
import { tr } from "./i18n";
import { api } from "./api";
import type { PersonalSource, PersonalPage } from "./personalSources";
export default function PersonalFilters({
  userId,
  sources,
  sourceId,
  category,
  onApply,
}: {
  userId: number;
  sources: PersonalSource[];
  sourceId: string;
  category: string;
  onApply: (source: string, category: string) => void;
}) {
  const [open, setOpen] = useState(false),
    [source, setSource] = useState(sourceId),
    [path, setPath] = useState(category);
  const directory = useQuery({
    queryKey: ["personal-stations", "filters", userId, source],
    queryFn: () =>
      api<PersonalPage>(
        `/personal-stations?${new URLSearchParams(source ? { source_id: source } : {})}`,
      ),
    enabled: open,
  });
  const count = Number(!!sourceId) + Number(!!category);
  return (
    <Dialog.Root
      open={open}
      onOpenChange={(value) => {
        if (value) {
          setSource(sourceId);
          setPath(category);
        }
        setOpen(value);
      }}
    >
      <Dialog.Trigger asChild>
        <button className="filter-trigger" aria-label={tr("筛选个人电台")}>
          <SlidersHorizontal size={17} />
          <span>
            {tr("筛选")}
            {count > 0 ? ` · ${count}` : ""}
          </span>
        </button>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="modal-overlay" />
        <Dialog.Content className="modal source-modal">
          <Dialog.Title>{tr("筛选个人电台")}</Dialog.Title>
          <Dialog.Description>
            {tr("按来源和分类浏览，无需输入关键词。")}
          </Dialog.Description>
          <div className="personal-filter-fields">
            <label>
              {tr("电台来源")}
              <select
                value={source}
                onChange={(e) => {
                  setSource(e.target.value);
                  setPath("");
                }}
              >
                <option value="">{tr("全部来源")}</option>
                {sources.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.label}
                  </option>
                ))}
              </select>
            </label>
            <label>
              {tr("分类")}
              <select
                value={path}
                disabled={directory.isPending}
                onChange={(e) => setPath(e.target.value)}
              >
                <option value="">{tr("全部分类")}</option>
                {directory.data?.categories.map((category) => (
                  <option
                    key={JSON.stringify(category)}
                    value={JSON.stringify(category)}
                  >
                    {category.join(" / ")}
                  </option>
                ))}
              </select>
            </label>
          </div>
          {directory.error && (
            <p className="form-error" role="alert">
              {tr(directory.error.message)}
            </p>
          )}
          <div className="source-dialog-actions">
            <button
              className="secondary"
              onClick={() => {
                setSource("");
                setPath("");
              }}
            >
              {tr("重置")}
            </button>
            <button
              className="primary"
              onClick={() => {
                onApply(source, path);
                setOpen(false);
              }}
            >
              {tr("应用筛选")}
            </button>
          </div>
          <Dialog.Close
            className="modal-close icon-button"
            aria-label={tr("关闭")}
          >
            <X size={20} />
          </Dialog.Close>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
