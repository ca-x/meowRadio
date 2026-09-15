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
}));
vi.mock("./api", async (original) => ({
  ...(await original<object>()),
  api: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("hls.js", () => ({
  default: class {
    static Events = { MANIFEST_PARSED: "manifest", ERROR: "error" };
    static isSupported() {
      return true;
    }
    loadSource() {}
    attachMedia() {}
    destroy() {
      hls.destroy();
    }
    on(event: string, callback: () => void) {
      if (event === "manifest") hls.manifest = callback;
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
  it("preserves audio instance and playback when switching all four themes", () => {
    const { rerender } = render(<Player {...props} />);
    const audio = document.querySelector("audio");
    expect(HTMLMediaElement.prototype.play).toHaveBeenCalledTimes(1);
    rerender(<Player {...props} theme="vitreous" />);
    rerender(<Player {...props} theme="led" />);
    rerender(<Player {...props} theme="soft" />);
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
