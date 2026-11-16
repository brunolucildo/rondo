"use client";

import { useSyncExternalStore } from "react";
import { Button, type ButtonProps } from "./button";
import { MoonIcon, SunIcon } from "./icons";
import { applyTheme, storeTheme, type Theme } from "./theme";

function subscribe(onChange: () => void): () => void {
  const observer = new MutationObserver(onChange);

  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });

  return () => observer.disconnect();
}

const getSnapshot = (): Theme =>
  document.documentElement.dataset.theme === "dark" ? "dark" : "light";
const getServerSnapshot = (): Theme => "light";

export type ThemeToggleProps = Omit<ButtonProps, "onClick" | "children" | "aria-pressed">;

/**
 * Switches between the light and the dark theme. It is a toggle button ("Dark theme", pressed
 * when dark); the icon shows what a click leads to. The choice is saved in `localStorage` (never
 * throws) and applied to `<html data-theme>`, so nothing reloads and nothing typed is lost.
 */
export function ThemeToggle({
  className,
  variant = "outline",
  size = "icon",
  ...props
}: ThemeToggleProps) {
  const theme = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const dark = theme === "dark";

  function toggle() {
    const next: Theme = dark ? "light" : "dark";

    applyTheme(next);
    storeTheme(next);
  }

  return (
    <Button
      variant={variant}
      size={size}
      aria-label="Dark theme"
      aria-pressed={dark}
      className={className}
      onClick={toggle}
      {...props}
    >
      {dark ? <SunIcon className="size-[22px]" /> : <MoonIcon className="size-[22px]" />}
    </Button>
  );
}
