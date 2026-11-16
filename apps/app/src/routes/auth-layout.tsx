import { RondoWordmark } from "@repo/ui/brand";
import { FieldBackdrop } from "@repo/ui/pitch";
import { ThemeToggle } from "@repo/ui/theme-toggle";
import { Outlet, useLocation } from "@tanstack/react-router";
import { getAuthPageRedirect } from "../features/auth/auth-redirect";
import { SessionLoading } from "../features/auth/session-states";
import { useRedirect } from "../features/auth/use-redirect";
import { useSession } from "../features/auth/use-session";

/**
 * Layout of the public `/auth/*` group (sign-up, sign-in, password recovery). A visitor
 * with a valid session is sent to `/app` (except on the link pages); with a stored token
 * the page waits for the check, and an invalid or unverifiable token never blocks it.
 *
 * Visual: a pixel pitch on one side (a short strip above the card on small screens) and the
 * form on the other. The wordmark is shown here, once, so the pages do not repeat it.
 */
export function AuthLayout() {
  const { pathname } = useLocation();
  const session = useSession();
  const redirect = getAuthPageRedirect(pathname, session.data !== undefined);
  const mustWait = session.isLoading && getAuthPageRedirect(pathname, true) !== null;

  useRedirect(redirect);

  if (redirect !== null) {
    return null;
  }

  if (mustWait) {
    return (
      <div data-testid="auth-layout" className="min-h-screen bg-background text-foreground">
        <SessionLoading />
      </div>
    );
  }

  return (
    <div
      data-testid="auth-layout"
      className="grid min-h-screen grid-rows-[auto_1fr] bg-background text-foreground lg:grid-cols-[minmax(0,1fr)_minmax(0,40rem)] lg:grid-rows-1"
    >
      <aside className="relative h-28 overflow-hidden border-b-2 border-border sm:h-36 lg:h-auto lg:border-r-2 lg:border-b-0">
        <FieldBackdrop />
        <p className="absolute bottom-8 left-8 hidden max-w-[16rem] rounded-md border-2 border-border bg-background px-4 py-3 text-lg font-bold text-foreground shadow-pixel lg:block">
          Club knowledge, in play.
        </p>
      </aside>
      <div className="flex min-w-0 flex-col gap-8 px-6 py-6 sm:px-10 lg:py-8">
        <header className="flex items-center justify-between gap-4">
          <RondoWordmark title="Rondo" className="h-7 w-auto" />
          <ThemeToggle />
        </header>
        <main className="mx-auto flex w-full max-w-md flex-1 flex-col justify-center pb-6">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
