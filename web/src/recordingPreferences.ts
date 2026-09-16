import { useEffect, useState } from "react";

export const recordingFormats = [
  { mime: "audio/webm;codecs=opus", label: "WebM · Opus", extension: "webm" },
  { mime: "audio/ogg;codecs=opus", label: "Ogg · Opus", extension: "ogg" },
  { mime: "audio/mp4", label: "M4A · AAC", extension: "m4a" },
] as const;
export type RecordingFormat = (typeof recordingFormats)[number];
export const recordingBitrates = [64, 128, 192, 256] as const;
export const recordingDurations = [5, 15, 30, 60] as const;
export type RecordingPreferences = {
  mime: string;
  bitrate: number;
  maxMinutes: number;
};
const key = "meow-recording";
const changed = "meow-recording-change";
let volatilePreferences: Partial<RecordingPreferences> = {};
export function supportedRecordingFormats(): RecordingFormat[] {
  if (typeof MediaRecorder === "undefined") return [];
  return recordingFormats.filter(({ mime }) => {
    try {
      return MediaRecorder.isTypeSupported(mime);
    } catch {
      return false;
    }
  });
}
export function readRecordingPreferences(): RecordingPreferences {
  let value: Partial<RecordingPreferences> = {};
  try {
    value = JSON.parse(localStorage.getItem(key) || "{}") || {};
  } catch {
    value = volatilePreferences;
  }
  const formats = supportedRecordingFormats();
  return {
    mime:
      formats.find((format) => format.mime === value.mime)?.mime ||
      formats[0]?.mime ||
      "",
    bitrate: recordingBitrates.some((bitrate) => bitrate === value.bitrate)
      ? value.bitrate!
      : 128,
    maxMinutes: recordingDurations.some(
      (minutes) => minutes === value.maxMinutes,
    )
      ? value.maxMinutes!
      : 30,
  };
}
export function useRecordingPreferences() {
  const [preferences, setPreferences] = useState(readRecordingPreferences);
  useEffect(() => {
    const refresh = (event: Event) =>
      setPreferences(
        event instanceof CustomEvent
          ? event.detail
          : readRecordingPreferences(),
      );
    window.addEventListener(changed, refresh);
    window.addEventListener("storage", refresh);
    return () => {
      window.removeEventListener(changed, refresh);
      window.removeEventListener("storage", refresh);
    };
  }, []);
  const update = (patch: Partial<RecordingPreferences>) => {
    const next = { ...preferences, ...patch };
    setPreferences(next);
    try {
      localStorage.setItem(key, JSON.stringify(next));
      window.dispatchEvent(new Event(changed));
    } catch {
      volatilePreferences = next;
      window.dispatchEvent(new CustomEvent(changed, { detail: next }));
    }
  };
  return [preferences, update] as const;
}
