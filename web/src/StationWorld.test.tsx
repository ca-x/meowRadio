import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import StationWorld from "./StationWorld";
import { createStationScene } from "./StationScene";
import type { Station } from "./api";
import i18n, { setLanguage } from "./i18n";

vi.mock("./StationScene", () => ({ createStationScene: vi.fn() }));
const stations: Station[] = [
  {
    id: "a",
    name: "Paris Jazz",
    url: "https://radio.example/a",
    country: "France",
    countrycode: "FR",
    tags: "jazz",
    codec: "MP3",
    bitrate: 128,
    hls: false,
    geo_lat: 48.86,
    geo_long: 2.35,
  },
  {
    id: "b",
    name: "Personal Ambient",
    url: "/api/personal-stations/b/stream",
    country: "",
    countrycode: "",
    tags: "ambient",
    codec: "MP3",
    bitrate: 128,
    hls: false,
    personal: true,
  },
];
const makeScene = () => ({
  focus: vi.fn(),
  select: vi.fn(),
  reset: vi.fn(),
  zoom: vi.fn(),
  rotate: vi.fn(),
  setActive: vi.fn(),
  dispose: vi.fn(),
});
let scene = makeScene();
function props() {
  return {
    view: "globe" as const,
    stations,
    active: true,
    savedIds: new Set<string>(),
    saving: false,
    onChoose: vi.fn(),
    onChooseProxy: vi.fn(),
    onSave: vi.fn(),
    onList: vi.fn(),
  };
}
beforeEach(async () => {
  scene = makeScene();
  vi.mocked(createStationScene).mockReset().mockReturnValue(scene);
  await i18n.changeLanguage("zh");
});
afterEach(async () => {
  cleanup();
  localStorage.clear();
  await i18n.changeLanguage("zh");
});
async function ready() {
  await screen.findByRole("button", { name: "放大视图" });
}

describe("3D station controls", () => {
  it("initializes without autoplay and keeps listening, relay and favorite actions explicit", async () => {
    const actions = props();
    render(<StationWorld {...actions} />);
    await ready();
    expect(actions.onChoose).not.toHaveBeenCalled();
    expect(screen.getByText("电台提供的坐标 · 1 个电台无位置")).toBeTruthy();
    fireEvent.change(screen.getByRole("combobox", { name: "选择电台" }), {
      target: { value: "b" },
    });
    expect(scene.focus).toHaveBeenCalledWith("b");
    expect(actions.onChoose).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "收听" }));
    expect(actions.onChoose).toHaveBeenCalledWith(stations[1]);
    fireEvent.click(
      screen.getByRole("button", { name: "本次经服务器收听 Personal Ambient" }),
    );
    expect(actions.onChooseProxy).toHaveBeenCalledWith(stations[1]);
    fireEvent.click(
      screen.getByRole("button", { name: "收藏 Personal Ambient" }),
    );
    expect(actions.onSave).toHaveBeenCalledWith(stations[1]);
  });
  it("maps scene picking to the existing station playback callback", async () => {
    const actions = props();
    render(<StationWorld {...actions} />);
    await ready();
    act(() => vi.mocked(createStationScene).mock.calls[0][3]("a"));
    expect(actions.onChoose).toHaveBeenCalledWith(stations[0]);
    act(() => vi.mocked(createStationScene).mock.calls[0][3]("stale-id"));
    expect(actions.onChoose).toHaveBeenCalledTimes(1);
  });
  it("supports keyboard rotation, zoom buttons and view reset", async () => {
    render(<StationWorld {...props()} />);
    await ready();
    const viewport = screen.getByRole("group", { name: /三维电台场景/ });
    fireEvent.keyDown(viewport, { key: "ArrowLeft" });
    expect(scene.rotate).toHaveBeenCalledWith(-0.14, 0);
    fireEvent.keyDown(viewport, { key: "+" });
    expect(scene.zoom).toHaveBeenCalledWith(1);
    fireEvent.click(screen.getByRole("button", { name: "缩小视图" }));
    expect(scene.zoom).toHaveBeenCalledWith(-1);
    fireEvent.click(screen.getByRole("button", { name: "重置视角" }));
    expect(scene.reset).toHaveBeenCalled();
  });
  it("disposes scenes when switching views and suspends rendering off the home page", async () => {
    const actions = props();
    const { rerender, unmount } = render(<StationWorld {...actions} />);
    await ready();
    rerender(<StationWorld {...actions} active={false} />);
    expect(scene.setActive).toHaveBeenLastCalledWith(false);
    rerender(<StationWorld {...actions} view="nebula" selectedId="b" />);
    await waitFor(() => expect(createStationScene).toHaveBeenCalledTimes(2));
    expect(scene.dispose).toHaveBeenCalledTimes(1);
    expect(actions.onChoose).not.toHaveBeenCalled();
    expect(screen.getByLabelText("流派分组")).toBeTruthy();
    unmount();
    expect(scene.dispose).toHaveBeenCalledTimes(2);
  });
  it("offers a usable list fallback when WebGL initialization fails and can retry", async () => {
    vi.mocked(createStationScene).mockImplementationOnce(() => {
      throw new Error("no webgl");
    });
    const actions = props();
    render(<StationWorld {...actions} />);
    await screen.findByText("三维视图需要 WebGL 2");
    fireEvent.click(screen.getByRole("button", { name: "切回列表" }));
    expect(actions.onList).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    await ready();
    expect(createStationScene).toHaveBeenCalledTimes(2);
  });
  it("releases a lost WebGL context and shows recovery actions", async () => {
    render(<StationWorld {...props()} />);
    await ready();
    act(() => vi.mocked(createStationScene).mock.calls[0][5]());
    expect(scene.dispose).toHaveBeenCalled();
    expect(screen.getByText("三维视图需要 WebGL 2")).toBeTruthy();
  });
  it("translates the scene controls without recreating the renderer", async () => {
    render(<StationWorld {...props()} />);
    await ready();
    await act(async () => setLanguage("en"));
    expect(screen.getByRole("button", { name: "Zoom in" })).toBeTruthy();
    expect(
      screen.getByRole("combobox", { name: "Choose a station" }),
    ).toBeTruthy();
    expect(createStationScene).toHaveBeenCalledOnce();
  });
});
