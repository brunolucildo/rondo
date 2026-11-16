// Captures the UI catalog of spec 0018 (.specs/0018-ui-redesign-retro-8bit.md §5) into
// `.screenshots/`. Deterministic: every API call is intercepted in the browser with fictional
// data, so no API, no database and no real e-mail or token are involved.
//
// Usage (the app on :5173 and the docs on :3001 must be running):
//   node scripts/capture-screenshots.mjs --phase before
//   node scripts/capture-screenshots.mjs --phase after
//   node scripts/capture-screenshots.mjs --phase after --only sign-in,home
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { chromium } from "@playwright/test";

const APP = process.env.CAPTURE_APP_URL ?? "http://localhost:5173";
const DOCS = process.env.CAPTURE_DOCS_URL ?? "http://localhost:3001";
const OUT = join(import.meta.dirname, "..", ".screenshots");

const args = process.argv.slice(2);
const option = (name) => {
  const index = args.indexOf(`--${name}`);

  return index === -1 ? undefined : args[index + 1];
};
const phase = option("phase");
const only = option("only")?.split(",");

if (phase !== "before" && phase !== "after") {
  console.error("Use --phase before|after");
  process.exit(1);
}

const FAKE_TOKEN = "fake-token-for-screenshots";
const FAKE_USER = { id: "u-1", firstName: "Alex", lastName: "Morgan", email: "alex@example.test" };
const FAKE_PASSWORD = "Correct-Horse-9";

const DESKTOP = { width: 1280, height: 800 };
const MOBILE = { width: 375, height: 812 };

/** Fictional API: `responses` maps "METHOD /path" to `{ status, body }` or "abort" or "hang". */
async function mockApi(page, responses) {
  await page.route("**/api/v1/**", async (route) => {
    const request = route.request();
    const cors = {
      "access-control-allow-origin": APP,
      "access-control-allow-headers": "*",
      "access-control-allow-methods": "GET,POST,OPTIONS",
    };

    if (request.method() === "OPTIONS") {
      await route.fulfill({ status: 204, headers: cors });
      return;
    }

    const key = `${request.method()} ${new URL(request.url()).pathname.replace("/api/v1", "")}`;
    const response = responses[key];

    if (response === "abort") {
      await route.abort("connectionrefused");
      return;
    }

    if (response === "hang") {
      return; // never answered: the screen stays in its loading state
    }

    await route.fulfill({
      status: response?.status ?? 404,
      headers: { ...cors, "content-type": "application/json" },
      body: JSON.stringify(
        response?.body ?? { error: { code: "NOT_FOUND", message: "Not found.", details: [] } },
      ),
    });
  });
}

async function signedIn(page) {
  await page.addInitScript(
    (token) => window.localStorage.setItem("access_token", token),
    FAKE_TOKEN,
  );
}

async function settle(page) {
  await page.waitForSelector("h1, [role=status]");
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(250);
}

const fill = (page, label, value) => page.getByLabel(label, { exact: true }).fill(value);

