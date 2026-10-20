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
  setGenreFilter: vi.fn(),
  getCameraState: vi.fn(() => ({
    position: [1, 2, 3] as [number, number, number],
    target: [0, 0, 0] as [number, number, number],
    fitFactor: 1,
  })),
  restoreCameraState: vi.fn(),
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
    genreCounts: [1, 0, 0, 0, 0, 1, 0, 0],
    genreFilter: null,
    onGenreFilter: vi.fn(),
  };
}
beforeEach(async () => {
  scene = makeScene();
  vi.mocked(createStationScene)
    .mockReset()
    .mockImplementation(
      (_host, _view, items, _pick, _hover, _lost, visible) => {
        visible?.({
          ids: items.map((station) => station.id),
          countries: ["FR"],
          genreCounts: [1, 0, 0, 0, 0, 1, 0, 0],
          cameraKey: "initial",
          distance: 4.8,
        });
        return scene;
      },
    );
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

it("shows visible point counts and makes the legend filterable", async () => {
  const actions = props();
  render(<StationWorld {...actions} view="nebula" />);
  await ready();
  fireEvent.click(screen.getByRole("button", { name: "爵士 1 点" }));
  expect(actions.onGenreFilter).toHaveBeenCalledWith(0);
  expect(screen.queryByRole("button", { name: /摇滚/ })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "全部 2 点" }));
  expect(actions.onGenreFilter).toHaveBeenCalledWith(null);
});

it("limits selector and counts to settled viewport visibility without autoplay", async () => {
  const actions = { ...props(), onVisibility: vi.fn() };
  render(<StationWorld {...actions} view="nebula" />);
  await ready();
  const visible = {
    ids: ["a"],
    countries: ["FR"],
    genreCounts: [1, 0, 0, 0, 0, 0, 0, 0],
    cameraKey: "moved",
    distance: 3,
  };
  act(() => vi.mocked(createStationScene).mock.calls[0][6]?.(visible));
  expect(screen.getAllByRole("option")).toHaveLength(1);
  expect(screen.queryByRole("option", { name: "Personal Ambient" })).toBeNull();
  expect(screen.queryByRole("button", { name: /氛围/ })).toBeNull();
  expect(actions.onVisibility).toHaveBeenLastCalledWith(visible);
  expect(actions.onChoose).not.toHaveBeenCalled();
});

it("updates genre indices without recreating the scene and restores camera after detail updates", async () => {
  const actions = props();
  const { rerender } = render(<StationWorld {...actions} selectedId="a" />);
  await ready();
  rerender(<StationWorld {...actions} selectedId="a" genreFilter={0} />);
  expect(scene.setGenreFilter).toHaveBeenLastCalledWith(0);
  expect(createStationScene).toHaveBeenCalledTimes(1);
  scene.focus.mockClear();
  rerender(
    <StationWorld {...actions} selectedId="a" stations={[...stations]} />,
  );
  await waitFor(() => expect(createStationScene).toHaveBeenCalledTimes(2));
  expect(scene.restoreCameraState).toHaveBeenCalledWith(scene.getCameraState());
  expect(scene.focus).not.toHaveBeenCalled();
});

it("shows aggregates as exploration actions without playback, relay or favorite controls", async () => {
  const cluster: Station = {
    ...stations[0],
    id: "country:FR",
    url: "",
    cluster: { kind: "country", key: "FR", count: null },
  };
  const actions = { ...props(), stations: [cluster] };
  render(<StationWorld {...actions} />);
  await ready();
  expect(screen.getByRole("option").textContent).toContain("数量未知");
  expect(screen.queryByRole("button", { name: "收听" })).toBeNull();
  expect(
    screen.queryByRole("button", { name: /收藏|本次经服务器/ }),
  ).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "探索" }));
  expect(actions.onChoose).toHaveBeenCalledWith(cluster);
  expect(actions.onChooseProxy).not.toHaveBeenCalled();
  expect(actions.onSave).not.toHaveBeenCalled();
});

it("counts unknown-count genre aggregates as visible points", async () => {
  const cluster: Station = {
    ...stations[0],
    id: "genre:jazz",
    url: "",
    cluster: { kind: "genre", key: "jazz", count: null },
  };
  render(<StationWorld {...props()} stations={[cluster]} view="nebula" />);
  await ready();
  act(() =>
    vi.mocked(createStationScene).mock.calls[0][6]?.({
      ids: [cluster.id],
      countries: [],
      genreCounts: Array(8).fill(0),
      distance: 6.2,
      cameraKey: "initial",
    }),
  );
  expect(screen.getByRole("button", { name: "爵士 1 点" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "全部 1 点" })).toBeTruthy();
});

it("restores camera only for detail data within the same search scope", async () => {
  const actions = props();
  const { rerender } = render(
    <StationWorld {...actions} cameraScope="search-1" />,
  );
  await ready();
  rerender(
    <StationWorld
      {...actions}
      stations={[...stations]}
      cameraScope="search-1"
    />,
  );
  await waitFor(() => expect(createStationScene).toHaveBeenCalledTimes(2));
  expect(scene.restoreCameraState).toHaveBeenCalledOnce();
  scene.restoreCameraState.mockClear();
  rerender(
    <StationWorld
      {...actions}
      stations={[...stations]}
      cameraScope="search-2"
    />,
  );
  await waitFor(() => expect(createStationScene).toHaveBeenCalledTimes(3));
  expect(scene.restoreCameraState).not.toHaveBeenCalled();
});

it("suggests rotation or reset when the settled viewport is empty", async () => {
  render(<StationWorld {...props()} />);
  await ready();
  act(() =>
    vi.mocked(createStationScene).mock.calls[0][6]?.({
      ids: [],
      countries: [],
      genreCounts: Array(8).fill(0),
      distance: 4.8,
      cameraKey: "empty",
    }),
  );
  expect(screen.getByRole("status").textContent).toContain(
    "当前视野没有节点，试试旋转或重置视角",
  );
  expect(screen.queryAllByRole("option")).toHaveLength(0);
});

it("counts overlapping directory tag aggregates as points instead of summing their station totals", async () => {
  const clusters: Station[] = [
    {
      ...stations[0],
      id: "genre:jazz",
      tags: "jazz",
      url: "",
      cluster: { kind: "genre", key: "jazz", count: 120 },
    },
    {
      ...stations[0],
      id: "genre:smoothjazz",
      tags: "jazz,smoothjazz",
      url: "",
      cluster: { kind: "genre", key: "smoothjazz", count: 80 },
    },
  ];
  render(<StationWorld {...props()} stations={clusters} view="nebula" />);
  await ready();
  act(() =>
    vi.mocked(createStationScene).mock.calls[0][6]?.({
      ids: clusters.map((station) => station.id),
      countries: [],
      genreCounts: [-1, 0, 0, 0, 0, 0, 0, 0],
      distance: 6.2,
      cameraKey: "overlap",
    }),
  );
  expect(screen.getByRole("button", { name: "爵士 2 点" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "全部 2 点" })).toBeTruthy();
  expect(
    screen.getAllByRole("option").map((option) => option.textContent),
  ).toEqual(
    expect.arrayContaining([
      expect.stringContaining("120"),
      expect.stringContaining("80"),
    ]),
  );
  expect(screen.queryByRole("button", { name: /200/ })).toBeNull();
});
