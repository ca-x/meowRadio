import { useState, useEffect } from "react";
export default function useTheme() {
  const [theme, setTheme] = useState<"walnut" | "vitreous" | "led" | "soft">(
    () => {
      try {
        const saved = localStorage.getItem("meow-theme");
        return saved === "vitreous" || saved === "led" || saved === "soft"
          ? saved
          : "walnut";
      } catch {
        return "walnut";
      }
    },
  );
  const [colorMode, setColorMode] = useState<"light" | "dark">(() => {
    try {
      const saved = localStorage.getItem("meow-color");
      if (saved === "light" || saved === "dark") return saved;
    } catch {
      /* private storage */
    }
    return theme === "vitreous" || theme === "led" ? "dark" : "light";
  });
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.documentElement.dataset.color = colorMode;
    const color =
      getComputedStyle(document.documentElement)
        .getPropertyValue("--canvas")
        .trim() || (colorMode === "dark" ? "#101315" : "#eeeae3");
    document
      .querySelector('meta[name="theme-color"]')
      ?.setAttribute("content", color);
    try {
      localStorage.setItem("meow-theme", theme);
      localStorage.setItem("meow-color", colorMode);
    } catch {
      /* private storage */
    }
  }, [theme, colorMode]);
  return [theme, setTheme, colorMode, setColorMode] as const;
}
