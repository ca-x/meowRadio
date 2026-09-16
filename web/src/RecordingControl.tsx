import { useEffect, useRef, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { Circle, Download, Square, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { tr } from "./i18n";
import { recordingAvailable, useRecording } from "./useRecording";
import type {
  RecordedAudio,
  RecordingFile,
  RecordingInput,
} from "./useRecording";
import "./recording.css";

type Props = RecordingInput & {
  onRequestRelay: () => void;
  active?: boolean;
  onRecorded?: (recording: RecordedAudio) => Promise<void> | void;
  onOpenLibrary?: () => void;
};
export default function RecordingControl({
  onRequestRelay,
  active = true,
  onRecorded,
  onOpenLibrary,
  ...input
}: Props) {
  useTranslation();
  const recording = useRecording(input);
  const [open, setOpen] = useState(false);
  const [discardConfirm, setDiscardConfirm] = useState(false);
  const [relayHint, setRelayHint] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const [upload, setUpload] = useState<"idle" | "saving" | "saved" | "error">(
    "idle",
  );
  const currentFile = useRef(recording.pending);
  currentFile.current = recording.pending;
  const [uploadError, setUploadError] = useState("");
  const uploadCallback = useRef(onRecorded);
  uploadCallback.current = onRecorded;
  const uploadedUrl = useRef<string | null>(null);
  const uploadGeneration = useRef(0);
  const uploadFile = async (file: RecordingFile) => {
    if (!uploadCallback.current) return;
    const generation = ++uploadGeneration.current;
    setUpload("saving");
    setUploadError("");
    try {
      await uploadCallback.current(file);
      if (generation === uploadGeneration.current) {
        setUpload("saved");
        if (currentFile.current?.url === file.url) recording.markSaved();
      }
    } catch (error) {
      if (generation === uploadGeneration.current) {
        setUpload("error");
        setUploadError(error instanceof Error ? error.message : "");
      }
    }
  };
  useEffect(() => {
    const file = recording.pending;
    if (!file || uploadedUrl.current === file.url) return;
    uploadedUrl.current = file.url;
    void uploadFile(file);
  }, [recording.pending]);
  useEffect(
    () => () => {
      uploadGeneration.current++;
    },
    [],
  );
  const available = recordingAvailable();
  const running = recording.phase !== "idle";
  const unsaved = recording.pending && !recording.pending.saved;
  useEffect(() => {
    if (recording.pending && !recording.pending.saved) {
      setOpen(true);
      setDiscardConfirm(false);
    }
  }, [recording.pending]);
  const action = () => {
    if (running) {
      recording.stop();
      return;
    }
    if (unsaved) {
      setOpen(true);
      return;
    }
    if (!input.relay) {
      setRelayHint(true);
      return;
    }
    setRelayHint(false);
    recording.start();
  };
  const label = running
    ? tr("停止录制")
    : unsaved
      ? tr("保存录音")
      : tr("开始录制");
  return (
    <>
      <div className="recording-control" hidden={!active}>
        <button
          ref={button}
          type="button"
          className="recording-entry"
          data-recording={running}
          onClick={action}
          aria-label={label}
          title={
            available
              ? label
              : tr("此浏览器暂不支持电台录制，请使用最新版 Chrome 或 Firefox。")
          }
          disabled={
            recording.phase === "stopping" ||
            (!running && !unsaved && (!input.station || !available))
          }
        >
          {running ? (
            <Square size={16} fill="currentColor" aria-hidden="true" />
          ) : unsaved ? (
            <Download size={18} aria-hidden="true" />
          ) : (
            <Circle size={17} aria-hidden="true" />
          )}
          {running && (
            <span aria-hidden="true">
              {String(Math.floor(recording.seconds / 60)).padStart(2, "0")}:
              {String(recording.seconds % 60).padStart(2, "0")}
            </span>
          )}
        </button>
        {recording.pending?.saved && !running && (
          <button
            type="button"
            className="recording-entry"
            aria-label={tr("查看本次录音")}
            title={tr("查看本次录音")}
            onClick={() => setOpen(true)}
          >
            <Download size={18} aria-hidden="true" />
          </button>
        )}
        {relayHint && !input.relay && (
          <span className="recording-hint">
            {tr("录制需通过服务器播放")}{" "}
            <button
              type="button"
              onClick={() => {
                setRelayHint(false);
                onRequestRelay();
              }}
            >
              {tr("通过服务器播放")}
            </button>
          </span>
        )}
        {recording.notice && (
          <span className="recording-notice" role="status">
            {tr(recording.notice)}
          </span>
        )}
      </div>
      <Dialog.Root
        open={open}
        onOpenChange={(value) => {
          setOpen(value);
          setDiscardConfirm(false);
        }}
      >
        <Dialog.Portal>
          <Dialog.Overlay className="recording-overlay" />
          <Dialog.Content
            className="recording-dialog"
            onCloseAutoFocus={(event) => {
              event.preventDefault();
              if (active) button.current?.focus();
            }}
          >
            <div className="recording-heading">
              <Dialog.Title>{tr("保存录音")}</Dialog.Title>
              <Dialog.Close asChild>
                <button
                  className="recording-close"
                  aria-label={tr("关闭保存窗口")}
                >
                  <X size={20} />
                </button>
              </Dialog.Close>
            </div>
            <Dialog.Description>
              {tr("录音已就绪，保存到你的设备后即可随时收听。")}
            </Dialog.Description>
            {recording.pending && (
              <>
                <p className="recording-filename">
                  {recording.pending.filename}
                </p>
                <p className="recording-file-meta">
                  {recording.pending.format} ·{" "}
                  {(recording.pending.blob.size / 1024 / 1024).toFixed(2)} MiB
                </p>
                {onRecorded && (
                  <p role="status">
                    {upload === "saving"
                      ? tr("正在保存到录音库…")
                      : upload === "saved"
                        ? tr("已保存到录音库")
                        : upload === "error"
                          ? tr("未能保存到录音库，请重试或下载到本机。")
                          : ""}
                  </p>
                )}
                {upload === "error" && uploadError && (
                  <p role="alert">{tr(uploadError)}</p>
                )}
                {upload === "saved" && onOpenLibrary && (
                  <button
                    className="recording-retry"
                    onClick={() => {
                      setOpen(false);
                      onOpenLibrary();
                    }}
                  >
                    {tr("查看录音")}
                  </button>
                )}
                {upload === "error" && (
                  <button
                    className="recording-retry"
                    onClick={() => {
                      if (recording.pending) void uploadFile(recording.pending);
                    }}
                  >
                    {tr("重试保存到录音库")}
                  </button>
                )}
                {discardConfirm && (
                  <p role="alert">
                    {recording.pending.saved
                      ? tr("关闭此录音的本地副本？录音库中的文件不受影响。")
                      : tr("丢弃后无法恢复这段录音。")}
                  </p>
                )}
                <div className="recording-actions">
                  <button
                    onClick={() => {
                      if (!discardConfirm) {
                        setDiscardConfirm(true);
                        return;
                      }
                      recording.discard();
                      setOpen(false);
                      setDiscardConfirm(false);
                    }}
                  >
                    {discardConfirm
                      ? tr("确认丢弃")
                      : recording.pending.saved
                        ? tr("关闭录音")
                        : tr("丢弃录音")}
                  </button>
                  <a
                    className="recording-download"
                    href={recording.pending.url}
                    download={recording.pending.filename}
                    onClick={() => {
                      recording.markSaved();
                      setOpen(false);
                    }}
                  >
                    <Download size={16} aria-hidden="true" />
                    {tr("保存到本机")}
                  </a>
                </div>
                <p className="recording-save-hint">
                  {tr(
                    "文件会保存到浏览器的下载位置。关闭此窗口后仍可继续保存。",
                  )}
                </p>
              </>
            )}
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </>
  );
}
