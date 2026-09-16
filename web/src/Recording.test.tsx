import { StrictMode } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Station } from "./api";
import { MAX_RECORDING_BYTES, useRecording } from "./useRecording";
import type { RecordingAudio, RecordingInput } from "./useRecording";
import {
  readRecordingPreferences,
  supportedRecordingFormats,
} from "./recordingPreferences";
import RecordingControl from "./RecordingControl";
import RecordingSettings from "./RecordingSettings";

vi.mock("react-i18next", () => ({ useTranslation: () => ({}) }));
vi.mock("./i18n", () => ({
  tr: (key: string, options: Record<string, unknown> = {}) =>
    key.replace(/\{\{(\w+)\}\}/g, (_, name: string) =>
      String(options[name] ?? ""),
    ),
}));
class Track extends EventTarget {
  readyState = "live";
  muted = false;
  stop = vi.fn(() => {
    this.readyState = "ended";
  });
}
class Stream {
  constructor(public tracks: Track[]) {}
  getAudioTracks() {
    return this.tracks;
  }
  getVideoTracks() {
    return [];
  }
  getTracks() {
    return this.tracks;
  }
}
class Recorder {
  static instances: Recorder[] = [];
  static isTypeSupported = vi.fn(
    (mime: string) =>
      mime.startsWith("audio/webm") || mime.startsWith("audio/ogg"),
  );
  state = "inactive";
  mimeType: string;
  ondataavailable: ((event: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(
    public stream: Stream,
    public options: MediaRecorderOptions,
  ) {
    this.mimeType = options.mimeType!;
    Recorder.instances.push(this);
  }
  start = vi.fn(() => {
    this.state = "recording";
  });
  stop = vi.fn(() => {
    this.state = "inactive";
    this.onstop?.();
  });
  chunk(data: Blob = new Blob(["recorded audio"])) {
    this.ondataavailable?.({ data });
  }
}
const station: Station = {
  id: "station-1",
  name: "Radio:/ One",
  url: "https://example.com/one",
  country: "",
  countrycode: "",
  tags: "",
  codec: "",
  bitrate: 128,
  hls: false,
};
let track: Track;
let audio: RecordingAudio;
let input: RecordingInput;
let createURL: ReturnType<typeof vi.fn<(blob: Blob | MediaSource) => string>>;
let revokeURL: ReturnType<typeof vi.fn<(url: string) => void>>;
let capture: ReturnType<typeof vi.fn>;
beforeEach(() => {
  localStorage.clear();
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-16T10:00:00Z"));
  Recorder.instances = [];
  Recorder.isTypeSupported.mockImplementation(
    (mime) => mime.startsWith("audio/webm") || mime.startsWith("audio/ogg"),
  );
  vi.stubGlobal("MediaRecorder", Recorder);
  vi.stubGlobal("MediaStream", Stream);
  createURL = vi.fn(() => `blob:recording-${Math.random()}`);
  revokeURL = vi.fn();
  vi.stubGlobal(
    "URL",
    class extends URL {
      static createObjectURL = createURL;
      static revokeObjectURL = revokeURL;
    },
  );
  track = new Track();
  capture = vi.fn(() => new Stream([track]));
  Object.defineProperty(HTMLAudioElement.prototype, "captureStream", {
    configurable: true,
    value: capture,
  });
  audio = document.createElement("audio");
  Object.defineProperty(audio, "paused", { configurable: true, value: false });
  input = {
    audio: { current: audio },
    station,
    relay: true,
    status: "playing",
  };
});
afterEach(() => {
  cleanup();
  delete (HTMLAudioElement.prototype as RecordingAudio).captureStream;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
function recordChunk() {
  const recorder = Recorder.instances.at(-1)!;
  act(() => recorder.chunk());
  return recorder;
}

describe("recording lifecycle", () => {
  it("captures audio with the chosen codec/bitrate, creates a sanitized file and protects pending data", () => {
    localStorage.setItem(
      "meow-recording",
      JSON.stringify({
        mime: "audio/ogg;codecs=opus",
        bitrate: 192,
        maxMinutes: 5,
      }),
    );
    const { result, unmount } = renderHook(() => useRecording(input), {
      wrapper: StrictMode,
    });
    act(() => result.current.start());
    const recorder = recordChunk();
    expect(recorder.options).toEqual({
      mimeType: "audio/ogg;codecs=opus",
      audioBitsPerSecond: 192000,
    });
    expect(recorder.start).toHaveBeenCalledWith(1000);
    act(() => {
      vi.advanceTimersByTime(3000);
      recorder.chunk(new Blob(["second"]));
      result.current.stop();
    });
    expect(result.current.pending?.blob.size).toBe(20);
    expect(result.current.pending?.mimeType).toBe("audio/ogg;codecs=opus");
    expect(result.current.pending?.filename).toBe(
      "Radio__ One-2026-09-16T10-00-00-000Z.ogg",
    );
    expect(result.current.pending?.durationSeconds).toBe(3);
    act(() => result.current.start());
    expect(Recorder.instances).toHaveLength(1);
    expect(track.stop).toHaveBeenCalledTimes(1);
    const url = result.current.pending!.url;
    unmount();
    expect(revokeURL).toHaveBeenCalledWith(url);
  });
  it("includes the final data event delivered after stop was requested", () => {
    const { result } = renderHook(() => useRecording(input));
    act(() => result.current.start());
    const recorder = recordChunk();
    recorder.stop.mockImplementationOnce(() => {
      recorder.state = "inactive";
    });
    act(() => result.current.stop());
    expect(result.current.phase).toBe("stopping");
    expect(result.current.pending).toBeNull();
    act(() => {
      recorder.chunk(new Blob(["final"]));
      recorder.onstop?.();
    });
    expect(result.current.pending?.blob.size).toBe(19);
  });
  it.each([
    { stopAfter: 3601, callbackDelay: 10, expected: 3600 },
    { stopAfter: 12, callbackDelay: 10, expected: 12 },
  ])(
    "keeps duration $expected when stop metadata is finalized late",
    ({ stopAfter, callbackDelay, expected }) => {
      localStorage.setItem(
        "meow-recording",
        JSON.stringify({ maxMinutes: 60 }),
      );
      const { result } = renderHook(() =>
        useRecording({ ...input, ownerKey: "user-1" }),
      );
      act(() => result.current.start());
      const recorder = recordChunk();
      recorder.stop.mockImplementationOnce(() => {
        recorder.state = "inactive";
      });
      act(() => {
        vi.setSystemTime(Date.now() + stopAfter * 1000);
        if (stopAfter >= 3600) window.dispatchEvent(new Event("focus"));
        else result.current.stop();
      });
      expect(result.current.phase).toBe("stopping");
      act(() => {
        vi.setSystemTime(Date.now() + callbackDelay * 1000);
        recorder.chunk(new Blob(["final"]));
        recorder.onstop?.();
      });
      expect(result.current.pending?.durationSeconds).toBe(expected);
      expect(result.current.pending?.blob.size).toBe(19);
      expect(result.current.pending?.ownerKey).toBe("user-1");
    },
  );
  it("releases a saved URL on replacement and stops tracks on unmount", () => {
    const { result, unmount } = renderHook(() => useRecording(input));
    act(() => result.current.start());
    recordChunk();
    act(() => result.current.stop());
    const previousURL = result.current.pending!.url;
    act(() => result.current.markSaved());
    track = new Track();
    act(() => result.current.start());
    expect(revokeURL).toHaveBeenCalledWith(previousURL);
    const recorder = Recorder.instances.at(-1)!;
    unmount();
    expect(recorder.stop).toHaveBeenCalledTimes(1);
    expect(track.stop).toHaveBeenCalledTimes(1);
  });
  it("reports an empty recording instead of presenting an empty download", () => {
    const { result } = renderHook(() => useRecording(input));
    act(() => result.current.start());
    act(() => result.current.stop());
    expect(result.current.pending).toBeNull();
    expect(createURL).not.toHaveBeenCalled();
    expect(result.current.notice).toContain("没有录到音频");
  });
  it("stops once when switching station and keeps original station metadata", () => {
    const { result, rerender } = renderHook((props) => useRecording(props), {
      initialProps: input,
    });
    act(() => result.current.start());
    const recorder = recordChunk();
    rerender({
      ...input,
      station: { ...station, id: "station-2", name: "Other radio" },
    });
    act(() => {
      audio.dispatchEvent(new Event("pause"));
      audio.dispatchEvent(new Event("emptied"));
    });
    expect(recorder.stop).toHaveBeenCalledTimes(1);
    expect(result.current.pending?.stationId).toBe("station-1");
    expect(result.current.pending?.stationName).toBe(station.name);
  });
  it.each(["pause", "ended", "emptied", "error"])(
    "saves captured data when the audio element emits %s",
    (event) => {
      const { result } = renderHook(() => useRecording(input));
      act(() => result.current.start());
      const recorder = recordChunk();
      act(() => audio.dispatchEvent(new Event(event)));
      expect(recorder.stop).toHaveBeenCalledTimes(1);
      expect(result.current.pending?.blob.size).toBeGreaterThan(0);
    },
  );
  it("stops on same-station source retries and doesn't stop during a transient buffer wait", () => {
    const { result, rerender } = renderHook((props) => useRecording(props), {
      initialProps: { ...input, sourceKey: 1 },
    });
    act(() => result.current.start());
    const recorder = recordChunk();
    rerender({ ...input, status: "loading", sourceKey: 1 });
    expect(recorder.stop).not.toHaveBeenCalled();
    rerender({ ...input, sourceKey: 2 });
    expect(recorder.stop).toHaveBeenCalledTimes(1);
  });
  it("stops when the account changes and preserves the original recording owner", () => {
    const { result, rerender } = renderHook((props) => useRecording(props), {
      initialProps: { ...input, ownerKey: "user-1" },
    });
    act(() => result.current.start());
    const recorder = recordChunk();
    rerender({ ...input, ownerKey: "user-2" });
    expect(recorder.stop).toHaveBeenCalledTimes(1);
    expect(result.current.pending?.ownerKey).toBe("user-1");
  });
  it("refuses direct, paused, missing and muted audio tracks without recording", () => {
    const { result, rerender } = renderHook((props) => useRecording(props), {
      initialProps: { ...input, relay: false },
    });
    act(() => result.current.start());
    expect(capture).not.toHaveBeenCalled();
    rerender({ ...input, status: "paused" });
    act(() => result.current.start());
    expect(capture).not.toHaveBeenCalled();
    rerender(input);
    capture.mockReturnValueOnce(new Stream([]));
    act(() => result.current.start());
    expect(result.current.notice).toContain("未能获取");
    track.muted = true;
    act(() => result.current.start());
    expect(Recorder.instances).toHaveLength(0);
    expect(track.stop).toHaveBeenCalled();
  });
  it("handles capture errors without leaving an active session", () => {
    capture.mockImplementationOnce(() => {
      throw new DOMException("blocked", "SecurityError");
    });
    const { result } = renderHook(() => useRecording(input));
    act(() => result.current.start());
    expect(result.current.phase).toBe("idle");
    expect(result.current.notice).toContain("无法开始录制");
    act(() => result.current.start());
    expect(result.current.phase).toBe("recording");
  });
  it("preserves already captured chunks on recorder error and ignores stale events", () => {
    const { result } = renderHook(() => useRecording(input));
    act(() => result.current.start());
    const old = recordChunk();
    const lateData = old.ondataavailable!;
    act(() => old.onerror?.());
    const size = result.current.pending!.blob.size;
    act(() => lateData({ data: new Blob(["late"]) }));
    expect(result.current.pending!.blob.size).toBe(size);
    expect(result.current.notice).toContain("录制中断");
  });
  it("enforces elapsed-time and memory limits", () => {
    localStorage.setItem("meow-recording", JSON.stringify({ maxMinutes: 5 }));
    const { result } = renderHook(() => useRecording(input));
    act(() => result.current.start());
    const first = recordChunk();
    act(() => {
      vi.setSystemTime(Date.now() + 301000);
      window.dispatchEvent(new Event("focus"));
    });
    expect(first.stop).toHaveBeenCalledTimes(1);
    expect(result.current.notice).toContain("设定时长");
    act(() => result.current.discard());
    track = new Track();
    act(() => result.current.start());
    const second = recordChunk();
    act(() => second.chunk({ size: MAX_RECORDING_BYTES } as Blob));
    expect(second.stop).toHaveBeenCalledTimes(1);
    expect(result.current.pending!.blob.size).toBe(14);
    expect(result.current.notice).toContain("100 MiB");
  });
  it("warns for unsaved recordings and removes the warning once saved", () => {
    const { result } = renderHook(() => useRecording(input));
    act(() => result.current.start());
    recordChunk();
    const during = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(during);
    expect(during.defaultPrevented).toBe(true);
    act(() => result.current.stop());
    const pending = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(pending);
    expect(pending.defaultPrevented).toBe(true);
    act(() => result.current.markSaved());
    const saved = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(saved);
    expect(saved.defaultPrevented).toBe(false);
    const url = result.current.pending!.url;
    act(() => result.current.discard());
    expect(revokeURL).toHaveBeenCalledWith(url);
  });
});

describe("recording interface", () => {
  it("shows supported formats only and propagates next-recording preferences", () => {
    expect(
      supportedRecordingFormats().map((format) => format.extension),
    ).toEqual(["webm", "ogg"]);
    render(
      <>
        <RecordingSettings />
        <RecordingSettings />
      </>,
    );
    const formatSelects = screen.getAllByLabelText(
      "录制格式",
    ) as HTMLSelectElement[];
    expect(formatSelects[0].options).toHaveLength(2);
    fireEvent.change(formatSelects[0], {
      target: { value: "audio/ogg;codecs=opus" },
    });
    expect(formatSelects[1].value).toBe("audio/ogg;codecs=opus");
    expect(readRecordingPreferences().mime).toBe("audio/ogg;codecs=opus");
  });
  it("requests relay without automatically recording after the switch", () => {
    const onRequestRelay = vi.fn();
    const { rerender } = render(
      <RecordingControl
        {...input}
        relay={false}
        onRequestRelay={onRequestRelay}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "开始录制" }));
    fireEvent.click(screen.getByRole("button", { name: "通过服务器播放" }));
    expect(onRequestRelay).toHaveBeenCalledOnce();
    rerender(<RecordingControl {...input} onRequestRelay={onRequestRelay} />);
    expect(Recorder.instances).toHaveLength(0);
  });
  it("uploads once after stop, retries errors and keeps a local download with correct metadata", async () => {
    const onRecorded = vi
      .fn()
      .mockRejectedValueOnce(new Error("network"))
      .mockResolvedValueOnce(undefined);
    const onOpenLibrary = vi.fn();
    render(
      <StrictMode>
        <RecordingControl
          {...input}
          onRequestRelay={vi.fn()}
          onRecorded={onRecorded}
          onOpenLibrary={onOpenLibrary}
        />
      </StrictMode>,
    );
    fireEvent.click(screen.getByRole("button", { name: "开始录制" }));
    recordChunk();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "停止录制" }));
    });
    expect(onRecorded).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("alert").textContent).toBe("network");
    fireEvent.click(screen.getByRole("button", { name: "关闭保存窗口" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "保存录音" }));
    expect(onRecorded).toHaveBeenCalledTimes(1);
    expect(onRecorded.mock.calls[0][0]).toMatchObject({
      stationId: station.id,
      stationName: station.name,
      mimeType: "audio/webm;codecs=opus",
    });
    const download = screen.getByRole("link", { name: "保存到本机" });
    expect(download.getAttribute("href")).toContain("blob:recording-");
    expect(download.getAttribute("download")).toContain("Radio__ One");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "重试保存到录音库" }));
    });
    expect(onRecorded).toHaveBeenCalledTimes(2);
    expect(screen.getByText("已保存到录音库")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "关闭保存窗口" }));
    fireEvent.click(screen.getByRole("button", { name: "查看本次录音" }));
    expect(screen.getByRole("link", { name: "保存到本机" })).toBeTruthy();
    expect(onRecorded).toHaveBeenCalledTimes(2);
    fireEvent.click(screen.getByRole("button", { name: "查看录音" }));
    expect(onOpenLibrary).toHaveBeenCalledOnce();
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
