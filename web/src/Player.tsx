import { tr } from "./i18n";
import { useTranslation } from "react-i18next";
import { useEffect, useRef, useState } from "react";
import type Hls from "hls.js";
import LedScene from "./LedScene";
import SleepTimer from "./SleepTimer";
import SoftReceiver from "./SoftReceiver";
import {
  Play,
  Pause,
  Power,
  SkipBack,
  SkipForward,
  Volume2,
  Heart,
  Radio,
  LoaderCircle,
} from "lucide-react";
import type { Station } from "./api";
import { api, playableUrl } from "./api";
type Props = {
  active?: boolean;
  theme: "walnut" | "vitreous" | "led" | "soft";
  station: Station | null;
  stations: Station[];
  onSelect: (station: Station) => void;
  relay: boolean;
  saved: boolean;
  onSave: () => void;
  selection: number;
};
export default function Player({
  active = true,
  theme,
  station,
  stations,
  onSelect,
  relay,
  saved,
  onSave,
  selection,
}: Props) {
  useTranslation();
  const audio = useRef<HTMLAudioElement>(null);
  const [status, setStatus] = useState<
    "idle" | "loading" | "playing" | "paused" | "error"
  >("idle");
  const [error, setError] = useState("");
  const [timerNotice, setTimerNotice] = useState(false);
  useEffect(() => {
    if (!timerNotice) return;
    const timeout = setTimeout(() => setTimerNotice(false), 5000);
    return () => clearTimeout(timeout);
  }, [timerNotice]);
  const [volume, setVolume] = useState(() => {
    try {
      const v = Number(localStorage.getItem("meow-volume") ?? 0.7);
      return Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0.7;
    } catch {
      return 0.7;
    }
  });
  const [elapsed, setElapsed] = useState(0);
  const attempt = useRef(0);
  const wantsPlayback = useRef(false);
  useEffect(() => {
    if (audio.current) audio.current.volume = volume;
    try {
      localStorage.setItem("meow-volume", String(volume));
    } catch {
      /* private storage can be unavailable */
    }
  }, [volume]);
  useEffect(() => {
    const element = audio.current!;
    const generation = ++attempt.current;
    wantsPlayback.current = false;
    element.pause();
    element.removeAttribute("src");
    element.load();
    setError("");
    setElapsed(0);
    if (!station) {
      setStatus("idle");
      return;
    }
    const url = playableUrl(station.url);
    if (!url) {
      setError("这个电台的音频地址无效，请换一个频道。");
      setStatus("error");
      return;
    }
    if (relay && station.hls) {
      setError("HLS 电台需要在连接设置中切换为直连收听。");
      setStatus("error");
      return;
    }
    if (!relay && location.protocol === "https:" && url.startsWith("http:")) {
      setError("此电台使用 HTTP，请在连接设置中启用服务端中转。");
      setStatus("error");
      return;
    }
    wantsPlayback.current = true;
    setStatus("loading");
    const play = () => {
      if (!wantsPlayback.current || attempt.current !== generation) return;
      void element.play().catch((e: unknown) => {
        if (
          wantsPlayback.current &&
          attempt.current === generation &&
          !(e instanceof DOMException && e.name === "AbortError")
        ) {
          setStatus("error");
          setError(
            "暂时无法播放，请按电源键重试，或在连接设置中切换收听方式。",
          );
        }
      });
    };
    let hls: Hls | undefined;
    if (station.hls && !element.canPlayType("application/vnd.apple.mpegurl")) {
      void import("hls.js")
        .then(({ default: HlsPlayer }) => {
          if (attempt.current !== generation) return;
          if (!HlsPlayer.isSupported()) {
            setStatus("error");
            setError("此浏览器不支持这个 HLS 电台，请换一个频道。");
            return;
          }
          hls = new HlsPlayer();
          hls.loadSource(url);
          hls.attachMedia(element);
          hls.on(HlsPlayer.Events.MANIFEST_PARSED, play);
          hls.on(HlsPlayer.Events.ERROR, (_event, data) => {
            if (
              data.fatal &&
              attempt.current === generation &&
              wantsPlayback.current
            ) {
              wantsPlayback.current = false;
              setStatus("error");
              setError("电台连接中断，请换台或重试。");
            }
          });
        })
        .catch(() => {
          if (attempt.current === generation) {
            setStatus("error");
            setError("播放组件加载失败，请刷新后重试。");
          }
        });
    } else {
      element.src = relay ? `/api/stream/${station.id}` : url;
      play();
    }
    void api(`/stations/${station.id}/click`, "POST").catch(() => {});
    return () => {
      wantsPlayback.current = false;
      attempt.current++;
      hls?.destroy();
      element.pause();
      element.removeAttribute("src");
      element.load();
    };
  }, [station, relay, selection]);
  useEffect(() => {
    if (status !== "playing") return;
    const timer = window.setInterval(() => setElapsed((v) => v + 1), 1000);
    return () => clearInterval(timer);
  }, [status]);
  useEffect(() => {
    if (status !== "loading") return;
    const timer = setTimeout(() => {
      wantsPlayback.current = false;
      audio.current?.pause();
      setStatus("error");
      setError("连接超时。请按电源键重试，或换一个频道。");
    }, 25000);
    return () => clearTimeout(timer);
  }, [status, station]);
  const toggle = () => {
    if (!station) {
      if (stations[0]) onSelect(stations[0]);
      return;
    }
    if (status === "playing" || status === "loading") {
      wantsPlayback.current = false;
      audio.current?.pause();
      setStatus("paused");
    } else if (status === "error") onSelect(station);
    else {
      const generation = attempt.current;
      wantsPlayback.current = true;
      setStatus("loading");
      void audio.current?.play().catch((e: unknown) => {
        if (
          attempt.current === generation &&
          wantsPlayback.current &&
          !(e instanceof DOMException && e.name === "AbortError")
        ) {
          setError("无法播放，请换台或重试。");
          setStatus("error");
        }
      });
    }
  };
  const index = stations.findIndex((s) => s.id === station?.id);
  const next = (direction: number) => {
    if (stations.length)
      onSelect(
        stations[
          (Math.max(index, 0) + direction + stations.length) % stations.length
        ],
      );
  };
  return (
    <section
      className={`receiver ${theme === "vitreous" ? "receiver-vitreous" : theme === "led" ? "receiver-vitreous receiver-led" : theme === "soft" ? "receiver-soft" : ""}`}
      aria-label={tr("收音机播放器")}
    >
      {theme === "soft" && (
        <SoftReceiver
          station={station}
          stations={stations}
          playing={status === "playing"}
          loading={status === "loading"}
          volume={volume}
          saved={saved}
          onVolume={setVolume}
          onSelect={onSelect}
          onToggle={toggle}
          onNext={next}
          onSave={onSave}
        />
      )}
      <div className="night-receiver">
        {theme === "led" && (
          <LedScene playing={status === "playing"} saved={saved} />
        )}
        <div className="night-header">
          <span
            className={`night-status ${status === "playing" ? "live" : ""}`}
          >
            {status === "playing"
              ? "LIVE STREAM"
              : status === "loading"
                ? "CONNECTING"
                : "STANDBY"}
          </span>
          <div className="night-readout">
            <strong>{station?.bitrate || "—"}</strong>
            <span>
              {station?.bitrate
                ? "KBPS / " + (station.codec || "AUDIO")
                : "INTERNET RADIO"}
            </span>
          </div>
        </div>
        <div
          className={`night-wave ${status === "playing" ? "playing" : ""}`}
          aria-hidden="true"
        >
          {Array.from(
            {
              length: 32,
            },
            (_, i) => (
              <i
                key={i}
                style={{
                  height: `${24 + Math.sin(i * 0.7) ** 2 * 100}px`,
                  animationDelay: `${(i % 7) * -0.19}s`,
                }}
              />
            ),
          )}
        </div>
        <div className="night-card">
          <div className="night-metadata">
            <p>
              <span className={status === "playing" ? "live" : ""} />
              {status === "playing"
                ? "NOW ON AIR"
                : status === "loading"
                  ? "TUNING IN"
                  : "YOUR NEXT FREQUENCY"}
            </p>
            <h2>{station?.name || tr("世界正在发声")}</h2>
            <span>
              {station
                ? `${station.country || tr("世界电台")} · ${station.tags.split(",")[0] || "Radio"}`
                : tr("在夜色里，遇见一个好声音。")}
            </span>
          </div>
          <div className="night-controls">
            <button
              className="night-small"
              onClick={() => next(-1)}
              disabled={!stations.length}
              aria-label={tr("上一个频道")}
            >
              <SkipBack size={22} />
            </button>
            <button
              className="night-play"
              onClick={toggle}
              disabled={!station && !stations.length}
              aria-label={
                status === "playing" || status === "loading"
                  ? tr("暂停收听")
                  : tr("开始收听")
              }
            >
              {status === "playing" || status === "loading" ? (
                <Pause size={27} fill="currentColor" />
              ) : (
                <Play size={27} fill="currentColor" />
              )}
            </button>
            <button
              className="night-small"
              onClick={() => next(1)}
              disabled={!stations.length}
              aria-label={tr("下一个频道")}
            >
              <SkipForward size={22} />
            </button>
          </div>
          <div className="night-volume">
            <Volume2 size={16} />
            <input
              type="range"
              aria-label={tr("音量")}
              min="0"
              max="1"
              step="0.01"
              value={volume}
              onChange={(e) => setVolume(Number(e.target.value))}
            />
            <span>{Math.round(volume * 100)}%</span>
            <button
              className="icon-button"
              disabled={!station}
              onClick={onSave}
              aria-label={saved ? tr("取消收藏当前电台") : tr("收藏当前电台")}
              aria-pressed={saved}
            >
              <Heart size={19} fill={saved ? "currentColor" : "none"} />
            </button>
          </div>
        </div>
        <div className="night-ticks" aria-hidden="true">
          {Array.from(
            {
              length: 25,
            },
            (_, i) => (
              <span
                className={`${i % 4 === 0 ? "major" : ""} ${i === Math.max(0, index) ? "active" : ""}`}
                key={i}
              >
                {i % 4 === 0 && <b>{String(i + 1).padStart(2, "0")}</b>}
              </span>
            ),
          )}
        </div>
        <p className="night-caption">
          STATION SELECTOR ·{" "}
          {status === "playing" ? tr("正在收听") : tr("等待信号")} ·{" "}
          {String(Math.floor(elapsed / 60)).padStart(2, "0")}:
          {String(elapsed % 60).padStart(2, "0")}
        </p>
      </div>
      <span className="screw screw-tl" aria-hidden="true" />
      <span className="screw screw-tr" aria-hidden="true" />
      <div className="receiver-face">
        <div className="receiver-top">
          <span className="engraved">MEOW AUDIO</span>
          <span className="model">{tr("网络收音机 / MR–01")}</span>
        </div>
        <div className="receiver-core">
          <div className="speaker" aria-hidden="true">
            <div className="speaker-center">m.</div>
          </div>
          <div className="tuner">
            <div className="lcd">
              <div className="lcd-meta">
                <span
                  className={status === "playing" ? "on-air active" : "on-air"}
                >
                  <span />{" "}
                  {status === "playing"
                    ? "ON AIR"
                    : status === "loading"
                      ? "TUNING"
                      : "STANDBY"}
                </span>
                <span>INTERNET RADIO</span>
              </div>
              <h2 title={station?.name}>
                {station?.name || tr("世界正在发声")}
              </h2>
              <p>
                {station
                  ? `${station.country || tr("世界电台")} · ${station.codec || "AUDIO"}${station.bitrate ? ` / ${station.bitrate} KBPS` : ""}`
                  : tr("挑一个频道，把时间调慢一点。")}
              </p>
              <div className="lcd-bottom">
                <span>
                  {status === "playing"
                    ? tr("正在收听")
                    : status === "loading"
                      ? tr("正在连接信号…")
                      : status === "error"
                        ? tr("信号中断")
                        : tr("等待你的下一次调频")}
                </span>
                <span>
                  {String(Math.floor(elapsed / 60)).padStart(2, "0")}:
                  {String(elapsed % 60).padStart(2, "0")}
                </span>
              </div>
            </div>
            <div className="dial-scale" aria-hidden="true">
              <div className="scale-labels">
                <span>01</span>
                <span>06</span>
                <span>12</span>
                <span>18</span>
                <span>24</span>
              </div>
              <div className="scale-ticks" />
              <span
                className="tuning-needle"
                style={{
                  left: `${4 + (index < 0 ? 0 : index / Math.max(stations.length - 1, 1)) * 92}%`,
                }}
              />
              <span className="scale-caption">S T A T I O N S</span>
            </div>
          </div>
        </div>
        <div className="receiver-controls">
          <div className="power-group">
            <button
              className={`power-button ${status === "playing" ? "is-on" : ""}`}
              onClick={toggle}
              aria-label={
                status === "playing" || status === "loading"
                  ? tr("暂停收听")
                  : tr("开始收听")
              }
              disabled={!station && !stations.length}
            >
              {status === "loading" ? (
                <LoaderCircle size={24} />
              ) : (
                <Power size={24} />
              )}
            </button>
            <span>POWER</span>
          </div>
          <div className="transport">
            <div className="transport-keys">
              <button
                onClick={() => next(-1)}
                aria-label={tr("上一个频道")}
                disabled={!stations.length}
              >
                <SkipBack size={19} />
              </button>
              <button
                className={saved ? "is-saved" : ""}
                onClick={onSave}
                disabled={!station}
                aria-label={saved ? tr("取消收藏当前电台") : tr("收藏当前电台")}
                aria-pressed={saved}
              >
                <Heart size={19} fill={saved ? "currentColor" : "none"} />
              </button>
              <button
                onClick={() => next(1)}
                aria-label={tr("下一个频道")}
                disabled={!stations.length}
              >
                <SkipForward size={19} />
              </button>
            </div>
            <span>{tr("你的节奏，你的频道")}</span>
          </div>
          <div className="volume-group">
            <div
              className="volume-dial"
              style={{
                transform: `rotate(${-130 + volume * 260}deg)`,
              }}
              aria-hidden="true"
            >
              <i />
            </div>
            <label htmlFor="volume">
              <Volume2 size={14} />
              {tr("音量")} <span>{Math.round(volume * 100)}%</span>
            </label>
            <input
              id="volume"
              type="range"
              min="0"
              max="1"
              step="0.01"
              value={volume}
              onChange={(e) => setVolume(Number(e.target.value))}
            />
          </div>
        </div>
        <div className="receiver-foot">
          <span>
            <Radio size={12} /> HIGH FIDELITY · LOW DISTRACTION
          </span>
          <span>{tr("拾起声音，放下匆忙。")}</span>
        </div>
      </div>
      <span className="screw screw-bl" aria-hidden="true" />
      <span className="screw screw-br" aria-hidden="true" />
      {error && (
        <div className="playback-error" role="alert">
          {tr(error)}
        </div>
      )}
      <div className="player-utilities">
        <SleepTimer
          active={active}
          onExpire={() => {
            wantsPlayback.current = false;
            audio.current?.pause();
            setStatus("paused");
            setTimerNotice(true);
          }}
        />
        {timerNotice && (
          <span aria-hidden="true">{tr("定时已到，已停止播放")}</span>
        )}
      </div>
      <audio
        ref={audio}
        preload="none"
        onPlaying={() => {
          if (!wantsPlayback.current) {
            audio.current?.pause();
            return;
          }
          setStatus("playing");
          setError("");
          setTimerNotice(false);
        }}
        onPause={() => setStatus((v) => (v === "error" ? v : "paused"))}
        onWaiting={() => {
          if (wantsPlayback.current) setStatus("loading");
        }}
        onError={() => {
          if (wantsPlayback.current && audio.current?.getAttribute("src")) {
            setStatus("error");
            setError("无法连接这个电台。请重试、换台，或调整连接设置。");
          }
        }}
        onEnded={() => {
          setStatus("paused");
          setError("电台已结束播放，请重新连接。");
        }}
      />
    </section>
  );
}
