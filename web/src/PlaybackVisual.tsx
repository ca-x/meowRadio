import type { CSSProperties } from "react";
import "./playback-visual.css";

type Variant = "meter" | "wave" | "soft" | "led";

type Props = {
  variant: Variant;
  /** Actual playback, already gated by the active theme and page visibility. */
  running: boolean;
  volume: number;
  className?: string;
};

const counts: Record<Variant, number> = {
  meter: 16,
  wave: 41,
  soft: 15,
  led: 12,
};

type BarStyle = CSSProperties & Record<`--${string}`, number | string>;

/** Decorative playback feedback; these shapes do not represent measured audio. */
export default function PlaybackVisual({
  variant,
  running,
  volume,
  className = "",
}: Props) {
  const level = Number.isFinite(volume) ? Math.min(1, Math.max(0, volume)) : 0;
  const moving = running && level > 0;
  const count = counts[variant];

  return (
    <div
      className={`playback-visual playback-visual--${variant} ${className}`.trim()}
      data-running={moving}
      aria-hidden="true"
    >
      {Array.from({ length: count }, (_, index) => {
        const position = index / (count - 1);
        const envelope =
          variant === "meter" || variant === "led"
            ? 0.55 + 0.45 * Math.sin(position * Math.PI)
            : 0.18 + 0.82 * Math.sin(position * Math.PI) ** 1.4;
        const amplitude = envelope * (0.25 + level * 0.75);
        const sample = (phase: number) =>
          0.12 +
          amplitude *
            (0.42 +
              0.23 * Math.sin(index * 0.73 + phase) +
              0.15 * Math.cos(index * 1.31 - phase * 2));
        const style: BarStyle = {
          "--bar-a": sample(0),
          "--bar-b": sample(Math.PI / 2),
          "--bar-c": sample(Math.PI),
          "--bar-d": sample((Math.PI * 3) / 2),
          animationDelay: `${-index * 0.11}s`,
        };

        return <i className="playback-visual__bar" style={style} key={index} />;
      })}
    </div>
  );
}
