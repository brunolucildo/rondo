import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

/**
 * Automatic accessibility check (spec 0018, R16): every screen of the catalog, in both themes,
 * must have no `serious` or `critical` axe violation. The API is intercepted in the browser with
 * fictional data, so this spec needs no seeded database (the suite's web servers still start).
 */
const TOKEN = "fake-token-for-axe";
const USER = { id: "u-1", firstName: "Alex", lastName: "Morgan", email: "alex@example.test" };

type Api = "none" | "session" | "session-down" | "session-hang";

interface Screen {
  name: string;
  path: string;
  api: Api;
  signedIn?: boolean;
  ready: (page: Page) => Promise<unknown>;
}

const heading = (page: Page) => page.locator("h1").first().waitFor();

const SCREENS: Screen[] = [
  { name: "sign-in", path: "/auth/sign-in", api: "none", ready: heading },
  {
    name: "sign-in reset notice",
    path: "/auth/sign-in?reset=success",
    api: "none",
    ready: heading,
  },
  { name: "sign-up", path: "/auth/sign-up", api: "none", ready: heading },
  { name: "forgot-password", path: "/auth/forgot-password", api: "none", ready: heading },
  { name: "resend-confirmation", path: "/auth/resend-confirmation", api: "none", ready: heading },
  {
    name: "confirm-account (no token)",
    path: "/auth/confirm-account",
    api: "none",
    ready: heading,
  },
  {
    name: "reset-password",
    path: "/auth/reset-password?token=fictional",
    api: "none",
    ready: heading,
  },
  { name: "reset-password (no token)", path: "/auth/reset-password", api: "none", ready: heading },
  { name: "home", path: "/app", api: "session", signedIn: true, ready: heading },
  { name: "not-found", path: "/does-not-exist", api: "none", ready: heading },
  {
    name: "session-error",
    path: "/app",
    api: "session-down",
    signedIn: true,
    ready: (page) => page.getByRole("button", { name: "Try again" }).waitFor(),
  },
  {
    name: "session-loading",
    path: "/app",
    api: "session-hang",
    signedIn: true,
    ready: (page) => page.getByText("Verifying your session").waitFor(),
  },
];

async function mockApi(page: Page, api: Api) {
  await page.route("**/api/v1/**", async (route) => {
    const cors = {
      "access-control-allow-origin": "*",
      "access-control-allow-headers": "*",
      "access-control-allow-methods": "GET,POST,OPTIONS",
    };

    if (route.request().method() === "OPTIONS") {
      await route.fulfill({ status: 204, headers: cors });
      return;
    }

    if (api === "session-hang") {
      return; // never answered: the screen stays in its loading state
    }

    if (api === "session-down") {
      await route.abort("connectionrefused");
      return;
    }

    await route.fulfill({
      status: api === "session" ? 200 : 404,
      headers: { ...cors, "content-type": "application/json" },
      body: JSON.stringify(
        api === "session"
          ? { user: USER }
          : { error: { code: "NOT_FOUND", message: "Not found.", details: [] } },
      ),
    });
  });
}

for (const theme of ["light", "dark"] as const) {
  for (const screen of SCREENS) {
    test(`${screen.name} has no serious accessibility violation (${theme} theme)`, async ({
      page,
    }) => {
      await page.addInitScript(
        ([themeKey, choice, tokenKey, token, signedIn]) => {
          window.localStorage.setItem(themeKey as string, choice as string);

          if (signedIn) {
            window.localStorage.setItem(tokenKey as string, token as string);
          }
        },
        ["rondo-theme", theme, "access_token", TOKEN, Boolean(screen.signedIn)],
      );
      await mockApi(page, screen.api);
      await page.goto(screen.path);
      await screen.ready(page);
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);

      const { violations } = await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
        .analyze();
      const blocking = violations.filter(
        (violation) => violation.impact === "serious" || violation.impact === "critical",
      );

      expect(
        blocking.map((violation) => `${violation.id}: ${violation.nodes.length} node(s)`),
      ).toEqual([]);
    });
  }
}
