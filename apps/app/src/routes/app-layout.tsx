import { RondoWordmark } from "@repo/ui/brand";
import { ThemeToggle } from "@repo/ui/theme-toggle";
import { Outlet } from "@tanstack/react-router";
import { SessionError, SessionLoading } from "../features/auth/session-states";
import { SignOutButton } from "../features/auth/sign-out-button";
import { useRedirect } from "../features/auth/use-redirect";
import { useSession } from "../features/auth/use-session";
import { getAccessToken } from "../lib/access-token";
import { isUnauthenticated } from "../lib/api-client";

/**
 * Layout of the private `/app/*` group and the second half of its guard (the router's
 * `beforeLoad` already sent away visitors without a token). It asks the API who the token
 * belongs to and renders the page only for a valid session: a loading state while it
 * checks, a retry screen when the check itself fails, and the sign-in page when the API
 * says the session is gone (the API client has already dropped the token by then). With a valid
 * session it also draws the shell header (wordmark, theme toggle, sign-out); the full-screen
 * states carry the compact mark instead.
 */
export function AppLayout() {
  const session = useSession();
  const lostSession = getAccessToken() === null || isUnauthenticated(session.error);

  useRedirect(lostSession ? "/auth/sign-in" : null);

  let content;

  if (lostSession) {
    content = null;
  } else if (session.data !== undefined) {
    content = (
      <>
        <header className="flex items-center justify-between gap-4 border-b-2 border-border bg-card px-6 py-3">
          <RondoWordmark title="Rondo" className="h-7 w-auto" />
          <div className="flex items-center gap-3">
            <ThemeToggle />
            <SignOutButton />
          </div>
        </header>
        <Outlet />
      </>
    );
  } else if (session.isError) {
    content = <SessionError onRetry={() => void session.refetch()} />;
  } else {
    content = <SessionLoading />;
  }

  return (
    <div
      data-testid="app-layout"
      className="flex min-h-screen flex-col bg-background text-foreground"
    >
      {content}
    </div>
  );
}
