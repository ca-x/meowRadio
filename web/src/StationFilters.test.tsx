import { useState } from "react";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import StationFilters, { DEFAULT_FILTERS } from "./StationFilters";
import type { Filters } from "./StationFilters";
import { api } from "./api";
vi.mock("./api", () => ({ api: vi.fn() }));
function Harness({ apply }: { apply: (v: Filters) => void }) {
  const [filters, setFilters] = useState({ ...DEFAULT_FILTERS });
  return (
    <StationFilters
      value={filters}
      onApply={(v) => {
        setFilters(v);
        apply(v);
      }}
    />
  );
}
function mount(apply = vi.fn()) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <Harness apply={apply} />
    </QueryClientProvider>,
  );
  return apply;
}
beforeEach(() => {
  vi.mocked(api).mockResolvedValue({
    countries: [
      { value: "CN", label: "China", count: 500 },
      { value: "FR", label: "France", count: 900 },
    ],
    languages: [{ value: "chinese", label: "chinese", count: 500 }],
    tags: [{ value: "news", label: "news", count: 80 }],
  });
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});
describe("restrained station filtering", () => {
  it("shows only the entry and fetches options only when opened", async () => {
    mount();
    expect(screen.queryByRole("combobox")).toBeNull();
    expect(api).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "筛选电台" }));
    await screen.findByRole("option", { name: /法国/ });
    expect(api).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("dialog")).toBeTruthy();
  });
  it("applies country/language without a keyword and keeps a compact count", async () => {
    const apply = mount();
    fireEvent.click(screen.getByRole("button", { name: "筛选电台" }));
    await screen.findByRole("option", { name: /中国/ });
    fireEvent.change(screen.getByRole("combobox", { name: "国家 / 地区" }), {
      target: { value: "CN" },
    });
    fireEvent.change(screen.getByRole("combobox", { name: "语言" }), {
      target: { value: "chinese" },
    });
    expect(apply).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "应用筛选" }));
    expect(apply).toHaveBeenCalledWith({
      ...DEFAULT_FILTERS,
      country: "CN",
      language: "chinese",
    });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(
      screen.getByRole("button", { name: "筛选电台，已启用 2 项" }),
    ).toBeTruthy();
  });
  it("closing discards draft edits and restores focus to the entry", async () => {
    const apply = mount();
    const trigger = screen.getByRole("button", { name: "筛选电台" });
    fireEvent.click(trigger);
    await screen.findByRole("option", { name: /法国/ });
    fireEvent.change(screen.getByRole("combobox", { name: "国家 / 地区" }), {
      target: { value: "FR" },
    });
    fireEvent.click(screen.getByRole("button", { name: "关闭筛选" }));
    expect(apply).not.toHaveBeenCalled();
    await waitFor(() => expect(document.activeElement).toBe(trigger));
    fireEvent.click(trigger);
    expect(
      (
        screen.getByRole("combobox", {
          name: "国家 / 地区",
        }) as HTMLSelectElement
      ).value,
    ).toBe("");
  });
});

it("offers only visible countries while keeping the worldwide reset", async () => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <StationFilters
        value={{ ...DEFAULT_FILTERS }}
        onApply={vi.fn()}
        visibleCountries={["CN"]}
      />
    </QueryClientProvider>,
  );
  fireEvent.click(screen.getByRole("button", { name: "筛选电台" }));
  await screen.findByRole("option", { name: /中国/ });
  expect(screen.queryByRole("option", { name: /法国/ })).toBeNull();
  expect(screen.getByRole("option", { name: "世界各地" })).toBeTruthy();
  expect(screen.getByRole("combobox", { name: "国家 / 地区" })).toBeTruthy();
});
