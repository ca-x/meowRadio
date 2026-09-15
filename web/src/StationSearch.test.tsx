import { useState } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import StationSearch, { normalizeSearch } from "./StationSearch";
function Harness({ onCommit }: { onCommit: (v: string) => void }) {
  const [value, setValue] = useState("");
  const [query, setQuery] = useState("");
  return (
    <>
      <StationSearch
        value={value}
        committedValue={query}
        onChange={setValue}
        onCommit={(v) => {
          setQuery(v);
          onCommit(v);
        }}
      />
      <p id="search-help">Search by name</p>
      <button
        onClick={() => {
          setValue("");
          setQuery("");
        }}
      >
        Reset all
      </button>
    </>
  );
}
beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});
describe("station search", () => {
  it("normalizes FM frequency notation and full-width input without altering station names", () => {
    expect(normalizeSearch("  ＦＭ　１０４．２ MHz ")).toBe("104.2");
    expect(normalizeSearch("FM 100.00")).toBe("100");
    expect(normalizeSearch("FM4")).toBe("FM4");
    expect(normalizeSearch("  BBC   Radio 4 ")).toBe("BBC Radio 4");
    expect(normalizeSearch("FM 999")).toBe("FM 999");
  });
  it("debounces rapid input and commits only the final text", () => {
    const commit = vi.fn();
    render(<Harness onCommit={commit} />);
    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "B" } });
    act(() => vi.advanceTimersByTime(200));
    fireEvent.change(input, { target: { value: "BBC" } });
    act(() => vi.advanceTimersByTime(349));
    expect(commit).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(1));
    expect(commit).toHaveBeenCalledExactlyOnceWith("BBC");
  });
  it("does not search or clear while composing Chinese input", () => {
    const commit = vi.fn();
    render(<Harness onCommit={commit} />);
    const input = screen.getByRole("textbox");
    fireEvent.compositionStart(input);
    fireEvent.change(input, { target: { value: "bei" } });
    act(() => vi.advanceTimersByTime(500));
    fireEvent.keyDown(input, { key: "Escape", isComposing: true });
    expect((input as HTMLInputElement).value).toBe("bei");
    expect(commit).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: "北京" } });
    fireEvent.compositionEnd(input);
    act(() => vi.advanceTimersByTime(350));
    expect(commit).toHaveBeenCalledExactlyOnceWith("北京");
  });
  it("submits immediately and cancels the pending debounce", () => {
    const commit = vi.fn();
    render(<Harness onCommit={commit} />);
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "FM 104.2" },
    });
    fireEvent.submit(screen.getByRole("search"));
    expect(commit).toHaveBeenCalledExactlyOnceWith("104.2");
    act(() => vi.advanceTimersByTime(500));
    expect(commit).toHaveBeenCalledTimes(1);
  });
  it("clears immediately and prevents an obsolete search from returning", () => {
    const commit = vi.fn();
    render(<Harness onCommit={commit} />);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "BBC" } });
    fireEvent.click(screen.getByRole("button", { name: "清空搜索" }));
    act(() => vi.advanceTimersByTime(500));
    expect(commit).toHaveBeenCalledExactlyOnceWith("");
    expect((screen.getByRole("textbox") as HTMLInputElement).value).toBe("");
  });
  it("an external reset does not submit again after a later page change", () => {
    const commit = vi.fn();
    render(<Harness onCommit={commit} />);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "BBC" } });
    act(() => vi.advanceTimersByTime(350));
    commit.mockClear();
    fireEvent.click(screen.getByRole("button", { name: "Reset all" }));
    act(() => vi.advanceTimersByTime(500));
    expect(commit).not.toHaveBeenCalled();
  });
});
