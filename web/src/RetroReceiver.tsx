import {
  Heart,
  Pause,
  Play,
  Radio,
  SkipBack,
  SkipForward,
  Volume2,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import type { Station } from "./api";
import { tr } from "./i18n";
import PlaybackVisual from "./PlaybackVisual";
import "./retro-receiver.css";

type Props = {
  station: Station | null;
  stations: Station[];
  favorites: Station[];
  favoriteCount?: number;
  playing: boolean;
  loading: boolean;
  moving: boolean;
  volume: number;
  saved: boolean;
  onVolume: (volume: number) => void;
  onSelect: (station: Station) => void;
  onToggle: () => void;
  onNext: (direction: number) => void;
  onSave: () => void;
};

export default function RetroReceiver({
  station,
  stations,
  favorites,
  favoriteCount = favorites.length,
  playing,
  loading,
  moving,
  volume,
  saved,
  onVolume,
  onSelect,
  onToggle,
  onNext,
  onSave,
}: Props) {
  useTranslation();
  const index = stations.findIndex((item) => item.id === station?.id);
  const active = playing || loading;
  const status = loading ? tr("连接中") : playing ? tr("正在收听") : tr("待机");

  return (
    <div className="retro-receiver">
      <section className="retro-chassis" aria-label={tr("银色复古收音机")}>
        <div className="retro-speaker" aria-hidden="true">
          <div className="retro-grille" />
        </div>
        <div className="retro-face">
          <div className="retro-wordmark">
            meow<span>Radio</span>
          </div>
          <div className="retro-pointer" aria-hidden="true" />
          <div className="retro-dial">
            <div className="retro-ticks" aria-hidden="true">
              {Array.from({ length: 60 }, (_, tick) => (
                <i
                  key={tick}
                  className={tick % 5 === 0 ? "major" : ""}
                  style={{ transform: `rotate(${tick * 6}deg)` }}
                />
              ))}
            </div>
            <div className="retro-dial-center">
              <span className="retro-status" role="status">
                {status}
              </span>
              <div
                className="retro-channel"
                role="img"
                aria-label={
                  index >= 0
                    ? tr("频道 {{number}}", { number: index + 1 })
                    : tr("请选择电台")
                }
              >
                <strong>
                  {index >= 0 ? String(index + 1).padStart(2, "0") : "—"}
                </strong>
                <span aria-hidden="true">CH</span>
              </div>
              <PlaybackVisual variant="soft" running={moving} volume={volume} />
            </div>
          </div>
          <div className="retro-station">
            <h2 title={station?.name}>{station?.name || tr("请选择电台")}</h2>
            <p>
              {station
                ? station.country || tr("网络电台")
                : tr("从下方列表选择电台")}
            </p>
          </div>
          <div className="retro-transport">
            <button
              className="retro-step"
              onClick={() => onNext(-1)}
              disabled={!stations.length}
              aria-label={tr("上一个频道")}
            >
              <SkipBack size={19} aria-hidden="true" />
            </button>
            <button
              className="retro-switch"
              data-active={active}
              onClick={onToggle}
              disabled={!station && !stations.length}
              aria-label={active ? tr("暂停收听") : tr("开始收听")}
              aria-pressed={active}
            >
              <span className="retro-switch-track" aria-hidden="true" />
              <span className="retro-switch-thumb" aria-hidden="true">
                {active ? (
                  <Pause size={17} fill="currentColor" />
                ) : (
                  <Play size={17} fill="currentColor" />
                )}
              </span>
            </button>
            <button
              className="retro-step"
              onClick={() => onNext(1)}
              disabled={!stations.length}
              aria-label={tr("下一个频道")}
            >
              <SkipForward size={19} aria-hidden="true" />
            </button>
          </div>
          <div className="retro-level">
            <label className="retro-volume">
              <Volume2 size={16} aria-hidden="true" />
              <input
                type="range"
                min={0}
                max={1}
                step={0.01}
                value={volume}
                onChange={(event) => onVolume(Number(event.target.value))}
                aria-label={tr("音量")}
              />
              <span>{Math.round(volume * 100)}%</span>
            </label>
            <button
              className="retro-save"
              onClick={onSave}
              disabled={!station}
              aria-label={saved ? tr("取消收藏当前电台") : tr("收藏当前电台")}
              aria-pressed={saved}
            >
              <Heart
                size={17}
                fill={saved ? "currentColor" : "none"}
                aria-hidden="true"
              />
            </button>
          </div>
          <div className="retro-presets">
            <div className="retro-presets-heading">
              <span>{tr("我的收藏")}</span>
              <span>{favoriteCount}</span>
            </div>
            {favorites.length ? (
              <div className="retro-preset-list">
                {favorites.slice(0, 4).map((favorite) => (
                  <button
                    key={favorite.id}
                    onClick={() => onSelect(favorite)}
                    aria-pressed={station?.id === favorite.id}
                    title={favorite.name}
                  >
                    <span className="retro-preset-icon" aria-hidden="true">
                      <Radio size={18} />
                    </span>
                    <span className="retro-preset-name">{favorite.name}</span>
                  </button>
                ))}
              </div>
            ) : (
              <p className="retro-presets-empty">
                {tr("点击电台旁的爱心即可收藏。")}
              </p>
            )}
          </div>
        </div>
      </section>
    </div>
  );
}
