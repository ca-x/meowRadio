import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import useLazycatControls, {
  type LazycatControlsOptions,
} from "./useLazycatControls";

const mocks = vi.hoisted(() => ({
  ios: vi.fn(() => false),
  android: vi.fn(() => true),
  available: vi.fn(() => true),
  metadata: vi.fn().mockResolvedValue(undefined),
  playback: vi.fn().mockResolvedValue(undefined),
  action: vi.fn().mockResolvedValue(undefined),
  position: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@lazycatcloud/sdk/dist/extentions/base", () => ({
  default: { isIosWebShell: mocks.ios, isAndroidWebShell: mocks.android },
}));
vi.mock("@lazycatcloud/sdk/dist/extentions/mediasession/index", () => ({
  isMediaSessionAvailable: mocks.available,
  MediaSession: {
    setMetadata: mocks.metadata,
    setPlaybackState: mocks.playback,
    setActionHandler: mocks.action,
    setPositionState: mocks.position,
  },
}));

function options(): LazycatControlsOptions {
  return {
    station: {
      id: "a",
      name: "Jazz FM",
      country: "France",
      countrycode: "FR",
      tags: "jazz",
      url: "https://example.com/live",
      hls: false,
      codec: "MP3",
      bitrate: 128,
    },
    status: "playing",
    onPlay: vi.fn(),
    onPause: vi.fn(),
    onNext: vi.fn(),
    onPrevious: vi.fn(),
  };
}
const statusColor = vi.fn();
const visibility = vi.fn();
beforeEach(() => {
  vi.clearAllMocks();
  mocks.ios.mockReturnValue(false);
  mocks.android.mockReturnValue(true);
  mocks.available.mockReturnValue(true);
  vi.spyOn(navigator, "userAgent", "get").mockReturnValue("Lazycat_101");
  vi.stubGlobal("lzc_window", { SetStatusBarColor: statusColor });
  vi.stubGlobal("lzc_tab", { SetControlViewVisibility: visibility });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.documentElement.removeAttribute("data-color");
  document.documentElement.style.removeProperty("--canvas");
});

it("does not load capabilities or call hosts in an ordinary browser, even on a LazyCat domain", async () => {
  vi.mocked(
    Object.getOwnPropertyDescriptor(navigator, "userAgent")!.get!,
  ).mockReturnValue("Mozilla/5.0");
  const { unmount } = renderHook(() => useLazycatControls(options()));
  await act(async () => {});
  unmount();
  expect(mocks.ios).not.toHaveBeenCalled();
  expect(mocks.android).not.toHaveBeenCalled();
  expect(mocks.available).not.toHaveBeenCalled();
  expect(mocks.action).not.toHaveBeenCalled();
  expect(statusColor).not.toHaveBeenCalled();
  expect(visibility).not.toHaveBeenCalled();
  expect(document.querySelector('meta[name^="lzcapp-"]')).toBeNull();
  expect(document.documentElement.dataset.lazycatWebshell).toBeUndefined();
});

it("requires official SDK confirmation after the user-agent prefilter", async () => {
  mocks.android.mockReturnValue(false);
  renderHook(() => useLazycatControls(options()));
  await waitFor(() => expect(mocks.android).toHaveBeenCalled());
  expect(statusColor).not.toHaveBeenCalled();
  expect(mocks.available).not.toHaveBeenCalled();
  expect(document.querySelector('meta[name^="lzcapp-"]')).toBeNull();
});

it("publishes real playback and station metadata without a seek position", async () => {
  const initial = options();
  const { rerender } = renderHook((props) => useLazycatControls(props), {
    initialProps: initial,
  });
  await waitFor(() => expect(mocks.action).toHaveBeenCalledTimes(4));
  expect(mocks.metadata).toHaveBeenLastCalledWith({
    title: "Jazz FM",
    artist: "France",
    album: "meowRadio",
  });
  expect(mocks.playback).toHaveBeenLastCalledWith({ playbackState: "playing" });
  rerender({
    ...initial,
    status: "loading",
    station: { ...initial.station!, name: "News" },
  });
  expect(mocks.metadata).toHaveBeenLastCalledWith(
    expect.objectContaining({ title: "News" }),
  );
  expect(mocks.playback).toHaveBeenLastCalledWith({ playbackState: "paused" });
  rerender({ ...initial, station: null, status: "idle" });
  expect(mocks.playback).toHaveBeenLastCalledWith({ playbackState: "none" });
  expect(mocks.position).not.toHaveBeenCalled();
});

