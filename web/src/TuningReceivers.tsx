import {
  Heart,
  LoaderCircle,
  Pause,
  Play,
  SkipBack,
  SkipForward,
  Volume2,
} from "lucide-react";
import type { Station } from "./api";
import { tr } from "./i18n";
import PlaybackVisual from "./PlaybackVisual";

type Props = {
  variant: "arc" | "ivory" | "mono" | "signal";
  station: Station | null;
  stations: Station[];
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

const segments = [
  "abcdef",
  "bc",
  "abdeg",
  "abcdg",
  "bcfg",
  "acdfg",
  "acdefg",
  "abc",
  "abcdefg",
  "abcdfg",
];
const pixels: Record<string, string[]> = {
  "0": ["01110", "11011", "11011", "11011", "11011", "11011", "01110"],
  "1": ["00110", "01110", "00110", "00110", "00110", "00110", "01111"],
  "2": ["01110", "11011", "00011", "00110", "01100", "11000", "11111"],
  "3": ["11110", "00011", "00011", "01110", "00011", "00011", "11110"],
  "4": ["00011", "00111", "01111", "11011", "11111", "00011", "00011"],
  "5": ["11111", "11000", "11000", "11110", "00011", "11011", "01110"],
  "6": ["01110", "11000", "11000", "11110", "11011", "11011", "01110"],
  "7": ["11111", "00011", "00110", "00110", "01100", "01100", "01100"],
  "8": ["01110", "11011", "11011", "01110", "11011", "11011", "01110"],
  "9": ["01110", "11011", "11011", "01111", "00011", "00011", "01110"],
  "—": ["00000", "00000", "00000", "11111", "00000", "00000", "00000"],
};
function PixelNumber({ value }: { value: string }) {
  return (
    <span className="pixel-number" aria-hidden="true">
      {value.split("").map((digit, i) => (
        <span className="pixel-digit" key={i}>
          {pixels[digit]
            .join("")
            .split("")
            .map((lit, j) => (
              <i key={j} data-lit={lit === "1"} />
            ))}
        </span>
      ))}
    </span>
  );
}
function DigitalNumber({ value }: { value: string }) {
  return (
    <span className="digital-number" aria-hidden="true">
      {value.split("").map((digit, index) => (
        <span className="digital-digit" key={index}>
          {"abcdefg".split("").map((segment) => (
            <i
              key={segment}
              className={`segment segment-${segment}`}
              data-lit={(digit === "—"
                ? "g"
                : segments[Number(digit)]
              ).includes(segment)}
            />
          ))}
        </span>
      ))}
    </span>
  );
}

function StationScale({
  curved,
  index,
  stations,
  onSelect,
}: {
  curved: boolean;
  index: number;
  stations: Station[];
  onSelect: (station: Station) => void;
}) {
  const count = stations.length;
  // The scale is an index into the current results, never an invented FM band.
  const selected = Math.max(index, 0);
  const rotation = count > 1 ? 56 - (selected / (count - 1)) * 112 : 0;
  return (
    <div
      className={`station-scale ${curved ? "station-scale--arc" : "station-scale--linear"}`}
    >
      <div className="station-scale-art" aria-hidden="true">
        {curved ? (
          <svg className="arc-scale" viewBox="0 0 640 340">
            <g
              className="arc-wheel"
              style={{ transform: `rotate(${rotation}deg)` }}
            >
              <circle cx="320" cy="340" r="252" className="arc-disc" />
              {Array.from({ length: 121 }, (_, i) => (
                <line
                  key={i}
                  x1="320"
                  y1={i % 5 === 0 ? "48" : "63"}
                  x2="320"
                  y2="91"
                  transform={`rotate(${-60 + i} 320 340)`}
                  className={i % 5 === 0 ? "major" : "minor"}
                />
              ))}
              {stations.map((station, i) => {
                const angle = count > 1 ? 56 - (i / (count - 1)) * 112 : 0;
                return (
                  <g key={station.id} transform={`rotate(${-angle} 320 340)`}>
                    <text
                      x="320"
                      y="32"
                      textAnchor="middle"
                      className={i === index ? "selected" : ""}
                    >
                      {String(i + 1).padStart(2, "0")}
                    </text>
                  </g>
                );
              })}
              {Array.from({ length: 91 }, (_, i) => (
                <line
                  key={i}
                  x1="320"
                  y1="108"
                  x2="320"
                  y2="130"
                  transform={`rotate(${-90 + i * 2} 320 340)`}
                  className="inner-tick"
                />
              ))}
            </g>
            <path d="M313 5h14l-7 10Z" className="arc-pointer" />
            <path d="M320 49v63" className="arc-needle" />
            <circle cx="320" cy="266" r="18" className="arc-hub" />
            <path d="M320 147v100m0 38v55" className="arc-axis" />
          </svg>
        ) : (
          <div
            className="linear-track"
            style={{
              width: `${Math.max(count, 1) * 52}px`,
              transform: `translateX(-${(selected + 0.5) * 52}px)`,
            }}
          >
            {Array.from({ length: Math.max(count, 1) }, (_, i) => (
              <span className="linear-unit" key={i}>
                <i />
                <b>{count ? String(i + 1).padStart(2, "0") : "—"}</b>
              </span>
            ))}
          </div>
        )}
        {!curved && <span className="linear-needle" />}
      </div>
      <input
        type="range"
        min={0}
        max={Math.max(count - 1, 1)}
        step={1}
        value={selected}
        disabled={!count}
        aria-label={tr("频道调谐")}
        aria-valuetext={
          index >= 0
            ? tr("频道 {{number}}：{{name}}", {
                number: index + 1,
                name: stations[index].name,
              })
            : tr("请选择电台")
        }
        onChange={(event) => {
          const next = stations[Number(event.target.value)];
          if (next) onSelect(next);
        }}
      />
      <span className="scale-instruction">{tr("拖动刻度换台")}</span>
    </div>
  );
}

export default function TuningReceiver(props: Props) {
  const {
    variant,
    station,
    stations,
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
  } = props;
  const index = stations.findIndex((item) => item.id === station?.id);
  const number = index >= 0 ? String(index + 1).padStart(3, "0") : "———";
  const status = loading ? tr("连接中") : playing ? tr("正在收听") : tr("待机");
  const transport = (
    <div className="tuning-transport">
      <button
        onClick={() => onNext(-1)}
        disabled={!stations.length}
        aria-label={tr("上一个频道")}
      >
        <SkipBack size={24} />
      </button>
      <button
        className="tuning-play"
        onClick={onToggle}
        disabled={!station && !stations.length}
        aria-label={playing || loading ? tr("暂停收听") : tr("开始收听")}
      >
        {loading ? (
          <LoaderCircle size={30} className="tuning-loading" />
        ) : playing ? (
          <Pause size={30} fill="currentColor" />
        ) : (
          <Play size={30} fill="currentColor" />
        )}
        {variant === "mono" && (
          <span>{playing || loading ? tr("暂停收听") : tr("开始收听")}</span>
        )}
      </button>
      <button
        onClick={() => onNext(1)}
        disabled={!stations.length}
        aria-label={tr("下一个频道")}
      >
        <SkipForward size={24} />
      </button>
    </div>
  );
  const tools = (
    <div className="tuning-tools">
      <button
        className="tuning-save"
        onClick={onSave}
        disabled={!station}
        aria-label={saved ? tr("取消收藏当前电台") : tr("收藏当前电台")}
        aria-pressed={saved}
      >
        <Heart size={18} fill={saved ? "currentColor" : "none"} />
      </button>
      <label className="tuning-volume">
        <Volume2 size={16} aria-hidden="true" />
        <span className="sr-only">{tr("音量")}</span>
        <input
          type="range"
          min={0}
          max={1}
          step={0.01}
          value={volume}
          onChange={(e) => onVolume(Number(e.target.value))}
        />
        <span>{Math.round(volume * 100)}%</span>
      </label>
    </div>
  );
  return (
    <div className={`tuning-receiver tuning-receiver--${variant}`}>
      {variant === "ivory" && (
        <div className="ivory-grille" aria-hidden="true" />
      )}
      <div className="tuning-display">
        <div className="tuning-display-top">
          <span>{station?.country || tr("网络电台")}</span>
          <span className="tuning-state">
            <PlaybackVisual variant="soft" running={moving} volume={volume} />
            {status}
          </span>
        </div>
        <div
          className="tuning-number"
          role="img"
          aria-label={
            index >= 0
              ? tr("频道 {{number}}", { number: index + 1 })
              : tr("请选择电台")
          }
        >
          {variant === "ivory" ? (
            <DigitalNumber value={number} />
          ) : variant === "signal" ? (
            <PixelNumber value={number} />
          ) : (
            <span aria-hidden="true">
              <span className="number-prefix">{number.slice(0, 1)}</span>
              {number.slice(1)}
            </span>
          )}
          <span className="tuning-number-unit" aria-hidden="true">
            CH<span>{station?.codec || "RADIO"}</span>
          </span>
        </div>
        <h2 title={station?.name}>{station?.name || tr("请选择电台")}</h2>
        <p className="tuning-metadata">
          {station
            ? `${station.tags.split(",").filter(Boolean).slice(0, 2).join(" / ") || tr("网络电台")}${station.bitrate ? ` · ${station.bitrate} kbps` : ""}`
            : tr("从下方列表选择电台")}
        </p>
      </div>
      {variant !== "ivory" && (
        <StationScale
          curved={variant === "arc"}
          index={index}
          stations={stations}
          onSelect={onSelect}
        />
      )}
      {transport}
      {tools}
    </div>
  );
}
