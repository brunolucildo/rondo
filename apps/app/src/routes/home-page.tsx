import { PixelFormation } from "@repo/ui/pitch";
import { useSession } from "../features/auth/use-session";

/** Home of the signed-in area. `AppLayout` only renders it once the session is known. */
export function HomePage() {
  const session = useSession();

  return (
    <main className="mx-auto grid w-full flex-1 content-center max-w-4xl items-center gap-10 px-6 py-12 sm:py-16 md:grid-cols-[minmax(0,1fr)_auto]">
      <div className="space-y-4">
        <p
          aria-hidden="true"
          className="font-mono text-base font-bold uppercase text-muted-foreground"
        >
          Matchday
        </p>
        <h1 className="font-display text-2xl leading-relaxed text-balance break-words sm:text-4xl">
          Welcome, {session.data?.user.firstName}
        </h1>
        <p className="text-lg text-muted-foreground">You are signed in.</p>
      </div>
      <PixelFormation className="mx-auto h-64 w-48 rounded-md border-2 border-border shadow-pixel md:h-80 md:w-60" />
    </main>
  );
}
