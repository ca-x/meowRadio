import {
  act,
  cleanup,
  render,
  renderHook,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import useTheme from "./useTheme";
import i18n, { setLanguage, tr } from "./i18n";
import StationSearch from "./StationSearch";
beforeEach(async () => {
  localStorage.clear();
  await i18n.changeLanguage("zh");
});
afterEach(async () => {
  cleanup();
  await i18n.changeLanguage("zh");
  localStorage.clear();
});
describe("language and color preferences", () => {
  it("translates the live interface and remembers language choice", async () => {
    render(
      <StationSearch
        value=""
        committedValue=""
        onChange={vi.fn()}
        onCommit={vi.fn()}
      />,
    );
    expect(screen.getByRole("textbox", { name: "搜索电台" })).toBeTruthy();
    await act(async () => setLanguage("en"));
    expect(
      screen.getByRole("textbox", { name: "Search stations" }),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Search now" })).toBeTruthy();
    expect(localStorage.getItem("meow-language")).toBe("en");
    expect(document.documentElement.lang).toBe("en");
    expect(tr("请先登录")).not.toMatch(/[\u3400-\u9fff]/);
  });
  it("keeps light/dark preference independent of receiver style across remounts", () => {
    const first = renderHook(() => useTheme());
    expect(first.result.current[2]).toBe("light");
    act(() => first.result.current[3]("dark"));
    expect(document.documentElement.dataset.color).toBe("dark");
    act(() => first.result.current[1]("soft"));
    expect(first.result.current[2]).toBe("dark");
    first.unmount();
    const second = renderHook(() => useTheme());
    expect(second.result.current[0]).toBe("soft");
    expect(second.result.current[2]).toBe("dark");
  });
});
