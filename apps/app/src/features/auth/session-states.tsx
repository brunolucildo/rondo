import { RondoMark } from "@repo/ui/brand";
import { Button } from "@repo/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@repo/ui/card";
import { Spinner } from "@repo/ui/spinner";

/** Shown while `GET /auth/session` runs. A live region, so assistive tech announces it. */
export function SessionLoading() {
  return (
    <div
      role="status"
      className="flex min-h-screen flex-col items-center justify-center gap-6 px-6 text-foreground"
    >
      <RondoMark className="size-14" />
      <div className="flex items-center gap-3">
        <Spinner />
        <span className="text-base font-bold">Verifying your session…</span>
      </div>
    </div>
  );
}

/** The session could not be checked (network or server failure); the token is kept. */
export function SessionError({ onRetry }: { onRetry: () => void }) {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-6 px-6">
      <RondoMark className="size-14" />
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle as="h1">We couldn&apos;t verify your session.</CardTitle>
          <CardDescription>
            Check your connection and try again. You are not signed out.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Button size="lg" onClick={onRetry}>
            Try again
          </Button>
        </CardContent>
      </Card>
    </main>
  );
}
