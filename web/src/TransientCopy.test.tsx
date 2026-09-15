import { act, cleanup, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import TransientCopy from "./TransientCopy";
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});
it("shows decorative copy briefly, hides once without removing its layout slot, and does not replay on rerender", () => {
  vi.useFakeTimers();
  const { container, rerender } = render(
    <TransientCopy>短暂的口号</TransientCopy>,
  );
  const copy = container.firstElementChild!;
  expect(copy.getAttribute("data-phase")).toBe("visible");
  act(() => vi.advanceTimersByTime(1500));
  expect(copy.getAttribute("data-phase")).toBe("visible");
  act(() => vi.advanceTimersByTime(180));
  expect(copy.getAttribute("data-phase")).toBe("hidden");
  rerender(<TransientCopy>A translated slogan</TransientCopy>);
  expect(container.firstElementChild).toBe(copy);
  expect(copy.getAttribute("data-phase")).toBe("hidden");
  expect(copy.getAttribute("aria-hidden")).toBe("true");
});