/** The catalog of §5. `mobile` and `dark` mark the screens that also get those variants. */
const catalog = [
  {
    name: "sign-in",
    mobile: true,
    run: async (page) => {
      await mockApi(page, {});
      await page.goto(`${APP}/auth/sign-in`);
    },
  },
  {
    name: "sign-in-errors",
    run: async (page) => {
      await mockApi(page, {});
      await page.goto(`${APP}/auth/sign-in`);
      await page.getByRole("button", { name: "Sign in" }).click();
    },
  },
  {
    // The general (credentials) error: a server failure clears the client field errors, so it
    // is its own frame next to `sign-in-errors`.
    name: "sign-in-error-general",
    run: async (page) => {
      await mockApi(page, {
        "POST /auth/sign-in": {
          status: 401,
          body: { error: { code: "INVALID_CREDENTIALS", message: "Invalid.", details: [] } },
        },
      });
      await page.goto(`${APP}/auth/sign-in`);
      await fill(page, "Email", "alex@example.test");
      await fill(page, "Password", FAKE_PASSWORD);
      await page.getByRole("button", { name: "Sign in" }).click();
      await page.waitForSelector("[role=alert]");
    },
  },
  {
    name: "sign-in-reset-success",
    run: async (page) => {
      await mockApi(page, {});
      await page.goto(`${APP}/auth/sign-in?reset=success`);
    },
  },
  {
    name: "sign-up",
    mobile: true,
    run: async (page) => {
      await mockApi(page, {});
      await page.goto(`${APP}/auth/sign-up`);
    },
  },
  {
    name: "sign-up-errors",
    run: async (page) => {
      await mockApi(page, {});
      await page.goto(`${APP}/auth/sign-up`);
      await fill(page, "Email", "not-an-email");
      await fill(page, "Password", "short");
      await page.getByRole("button", { name: "Create account" }).click();
    },
  },
  {
    name: "sign-up-success",
    run: async (page) => {
      await mockApi(page, {
        "POST /auth/sign-up": { status: 201, body: { email: "alex@example.test" } },
      });
      await page.goto(`${APP}/auth/sign-up`);
      await fill(page, "First name", "Alex");
      await fill(page, "Last name", "Morgan");
      await fill(page, "Email", "alex@example.test");
      await fill(page, "Password", FAKE_PASSWORD);
      await fill(page, "Confirm password", FAKE_PASSWORD);
      await page.getByRole("button", { name: "Create account" }).click();
      await page.getByRole("heading", { name: "Check your email" }).waitFor();
    },
  },
  {
    name: "forgot-password",
    run: async (page) => {
      await mockApi(page, {});
      await page.goto(`${APP}/auth/forgot-password`);
    },
  },
  {
    name: "forgot-password-success",
    run: async (page) => {
      await mockApi(page, { "POST /auth/forgot-password": { status: 202, body: {} } });
      await page.goto(`${APP}/auth/forgot-password`);
      await fill(page, "Email", "alex@example.test");
      await page.getByRole("button", { name: "Send reset link" }).click();
      await page.getByRole("status").waitFor();
    },
  },
  {
    name: "resend-confirmation",
    run: async (page) => {
      await mockApi(page, {});
      await page.goto(`${APP}/auth/resend-confirmation`);
    },
  },
  {
    name: "resend-confirmation-success",
    run: async (page) => {
      await mockApi(page, { "POST /auth/resend-confirmation": { status: 202, body: {} } });
      await page.goto(`${APP}/auth/resend-confirmation`);
      await fill(page, "Email", "alex@example.test");
      await page.getByRole("button", { name: "Send new link" }).click();
      await page.getByRole("status").waitFor();
    },
  },
  {
    name: "confirm-account-invalid",
    run: async (page) => {
      await mockApi(page, {});
      await page.goto(`${APP}/auth/confirm-account`);
    },
  },
  {
    name: "reset-password",
    run: async (page) => {
      await mockApi(page, {});
      await page.goto(`${APP}/auth/reset-password?token=fictional-token`);
      await page.getByRole("heading", { name: "Choose a new password" }).waitFor();
    },
  },
  {
    name: "reset-password-invalid",
    run: async (page) => {
      await mockApi(page, {});
      await page.goto(`${APP}/auth/reset-password`);
    },
  },
  {
    name: "home",
    mobile: true,
    run: async (page) => {
      await signedIn(page);
      await mockApi(page, { "GET /auth/session": { status: 200, body: { user: FAKE_USER } } });
      await page.goto(`${APP}/app`);
      await page.getByRole("heading", { name: /Welcome/ }).waitFor();
    },
  },
  {
    name: "not-found",
    mobile: true,
    run: async (page) => {
      await mockApi(page, {});
      await page.goto(`${APP}/does-not-exist`);
    },
  },
  {
    name: "session-error",
    run: async (page) => {
      await signedIn(page);
      await mockApi(page, { "GET /auth/session": "abort" });
      await page.goto(`${APP}/app`);
      await page.getByRole("button", { name: "Try again" }).waitFor();
    },
  },
  {
    name: "session-loading",
    run: async (page) => {
      await signedIn(page);
      await mockApi(page, { "GET /auth/session": "hang" });
      await page.goto(`${APP}/app`);
      await page.getByText("Verifying your session").waitFor();
    },
  },
  {
    name: "docs-home",
    mobile: true,
    run: async (page) => {
      await page.goto(DOCS);
      // Hides the Next.js dev indicator (a dev-server overlay, not part of the page).
      await page.addStyleTag({ content: "nextjs-portal { display: none !important; }" });
    },
  },
];

async function capture(browser, entry, variant) {
  const viewport = variant === "mobile" ? MOBILE : DESKTOP;
  const context = await browser.newContext({
    viewport,
    deviceScaleFactor: 1,
    colorScheme: variant === "dark" ? "dark" : "light",
    reducedMotion: "no-preference",
  });
  const page = await context.newPage();

  try {
    await entry.run(page);
    await settle(page);

    const suffix = variant === "desktop" ? "" : `-${variant}`;
    const file = join(OUT, `${entry.name}${suffix}_${phase}.png`);

    await page.screenshot({ path: file, animations: "disabled", caret: "hide" });
    console.log(`ok   ${file}`);
  } catch (error) {
    console.error(`FAIL ${entry.name} (${variant}): ${error.message.split("\n")[0]}`);
    process.exitCode = 1;
  } finally {
    await context.close();
  }
}

await mkdir(OUT, { recursive: true });

const browser = await chromium.launch();

for (const entry of catalog) {
  if (only && !only.includes(entry.name)) {
    continue;
  }

  await capture(browser, entry, "desktop");

  if (entry.mobile) {
    await capture(browser, entry, "mobile");
  }

  // There is no dark "before": the theme did not exist.
  if (entry.mobile && phase === "after") {
    await capture(browser, entry, "dark");
  }
}

await browser.close();
