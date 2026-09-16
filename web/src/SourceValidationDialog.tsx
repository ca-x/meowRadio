import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as Dialog from "@radix-ui/react-dialog";
import { X, RefreshCw } from "lucide-react";
import { api, ApiError } from "./api";
import { tr } from "./i18n";
import type { PersonalSource } from "./personalSources";
export type InvalidAddress = {
  name: string;
  url: string;
  reason: string;
  line: number;
  key: string;
  station_id: string;
};
type ValidationJob = {
  id: string;
  source_id: string;
  total: number;
  checked: number;
  status: "running" | "complete" | "cancelled" | "blocked";
  failed_count: number;
  failures: InvalidAddress[];
  reason?: string;
};
export default function SourceValidationDialog({
  source,
  userId,
  onClose,
  onCleared,
}: {
  source: PersonalSource;
  userId: number;
  onClose: () => void;
  onCleared: () => Promise<void> | void;
}) {
  const cache = useQueryClient(),
    started = useRef(false);
  const mounted = useRef(true);
  const activeJob = useRef<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set()),
    [error, setError] = useState("");
  const [ready, setReady] = useState(false);
  const initialized = useRef<string | null>(null);
  const path = `/personal-sources/${source.id}/validation`,
    key = ["source-validation", userId, source.id];
  const headers = { "X-Meow-Owner": String(userId) };
  const cancelJob = (id: string) =>
    api<ValidationJob>(
      `${path}?job_id=${encodeURIComponent(id)}`,
      "DELETE",
      undefined,
      undefined,
      headers,
    );
  const start = useMutation({
    mutationFn: () =>
      api<ValidationJob>(path, "POST", undefined, undefined, headers),
    onSuccess: (job) => {
      if (!mounted.current) {
        void cancelJob(job.id).catch(() => {});
        return;
      }
      setReady(true);
      activeJob.current = job.status === "running" ? job.id : null;
      setError("");
      initialized.current = null;
      cache.setQueryData(key, job);
    },
    onError: async (failure) => {
      if (failure instanceof ApiError && failure.status === 409) {
        try {
          const job = await api<ValidationJob>(path);
          if (!mounted.current) {
            if (job.status === "running")
              void cancelJob(job.id).catch(() => {});
            return;
          }
          activeJob.current = job.status === "running" ? job.id : null;
          cache.setQueryData(key, job);
          setReady(true);
          return;
        } catch {
          /* show start failure */
        }
      }
      setError(failure.message);
    },
  });
  const job = useQuery({
    queryKey: key,
    queryFn: () => api<ValidationJob>(path),
    enabled: ready,
    refetchInterval: (query) =>
      query.state.data?.status === "running" ? 1000 : false,
  });
  const cancel = useMutation({
    mutationFn: (id: string) => cancelJob(id),
    onSuccess: (job) => {
      if (activeJob.current === job.id) activeJob.current = null;
      cache.setQueryData<ValidationJob>(key, (current) =>
        current?.id === job.id ? job : current,
      );
    },
  });
  const clear = useMutation({
    mutationFn: () =>
      api<{
        removed_lines: number;
        removed_stations: number;
        skipped_lines: number;
      }>(
        `${path}/clear`,
        "POST",
        { job_id: job.data?.id, keys: [...selected] },
        undefined,
        headers,
      ),
    onSuccess: async () => {
      await onCleared();
      onClose();
    },
  });
  useEffect(() => {
    mounted.current = true;
    if (!started.current) {
      started.current = true;
      start.mutate();
    }
    return () => {
      mounted.current = false;
      if (activeJob.current) {
        const id = activeJob.current;
        activeJob.current = null;
        void cancelJob(id).catch(() => {});
      }
    };
  }, []);
  useEffect(() => {
    if (ready && job.data)
      activeJob.current = job.data.status === "running" ? job.data.id : null;
    if (
      job.data?.status === "complete" &&
      initialized.current !== job.data.id
    ) {
      initialized.current = job.data.id;
      setSelected(new Set(job.data.failures.map((row) => row.key)));
    }
  }, [job.data, ready]);
  const failures = job.data?.failures || [],
    running = start.isPending || job.data?.status === "running";
  const close = () => {
    if (clear.isPending) return;
    if (job.data?.status === "running") {
      activeJob.current = null;
      cancel.mutate(job.data.id);
    }
    onClose();
  };
  return (
    <Dialog.Root
      open
      onOpenChange={(value) => {
        if (!value) close();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="modal-overlay" />
        <Dialog.Content className="modal source-validation-modal">
          <Dialog.Title>{tr("检查电台地址")}</Dialog.Title>
          <Dialog.Description>
            {source.label} · {tr("只列出检测失败的地址，确认后才会清理。")}
          </Dialog.Description>
          {running && (
            <div className="source-validation-progress" role="status">
              <progress
                max={job.data?.total || 1}
                value={job.data?.checked || 0}
              />
              <span>
                {tr("已检测 {{checked}} / {{total}} 个地址", {
                  checked: job.data?.checked || 0,
                  total: job.data?.total || 0,
                })}
              </span>
              <button
                className="secondary"
                disabled={cancel.isPending || !job.data}
                onClick={() => job.data && cancel.mutate(job.data.id)}
              >
                {tr("停止检测")}
              </button>
            </div>
          )}
          {(error || job.error || clear.error || cancel.error) && (
            <p className="form-error" role="alert">
              {tr(
                error ||
                  job.error?.message ||
                  clear.error?.message ||
                  cancel.error?.message ||
                  "",
              )}
            </p>
          )}
          {job.data?.reason && (
            <p className="source-help" role="status">
              {tr(job.data.reason)}
            </p>
          )}
          {job.data?.status === "complete" &&
            (failures.length ? (
              <>
                <div className="source-validation-select">
                  <label>
                    <input
                      type="checkbox"
                      checked={selected.size === failures.length}
                      onChange={(e) =>
                        setSelected(
                          e.target.checked
                            ? new Set(failures.map((row) => row.key))
                            : new Set(),
                        )
                      }
                    />
                    {tr("全部选择")}
                  </label>
                  <span>
                    {tr("{{count}} 个地址检测失败", { count: failures.length })}
                  </span>
                </div>
                <ul className="invalid-address-list">
                  {failures.map((row) => (
                    <li key={row.key}>
                      <label>
                        <input
                          type="checkbox"
                          checked={selected.has(row.key)}
                          onChange={(e) =>
                            setSelected((current) => {
                              const next = new Set(current);
                              if (e.target.checked) next.add(row.key);
                              else next.delete(row.key);
                              return next;
                            })
                          }
                        />
                        <div>
                          <strong>
                            {row.name} ·{" "}
                            {tr("线路 {{number}}", { number: row.line })}
                          </strong>
                          <code>{row.url}</code>
                          <span>{tr(row.reason)}</span>
                        </div>
                      </label>
                    </li>
                  ))}
                </ul>
                <p className="source-help">
                  {tr(
                    "只清理选中的地址。仍有备用地址的电台及收藏会保留；没有地址的空电台及对应收藏会一并移除。",
                  )}
                </p>
                <p className="source-help">
                  {tr("连接失败可能是暂时的，也可以先重新检测。")}
                </p>
              </>
            ) : (
              <p className="source-validation-ok" role="status">
                {job.data.total
                  ? tr("所有地址均可用，没有需要清理的记录。")
                  : tr("此源没有播放地址，无需检测。")}
              </p>
            ))}
          <div className="source-dialog-actions">
            {!running && (
              <button
                className="secondary"
                disabled={clear.isPending}
                onClick={() => {
                  setReady(false);
                  setSelected(new Set());
                  start.mutate();
                }}
              >
                <RefreshCw size={16} />
                {tr("重新检测")}
              </button>
            )}
            <button
              className="secondary"
              onClick={close}
              disabled={clear.isPending}
            >
              {tr("关闭")}
            </button>
            {job.data?.status === "complete" && failures.length > 0 && (
              <button
                className="danger-button"
                disabled={!selected.size || clear.isPending}
                onClick={() => clear.mutate()}
              >
                {clear.isPending
                  ? tr("正在清理…")
                  : tr("确认清理 {{count}} 个地址", { count: selected.size })}
              </button>
            )}
          </div>
          <button
            className="modal-close icon-button"
            aria-label={tr("关闭")}
            onClick={close}
          >
            <X size={20} />
          </button>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
