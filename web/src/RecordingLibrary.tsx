import { useState, useRef, useEffect } from "react";
import { useQuery, useQueryClient, useMutation } from "@tanstack/react-query";
import { Download, Pencil, Play, Trash2, X, Check, Disc3 } from "lucide-react";
import { useTranslation } from "react-i18next";
import i18n, { tr } from "./i18n";
import { api } from "./api";
import "./recording-library.css";

export type SavedRecording = {
  id: string;
  title: string;
  station_id: string;
  station_name: string;
  mime_type: string;
  size_bytes: number;
  duration_seconds: number;
  created_at: number | string;
};
export function recordingSize(bytes: number) {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
function duration(seconds: number) {
  return `${Math.floor(seconds / 60)
    .toString()
    .padStart(2, "0")}:${Math.floor(seconds % 60)
    .toString()
    .padStart(2, "0")}`;
}
function created(value: number | string) {
  const date = new Date(typeof value === "number" ? value * 1000 : value);
  return Number.isNaN(date.getTime())
    ? "—"
    : date.toLocaleString(i18n.language === "en" ? "en-GB" : "zh-CN", {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      });
}
export default function RecordingLibrary({
  userId,
  enabled,
  onPlay,
  onSignIn,
}: {
  userId?: number;
  enabled: boolean;
  onPlay: () => void;
  onSignIn: () => void;
}) {
  useTranslation();
  const cache = useQueryClient();
  const [current, setCurrent] = useState<SavedRecording | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [deleting, setDeleting] = useState<string | null>(null);
  const [playError, setPlayError] = useState("");
  const audio = useRef<HTMLAudioElement>(null);
  const key = ["recordings", userId];
  const recordings = useQuery({
    queryKey: key,
    queryFn: () => api<SavedRecording[]>("/recordings"),
    enabled: enabled && !!userId,
  });
  const rename = useMutation({
    mutationFn: ({ id, title }: { id: string; title: string }) =>
      api<SavedRecording>(`/recordings/${id}`, "PATCH", { title }),
    onSuccess: (_data, variables) => {
      setEditing(null);
      if (current?.id === variables.id)
        setCurrent({ ...current, title: variables.title });
      void cache.invalidateQueries({ queryKey: key });
    },
  });
  const remove = useMutation({
    mutationFn: (id: string) => api(`/recordings/${id}`, "DELETE"),
    onSuccess: (_data, id) => {
      setDeleting(null);
      if (current?.id === id) {
        audio.current?.pause();
        setCurrent(null);
      }
      void cache.invalidateQueries({ queryKey: key });
    },
  });
  useEffect(() => {
    if (!enabled) {
      audio.current?.pause();
      setCurrent(null);
      setEditing(null);
      setDeleting(null);
    }
  }, [enabled]);
  useEffect(() => {
    setCurrent(null);
    setPlayError("");
  }, [userId]);
  useEffect(() => {
    if (!current || !audio.current) return;
    const element = audio.current;
    let disposed = false;
    setPlayError("");
    void element.play().catch(() => {
      if (!disposed) setPlayError("录音暂时无法播放，请重试或下载。");
    });
    return () => {
      disposed = true;
      element.pause();
    };
  }, [current?.id]);
  if (!userId)
    return (
      <div className="recordings-empty">
        <Disc3 size={28} />
        <p>{tr("登录后管理自己的录音。")}</p>
        <button className="primary" onClick={onSignIn}>
          {tr("登录")}
        </button>
      </div>
    );
  return (
    <section className="recordings-library" aria-label={tr("我的录音")}>
      <div className="recordings-summary">
        <span>{tr("仅当前账号可访问")}</span>
        <span>
          {recordings.data
            ? tr("{{count}} 份录音", { count: recordings.data.length })
            : ""}
        </span>
      </div>
      {current && (
        <div className="recording-preview">
          <div>
            <strong>{current.title}</strong>
            <button
              className="icon-button"
              onClick={() => {
                audio.current?.pause();
                setCurrent(null);
              }}
              aria-label={tr("停止试听")}
            >
              <X size={18} />
            </button>
          </div>
          <audio
            ref={audio}
            controls
            preload="metadata"
            src={`/api/recordings/${current.id}/audio`}
            onPlay={onPlay}
            onError={() => setPlayError("录音暂时无法播放，请重试或下载。")}
          />
        </div>
      )}
      {playError && (
        <p className="form-error" role="alert">
          {tr(playError)}
        </p>
      )}
      {(rename.error || remove.error) && (
        <p className="form-error" role="alert">
          {tr((rename.error || remove.error)!.message)}
        </p>
      )}
      {recordings.isPending ? (
        <p role="status">{tr("正在加载录音…")}</p>
      ) : recordings.isError ? (
        <div className="recordings-empty" role="alert">
          <p>{tr(recordings.error.message)}</p>
          <button
            className="secondary"
            onClick={() => void recordings.refetch()}
          >
            {tr("重试")}
          </button>
        </div>
      ) : !recordings.data.length ? (
        <div className="recordings-empty">
          <Disc3 size={30} />
          <h3>{tr("还没有录音")}</h3>
          <p>{tr("在播放器点击录制，结束后会保存到这里。")}</p>
        </div>
      ) : (
        <ul className="recordings-list">
          {recordings.data.map((recording) => (
            <li
              key={recording.id}
              className={current?.id === recording.id ? "selected" : ""}
            >
              <div className="recording-row">
                <button
                  className="recording-listen"
                  aria-label={tr("试听 {{title}}", { title: recording.title })}
                  onClick={() => {
                    setPlayError("");
                    if (current?.id === recording.id && audio.current) {
                      audio.current.currentTime = 0;
                      void audio.current
                        .play()
                        .catch(() =>
                          setPlayError("录音暂时无法播放，请重试或下载。"),
                        );
                    } else setCurrent(recording);
                  }}
                >
                  <Play size={18} fill="currentColor" />
                </button>
                <div className="recording-description">
                  <strong>{recording.title}</strong>
                  <span>{recording.station_name}</span>
                  <small>
                    {created(recording.created_at)} ·{" "}
                    {duration(recording.duration_seconds)} ·{" "}
                    {recordingSize(recording.size_bytes)} ·{" "}
                    {recording.mime_type
                      .split("/")[1]
                      ?.split(";")[0]
                      .toUpperCase()}
                  </small>
                </div>
                <div className="recording-actions">
                  <a
                    className="icon-button"
                    href={`/api/recordings/${recording.id}/audio?download=true`}
                    aria-label={tr("下载 {{title}}", {
                      title: recording.title,
                    })}
                    title={tr("下载")}
                  >
                    <Download size={17} />
                  </a>
                  <button
                    className="icon-button"
                    onClick={() => {
                      setEditing(recording.id);
                      setTitle(recording.title);
                      setDeleting(null);
                      rename.reset();
                    }}
                    aria-label={tr("重命名 {{title}}", {
                      title: recording.title,
                    })}
                    title={tr("重命名")}
                  >
                    <Pencil size={16} />
                  </button>
                  <button
                    className="icon-button"
                    onClick={() => {
                      setDeleting(recording.id);
                      setEditing(null);
                      remove.reset();
                    }}
                    aria-label={tr("删除 {{title}}", {
                      title: recording.title,
                    })}
                    title={tr("删除")}
                  >
                    <Trash2 size={17} />
                  </button>
                </div>
              </div>
              {editing === recording.id && (
                <form
                  className="recording-edit"
                  onSubmit={(e) => {
                    e.preventDefault();
                    if (title.trim())
                      rename.mutate({ id: recording.id, title: title.trim() });
                  }}
                >
                  <label>
                    <span className="sr-only">{tr("录音名称")}</span>
                    <input
                      value={title}
                      onChange={(e) => setTitle(e.target.value)}
                      maxLength={160}
                      required
                      autoFocus
                    />
                  </label>
                  <button
                    className="icon-button"
                    disabled={rename.isPending || !title.trim()}
                    aria-label={tr("保存名称")}
                  >
                    <Check size={18} />
                  </button>
                  <button
                    type="button"
                    className="icon-button"
                    onClick={() => setEditing(null)}
                    aria-label={tr("取消")}
                  >
                    <X size={18} />
                  </button>
                </form>
              )}
              {deleting === recording.id && (
                <div className="recording-delete">
                  <p>{tr("删除这份录音？此操作无法撤销。")}</p>
                  <button
                    className="secondary"
                    onClick={() => setDeleting(null)}
                  >
                    {tr("取消")}
                  </button>
                  <button
                    className="danger-button"
                    disabled={remove.isPending}
                    onClick={() => remove.mutate(recording.id)}
                  >
                    {remove.isPending ? tr("正在删除…") : tr("确认删除")}
                  </button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
