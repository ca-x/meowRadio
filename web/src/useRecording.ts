import { useCallback, useEffect, useRef, useState } from "react";
import type { RefObject } from "react";
import type { Station } from "./api";
import {
  readRecordingPreferences,
  supportedRecordingFormats,
} from "./recordingPreferences";

export type RecordingAudio = HTMLAudioElement & {
  captureStream?: () => MediaStream;
  mozCaptureStream?: () => MediaStream;
};
export type RecordingInput = {
  audio: RefObject<HTMLAudioElement | null>;
  station: Station | null;
  relay: boolean;
  status: "idle" | "loading" | "playing" | "paused" | "error";
  sourceKey?: string | number;
  ownerKey?: string;
};
export const MAX_RECORDING_BYTES = 100 * 1024 * 1024;
export type RecordedAudio = {
  blob: Blob;
  filename: string;
  stationId: string;
  stationName: string;
  mimeType: string;
  durationSeconds: number;
  ownerKey?: string;
};
export type RecordingFile = RecordedAudio & {
  url: string;
  filename: string;
  format: string;
  saved: boolean;
};
type Session = {
  recorder: MediaRecorder;
  stream: MediaStream;
  chunks: Blob[];
  bytes: number;
  started: number;
  deadline: number;
  stopRequested: boolean;
  stoppedAt?: number;
  cleanup: () => void;
};
export function recordingAvailable() {
  const prototype = HTMLAudioElement.prototype as RecordingAudio;
  return Boolean(
    (prototype.captureStream || prototype.mozCaptureStream) &&
    supportedRecordingFormats().length,
  );
}
export function recordingFilename(
  name: string,
  extension: string,
  date: number,
) {
  const safe =
    name
      .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
      .replace(/[. ]+$/g, "")
      .slice(0, 80) || "radio";
  return `${safe}-${new Date(date).toISOString().replace(/[:.]/g, "-")}.${extension}`;
}