it("routes host actions to current callbacks and guards play/pause against toggling", async () => {
  const initial = options();
  const { rerender, unmount } = renderHook(
    (props) => useLazycatControls(props),
    { initialProps: initial },
  );
  await waitFor(() => expect(mocks.action).toHaveBeenCalledTimes(4));
  const handlers = Object.fromEntries(
    mocks.action.mock.calls.map(([arg, handler]) => [arg.action, handler]),
  );
  handlers.play();
  handlers.pause();
  expect(initial.onPlay).not.toHaveBeenCalled();
  expect(initial.onPause).toHaveBeenCalledOnce();
  const updated = { ...options(), status: "paused" as const };
  rerender(updated);
  handlers.play();
  handlers.pause();
  handlers.nexttrack();
  handlers.previoustrack();
  expect(updated.onPlay).toHaveBeenCalledOnce();
  expect(updated.onPause).not.toHaveBeenCalled();
  expect(updated.onNext).toHaveBeenCalledOnce();
  expect(updated.onPrevious).toHaveBeenCalledOnce();
  unmount();
  handlers.play();
  expect(updated.onPlay).toHaveBeenCalledOnce();
  expect(
    mocks.action.mock.calls
      .slice(-4)
      .every(([, callback]) => callback === null),
  ).toBe(true);
  expect(mocks.playback).toHaveBeenLastCalledWith({ playbackState: "none" });
});

it("keeps Android exit controls visible and follows app theme colors", async () => {
  document.documentElement.style.setProperty("--canvas", "#eeeae3");
  renderHook(() => useLazycatControls(options()));
  await waitFor(() => expect(visibility).toHaveBeenCalledWith(true));
  expect(statusColor).toHaveBeenLastCalledWith("#eeeae3");
  await act(async () => {
    document.documentElement.style.setProperty("--canvas", "#080b12");
    document.documentElement.dataset.color = "dark";
  });
  expect(statusColor).toHaveBeenLastCalledWith("#080b12");
});

it("uses iOS chrome metadata and restores it on unmount without Android calls", async () => {
  vi.mocked(
    Object.getOwnPropertyDescriptor(navigator, "userAgent")!.get!,
  ).mockReturnValue("Lazycat_103");
  vi.stubGlobal("webkit", {
    messageHandlers: { ScriptHandlers: { postMessage: vi.fn() } },
  });
  mocks.ios.mockReturnValue(true);
  const { unmount } = renderHook(() => useLazycatControls(options()));
  await waitFor(() =>
    expect(document.documentElement.dataset.lazycatWebshell).toBe("ios"),
  );
  expect(
    document
      .querySelector('meta[name="lzcapp-navigation-bar-scheme"]')
      ?.getAttribute("content"),
  ).toBe("statusBarOnly");
  expect(
    document
      .querySelector('meta[name="lzcapp-state-bar-color"]')
      ?.getAttribute("content"),
  ).toBe("#eeeae3");
  expect(mocks.available).not.toHaveBeenCalled();
  expect(statusColor).not.toHaveBeenCalled();
  expect(visibility).not.toHaveBeenCalled();
  unmount();
  expect(document.querySelector('meta[name^="lzcapp-"]')).toBeNull();
  expect(document.documentElement.dataset.lazycatWebshell).toBeUndefined();
});

it("tolerates missing iOS bridges and unavailable Android media sessions", async () => {
  mocks.available.mockReturnValue(false);
  const { unmount } = renderHook(() => useLazycatControls(options()));
  await waitFor(() => expect(mocks.available).toHaveBeenCalled());
  expect(mocks.action).not.toHaveBeenCalled();
  unmount();
  vi.clearAllMocks();
  vi.mocked(
    Object.getOwnPropertyDescriptor(navigator, "userAgent")!.get!,
  ).mockReturnValue("Lazycat_103");
  renderHook(() => useLazycatControls(options()));
  await act(async () => {});
  expect(mocks.ios).not.toHaveBeenCalled();
  expect(statusColor).not.toHaveBeenCalled();
});

it("contains rejected media APIs and throwing host controls", async () => {
  statusColor.mockImplementationOnce(() => {
    throw new Error("unsupported");
  });
  mocks.metadata.mockRejectedValueOnce(new Error("unsupported"));
  renderHook(() => useLazycatControls(options()));
  await waitFor(() => expect(mocks.playback).toHaveBeenCalled());
  expect(mocks.action).toHaveBeenCalledTimes(4);
});
