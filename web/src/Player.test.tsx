import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Player from "./Player";
import type { Station } from "./api";
const hls = vi.hoisted(() => ({
  manifest: undefined as (() => void) | undefined,
  destroy: vi.fn(),
  loadSource: vi.fn(),
  errors: [] as Array<(event: string, data: object) => void>,
}));
vi.mock("./api", async (original) => ({
  ...(await original<object>()),
  api: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("hls.js", () => ({
  default: class {
    static Events = { MANIFEST_PARSED: "manifest", ERROR: "error" };
    static ErrorTypes = { NETWORK_ERROR: "networkError" };
    static isSupported() {
      return true;
    }
    loadSource(source: string) {
      hls.loadSource(source);
    }
    attachMedia() {}
    destroy() {
      hls.destroy();
    }
    on(event: string, callback: (...args: never[]) => void) {
      if (event === "manifest") hls.manifest = callback;
      if (event === "error")
        hls.errors.push(callback as (event: string, data: object) => void);
    }
  },
}));
const station: Station = {
  id: "station-a",
  name: "Test station",
  url: "https://example.com/audio",
  country: "Test",
  countrycode: "US",
  tags: "jazz",
  codec: "MP3",
  bitrate: 128,
  hls: false,
};
const props = {
  theme: "walnut" as const,
  station,
  stations: [station],
  onSelect: vi.fn(),
  relay: false,
  saved: false,
  onSave: vi.fn(),
  selection: 1,
};
beforeEach(() => {
  hls.manifest = undefined;
  hls.errors = [];
  vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, "canPlayType").mockReturnValue("");
  // jsdom has no layout/CSS visibility; make the walnut control query unambiguous.
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
function power() {
  return document.querySelector(".power-button") as HTMLButtonElement;
}
describe("playback lifecycle", () => {
  it("does not autoplay without a selected station", () => {
    render(<Player {...props} station={null} />);
    expect(HTMLMediaElement.prototype.play).not.toHaveBeenCalled();
  });
  it("preserves audio instance and playback when switching all nine themes", () => {
    const { rerender } = render(<Player {...props} />);
    const audio = document.querySelector("audio");
    expect(HTMLMediaElement.prototype.play).toHaveBeenCalledTimes(1);
    rerender(<Player {...props} theme="vitreous" />);
    rerender(<Player {...props} theme="led" />);
    rerender(<Player {...props} theme="soft" />);
    for (const theme of ["arc", "ivory", "mono", "retro", "signal"] as const)
      rerender(<Player {...props} theme={theme} />);
    expect(document.querySelector("audio")).toBe(audio);
    expect(HTMLMediaElement.prototype.play).toHaveBeenCalledTimes(1);
  });
  it("does not let a late HLS manifest undo an intentional pause", async () => {
    render(<Player {...props} station={{ ...station, hls: true }} />);
    await waitFor(() => expect(hls.manifest).toBeTypeOf("function"));
    fireEvent.click(power());
    await act(async () => hls.manifest?.());
    expect(HTMLMediaElement.prototype.play).not.toHaveBeenCalled();
  });
  it("ignores an aborted play from the previous station", async () => {
    let reject!: (error: unknown) => void;
    vi.mocked(HTMLMediaElement.prototype.play).mockImplementationOnce(
      () =>
        new Promise((_resolve, r) => {
          reject = r;
        }),
    );
    const { rerender } = render(<Player {...props} />);
    rerender(
      <Player
        {...props}
        station={{ ...station, id: "station-b", name: "Second station" }}
      />,
    );
    await act(async () =>
      reject(new DOMException("interrupted", "AbortError")),
    );
    expect(screen.queryByRole("alert")).toBeNull();
  });
  it("handles blocked autoplay with an actionable error", async () => {
    vi.mocked(HTMLMediaElement.prototype.play).mockRejectedValue(
      new DOMException("blocked", "NotAllowedError"),
    );
    render(<Player {...props} />);
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toContain("电源键重试"),
    );
  });
  it("blocks non-http station protocols", () => {
    render(
      <Player
        {...props}
        station={{ ...station, url: "javascript:alert(1)" }}
      />,
    );
    expect(HTMLMediaElement.prototype.play).not.toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent).toContain("地址无效");
  });
});

it("updates an existing playback error when the interface language changes", async () => {
  const { default: i18n } = await import("./i18n");
  render(
    <Player {...props} station={{ ...station, url: "javascript:invalid" }} />,
  );
  expect(screen.getByRole("alert").textContent).toContain("地址无效");
  try {
    await act(async () => {
      await i18n.changeLanguage("en");
    });
    expect(screen.getByRole("alert").textContent?.toLowerCase()).toContain(
      "invalid",
    );
    expect(screen.getByRole("alert").textContent).not.toMatch(
      /[\u3400-\u9fff]/,
    );
  } finally {
    await act(async () => {
      await i18n.changeLanguage("zh");
    });
  }
});

it("loads relayed HLS through the authenticated origin instead of its HTTP address", async () => {
  render(
    <Player
      {...props}
      relay
      station={{ ...station, url: "http://example.com/live.m3u8", hls: true }}
    />,
  );
  await waitFor(() =>
    expect(hls.loadSource).toHaveBeenLastCalledWith("/api/stream/station-a"),
  );
  expect(screen.queryByRole("alert")).toBeNull();
});
it("starts motion only on playing and stops while buffering, muted, or hidden", () => {
  const { rerender } = render(<Player {...props} />);
  const visual = () => document.querySelector(".playback-visual--meter")!;
  const audio = document.querySelector("audio")!;
  expect(visual().getAttribute("data-running")).toBe("false");
  fireEvent.playing(audio);
  expect(visual().getAttribute("data-running")).toBe("true");
  fireEvent.waiting(audio);
  expect(visual().getAttribute("data-running")).toBe("false");
  fireEvent.playing(audio);
  rerender(<Player {...props} active={false} />);
  expect(visual().getAttribute("data-running")).toBe("false");
  rerender(<Player {...props} />);
  fireEvent.change(document.getElementById("volume")!, {
    target: { value: "0" },
  });
  expect(visual().getAttribute("data-running")).toBe("false");
});

describe("automatic stream recovery", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("reconnects an interrupted stream after two seconds without replacing the audio element", async () => {
    render(<Player {...props} />);
    const audio = document.querySelector("audio")!;
    fireEvent.playing(audio);
    fireEvent.error(audio);
    await act(async () => vi.advanceTimersByTime(1999));
    expect(HTMLMediaElement.prototype.play).toHaveBeenCalledTimes(1);
    await act(async () => vi.advanceTimersByTime(1));
    expect(HTMLMediaElement.prototype.play).toHaveBeenCalledTimes(2);
    expect(document.querySelector("audio")).toBe(audio);
    expect(audio.getAttribute("src")).toBe(station.url);
  });
  it.each(["ended", "stalled"])("reconnects after native %s", async (event) => {
    render(<Player {...props} />);
    const audio = document.querySelector("audio")!;
    fireEvent.playing(audio);
    fireEvent(audio, new Event(event));
    await act(async () => vi.advanceTimersByTime(2000));
    expect(HTMLMediaElement.prototype.play).toHaveBeenCalledTimes(2);
  });

  it("retries after a loading timeout", async () => {
    render(<Player {...props} />);
    await act(async () => vi.advanceTimersByTime(25000));
    expect(screen.getByRole("alert").textContent).toContain("重新连接");
    await act(async () => vi.advanceTimersByTime(2000));
    expect(HTMLMediaElement.prototype.play).toHaveBeenCalledTimes(2);
  });

  it("resumes an unexpectedly paused element when the page returns to the foreground", async () => {
    render(<Player {...props} />);
    fireEvent.playing(document.querySelector("audio")!);
    // jsdom's element remains paused, as if its process had been suspended.
    fireEvent(document, new Event("visibilitychange"));
    await act(async () => vi.advanceTimersByTime(2000));
    expect(HTMLMediaElement.prototype.play).toHaveBeenCalledTimes(2);
  });

  it("does not interrupt healthy playback on focus even if timeupdate was throttled", async () => {
    render(<Player {...props} />);
    const audio = document.querySelector("audio")!;
    Object.defineProperty(audio, "paused", {
      configurable: true,
      value: false,
    });
    fireEvent.playing(audio);
    await act(async () => vi.advanceTimersByTime(60000));
    audio.currentTime = 60;
    fireEvent.focus(window);
    await act(async () => vi.advanceTimersByTime(2000));
    expect(HTMLMediaElement.prototype.play).toHaveBeenCalledTimes(1);
  });

  it("recovers when playback stopped advancing without an error event", async () => {
    render(<Player {...props} />);
    const audio = document.querySelector("audio")!;
    Object.defineProperty(audio, "paused", {
      configurable: true,
      value: false,
    });
    fireEvent.playing(audio);
    await act(async () => vi.advanceTimersByTime(30000));
    fireEvent.focus(window);
    await act(async () => vi.advanceTimersByTime(2000));
    expect(HTMLMediaElement.prototype.play).toHaveBeenCalledTimes(2);
  });

  it("uses the pending attempt immediately on coming online and deduplicates wake events", async () => {
    render(<Player {...props} />);
    fireEvent.error(document.querySelector("audio")!);
    fireEvent.online(window);
    fireEvent.focus(window);
    await act(async () => vi.advanceTimersByTime(0));
    expect(HTMLMediaElement.prototype.play).toHaveBeenCalledTimes(2);
    await act(async () => vi.advanceTimersByTime(2000));
    expect(HTMLMediaElement.prototype.play).toHaveBeenCalledTimes(2);
  });

  it("cancels recovery on manual pause, including future wake events", async () => {
    render(<Player {...props} />);
    fireEvent.error(document.querySelector("audio")!);
    fireEvent.click(power());
    fireEvent.online(window);
    fireEvent.focus(window);
    await act(async () => vi.advanceTimersByTime(60000));
    expect(HTMLMediaElement.prototype.play).toHaveBeenCalledTimes(1);
    expect(power().getAttribute("aria-label")).toBe("开始收听");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("cancels recovery when the recording library requests a pause", async () => {
    const { rerender } = render(<Player {...props} />);
    fireEvent.error(document.querySelector("audio")!);
    rerender(<Player {...props} pauseRequest={1} />);
    fireEvent.online(window);
    await act(async () => vi.advanceTimersByTime(60000));
    expect(HTMLMediaElement.prototype.play).toHaveBeenCalledTimes(1);
  });

  it.each(["change", "logout"])(
    "discards the old retry after station %s",
    async (operation) => {
      const { rerender } = render(<Player {...props} />);
      fireEvent.error(document.querySelector("audio")!);
      const next =
        operation === "logout"
          ? null
          : { ...station, id: "station-b", url: "https://example.com/second" };
      rerender(<Player {...props} station={next} selection={2} />);
      if (next) fireEvent.playing(document.querySelector("audio")!);
      await act(async () => vi.advanceTimersByTime(2000));
      expect(HTMLMediaElement.prototype.play).toHaveBeenCalledTimes(
        next ? 2 : 1,
      );
      expect(document.querySelector("audio")!.getAttribute("src")).toBe(
        next?.url ?? null,
      );
    },
  );

  it("bounds attempts even when each connection briefly reports playing", async () => {
    render(<Player {...props} />);
    const audio = document.querySelector("audio")!;
    for (const delay of [2000, 4000, 8000, 16000, 30000, 30000]) {
      fireEvent.playing(audio);
      fireEvent.error(audio);
      await act(async () => vi.advanceTimersByTime(delay - 1));
      const calls = vi.mocked(HTMLMediaElement.prototype.play).mock.calls
        .length;
      await act(async () => vi.advanceTimersByTime(1));
      expect(HTMLMediaElement.prototype.play).toHaveBeenCalledTimes(calls + 1);
    }
    fireEvent.playing(audio);
    fireEvent.error(audio);
    await act(async () => vi.advanceTimersByTime(300000));
    expect(HTMLMediaElement.prototype.play).toHaveBeenCalledTimes(7);
    expect(screen.getByRole("alert").textContent).toContain("多次失败");
    expect(power().getAttribute("aria-label")).toBe("开始收听");
  });

  it("restores the initial backoff only after sustained playback progress", async () => {
    render(<Player {...props} />);
    const audio = document.querySelector("audio")!;
    fireEvent.error(audio);
    await act(async () => vi.advanceTimersByTime(2000));
    fireEvent.playing(audio);
    await act(async () => vi.advanceTimersByTime(30000));
    audio.currentTime = 30;
    fireEvent.timeUpdate(audio);
    fireEvent.error(audio);
    await act(async () => vi.advanceTimersByTime(2000));
    expect(HTMLMediaElement.prototype.play).toHaveBeenCalledTimes(3);
  });

  it("does not retry an unsupported codec", async () => {
    render(<Player {...props} />);
    const audio = document.querySelector("audio")!;
    Object.defineProperty(audio, "error", { value: { code: 4 } });
    fireEvent.error(audio);
    fireEvent.online(window);
    await act(async () => vi.advanceTimersByTime(60000));
    expect(HTMLMediaElement.prototype.play).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("alert").textContent).toContain("无法播放");
  });

  it("cancels a pending reconnection when the sleep timer expires", async () => {
    render(<Player {...props} />);
    const audio = document.querySelector("audio")!;
    fireEvent.playing(audio);
    fireEvent.click(screen.getByRole("button", { name: "定时关闭" }));
    fireEvent.change(screen.getByLabelText("分钟", { selector: "input" }), {
      target: { value: "1" },
    });
    fireEvent.click(screen.getByRole("button", { name: "开始计时" }));
    await act(async () => vi.advanceTimersByTime(59000));
    fireEvent.error(audio);
    await act(async () => vi.advanceTimersByTime(1000));
    fireEvent.focus(window);
    fireEvent.online(window);
    await act(async () => vi.advanceTimersByTime(60000));
    expect(HTMLMediaElement.prototype.play).toHaveBeenCalledTimes(1);
    expect(power().getAttribute("aria-label")).toBe("开始收听");
  });

  it("checks the sleep deadline before waking suspended playback", async () => {
    render(<Player {...props} />);
    fireEvent.playing(document.querySelector("audio")!);
    fireEvent.click(screen.getByRole("button", { name: "定时关闭" }));
    fireEvent.change(screen.getByLabelText("分钟", { selector: "input" }), {
      target: { value: "1" },
    });
    fireEvent.click(screen.getByRole("button", { name: "开始计时" }));
    vi.setSystemTime(Date.now() + 61000);
    fireEvent.focus(window);
    await act(async () => vi.advanceTimersByTime(3000));
    expect(HTMLMediaElement.prototype.play).toHaveBeenCalledTimes(1);
    expect(power().getAttribute("aria-label")).toBe("开始收听");
  });

  it("retries fatal HLS network errors and rejects late errors from the previous connection", async () => {
    render(<Player {...props} station={{ ...station, hls: true }} />);
    await act(async () => {});
    const stale = hls.errors[0];
    act(() => stale("error", { fatal: true, type: "networkError" }));
    await act(async () => vi.advanceTimersByTime(2000));
    expect(hls.errors).toHaveLength(2);
    act(() => stale("error", { fatal: true, type: "networkError" }));
    await act(async () => vi.advanceTimersByTime(4000));
    expect(hls.errors).toHaveLength(2);
  });

  it("stops automatic recovery and requests login on a relayed HLS 401", async () => {
    const onRelayAuthRequired = vi.fn();
    render(
      <Player
        {...props}
        relay
        station={{ ...station, hls: true }}
        onRelayAuthRequired={onRelayAuthRequired}
      />,
    );
    await act(async () => {});
    act(() =>
      hls.errors[0]("error", {
        fatal: true,
        type: "networkError",
        response: { code: 401 },
      }),
    );
    fireEvent.online(window);
    await act(async () => vi.advanceTimersByTime(60000));
    expect(onRelayAuthRequired).toHaveBeenCalledTimes(1);
    expect(hls.errors).toHaveLength(1);
    expect(screen.getByRole("alert").textContent).toBe("请先登录");
  });
  it("keeps an in-flight connection when focus and visibility events arrive", async () => {
    render(<Player {...props} />);
    fireEvent.focus(window);
    await act(async () => vi.advanceTimersByTime(0));
    fireEvent(document, new Event("visibilitychange"));
    await act(async () => vi.advanceTimersByTime(3000));
    expect(HTMLMediaElement.prototype.play).toHaveBeenCalledTimes(1);
  });

  it("retries on coming online even while the document is hidden", async () => {
    render(<Player {...props} />);
    fireEvent.error(document.querySelector("audio")!);
    vi.spyOn(document, "hidden", "get").mockReturnValue(true);
    fireEvent.online(window);
    await act(async () => vi.advanceTimersByTime(0));
    expect(HTMLMediaElement.prototype.play).toHaveBeenCalledTimes(2);
  });

  it("does not reconnect after unmount", async () => {
    const { unmount } = render(<Player {...props} />);
    fireEvent.error(document.querySelector("audio")!);
    unmount();
    fireEvent.online(window);
    await act(async () => vi.advanceTimersByTime(60000));
    expect(HTMLMediaElement.prototype.play).toHaveBeenCalledTimes(1);
  });

  it("ignores a late play rejection after pausing and starting a new connection", async () => {
    let reject!: (error: unknown) => void;
    vi.mocked(HTMLMediaElement.prototype.play).mockImplementationOnce(
      () =>
        new Promise((_resolve, fail) => {
          reject = fail;
        }),
    );
    render(<Player {...props} />);
    fireEvent.click(power());
    fireEvent.click(power());
    await act(async () => reject(new Error("late network failure")));
    fireEvent.playing(document.querySelector("audio")!);
    await act(async () => vi.advanceTimersByTime(2000));
    expect(HTMLMediaElement.prototype.play).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("alert")).toBeNull();
  });
  it("honors an expired sleep deadline on online recovery before its interval runs", async () => {
    render(<Player {...props} />);
    fireEvent.playing(document.querySelector("audio")!);
    fireEvent.click(screen.getByRole("button", { name: "定时关闭" }));
    fireEvent.change(screen.getByLabelText("分钟", { selector: "input" }), {
      target: { value: "1" },
    });
    fireEvent.click(screen.getByRole("button", { name: "开始计时" }));
    fireEvent.error(document.querySelector("audio")!);
    vi.setSystemTime(Date.now() + 61000);
    fireEvent.online(window);
    await act(async () => vi.advanceTimersByTime(0));
    expect(HTMLMediaElement.prototype.play).toHaveBeenCalledTimes(1);
    expect(power().getAttribute("aria-label")).toBe("开始收听");
    expect(screen.queryByRole("alert")).toBeNull();
  });
  it("recovers a previously playable stream misreported as unsupported while offline", async () => {
    render(<Player {...props} />);
    const audio = document.querySelector("audio")!;
    fireEvent.playing(audio);
    const online = vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
    Object.defineProperty(audio, "error", {
      configurable: true,
      value: { code: 4 },
    });
    fireEvent.error(audio);
    expect(screen.getByRole("alert").textContent).toContain("重新连接");
    online.mockReturnValue(true);
    Object.defineProperty(audio, "error", { configurable: true, value: null });
    fireEvent.online(window);
    await act(async () => vi.advanceTimersByTime(0));
    expect(HTMLMediaElement.prototype.play).toHaveBeenCalledTimes(2);
    fireEvent.playing(audio);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("retries an offline NotSupportedError play rejection when the network returns", async () => {
    const online = vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
    vi.mocked(HTMLMediaElement.prototype.play).mockRejectedValueOnce(
      new DOMException("offline", "NotSupportedError"),
    );
    render(<Player {...props} />);
    await act(async () => {});
    expect(screen.getByRole("alert").textContent).toContain("重新连接");
    online.mockReturnValue(true);
    fireEvent.online(window);
    await act(async () => vi.advanceTimersByTime(0));
    expect(HTMLMediaElement.prototype.play).toHaveBeenCalledTimes(2);
  });

  it.each(["online", "focus"])(
    "starts a fresh bounded recovery cycle on %s after exhausting retries",
    async (event) => {
      render(<Player {...props} />);
      const audio = document.querySelector("audio")!;
      for (const delay of [2000, 4000, 8000, 16000, 30000, 30000]) {
        fireEvent.error(audio);
        await act(async () => vi.advanceTimersByTime(delay));
      }
      fireEvent.error(audio);
      await act(async () => vi.advanceTimersByTime(300000));
      expect(HTMLMediaElement.prototype.play).toHaveBeenCalledTimes(7);
      fireEvent(window, new Event(event));
      await act(async () => vi.advanceTimersByTime(0));
      expect(HTMLMediaElement.prototype.play).toHaveBeenCalledTimes(8);
      fireEvent.error(audio);
      await act(async () => vi.advanceTimersByTime(2000));
      expect(HTMLMediaElement.prototype.play).toHaveBeenCalledTimes(9);
      fireEvent.click(power());
      fireEvent.online(window);
      await act(async () => vi.advanceTimersByTime(60000));
      expect(HTMLMediaElement.prototype.play).toHaveBeenCalledTimes(9);
    },
  );

  it.each(["pause", "sleep"])(
    "keeps exhausted recovery stopped after %s",
    async (action) => {
      const { rerender } = render(<Player {...props} />);
      const audio = document.querySelector("audio")!;
      if (action === "sleep") {
        fireEvent.click(screen.getByRole("button", { name: "定时关闭" }));
        fireEvent.change(screen.getByLabelText("分钟", { selector: "input" }), {
          target: { value: "2" },
        });
        fireEvent.click(screen.getByRole("button", { name: "开始计时" }));
      }
      for (const delay of [2000, 4000, 8000, 16000, 30000, 30000]) {
        fireEvent.error(audio);
        await act(async () => vi.advanceTimersByTime(delay));
      }
      fireEvent.error(audio);
      if (action === "pause") rerender(<Player {...props} pauseRequest={1} />);
      else await act(async () => vi.advanceTimersByTime(30000));
      fireEvent.online(window);
      fireEvent.focus(window);
      await act(async () => vi.advanceTimersByTime(60000));
      expect(HTMLMediaElement.prototype.play).toHaveBeenCalledTimes(7);
    },
  );
  it.each(["media", "promise"])(
    "treats an unsupported %s error as transient for a proven stream even if the browser reports online",
    async (failure) => {
      render(<Player {...props} />);
      const audio = document.querySelector("audio")!;
      fireEvent.playing(audio);
      expect(navigator.onLine).toBe(true);
      if (failure === "media") {
        Object.defineProperty(audio, "error", {
          configurable: true,
          value: { code: 4 },
        });
        fireEvent.error(audio);
      } else {
        vi.mocked(HTMLMediaElement.prototype.play).mockRejectedValueOnce(
          new DOMException("network loss", "NotSupportedError"),
        );
        fireEvent.stalled(audio);
        await act(async () => vi.advanceTimersByTime(2000));
      }
      expect(screen.getByRole("alert").textContent).toContain("重新连接");
      fireEvent.online(window);
      await act(async () => vi.advanceTimersByTime(0));
      expect(HTMLMediaElement.prototype.play).toHaveBeenCalledTimes(
        failure === "media" ? 2 : 3,
      );
    },
  );
});
