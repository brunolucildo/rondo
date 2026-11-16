import { themeInitScript, THEME_STORAGE_KEY } from "@repo/ui/theme";
import { ThemeToggle } from "@repo/ui/theme-toggle";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

function systemPrefersDark(dark: boolean) {
  vi.stubGlobal(
    "matchMedia",
    vi.fn((query: string) => ({ matches: dark && query.includes("dark"), media: query })),
  );
}

function runInitScript() {
  // The script is plain ES5 meant for the head; running it here does what the browser does.
  new Function(themeInitScript)();
}

beforeEach(() => {
  delete document.documentElement.dataset.theme;
  systemPrefersDark(false);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete document.documentElement.dataset.theme;
});

describe("pre-paint theme script", () => {
  it("follows a dark system preference when nothing was chosen", () => {
    systemPrefersDark(true);
    runInitScript();

    expect(document.documentElement.dataset.theme).toBe("dark");
  });

  it("follows a light system preference when nothing was chosen", () => {
    runInitScript();

    expect(document.documentElement.dataset.theme).toBe("light");
  });

  it("lets a stored choice win over the system", () => {
    systemPrefersDark(true);
    window.localStorage.setItem(THEME_STORAGE_KEY, "light");
    runInitScript();

    expect(document.documentElement.dataset.theme).toBe("light");
  });

  it("ignores an invalid stored value", () => {
    systemPrefersDark(true);
    window.localStorage.setItem(THEME_STORAGE_KEY, "purple");
    runInitScript();

    expect(document.documentElement.dataset.theme).toBe("dark");
  });

  it("renders in the system theme, without throwing, when storage is unavailable", () => {
    systemPrefersDark(true);
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });

    expect(runInitScript).not.toThrow();
    expect(document.documentElement.dataset.theme).toBe("dark");
  });

  it("is the same script inline in apps/app/index.html (the formatter may only change whitespace)", () => {
    const html = readFileSync(resolve(process.cwd(), "index.html"), "utf8");
    const inline = /<script>([\s\S]*?)<\/script>/.exec(html)?.[1] ?? "";
    const squash = (code: string) => code.replace(/\s+/g, "");

    expect(squash(inline)).toBe(squash(themeInitScript));
  });
});

describe("ThemeToggle", () => {
  it("is a toggle named Dark theme, pressed only in the dark theme", () => {
    document.documentElement.dataset.theme = "dark";
    render(<ThemeToggle />);

    expect(screen.getByRole("button", { name: "Dark theme" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("switches the theme and remembers the choice", async () => {
    document.documentElement.dataset.theme = "light";
    const user = userEvent.setup();

    render(<ThemeToggle />);

    const toggle = screen.getByRole("button", { name: "Dark theme" });

    expect(toggle).toHaveAttribute("aria-pressed", "false");

    await user.click(toggle);

    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe("dark");
    expect(toggle).toHaveAttribute("aria-pressed", "true");

    await user.click(toggle);

    expect(document.documentElement.dataset.theme).toBe("light");
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe("light");
  });

  it("works without localStorage: the theme still changes for this page", async () => {
    document.documentElement.dataset.theme = "light";
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    const user = userEvent.setup();

    render(<ThemeToggle />);
    await user.click(screen.getByRole("button", { name: "Dark theme" }));

    expect(document.documentElement.dataset.theme).toBe("dark");
  });

  it("follows a theme change made elsewhere", async () => {
    document.documentElement.dataset.theme = "light";
    render(<ThemeToggle />);

    await act(async () => {
      document.documentElement.dataset.theme = "dark";
      await Promise.resolve();
    });

    expect(screen.getByRole("button", { name: "Dark theme" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("is usable by keyboard and accepts className", async () => {
    const user = userEvent.setup();

    render(<ThemeToggle className="extra" />);
    await user.tab();

    const toggle = screen.getByRole("button", { name: "Dark theme" });

    expect(toggle).toHaveFocus();
    expect(toggle).toHaveClass("extra");

    await user.keyboard("{Enter}");

    expect(document.documentElement.dataset.theme).toBe("dark");
  });
});
