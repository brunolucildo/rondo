import { Link } from "@tanstack/react-router";
import { RondoMark } from "@repo/ui/brand";
import { Button } from "@repo/ui/button";
import { WhistleIcon } from "@repo/ui/icons";

export function NotFoundPage() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-6 bg-background px-6 py-12 text-center text-foreground">
      <RondoMark className="size-14" />
      {/* Decorative scoreboard: the functional title is the h1 below. */}
      <p
        aria-hidden="true"
        className="rounded-md border-2 border-border bg-foreground px-6 py-4 font-display text-5xl text-background shadow-pixel sm:text-6xl"
      >
        404
      </p>
      <h1 className="max-w-md font-display text-xl leading-relaxed text-balance sm:text-2xl">
        Page not found
      </h1>
      <p className="max-w-md text-base text-muted-foreground">
        The page you are looking for does not exist or was moved.
      </p>
      <p
        aria-hidden="true"
        className="flex items-center gap-2 font-mono text-base font-bold uppercase"
      >
        <WhistleIcon className="h-6 w-6" />
        Offside
      </p>
      <Button asChild size="lg">
        <Link to="/">Go to the home page</Link>
      </Button>
    </main>
  );
}
