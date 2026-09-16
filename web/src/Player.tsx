import PlaybackRoute from "./PlaybackRoute";
import { requiresRelay } from "./playback";
import RecordingControl from "./RecordingControl";
import type { RecordedAudio } from "./useRecording";
import TuningReceiver from "./TuningReceivers";
import RetroReceiver from "./RetroReceiver";
import type { ReceiverTheme } from "./receiverThemes";
import { tr } from "./i18n";
import { useTranslation } from "react-i18next";
import { useEffect, useRef, useState } from "react";
import type Hls from "hls.js";
import PlaybackVisual from "./PlaybackVisual";
import TransientCopy from "./TransientCopy";
import useLazycatControls from "./useLazycatControls";
import { isHls } from "./playback";
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
  LoaderCircle,
} from "lucide-react";
import type { Station } from "./api";
import { api, playableUrl } from "./api";
type Props = {
  active?: boolean;
  ownerKey?: string;
  pauseRequest?: number;
  onRequestRelay?: () => void;
  onRecorded?: (file: RecordedAudio) => Promise<void>;
  onOpenRecordings?: () => void;
  theme: ReceiverTheme;
  station: Station | null;
  stations: Station[];
  favorites?: Station[];
  onSelect: (station: Station) => void;
  relay: boolean;
  proxyConfigured?: boolean;
  onRouteChange?: (relay: boolean) => void;
  saved: boolean;
  onSave: () => void;
  selection: number;
  onRelayAuthRequired?: () => void;
};
export default function Player({
  active = true,
  ownerKey,
  pauseRequest = 0,
  onRequestRelay,
  onRecorded,
  onOpenRecordings,
  theme,
  station,
  stations,
  favorites = [],
  onSelect,
  relay,
  proxyConfigured = false,
  onRouteChange,
  saved,
  onSave,
  selection,
  onRelayAuthRequired,
}: Props) {
  useTranslation();
  const authRequired = useRef(onRelayAuthRequired);
  authRequired.current = onRelayAuthRequired;
  const [pageVisible, setPageVisible] = useState(!document.hidden);
  useEffect(() => {
    const update = () => setPageVisible(!document.hidden);
    document.addEventListener("visibilitychange", update);
    return () => document.removeEventListener("visibilitychange", update);
  }, []);
  const audio = useRef<HTMLAudioElement>(null);
  const [status, setStatus] = useState<
    "idle" | "loading" | "playing" | "paused" | "error"
  >("idle");
  const [error, setError] = useState("");
  const [retryNumber, setRetryNumber] = useState(0);
  const controls = useRef<{ pause: () => void; start: () => void } | null>(
    null,
  );
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
  const sleepDeadline = useRef<number | null>(null);
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
    const delays = [2000, 4000, 8000, 16000, 30000, 30000];
    let disposed = false;
    let hls: Hls | undefined;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let loadingTimer: ReturnType<typeof setTimeout> | undefined;
    let wakeTimer: ReturnType<typeof setTimeout> | undefined;
    let retries = 0;
    let exhausted = false;
    let hasEverPlayed = false;
    let connected = false;
    let stalled = false;
    let hasPlayed = false;
    let stableTime = 0;
    let lastTime = element.currentTime;
    let lastProgress = Date.now();
    let stableSince: number | undefined;
    const clearTimers = () => {
      clearTimeout(retryTimer);
      clearTimeout(loadingTimer);
      clearTimeout(wakeTimer);
      retryTimer = loadingTimer = wakeTimer = undefined;
    };
    const disconnect = () => {
      connected = false;
      attempt.current++;
      stableSince = undefined;
      hls?.destroy();
      hls = undefined;
      element.pause();
      element.removeAttribute("src");
      element.load();
    };
    const stop = (message?: string) => {
      wantsPlayback.current = false;
      exhausted = false;
      clearTimers();
      disconnect();
      setRetryNumber(0);
      setError(message || "");
      setStatus(message ? "error" : "paused");
    };
    const deadlineExpired = () => {
      if (sleepDeadline.current === null || Date.now() < sleepDeadline.current)
        return false;
      stop();
      setTimerNotice(true);
      return true;
    };
    const retry = () => {
      if (
        disposed ||
        !wantsPlayback.current ||
        deadlineExpired() ||
        retryTimer !== undefined
      )
        return;
      clearTimeout(loadingTimer);
      loadingTimer = undefined;
      if (retries >= delays.length) {
        clearTimers();
        disconnect();
        exhausted = true;
        setRetryNumber(0);
        setStatus("error");
        setError("连接多次失败，请按电源键重试，或换一个频道。");
        return;
      }
      disconnect();
      const delay = delays[retries++];
      setRetryNumber(retries);
      setError("连接中断，正在重新连接…");
      setStatus("loading");
      retryTimer = setTimeout(() => {
        retryTimer = undefined;
        connect();
      }, delay);
    };
    const armLoadingTimeout = () => {
      if (loadingTimer !== undefined) return;
      loadingTimer = setTimeout(() => {
        loadingTimer = undefined;
        retry();
      }, 25000);
    };
    const url = station && playableUrl(station.url);
    const connect = () => {
      if (
        disposed ||
        !wantsPlayback.current ||
        deadlineExpired() ||
        !station ||
        !url
      )
        return;
      clearTimers();
      disconnect();
      const generation = ++attempt.current;
      connected = true;
      stalled = false;
      hasPlayed = false;
      lastTime = element.currentTime;
      lastProgress = Date.now();
      setStatus("loading");
      armLoadingTimeout();
      const current = () =>
        !disposed && wantsPlayback.current && attempt.current === generation;
      const play = () => {
        if (!current()) return;
        void element.play().catch((e: unknown) => {
          if (
            !current() ||
            (e instanceof DOMException && e.name === "AbortError")
          )
            return;
          if (
            e instanceof DOMException &&
            (e.name === "NotAllowedError" ||
              (e.name === "NotSupportedError" &&
                navigator.onLine !== false &&
                !hasEverPlayed))
          ) {
            stop("暂时无法播放，请按电源键重试，或在连接设置中切换收听方式。");
          } else retry();
        });
      };
      const source = relay ? `/api/stream/${station.id}` : url;
      if (
        isHls(station) &&
        !element.canPlayType("application/vnd.apple.mpegurl")
      ) {
        void import("hls.js")
          .then(({ default: HlsPlayer }) => {
            if (!current()) return;
            if (!HlsPlayer.isSupported()) {
              stop("此浏览器不支持这个 HLS 电台，请换一个频道。");
              return;
            }
            hls = new HlsPlayer();
            hls.loadSource(source);
            hls.attachMedia(element);
            hls.on(HlsPlayer.Events.MANIFEST_PARSED, play);
            hls.on(HlsPlayer.Events.ERROR, (_event, data) => {
              if (!data.fatal || !current()) return;
              if (relay && data.response?.code === 401) {
                stop("请先登录");
                authRequired.current?.();
              } else if (data.type === HlsPlayer.ErrorTypes.NETWORK_ERROR) {
                retry();
              } else {
                stop("电台连接中断，请换台或重试。");
              }
            });
          })
          .catch(() => {
            if (current()) stop("播放组件加载失败，请刷新后重试。");
          });
      } else {
        element.src = source;
        play();
      }
    };
    const playing = () => {
      if (!wantsPlayback.current || !connected || deadlineExpired()) {
        element.pause();
        return;
      }
      clearTimeout(loadingTimer);
      loadingTimer = undefined;
      stalled = false;
      if (stableSince === undefined) {
        stableSince = Date.now();
        stableTime = element.currentTime;
      }
      hasPlayed = true;
      hasEverPlayed = true;
      lastProgress = Date.now();
      lastTime = element.currentTime;
      setStatus("playing");
      setError("");
      setRetryNumber(0);
      setTimerNotice(false);
    };
    const progress = () => {
      if (
        !wantsPlayback.current ||
        !connected ||
        element.currentTime === lastTime
      )
        return;
      lastTime = element.currentTime;
      lastProgress = Date.now();
      // A brief playing event must not give a flapping stream unlimited retries.
      if (
        stableSince !== undefined &&
        Date.now() - stableSince >= 30000 &&
        element.currentTime - stableTime >= 30
      )
        retries = 0;
    };
    const waiting = () => {
      if (!wantsPlayback.current || !connected) return;
      stalled = true;
      stableSince = undefined;
      setStatus("loading");
      armLoadingTimeout();
    };
    const interrupted = () => {
      if (wantsPlayback.current && connected) retry();
    };
    const failed = () => {
      if (!wantsPlayback.current || !connected) return;
      // Some browsers report offline requests as unsupported media, even for
      // a stream they were playing moments earlier.
      if (
        element.error?.code === 3 ||
        (element.error?.code === 4 &&
          navigator.onLine !== false &&
          !hasEverPlayed)
      ) {
        stop("无法播放，请换台或重试。");
      } else retry();
    };
    const paused = () => {
      if (wantsPlayback.current && connected && element.paused) {
        stableSince = undefined;
        stalled = true;
        setStatus("loading");
        armLoadingTimeout();
      }
    };
    const wake = (event: Event) => {
      if (
        (document.hidden && event.type !== "online") ||
        !wantsPlayback.current ||
        wakeTimer !== undefined
      )
        return;
      // Let the sleep timer process its absolute deadline before any wake recovery.
      wakeTimer = setTimeout(() => {
        wakeTimer = undefined;
        if (disposed || !wantsPlayback.current || deadlineExpired()) return;
        if (exhausted) {
          if (navigator.onLine === false) return;
          // Each recovery cycle is bounded; a later external wake can begin a
          // new cycle without erasing the user's original request to listen.
          exhausted = false;
          retries = 0;
          setError("连接中断，正在重新连接…");
          connect();
          return;
        }
        const progressed = element.currentTime !== lastTime;
        if (progressed) progress();
        if (retryTimer !== undefined) {
          if (event.type === "online") {
            clearTimeout(retryTimer);
            retryTimer = undefined;
            connect();
          }
        } else if (
          connected &&
          !hasPlayed &&
          Date.now() - lastProgress < 25000
        ) {
          // A focus event must not restart an already pending initial connection.
          return;
        } else if (
          element.paused ||
          element.error ||
          stalled ||
          (!progressed && Date.now() - lastProgress >= 25000)
        ) {
          retry();
        }
      }, 0);
    };
    const events = {
      playing,
      timeupdate: progress,
      waiting,
      stalled: interrupted,
      error: failed,
      ended: interrupted,
      pause: paused,
    };
    for (const [name, handler] of Object.entries(events))
      element.addEventListener(name, handler);
    document.addEventListener("visibilitychange", wake);
    window.addEventListener("focus", wake);
    window.addEventListener("pageshow", wake);
    window.addEventListener("online", wake);
    controls.current = {
      pause: () => stop(),
      start: () => {
        retries = 0;
        exhausted = false;
        wantsPlayback.current = true;
        setError("");
        setRetryNumber(0);
        connect();
      },
    };
    wantsPlayback.current = false;
    disconnect();
    setError("");
    setRetryNumber(0);
    setElapsed(0);
    if (!station) setStatus("idle");
    else if (!url) stop("这个电台的音频地址无效，请换一个频道。");
    else if (
      !relay &&
      location.protocol === "https:" &&
      url.startsWith("http:")
    ) {
      stop("此电台使用 HTTP，请在连接设置中启用服务端中转。");
    } else {
      wantsPlayback.current = true;
      connect();
      void api(`/stations/${station.id}/click`, "POST").catch(() => {});
    }
    return () => {
      disposed = true;
      wantsPlayback.current = false;
      controls.current = null;
      clearTimers();
      for (const [name, handler] of Object.entries(events))
        element.removeEventListener(name, handler);
      document.removeEventListener("visibilitychange", wake);
      window.removeEventListener("focus", wake);
      window.removeEventListener("pageshow", wake);
      window.removeEventListener("online", wake);
      disconnect();
    };
  }, [station, relay, selection]);
  useEffect(() => {
    if (pauseRequest) controls.current?.pause();
  }, [pauseRequest]);
  useEffect(() => {
    if (status !== "playing") return;
    const timer = window.setInterval(() => setElapsed((v) => v + 1), 1000);
    return () => clearInterval(timer);
  }, [status]);
  const toggle = () => {
    if (!station) {
      if (stations[0]) onSelect(stations[0]);
    } else if (status === "error") {
      if (wantsPlayback.current) controls.current?.start();
      else onSelect(station);
    } else if (wantsPlayback.current) controls.current?.pause();
    else controls.current?.start();
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
  useLazycatControls({
    station,
    status,
    onPlay: toggle,
    onPause: toggle,
    onNext: () => next(1),
    onPrevious: () => next(-1),
  });
  const moving = status === "playing" && active && pageVisible;
  return (
    <section
      className={`receiver ${theme === "vitreous" ? "receiver-vitreous" : theme === "led" ? "receiver-vitreous receiver-led" : theme === "soft" ? "receiver-soft" : ["arc", "ivory", "mono", "retro", "signal"].includes(theme) ? "receiver-tuning" : ""}`}
      aria-label={tr("收音机播放器")}
    >
      {(theme === "arc" ||
        theme === "ivory" ||
        theme === "mono" ||
        theme === "signal") && (
        <TuningReceiver
          variant={theme}
          station={station}
          stations={stations}
          playing={status === "playing"}
          loading={status === "loading"}
          moving={moving}
          volume={volume}
          saved={saved}
          onVolume={setVolume}
          onSelect={onSelect}
          onToggle={toggle}
          onNext={next}
          onSave={onSave}
        />
      )}
      {theme === "retro" && (
        <RetroReceiver
          station={station}
          stations={stations}
          favorites={favorites}
          playing={status === "playing"}
          loading={status === "loading"}
          moving={moving}
          volume={volume}
          saved={saved}
          onVolume={setVolume}
          onSelect={onSelect}
          onToggle={toggle}
          onNext={next}
          onSave={onSave}
        />
      )}
      {theme === "soft" && (
        <SoftReceiver
          station={station}
          stations={stations}
          playing={status === "playing"}
          loading={status === "loading"}
          moving={moving}
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
          <LedScene
            playing={status === "playing"}
            saved={saved}
            moving={moving}
            volume={volume}
          />
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
        {theme === "vitreous" && (
          <PlaybackVisual
            variant="wave"
            running={moving}
            volume={volume}
            className="night-wave"
          />
        )}
        <div className="night-card">
          <div className="night-metadata">
            <p>
              <span className={status === "playing" ? "live" : ""} />
              {status === "playing"
                ? "NOW ON AIR"
                : status === "loading"
                  ? "TUNING IN"
                  : tr("待机")}
            </p>
            <h2>{station?.name || tr("请选择电台")}</h2>
            <span>
              {station ? (
                `${station.country || tr("世界电台")} · ${station.tags.split(",")[0] || "Radio"}`
              ) : (
                <TransientCopy>
                  {tr("在夜色里，遇见一个好声音。")}
                </TransientCopy>
              )}
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
              <h2 title={station?.name}>{station?.name || tr("请选择电台")}</h2>
              <p>
                {station ? (
                  `${station.country || tr("世界电台")} · ${station.codec || "AUDIO"}${station.bitrate ? ` / ${station.bitrate} KBPS` : ""}`
                ) : (
                  <TransientCopy>
                    {tr("挑一个频道，把时间调慢一点。")}
                  </TransientCopy>
                )}
              </p>
              {theme === "walnut" && (
                <PlaybackVisual
                  variant="meter"
                  running={moving}
                  volume={volume}
                />
              )}
              <div className="lcd-bottom">
                <span>
                  {status === "playing"
                    ? tr("正在收听")
                    : status === "loading"
                      ? tr("正在连接信号…")
                      : status === "error"
                        ? tr("信号中断")
                        : tr("待机")}
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
            <TransientCopy>{tr("你的节奏，你的频道")}</TransientCopy>
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
          <TransientCopy>{tr("拾起声音，放下匆忙。")}</TransientCopy>
        </div>
      </div>
      <span className="screw screw-bl" aria-hidden="true" />
      <span className="screw screw-br" aria-hidden="true" />
      {error && (
        <div className="playback-error" role="alert">
          {tr(error)}
          {retryNumber > 0 &&
            " " +
              tr("自动重连 {{attempt}} / {{total}}", {
                attempt: retryNumber,
                total: 6,
              })}
        </div>
      )}
      <div className="player-utilities">
        {station && onRouteChange && (
          <PlaybackRoute
            relay={relay}
            proxyConfigured={proxyConfigured}
            directAllowed={!requiresRelay(station)}
            onChange={onRouteChange}
          />
        )}
        <RecordingControl
          audio={audio}
          station={station}
          relay={relay}
          status={status}
          active={active}
          sourceKey={selection}
          ownerKey={ownerKey}
          onRequestRelay={onRequestRelay || (() => {})}
          onRecorded={onRecorded}
          onOpenLibrary={onOpenRecordings}
        />
        <SleepTimer
          active={active}
          onDeadlineChange={(deadline) => {
            sleepDeadline.current = deadline;
          }}
          onExpire={() => {
            controls.current?.pause();
            setTimerNotice(true);
          }}
        />
        {timerNotice && (
          <span aria-hidden="true">{tr("定时已到，已停止播放")}</span>
        )}
      </div>
      <audio ref={audio} preload="none" />
    </section>
  );
}
