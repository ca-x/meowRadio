import TransientCopy from "./TransientCopy";
import { useEffect, useId, useRef, useState } from "react";
import type { KeyboardEvent, PointerEvent } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { Clock3, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { tr } from "./i18n";
import "./sleep-timer.css";

type Props = { onExpire: () => void; disabled?: boolean; active?: boolean };
type Hand = "hour" | "minute";
const reminderOptions = [0, 10, 30, 60, 300] as const;
function savedReminder() {
  try {
    const saved = localStorage.getItem("meow-countdown-lead");
    const value = saved === null ? 30 : Number(saved);
    return reminderOptions.some((option) => option === value) ? value : 30;
  } catch {
    return 30;
  }
}
const clamp = (value: number, max: number) =>
  Math.min(max, Math.max(0, Math.round(value)));
function countdown(milliseconds: number) {
  const seconds = Math.max(0, Math.ceil(milliseconds / 1000));
  const hours = Math.floor(seconds / 3600);
  return `${hours ? `${hours}:` : ""}${String(Math.floor(seconds / 60) % 60).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}

export default function SleepTimer({
  onExpire,
  disabled = false,
  active = true,
}: Props) {
  useTranslation();
  const [open, setOpen] = useState(false);
  const [hours, setHours] = useState(0);
  const [minutes, setMinutes] = useState(30);
  const [deadline, setDeadline] = useState<number | null>(null);
  const [remaining, setRemaining] = useState(0);
  const [reminderLead, setReminderLead] = useState(savedReminder);
  const [finalMotion, setFinalMotion] = useState(false);
  const finalAnnounced = useRef(false);
  const suppressFinalMotion = useRef(false);
  const finalPhase =
    deadline !== null &&
    remaining > 0 &&
    reminderLead > 0 &&
    remaining <= reminderLead * 1000;
  const [notice, setNotice] = useState<
    "started" | "cancelled" | "expired" | "final" | null
  >(null);
  const activeDeadline = useRef<number | null>(null);
  const expire = useRef(onExpire);
  const face = useRef<HTMLDivElement>(null);
  const drag = useRef<{ hand: Hand; pointer: number } | null>(null);
  const hintId = useId();
  const hourId = useId();
  const minuteId = useId();
  const reminderId = useId();
  useEffect(() => {
    try {
      localStorage.setItem("meow-countdown-lead", String(reminderLead));
    } catch {
      // Keep the in-session preference when browser storage is unavailable.
    }
  }, [reminderLead]);
  useEffect(() => {
    if (finalPhase && !finalAnnounced.current) {
      finalAnnounced.current = true;
      setFinalMotion(active && !suppressFinalMotion.current);
      setNotice("final");
    }
    suppressFinalMotion.current = false;
  }, [finalPhase, deadline, remaining, reminderLead, active]);
  useEffect(() => {
    expire.current = onExpire;
  }, [onExpire]);
  useEffect(() => {
    if (!active) {
      setOpen(false);
      setFinalMotion(false);
    }
    if (!active || !open) drag.current = null;
  }, [active, open]);

  useEffect(() => {
    if (deadline === null) return;
    const tick = () => {
      if (activeDeadline.current !== deadline) return;
      const left = Math.max(0, deadline - Date.now());
      setRemaining(left);
      if (left === 0) {
        // Clear synchronously before notifying playback: interval and wake events may coincide.
        activeDeadline.current = null;
        setDeadline(null);
        setNotice("expired");
        expire.current();
      }
    };
    tick();
    const interval = window.setInterval(tick, 1000);
    document.addEventListener("visibilitychange", tick);
    window.addEventListener("focus", tick);
    window.addEventListener("pageshow", tick);
    return () => {
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", tick);
      window.removeEventListener("focus", tick);
      window.removeEventListener("pageshow", tick);
    };
  }, [deadline]);

  const total = hours * 60 + minutes;
  const setHand = (hand: Hand, value: number) => {
    if (!Number.isFinite(value)) return;
    if (hand === "hour") setHours(clamp(value, 11));
    else setMinutes(clamp(value, 59));
  };
  const rotate = (event: PointerEvent<HTMLButtonElement>, hand: Hand) => {
    const bounds = face.current?.getBoundingClientRect();
    if (!bounds) return;
    const x = event.clientX - bounds.left - bounds.width / 2;
    const y = event.clientY - bounds.top - bounds.height / 2;
    if (Math.hypot(x, y) < 16) return;
    const turn = (Math.atan2(x, -y) + 2 * Math.PI) % (2 * Math.PI);
    const divisions = hand === "hour" ? 12 : 60;
    setHand(hand, Math.round((turn / (2 * Math.PI)) * divisions) % divisions);
  };
  const keyHand = (event: KeyboardEvent<HTMLButtonElement>, hand: Hand) => {
    const value = hand === "hour" ? hours : minutes;
    const maximum = hand === "hour" ? 11 : 59;
    const next = {
      ArrowUp: value + 1,
      ArrowRight: value + 1,
      ArrowDown: value - 1,
      ArrowLeft: value - 1,
      PageUp: value + (hand === "hour" ? 1 : 5),
      PageDown: value - (hand === "hour" ? 1 : 5),
      Home: 0,
      End: maximum,
    }[event.key];
    if (next !== undefined) {
      event.preventDefault();
      setHand(hand, next);
    }
  };
  const start = () => {
    if (!total || disabled) return;
    const target = Date.now() + total * 60_000;
    activeDeadline.current = target;
    finalAnnounced.current = false;
    suppressFinalMotion.current = true;
    setFinalMotion(false);
    setRemaining(total * 60_000);
    setDeadline(target);
    setNotice("started");
    setOpen(false);
  };
  const cancel = () => {
    activeDeadline.current = null;
    setDeadline(null);
    setRemaining(0);
    setNotice("cancelled");
    setOpen(false);
  };

  return (
    <Dialog.Root open={open && active} onOpenChange={setOpen}>
      <div className="sleep-timer-control" hidden={!active}>
        <Dialog.Trigger asChild>
          <button
            className="sleep-timer-entry"
            data-running={deadline !== null}
            disabled={disabled && deadline === null}
          >
            <Clock3 size={16} aria-hidden="true" />
            <span>
              {deadline === null
                ? tr("定时关闭")
                : tr("{{time}} 后关闭", { time: countdown(remaining) })}
            </span>
          </button>
        </Dialog.Trigger>
        {finalPhase && (
          <div
            className="sleep-timer-final"
            data-animate={finalMotion}
            role="timer"
            aria-live="off"
            aria-label={tr("即将停止播放")}
          >
            <span className="sleep-timer-final-halo" aria-hidden="true" />
            <span className="sleep-timer-final-label">{tr("即将停止")}</span>
            <strong>{countdown(remaining)}</strong>
          </div>
        )}
      </div>
      <span className="sleep-timer-sr" role="status" hidden={!active}>
        {notice === "started"
          ? tr("已设置定时关闭")
          : notice === "cancelled"
            ? tr("已取消定时关闭")
            : notice === "expired"
              ? tr("时间到了，已停止播放")
              : notice === "final"
                ? tr("即将停止播放，已进入最后倒计时")
                : ""}
      </span>
      <Dialog.Portal>
        <Dialog.Overlay className="sleep-timer-overlay" />
        <Dialog.Content className="sleep-timer-dialog">
          <div className="sleep-timer-heading">
            <Dialog.Title>{tr("定时关闭")}</Dialog.Title>
            <Dialog.Close asChild>
              <button
                className="sleep-timer-close"
                aria-label={tr("关闭定时设置")}
              >
                <X size={20} />
              </button>
            </Dialog.Close>
          </div>
          <Dialog.Description className="sleep-timer-description">
            <TransientCopy>
              {tr("让声音陪你入睡，到时自动停止播放。")}
            </TransientCopy>
          </Dialog.Description>
          {deadline !== null && (
            <p className="sleep-timer-active">
              {tr("正在倒计时 · {{time}}", { time: countdown(remaining) })}
            </p>
          )}
          <div className="sleep-timer-clock" ref={face}>
            <div className="sleep-timer-dial" aria-hidden="true">
              {Array.from({ length: 60 }, (_, index) => (
                <i
                  key={index}
                  className={index % 5 === 0 ? "major" : ""}
                  style={{ transform: `rotate(${index * 6}deg)` }}
                />
              ))}
              {[0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11].map((value) => (
                <span
                  key={value}
                  style={{
                    left: `${50 + Math.sin((value * Math.PI) / 6) * 37}%`,
                    top: `${50 - Math.cos((value * Math.PI) / 6) * 37}%`,
                  }}
                >
                  {value === 0 ? "0" : value}
                </span>
              ))}
            </div>
            {(["minute", "hour"] as const).map((hand) => (
              <button
                key={hand}
                type="button"
                role="slider"
                className={`sleep-timer-hand sleep-timer-${hand}`}
                aria-label={hand === "hour" ? tr("时针") : tr("分针")}
                aria-valuemin={0}
                aria-valuemax={hand === "hour" ? 11 : 59}
                aria-valuenow={hand === "hour" ? hours : minutes}
                aria-valuetext={
                  hand === "hour"
                    ? tr("{{count}} 小时", { count: hours })
                    : tr("{{count}} 分钟", { count: minutes })
                }
                aria-describedby={hintId}
                style={{
                  transform: `translateX(-50%) rotate(${hand === "hour" ? hours * 30 : minutes * 6}deg)`,
                }}
                onKeyDown={(event) => keyHand(event, hand)}
                onPointerDown={(event) => {
                  if (drag.current || event.button !== 0) return;
                  event.preventDefault();
                  event.currentTarget.focus({ preventScroll: true });
                  event.currentTarget.setPointerCapture(event.pointerId);
                  drag.current = { hand, pointer: event.pointerId };
                  rotate(event, hand);
                }}
                onPointerMove={(event) => {
                  if (
                    drag.current?.pointer === event.pointerId &&
                    drag.current.hand === hand
                  )
                    rotate(event, hand);
                }}
                onPointerUp={(event) => {
                  if (drag.current?.pointer !== event.pointerId) return;
                  drag.current = null;
                  if (event.currentTarget.hasPointerCapture(event.pointerId))
                    event.currentTarget.releasePointerCapture(event.pointerId);
                }}
                onPointerCancel={() => {
                  drag.current = null;
                }}
                onLostPointerCapture={() => {
                  drag.current = null;
                }}
              >
                <span aria-hidden="true" />
              </button>
            ))}
            <b className="sleep-timer-pin" aria-hidden="true" />
          </div>
          <p id={hintId} className="sleep-timer-hint">
            {tr("拖动时针或分针，也可用方向键微调。")}
          </p>
          <div className="sleep-timer-fields">
            <label htmlFor={hourId}>
              <input
                id={hourId}
                type="number"
                inputMode="numeric"
                min={0}
                max={11}
                value={hours}
                onChange={(event) =>
                  setHand("hour", Number(event.target.value))
                }
              />
              {tr("小时")}
            </label>
            <span aria-hidden="true">:</span>
            <label htmlFor={minuteId}>
              <input
                id={minuteId}
                type="number"
                inputMode="numeric"
                min={0}
                max={59}
                value={minutes}
                onChange={(event) =>
                  setHand("minute", Number(event.target.value))
                }
              />
              {tr("分钟")}
            </label>
          </div>
          <div className="sleep-timer-presets" aria-label={tr("常用时长")}>
            {[15, 30, 60, 120].map((value) => (
              <button
                key={value}
                aria-pressed={total === value}
                onClick={() => {
                  setHours(Math.floor(value / 60));
                  setMinutes(value % 60);
                }}
              >
                {value < 60
                  ? tr("{{count}} 分钟", { count: value })
                  : tr("{{count}} 小时", { count: value / 60 })}
              </button>
            ))}
          </div>
          <div className="sleep-timer-reminder">
            <label htmlFor={reminderId}>{tr("提前强调倒计时")}</label>
            <select
              id={reminderId}
              value={reminderLead}
              onChange={(event) => {
                suppressFinalMotion.current = true;
                setFinalMotion(false);
                setReminderLead(Number(event.target.value));
              }}
            >
              {reminderOptions.map((value) => (
                <option key={value} value={value}>
                  {value === 0
                    ? tr("关闭提醒")
                    : value < 60
                      ? tr("提前 {{count}} 秒", { count: value })
                      : tr("提前 {{count}} 分钟", { count: value / 60 })}
                </option>
              ))}
            </select>
          </div>
          <div className="sleep-timer-actions">
            {deadline !== null && (
              <button className="sleep-timer-cancel" onClick={cancel}>
                {tr("取消定时")}
              </button>
            )}
            <button
              className="sleep-timer-start"
              disabled={total === 0 || disabled}
              onClick={start}
            >
              {deadline === null ? tr("开始计时") : tr("重新计时")}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
