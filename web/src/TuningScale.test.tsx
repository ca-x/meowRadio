import { cleanup, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import TuningReceiver from "./TuningReceivers";
import type { Station } from "./api";

afterEach(cleanup);
function stations(count: number): Station[] {
  return Array.from({ length: count }, (_, index) => ({
    id: String(index),
    name: `Radio ${index}`,
    url: "https://radio.example/live",
    country: "",
    countrycode: "",
    tags: "jazz",
    codec: "MP3",
    bitrate: 128,
    hls: false,
  }));
}
function receiver(items: Station[], index: number) {
  return (
    <TuningReceiver
      variant="mono"
      station={items[index] || null}
      stations={items}
      playing={false}
      loading={false}
      moving={false}
      volume={0.7}
      saved={false}
      onVolume={vi.fn()}
      onSelect={vi.fn()}
      onToggle={vi.fn()}
      onNext={vi.fn()}
      onSave={vi.fn()}
    />
  );
}
it("retains scale labels with one or two matching stations", () => {
  const items = stations(2);
  const { container, rerender } = render(receiver(items.slice(0, 1), 0));
  expect(container.querySelector(".linear-unit b")?.textContent).toBe("01");
  rerender(receiver(items, 1));
  expect(
    [...container.querySelectorAll(".linear-unit b")].map(
      (item) => item.textContent,
    ),
  ).toEqual(["01", "02"]);
});
it("keeps a bounded scale for the complete catalog while showing the actual station number", () => {
  const items = stations(35000);
  const { container } = render(receiver(items, 20000));
  expect(container.querySelectorAll(".linear-unit").length).toBeLessThanOrEqual(
    21,
  );
  expect(
    [...container.querySelectorAll(".linear-unit b")].some(
      (item) => item.textContent === "20001",
    ),
  ).toBe(true);
});
