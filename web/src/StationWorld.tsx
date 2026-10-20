import { useEffect, useMemo, useRef, useState } from "react";
import { Cable, Heart, Minus, Play, Plus, RotateCcw } from "lucide-react";
import type { Station } from "./api";
import type { StationScene } from "./StationScene";
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
  active: boolean;
  stations: Station[];
  selectedId?: string;
  savedIds: Set<string>;
  onChoose: (station: Station) => void;
  onChooseProxy: (station: Station) => void;
  onSave: (station: Station) => void;
  onList: () => void;
  saving: boolean;
};

export default function StationWorld(props: Props) {
  useTranslation();
  const {
    view,
    stations,
    active,
    selectedId,
    savedIds,
    onChoose,
    onChooseProxy,
    onSave,
    onList,
    saving,
  } = props;
  const host = useRef<HTMLDivElement>(null);
  const scene = useRef<StationScene | null>(null);
  const callbacks = useRef(props);
  callbacks.current = props;
  const [focusedId, setFocusedId] = useState<string>();
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "unavailable">(
    "loading",
  );
  const [attempt, setAttempt] = useState(0);
  const focused =
    stations.find((station) => station.id === focusedId) ||
    stations.find((station) => station.id === selectedId) ||
    stations[0];
  const hovered = stations.find((station) => station.id === hoveredId);
  const location = focused && stationLocation(focused);
  const locatedCount = useMemo(
    () => stations.filter((station) => stationLocation(station)).length,
    [stations],
  );
  const presentGenres = useMemo(
    () => new Set(stations.map(genreIndex)),
    [stations],
  );

  useEffect(() => {
    let cancelled = false;
    let instance: StationScene | undefined;
    setStatus("loading");
    setHoveredId(null);
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
        );
        scene.current = instance;
        instance.setActive(callbacks.current.active);
        instance.select(callbacks.current.selectedId);
        setStatus("ready");
      })
      .catch(() => {
        if (!cancelled) setStatus("unavailable");
      });
    return () => {
      cancelled = true;
      instance?.dispose();
      if (scene.current === instance) scene.current = null;
    };
  }, [view, stations, attempt]);
  useEffect(() => scene.current?.setActive(active), [active]);
  useEffect(() => {
    scene.current?.select(selectedId);
    if (selectedId) {
      setFocusedId(selectedId);
      scene.current?.focus(selectedId);
    }
  }, [selectedId, status]);

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
            <span>{tr("点选光点收听")}</span>
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
        {status === "ready" && view === "globe" && locatedCount === 0 && (
          <div className="station-world__location-note">
            {tr("本页电台未提供位置信息，可在星云或列表中收听。")}
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
        <div className="station-world__legend" aria-label={tr("流派分组")}>
          {genreGroups.map(
            (group, index) =>
              presentGenres.has(index) && (
                <span key={group.name}>
                  <i style={{ background: group.color }} />
                  {tr(group.name)}
                </span>
              ),
          )}
        </div>
      )}
      <div className="station-world__footer">
        <div className="station-world__catalog">
          <label htmlFor="world-station-select">
            {tr("本页 {{v0}} 个电台", { v0: stations.length })}
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
            {stations.map((station) => (
              <option key={station.id} value={station.id}>
                {station.name}
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
              {locatedCount < stations.length &&
                ` · ${tr("{{v0}} 个电台无位置", { v0: stations.length - locatedCount })}`}
            </span>
          )}
        </div>
        {focused && (
          <div className="station-world__selection">
            <span>
              {focused.country || focused.source_name || stationGenre(focused)}
            </span>
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
              aria-label={tr("本次经服务器收听 {{v0}}", { v0: focused.name })}
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
          </div>
        )}
      </div>
    </section>
  );
}
