import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import RecordingLibrary from "./RecordingLibrary";
import { api, rawApi } from "./api";
const file = {
  id: "recording-a",
  title: "Morning radio",
  station_id: "station-a",
  station_name: "Test FM",
  mime_type: "audio/webm",
  size_bytes: 1000,
  duration_seconds: 25,
  created_at: 1700000000,
};
vi.mock("./api", async (original) => ({
  ...(await original<object>()),
  api: vi.fn(),
}));
beforeEach(() => {
  vi.mocked(api).mockResolvedValue([file]);
  vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
function mount() {
  const onPlay = vi.fn();
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <RecordingLibrary userId={1} enabled onPlay={onPlay} onSignIn={vi.fn()} />
    </QueryClientProvider>,
  );
  return onPlay;
}
it("plays server audio in-app, can replay, and pauses live audio only once actual playback begins", async () => {
  const onPlay = mount();
  fireEvent.click(
    await screen.findByRole("button", { name: "试听 Morning radio" }),
  );
  const audio = document.querySelector("audio")!;
  expect(audio.getAttribute("src")).toBe("/api/recordings/recording-a/audio");
  expect(onPlay).not.toHaveBeenCalled();
  fireEvent.play(audio);
  expect(onPlay).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByRole("button", { name: "试听 Morning radio" }));
  await waitFor(() =>
    expect(HTMLMediaElement.prototype.play).toHaveBeenCalledTimes(2),
  );
});
it("requires explicit confirmation before deleting a recording", async () => {
  mount();
  fireEvent.click(
    await screen.findByRole("button", { name: "删除 Morning radio" }),
  );
  expect(api).not.toHaveBeenCalledWith("/recordings/recording-a", "DELETE");
  fireEvent.click(screen.getByRole("button", { name: "取消" }));
  expect(screen.queryByRole("button", { name: "确认删除" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "删除 Morning radio" }));
  fireEvent.click(screen.getByRole("button", { name: "确认删除" }));
  await waitFor(() =>
    expect(api).toHaveBeenCalledWith("/recordings/recording-a", "DELETE"),
  );
});
it("sends the recording owner with raw uploads instead of relying on cached identity", async () => {
  const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(JSON.stringify(file), {
      status: 201,
      headers: { "content-type": "application/json" },
    }),
  );
  const blob = new Blob(["audio"], { type: "audio/webm" });
  await rawApi("/recordings", blob, "audio/webm", "7");
  expect(fetch).toHaveBeenCalledWith(
    "/api/recordings",
    expect.objectContaining({
      body: blob,
      headers: expect.objectContaining({
        "X-Meow-Owner": "7",
        "X-Meow-Request": "1",
      }),
    }),
  );
});
