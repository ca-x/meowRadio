import { StrictMode } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import SleepTimer from "./SleepTimer";

vi.mock("react-i18next", () => ({ useTranslation: () => ({}) }));
vi.mock("./i18n", () => ({
  tr: (key: string, options: Record<string, unknown> = {}) =>
    key.replace(/\{\{(\w+)\}\}/g, (_, name: string) =>
      String(options[name] ?? ""),
    ),
}));

beforeEach(() => {
  localStorage.removeItem("meow-countdown-lead");
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-15T20:00:00Z"));
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
function open() {
  fireEvent.click(screen.getByRole("button", { name: /定时关闭|后关闭/ }));
}
function schedule(minutes = 1) {
  open();
  fireEvent.change(screen.getByRole("spinbutton", { name: "分钟" }), {
    target: { value: String(minutes) },
  });
  fireEvent.click(screen.getByRole("button", { name: "开始计时" }));
}

describe("sleep timer", () => {
  it("expires exactly once and preserves the deadline across rerenders", () => {
    const onExpire = vi.fn();
    const nextCallback = vi.fn();
    const { rerender } = render(
      <StrictMode>
        <SleepTimer onExpire={onExpire} />
      </StrictMode>,
    );
    schedule();
    act(() => vi.advanceTimersByTime(30_000));
    expect(screen.getByRole("button", { name: "00:30 后关闭" })).toBeTruthy();
    rerender(
      <StrictMode>
        <SleepTimer onExpire={nextCallback} />
      </StrictMode>,
    );
    act(() => vi.advanceTimersByTime(30_000));
    expect(onExpire).not.toHaveBeenCalled();
    expect(nextCallback).toHaveBeenCalledTimes(1);
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
      window.dispatchEvent(new Event("focus"));
      vi.advanceTimersByTime(120_000);
    });
    expect(nextCallback).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "定时关闭" })).toBeTruthy();
  });

  it("checks real elapsed time on returning from a suspended tab", () => {
    const onExpire = vi.fn();
    render(<SleepTimer onExpire={onExpire} />);
    schedule();
    act(() => {
      vi.setSystemTime(Date.now() + 180_000);
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(onExpire).toHaveBeenCalledTimes(1);
  });

  it("cancels without stopping playback even if controls become disabled", () => {
    const onExpire = vi.fn();
    const { rerender } = render(<SleepTimer onExpire={onExpire} />);
    schedule();
    rerender(<SleepTimer onExpire={onExpire} disabled />);
    open();
    fireEvent.click(screen.getByRole("button", { name: "取消定时" }));
    act(() => vi.advanceTimersByTime(120_000));
    expect(onExpire).not.toHaveBeenCalled();
    expect(
      (screen.getByRole("button", { name: "定时关闭" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });

  it("replaces the previous deadline when restarted", () => {
    const onExpire = vi.fn();
    render(<SleepTimer onExpire={onExpire} />);
    schedule();
    act(() => vi.advanceTimersByTime(30_000));
    open();
    fireEvent.change(screen.getByRole("spinbutton", { name: "分钟" }), {
      target: { value: "2" },
    });
    fireEvent.click(screen.getByRole("button", { name: "重新计时" }));
    act(() => vi.advanceTimersByTime(30_000));
    expect(onExpire).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(90_000));
    expect(onExpire).toHaveBeenCalledTimes(1);
  });

  it("supports keyboard hands, presets, numeric bounds and zero-duration protection", () => {
    render(<SleepTimer onExpire={vi.fn()} />);
    open();
    const hour = screen.getByRole("slider", { name: "时针" });
    const minute = screen.getByRole("slider", { name: "分针" });
    fireEvent.keyDown(hour, { key: "ArrowUp" });
    fireEvent.keyDown(minute, { key: "ArrowLeft" });
    expect(hour.getAttribute("aria-valuenow")).toBe("1");
    expect(minute.getAttribute("aria-valuenow")).toBe("29");
    fireEvent.keyDown(hour, { key: "End" });
    fireEvent.keyDown(minute, { key: "End" });
    expect(hour.getAttribute("aria-valuenow")).toBe("11");
    expect(minute.getAttribute("aria-valuenow")).toBe("59");
    fireEvent.click(screen.getByRole("button", { name: "15 分钟" }));
    expect(hour.getAttribute("aria-valuenow")).toBe("0");
    expect(minute.getAttribute("aria-valuenow")).toBe("15");
    fireEvent.change(screen.getByRole("spinbutton", { name: "小时" }), {
      target: { value: "40" },
    });
    expect(hour.getAttribute("aria-valuenow")).toBe("11");
    fireEvent.keyDown(hour, { key: "Home" });
    fireEvent.keyDown(minute, { key: "Home" });
    expect(
      (screen.getByRole("button", { name: "开始计时" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });

  it("captures hand drags and ignores additional pointers", () => {
    class TestPointerEvent extends MouseEvent {
      pointerId: number;
      constructor(type: string, options: PointerEventInit) {
        super(type, options);
        this.pointerId = options.pointerId ?? 0;
      }
    }
    vi.stubGlobal("PointerEvent", TestPointerEvent);
    render(<SleepTimer onExpire={vi.fn()} />);
    open();
    const minute = screen.getByRole("slider", { name: "分针" });
    const hour = screen.getByRole("slider", { name: "时针" });
    const capture = vi.fn();
    const release = vi.fn();
    Object.defineProperties(minute, {
      setPointerCapture: { value: capture },
      hasPointerCapture: { value: () => true },
      releasePointerCapture: { value: release },
    });
    vi.spyOn(
      document.querySelector(".sleep-timer-clock")!,
      "getBoundingClientRect",
    ).mockReturnValue({
      left: 0,
      top: 0,
      width: 240,
      height: 240,
      right: 240,
      bottom: 240,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });
    fireEvent.pointerDown(minute, {
      pointerId: 1,
      button: 0,
      clientX: 120,
      clientY: 20,
    });
    expect(capture).toHaveBeenCalledWith(1);
    fireEvent.pointerDown(hour, {
      pointerId: 2,
      button: 0,
      clientX: 240,
      clientY: 120,
    });
    expect(hour.getAttribute("aria-valuenow")).toBe("0");
    fireEvent.pointerMove(minute, { pointerId: 1, clientX: 240, clientY: 120 });
    expect(minute.getAttribute("aria-valuenow")).toBe("15");
    fireEvent.pointerUp(minute, { pointerId: 1 });
    expect(release).toHaveBeenCalledWith(1);
    fireEvent.pointerMove(minute, { pointerId: 1, clientX: 120, clientY: 240 });
    expect(minute.getAttribute("aria-valuenow")).toBe("15");
  });

  it("closes the portal when inactive while preserving the deadline", () => {
    const onExpire = vi.fn();
    const { rerender } = render(<SleepTimer onExpire={onExpire} />);
    schedule();
    open();
    expect(screen.queryByRole("dialog")).toBeTruthy();
    rerender(<SleepTimer onExpire={onExpire} active={false} />);
    expect(screen.queryByRole("dialog")).toBeNull();
    act(() => vi.advanceTimersByTime(60_000));
    expect(onExpire).toHaveBeenCalledTimes(1);
    rerender(<SleepTimer onExpire={onExpire} active />);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("removes pending work when unmounted", () => {
    const onExpire = vi.fn();
    const { unmount } = render(<SleepTimer onExpire={onExpire} />);
    schedule();
    unmount();
    act(() => vi.advanceTimersByTime(120_000));
    expect(onExpire).not.toHaveBeenCalled();
  });
});

describe("final countdown reminder", () => {
  it("enters at the exact default boundary and announces the phase once", () => {
    render(<SleepTimer onExpire={vi.fn()} />);
    schedule();
    act(() => vi.advanceTimersByTime(29_000));
    expect(screen.queryByRole("timer")).toBeNull();
    act(() => vi.advanceTimersByTime(1000));
    const reminder = screen.getByRole("timer", { name: "即将停止播放" });
    expect(reminder.textContent).toContain("00:30");
    expect(reminder.getAttribute("data-animate")).toBe("true");
    const announcement = screen.getByRole("status").textContent;
    expect(announcement).toBe("即将停止播放，已进入最后倒计时");
    act(() => vi.advanceTimersByTime(10_000));
    expect(reminder.textContent).toContain("00:20");
    expect(screen.getByRole("status").textContent).toBe(announcement);
    act(() => vi.advanceTimersByTime(20_000));
    expect(screen.queryByRole("timer")).toBeNull();
  });

  it("applies a new threshold immediately without restarting playback time", () => {
    const onExpire = vi.fn();
    render(<SleepTimer onExpire={onExpire} />);
    schedule();
    act(() => vi.advanceTimersByTime(15_000));
    open();
    fireEvent.change(screen.getByRole("combobox", { name: "提前强调倒计时" }), {
      target: { value: "60" },
    });
    fireEvent.click(screen.getByRole("button", { name: "关闭定时设置" }));
    expect(screen.getByRole("timer").textContent).toContain("00:45");
    expect(screen.getByRole("timer").getAttribute("data-animate")).toBe(
      "false",
    );
    act(() => vi.advanceTimersByTime(45_000));
    expect(onExpire).toHaveBeenCalledTimes(1);
  });

  it("turns off the reminder without affecting expiry", () => {
    const onExpire = vi.fn();
    render(<SleepTimer onExpire={onExpire} />);
    open();
    fireEvent.change(screen.getByRole("combobox", { name: "提前强调倒计时" }), {
      target: { value: "0" },
    });
    fireEvent.change(screen.getByRole("spinbutton", { name: "分钟" }), {
      target: { value: "1" },
    });
    fireEvent.click(screen.getByRole("button", { name: "开始计时" }));
    act(() => vi.advanceTimersByTime(59_000));
    expect(screen.queryByRole("timer")).toBeNull();
    expect(screen.getByRole("status").textContent).toBe("已设置定时关闭");
    act(() => vi.advanceTimersByTime(1000));
    expect(onExpire).toHaveBeenCalledTimes(1);
  });

  it("persists the threshold and shows immediate user-requested emphasis without motion", () => {
    const { unmount } = render(<SleepTimer onExpire={vi.fn()} />);
    open();
    fireEvent.change(screen.getByRole("combobox", { name: "提前强调倒计时" }), {
      target: { value: "300" },
    });
    expect(localStorage.getItem("meow-countdown-lead")).toBe("300");
    unmount();
    render(<SleepTimer onExpire={vi.fn()} />);
    open();
    expect(
      (
        screen.getByRole("combobox", {
          name: "提前强调倒计时",
        }) as HTMLSelectElement
      ).value,
    ).toBe("300");
    fireEvent.change(screen.getByRole("spinbutton", { name: "分钟" }), {
      target: { value: "1" },
    });
    fireEvent.click(screen.getByRole("button", { name: "开始计时" }));
    expect(screen.getByRole("timer").getAttribute("data-animate")).toBe(
      "false",
    );
  });

  it("resets the final phase on restart and clears it on cancel", () => {
    render(<SleepTimer onExpire={vi.fn()} />);
    schedule();
    act(() => vi.advanceTimersByTime(30_000));
    expect(screen.getByRole("timer")).toBeTruthy();
    open();
    fireEvent.click(screen.getByRole("button", { name: "重新计时" }));
    expect(screen.queryByRole("timer")).toBeNull();
    expect(screen.getByRole("status").textContent).toBe("已设置定时关闭");
    act(() => vi.advanceTimersByTime(30_000));
    expect(screen.getByRole("timer")).toBeTruthy();
    expect(screen.getByRole("status").textContent).toBe(
      "即将停止播放，已进入最后倒计时",
    );
    open();
    fireEvent.click(screen.getByRole("button", { name: "取消定时" }));
    expect(screen.queryByRole("timer")).toBeNull();
  });

  it("preserves the final phase while the listening route is hidden", () => {
    const { rerender } = render(<SleepTimer onExpire={vi.fn()} />);
    schedule();
    act(() => vi.advanceTimersByTime(30_000));
    rerender(<SleepTimer onExpire={vi.fn()} active={false} />);
    expect(screen.queryByRole("timer")).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
    act(() => vi.advanceTimersByTime(5000));
    rerender(<SleepTimer onExpire={vi.fn()} active />);
    expect(screen.getByRole("timer").textContent).toContain("00:25");
  });

  it("uses the default for corrupt preferences and tolerates unavailable storage", () => {
    localStorage.setItem("meow-countdown-lead", "invalid");
    const { unmount } = render(<SleepTimer onExpire={vi.fn()} />);
    open();
    expect(
      (
        screen.getByRole("combobox", {
          name: "提前强调倒计时",
        }) as HTMLSelectElement
      ).value,
    ).toBe("30");
    unmount();
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("unavailable");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("unavailable");
    });
    render(<SleepTimer onExpire={vi.fn()} />);
    schedule();
    act(() => vi.advanceTimersByTime(30_000));
    expect(screen.getByRole("timer")).toBeTruthy();
  });
});