export function useRecording({
  audio,
  station,
  relay,
  status,
  sourceKey,
  ownerKey,
}: RecordingInput) {
  const session = useRef<Session | null>(null);
  const file = useRef<RecordingFile | null>(null);
  const [pending, setPending] = useState<RecordingFile | null>(null);
  const [phase, setPhase] = useState<"idle" | "recording" | "stopping">("idle");
  const [seconds, setSeconds] = useState(0);
  const [notice, setNotice] = useState("");
  const replaceFile = useCallback((next: RecordingFile | null) => {
    if (file.current && file.current.url !== next?.url)
      URL.revokeObjectURL(file.current.url);
    file.current = next;
    setPending(next);
  }, []);
  const stop = useCallback((message = "录制已停止，可以保存到本机。") => {
    const current = session.current;
    if (!current || current.stopRequested) return;
    current.stopRequested = true;
    current.stoppedAt = Date.now();
    setNotice(message);
    setPhase("stopping");
    if (current.recorder.state !== "inactive") current.recorder.stop();
  }, []);
  const start = () => {
    if (session.current || (file.current && !file.current.saved)) return;
    setNotice("");
    if (!relay) {
      setNotice("录制需通过服务器播放");
      return;
    }
    const element = audio.current as RecordingAudio | null;
    if (
      !station ||
      status !== "playing" ||
      !element ||
      element.paused ||
      element.ended
    ) {
      setNotice("请先播放电台，再开始录制。");
      return;
    }
    const capture = element.captureStream || element.mozCaptureStream;
    const preferences = readRecordingPreferences();
    const format = supportedRecordingFormats().find(
      (item) => item.mime === preferences.mime,
    );
    if (!capture || !format) {
      setNotice("此浏览器暂不支持电台录制，请使用最新版 Chrome 或 Firefox。");
      return;
    }
    let captured: MediaStream | undefined;
    let current: Session | undefined;
    try {
      captured = capture.call(element);
      const tracks = captured
        .getAudioTracks()
        .filter((track) => track.readyState === "live" && !track.muted);
      if (!tracks.length) {
        captured.getTracks().forEach((track) => track.stop());
        setNotice("未能获取可录制的音轨，请等待电台播放后重试。");
        return;
      }
      captured.getVideoTracks().forEach((track) => track.stop());
      const stream = new MediaStream(tracks);
      const recorder = new MediaRecorder(stream, {
        mimeType: format.mime,
        audioBitsPerSecond: preferences.bitrate * 1000,
      });
      const started = Date.now();
      current = {
        recorder,
        stream,
        chunks: [],
        bytes: 0,
        started,
        deadline: started + preferences.maxMinutes * 60_000,
        stopRequested: false,
        cleanup: () => {},
      };
      const active = current;
      const sourceStopped = () => stop("播放已停止，录制也已结束。");
      const events = ["pause", "ended", "emptied", "error"] as const;
      events.forEach((event) => element.addEventListener(event, sourceStopped));
      tracks.forEach((track) => {
        track.addEventListener("ended", sourceStopped);
        track.addEventListener("mute", sourceStopped);
      });
      active.cleanup = () => {
        events.forEach((event) =>
          element.removeEventListener(event, sourceStopped),
        );
        tracks.forEach((track) => {
          track.removeEventListener("ended", sourceStopped);
          track.removeEventListener("mute", sourceStopped);
          track.stop();
        });
      };
      recorder.ondataavailable = (event) => {
        if (session.current !== active || !event.data.size) return;
        if (active.bytes + event.data.size > MAX_RECORDING_BYTES) {
          stop("已达到 100 MiB 上限，录制已停止。");
          return;
        }
        active.chunks.push(event.data);
        active.bytes += event.data.size;
        if (active.bytes >= MAX_RECORDING_BYTES)
          stop("已达到 100 MiB 上限，录制已停止。");
      };
      recorder.onerror = () => {
        if (session.current === active)
          stop("录制中断，可以保存已录制的部分。");
      };
      recorder.onstop = () => {
        if (session.current !== active) return;
        session.current = null;
        active.cleanup();
        setPhase("idle");
        if (!active.bytes) {
          setNotice("没有录到音频，请等待电台播放后重试。");
          return;
        }
        const blob = new Blob(active.chunks, {
          type: recorder.mimeType || format.mime,
        });
        active.chunks = [];
        replaceFile({
          blob,
          url: URL.createObjectURL(blob),
          filename: recordingFilename(station.name, format.extension, started),
          ownerKey,
          stationId: station.id,
          stationName: station.name,
          mimeType: blob.type,
          durationSeconds: Math.max(
            0,
            Math.min(
              3600,
              Math.round(
                (Math.min(active.stoppedAt ?? Date.now(), active.deadline) -
                  started) /
                  1000,
              ),
            ),
          ),
          format: format.label,
          saved: false,
        });
      };
      session.current = active;
      recorder.start(1000);
      replaceFile(null);
      setSeconds(0);
      setPhase("recording");
    } catch {
      session.current = null;
      current?.cleanup();
      captured?.getTracks().forEach((track) => track.stop());
      setPhase("idle");
      setNotice("无法开始录制，请确认通过服务器播放，或尝试其他录制格式。");
    }
  };
  useEffect(() => {
    if (
      status === "paused" ||
      status === "error" ||
      status === "idle" ||
      !relay
    )
      stop("播放已停止，录制也已结束。");
  }, [status, relay, stop]);
  useEffect(
    () => () => stop("电台已切换，录制已结束。"),
    [station?.id, station?.url, relay, sourceKey, ownerKey, stop],
  );
  useEffect(() => {
    if (phase !== "recording") return;
    const tick = () => {
      const active = session.current;
      if (!active || active.stopRequested) return;
      setSeconds(Math.floor((Date.now() - active.started) / 1000));
      if (Date.now() >= active.deadline) stop("已达到设定时长，录制已停止。");
    };
    const interval = window.setInterval(tick, 1000);
    window.addEventListener("focus", tick);
    document.addEventListener("visibilitychange", tick);
    return () => {
      clearInterval(interval);
      window.removeEventListener("focus", tick);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [phase, stop]);
  useEffect(() => {
    if (phase === "idle" && (!pending || pending.saved)) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [phase, pending]);
  useEffect(
    () => () => {
      const active = session.current;
      session.current = null;
      if (active) {
        active.recorder.ondataavailable = null;
        active.recorder.onstop = null;
        active.recorder.onerror = null;
        if (active.recorder.state !== "inactive") active.recorder.stop();
        active.cleanup();
      }
      if (file.current) URL.revokeObjectURL(file.current.url);
    },
    [],
  );
  return {
    phase,
    seconds,
    notice,
    pending,
    start,
    stop,
    discard: () => replaceFile(null),
    markSaved: () => {
      setNotice("");
      if (file.current) replaceFile({ ...file.current, saved: true });
    },
  };
}
