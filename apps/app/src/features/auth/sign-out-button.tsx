import { Button } from "@repo/ui/button";
import { Spinner } from "@repo/ui/spinner";
import { useSignOut } from "./use-sign-out";

/** Ends the current session. Disabled while the request runs, so it cannot be sent twice. */
export function SignOutButton() {
  const signOut = useSignOut();

  return (
    <Button
      variant="outline"
      className="min-w-28"
      disabled={signOut.isPending}
      aria-busy={signOut.isPending}
      onClick={() => signOut.mutate()}
    >
      {signOut.isPending ? <Spinner className="size-5" /> : null}
      Sign out
    </Button>
  );
}
