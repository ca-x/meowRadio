import { useEffect, useMemo, useRef, useState } from "react";
import {
  Cable,
  Heart,
  Minus,
  Play,
  Plus,
  RotateCcw,
  Search,
} from "lucide-react";
import type { Station } from "./api";
import type {
  CameraState,
  SceneVisibility,
  StationScene,
} from "./StationScene";
import {
  genreGroups,
  genreIndex,
  stationGenre,
  stationLocation,
} from "./stationSpatial";
import { tr } from "./i18n";
import { useTranslation } from "react-i18next";
import "./station-world.css";

export type WorldView = "globe" | "nebula";
type Props = {
  view: WorldView;
  cameraScope?: string;
  active: boolean;
  stations: Station[];
  selectedId?: string;
  savedIds: Set<string>;
  onChoose: (station: Station) => void;
  onChooseProxy: (station: Station) => void;
  onSave: (station: Station) => void;
  onList: () => void;
  saving: boolean;
  genreCounts: number[];
  onVisibility?: (visibility: SceneVisibility) => void;
  genreFilter: number | null;
  onGenreFilter: (genre: number | null) => void;
};

export default function StationWorld(props: Props) {
  useTranslation();
  const {
    view,
    cameraScope,
    stations,
    active,
    selectedId,
    savedIds,
    onChoose,
    onChooseProxy,
    onSave,
    onList,
    saving,

    genreFilter,
    onGenreFilter,
  } = props;
  const host = useRef<HTMLDivElement>(null);
  const scene = useRef<StationScene | null>(null);
  const cameraState = useRef<{
    view: WorldView;
    scope?: string;
    state: CameraState;
  } | null>(null);
  const [visibility, setVisibility] = useState<SceneVisibility | null>(null);
  const callbacks = useRef(props);
  callbacks.current = props;
  const [focusedId, setFocusedId] = useState<string>();
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "unavailable">(
    "loading",
  );
  const [attempt, setAttempt] = useState(0);
  const visibleStations = useMemo(() => {
    const ids = new Set(visibility?.ids || []);
    const seen = new Set<string>();
    return stations.filter((station) => {
      if (!ids.has(station.id) || seen.has(station.id)) return false;
      seen.add(station.id);
      return true;
    });
  }, [stations, visibility]);
  const visibleGenreCounts = visibleStations.reduce(
    (counts, station) => {
      counts[genreIndex(station)]++;
      return counts;
    },
    genreGroups.map(() => 0),
  );
  const focused =
    visibleStations.find((station) => station.id === focusedId) ||
    visibleStations.find((station) => station.id === selectedId) ||
    visibleStations[0];
  const hovered = visibleStations.find((station) => station.id === hoveredId);
  const location = focused && stationLocation(focused);
  const locatedCount = useMemo(
    () => visibleStations.filter((station) => stationLocation(station)).length,
    [visibleStations],
  );

  useEffect(() => {
    let cancelled = false;
    let instance: StationScene | undefined;
    setStatus("loading");
    setHoveredId(null);
    setVisibility(null);
    void import("./StationScene")
      .then(({ createStationScene }) => {
        if (cancelled || !host.current) return;
        instance = createStationScene(
          host.current,
          view,
          stations,
          (id) => {
            const station = callbacks.current.stations.find(
              (item) => item.id === id,
            );
            if (!station) return;
            setFocusedId(id);
            callbacks.current.onChoose(station);
          },
          setHoveredId,
          () => {
            instance?.dispose();
            scene.current = null;
            setStatus("unavailable");
          },
          (next) => {
            if (cancelled) return;
            setVisibility(next);
            callbacks.current.onVisibility?.(next);
          },
        );
        scene.current = instance;
        instance.setActive(callbacks.current.active);
        instance.select(callbacks.current.selectedId);
        instance.setGenreFilter(callbacks.current.genreFilter);
        if (
          cameraState.current?.view === view &&
          cameraState.current.scope === cameraScope
        )
          instance.restoreCameraState(cameraState.current.state);
        else if (callbacks.current.selectedId)
          instance.focus(callbacks.current.selectedId);
        setStatus("ready");
      })
      .catch(() => {
        if (!cancelled) setStatus("unavailable");
      });
    return () => {
      cancelled = true;
      if (instance && scene.current === instance)
        cameraState.current = {
          view,
          scope: cameraScope,
          state: instance.getCameraState(),
        };
      instance?.dispose();
      if (scene.current === instance) scene.current = null;
    };
  }, [view, stations, attempt, cameraScope]);
  useEffect(() => scene.current?.setActive(active), [active]);
  useEffect(() => scene.current?.setGenreFilter(genreFilter), [genreFilter]);
  useEffect(() => {
    scene.current?.select(selectedId);
    if (selectedId) {
      setFocusedId(selectedId);
      scene.current?.focus(selectedId);
    }
  }, [selectedId]);

  return (
    <section
      className={`station-world station-world--${view}`}
      aria-label={view === "globe" ? tr("地球电台视图") : tr("星云电台视图")}
    >
      <div className="station-world__heading">
        <div>
          <span className="station-world__eyebrow">
            {view === "globe" ? "WORLD RADIO" : "SOUND NEBULA"}
          </span>
          <h3>
            {view === "globe"
              ? tr("转动地球，寻找一个频道")
              : tr("沿着声音，遇见电台")}
          </h3>
          <p>
            <span>{tr("拖动旋转 · 滚轮或双指缩放")}</span>
            <span>{tr("点选光点收听，聚合节点可展开探索")}</span>
          </p>
        </div>
        <button
          className="station-world__reset"
          onClick={() => scene.current?.reset()}
          disabled={status !== "ready"}
          aria-label={tr("重置视角")}
        >
          <RotateCcw size={16} />
          <span>{tr("重置视角")}</span>
        </button>
      </div>
      <div className="station-world__viewport">
        <div
          ref={host}
          className="station-world__canvas"
          tabIndex={status === "ready" ? 0 : -1}
          role="group"
          aria-label={tr("三维电台场景，方向键旋转，加减键缩放")}
          onKeyDown={(event) => {
            const rotations: Record<string, [number, number]> = {
              ArrowLeft: [-0.14, 0],
              ArrowRight: [0.14, 0],
              ArrowUp: [0, -0.14],
              ArrowDown: [0, 0.14],
            };
            const rotation = rotations[event.key];
            if (rotation) {
              event.preventDefault();
              event.stopPropagation();
              scene.current?.rotate(...rotation);
            }
            if (["+", "=", "-"].includes(event.key)) {
              event.preventDefault();
              event.stopPropagation();
              scene.current?.zoom(event.key === "-" ? -1 : 1);
            }
          }}
        />
        {status === "loading" && (
          <div className="station-world__message" role="status">
            {tr("正在展开声音地图…")}
          </div>
        )}
        {status === "unavailable" && (
          <div className="station-world__message" role="status">
            <strong>{tr("三维视图需要 WebGL 2")}</strong>
            <p>{tr("请启用浏览器图形加速，或切回列表继续收听。")}</p>
            <div>
              <button onClick={() => setAttempt((value) => value + 1)}>
                {tr("重试")}
              </button>
              <button onClick={onList}>{tr("切回列表")}</button>
            </div>
          </div>
        )}
        {status === "ready" &&
          view === "globe" &&
          stations.length > 0 &&
          !stations.some((station) => stationLocation(station)) && (
            <div className="station-world__location-note">
              {tr("这些电台未提供位置信息，可在星云或列表中收听。")}
            </div>
          )}
        {status === "ready" && visibility && visibleStations.length === 0 && (
          <div className="station-world__location-note" role="status">
            {tr("当前视野没有节点，试试旋转或重置视角")}
          </div>
        )}
        {status === "ready" && (
          <>
            <div className="station-world__reticle" aria-hidden="true" />
            <div className="station-world__zoom">
              <button
                onClick={() => scene.current?.zoom(1)}
                aria-label={tr("放大视图")}
              >
                <Plus size={18} />
              </button>
              <button
                onClick={() => scene.current?.zoom(-1)}
                aria-label={tr("缩小视图")}
              >
                <Minus size={18} />
              </button>
            </div>
            <div className="station-world__hover" aria-live="off">
              {hovered ? (
                <>
                  <strong>{hovered.name}</strong>
                  <span>{hovered.country || stationGenre(hovered)}</span>
                </>
              ) : null}
            </div>
          </>
        )}
      </div>
      {view === "nebula" && (
        <div
          className="station-world__legend"
          aria-label={tr("流派分组")}
          title={tr("当前视野的光点数量，包含聚合点")}
        >
          <button
            aria-pressed={genreFilter === null}
            onClick={() => onGenreFilter(null)}
          >
            {tr("全部")}{" "}
            <span>{tr("{{v0}} 点", { v0: visibleStations.length })}</span>
          </button>
          {genreGroups.map(
            (group, index) =>
              visibleStations.some(
                (station) => genreIndex(station) === index,
              ) && (
                <button
                  key={group.name}
                  aria-pressed={genreFilter === index}
                  onClick={() => onGenreFilter(index)}
                >
                  <i style={{ background: group.color }} />
                  {tr(group.name)}{" "}
                  <span>
                    {tr("{{v0}} 点", { v0: visibleGenreCounts[index] })}
                  </span>
                </button>
              ),
          )}
        </div>
      )}
      <div className="station-world__footer">
        <div className="station-world__catalog">
          <label htmlFor="world-station-select">
            {tr("当前视野 {{v0}} 个节点", { v0: visibleStations.length })}
          </label>
          <select
            id="world-station-select"
            aria-label={tr("选择电台")}
            value={focused?.id || ""}
            onChange={(event) => {
              setFocusedId(event.target.value);
              scene.current?.focus(event.target.value);
            }}
          >
            {visibleStations.map((station) => (
              <option key={station.id} value={station.id}>
                {station.name}
                {station.cluster
                  ? ` · ${tr("聚合")} · ${station.cluster.count ?? tr("数量未知")}`
                  : ""}
              </option>
            ))}
          </select>
          {view === "globe" && (
            <span className="station-world__precision">
              {location
                ? location.approximate
                  ? tr("按国家近似定位")
                  : tr("电台提供的坐标")
                : tr("未提供位置")}
              {locatedCount < visibleStations.length &&
                ` · ${tr("{{v0}} 个电台无位置", { v0: visibleStations.length - locatedCount })}`}
            </span>
          )}
        </div>
        {focused && (
          <div className="station-world__selection">
            <span>
              {focused.country || focused.source_name || stationGenre(focused)}
            </span>
            {focused.cluster ? (
              <button
                className="station-world__play"
                onClick={() => {
                  scene.current?.focus(focused.id);
                  onChoose(focused);
                }}
              >
                <Search size={15} />
                {tr("探索")}
              </button>
            ) : (
              <>
                <button
                  className="station-world__play"
                  onClick={() => onChoose(focused)}
                >
                  <Play size={15} fill="currentColor" />
                  {tr("收听")}
                </button>
                <button
                  className="station-world__action"
                  onClick={() => onChooseProxy(focused)}
                  aria-label={tr("本次经服务器收听 {{v0}}", {
                    v0: focused.name,
                  })}
                  title={tr("本次经服务器收听 {{v0}}", { v0: focused.name })}
                >
                  <Cable size={17} />
                </button>
                <button
                  className={`station-world__action ${savedIds.has(focused.id) ? "is-saved" : ""}`}
                  onClick={() => onSave(focused)}
                  disabled={saving}
                  aria-label={`${savedIds.has(focused.id) ? tr("取消收藏") : tr("收藏")} ${focused.name}`}
                  aria-pressed={savedIds.has(focused.id)}
                >
                  <Heart
                    size={17}
                    fill={savedIds.has(focused.id) ? "currentColor" : "none"}
                  />
                </button>
              </>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
