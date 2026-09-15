import { useEffect, useRef, useState, type ReactNode } from "react";
import "./transient-copy.css";

/** Decorative copy appears once when visible; its reserved space never shifts. */
export default function TransientCopy({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) {
  const element = useRef<HTMLSpanElement>(null);
  const [phase, setPhase] = useState("pending");
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let shown = false;
    const show = () => {
      if (shown) return;
      shown = true;
      setPhase("visible");
      timer = setTimeout(() => setPhase("hidden"), 1680);
    };
    const observer =
      typeof IntersectionObserver === "undefined"
        ? null
        : new IntersectionObserver((entries) => {
            if (entries.some((entry) => entry.isIntersecting)) {
              show();
              observer?.disconnect();
            }
          });
    if (observer && element.current) observer.observe(element.current);
    else show();
    return () => {
      observer?.disconnect();
      clearTimeout(timer);
    };
  }, []);
  return (
    <span
      ref={element}
      className={`transient-copy ${className}`}
      data-phase={phase}
      aria-hidden="true"
    >
      {children}
    </span>
  );
}
