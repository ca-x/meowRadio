import { tr } from "./i18n";
import { useTranslation } from "react-i18next";
import {
  Heart,
  Pause,
  Play,
  Radio,
  SkipBack,
  SkipForward,
  Volume2,
} from "lucide-react";
import type { Station } from "./api";
type Props = {
  station: Station | null;
  stations: Station[];
  playing: boolean;
  loading: boolean;
  volume: number;
  saved: boolean;
  onVolume: (volume: number) => void;
  onSelect: (station: Station) => void;
  onToggle: () => void;
  onNext: (direction: number) => void;
  onSave: () => void;
};
export default function SoftReceiver({
  station,
  stations,
  playing,
  loading,
  volume,
  saved,
  onVolume,
  onSelect,
  onToggle,
  onNext,
  onSave,
}: Props) {
  useTranslation();
  const index = stations.findIndex((s) => s.id === station?.id);
  return (
    <div className="soft-receiver">
      <div className="soft-tuner-unit">
        <div className="soft-unit-header">
          <span>
            meow<span>audio</span>
          </span>
          <span>MR–04</span>
        </div>
        <div className="soft-circular-tuner">
          <div className="soft-tick-ring" aria-hidden="true" />
          <div className="soft-dial">
            <div className="soft-dial-label">
              {loading ? "TUNING" : playing ? "ON AIR" : "STANDBY"}
            </div>
            <div
              className="soft-dial-needle"
              style={{
                transform: `rotate(${-70 + (Math.max(index, 0) / Math.max(stations.length - 1, 1)) * 140}deg)`,
              }}
              aria-hidden="true"
            />
            <strong>
              {index >= 0 ? String(index + 1).padStart(2, "0") : "—"}
            </strong>
            <span>STATION / {station?.codec || "RADIO"}</span>
            <div className="soft-dial-ticks" aria-hidden="true">
              {Array.from(
                {
                  length: 15,
                },
                (_, i) => (
                  <i key={i} />
                ),
              )}
            </div>
          </div>
        </div>
        <div className="soft-metadata">
          <h2>{station?.name || tr("调到喜欢的频道")}</h2>
          <p>
            {station
              ? `${station.country || tr("世界电台")} · ${station.tags.split(",")[0] || "Radio"}`
              : tr("一个声音，一段属于自己的时间。")}
          </p>
        </div>
        <label className="soft-channel-slider">
          {tr("频道调谐")}
          <span>TUNER</span>
          <input
            aria-label={tr("频道调谐")}
            type="range"
            min="0"
            max={Math.max(stations.length - 1, 1)}
            value={Math.max(index, 0)}
            disabled={!stations.length}
            onChange={(e) => {
              const target = stations[Number(e.target.value)];
              if (target) onSelect(target);
            }}
          />
        </label>
        <div className="soft-controls">
          <button
            onClick={() => onNext(-1)}
            disabled={!stations.length}
            aria-label={tr("上一个频道")}
          >
            <SkipBack size={21} />
          </button>
          <button
            className={`soft-play ${playing ? "active" : ""}`}
            onClick={onToggle}
            disabled={!station && !stations.length}
            aria-label={playing || loading ? tr("暂停收听") : tr("开始收听")}
          >
            {playing || loading ? (
              <Pause size={22} fill="currentColor" />
            ) : (
              <Play size={22} fill="currentColor" />
            )}
          </button>
          <button
            onClick={onSave}
            disabled={!station}
            aria-label={saved ? tr("取消收藏当前电台") : tr("收藏当前电台")}
            aria-pressed={saved}
          >
            <Heart size={21} fill={saved ? "currentColor" : "none"} />
          </button>
          <button
            onClick={() => onNext(1)}
            disabled={!stations.length}
            aria-label={tr("下一个频道")}
          >
            <SkipForward size={21} />
          </button>
        </div>
      </div>
      <div className="soft-speaker-unit">
        <div className="soft-perforations" aria-hidden="true" />
        <span>
          <Radio size={18} /> meowRadio
        </span>
        <small>LESS NOISE. MORE RADIO.</small>
      </div>
      <div className="soft-level-unit">
        <div className="soft-unit-title">
          <Volume2 size={18} />
          <span>{tr("声音的分寸")}</span>
          <span>LEVEL</span>
        </div>
        <div className="soft-volume-readout">
          <strong>
            {Math.round(volume * 100)}
            <small>%</small>
          </strong>
          <span>VOLUME</span>
        </div>
        <label className="soft-volume-slider">
          <span>{tr("音量")}</span>
          <input
            type="range"
            aria-label={tr("音量")}
            min="0"
            max="1"
            step="0.01"
            value={volume}
            onChange={(e) => onVolume(Number(e.target.value))}
          />
        </label>
        <div className="soft-stream-details">
          <span>
            {tr("音频编码")}
            <strong>{station?.codec || "—"}</strong>
          </span>
          <span>
            {tr("音质")}
            <strong>
              {station?.bitrate ? `${station.bitrate} kbps` : "—"}
            </strong>
          </span>
          <span>
            {tr("接收状态")}
            <strong>
              <i className={playing ? "connected" : ""} />
              {loading ? tr("连接中") : playing ? tr("正在收听") : tr("待机")}
            </strong>
          </span>
        </div>
      </div>
    </div>
  );
}
