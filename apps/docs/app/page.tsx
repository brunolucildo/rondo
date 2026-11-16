import { RondoWordmark } from "@repo/ui/brand";
import { Card, CardContent, CardHeader, CardTitle } from "@repo/ui/card";
import { FieldBackdrop } from "@repo/ui/pitch";
import { ThemeToggle } from "@repo/ui/theme-toggle";

export default function Home() {
  return (
    <div className="flex min-h-screen flex-col">
      <div className="h-28 border-b-2 border-border sm:h-36">
        <FieldBackdrop ball={false} preserveAspectRatio="xMidYMin slice" />
      </div>
      <header className="mx-auto flex w-full max-w-2xl items-center justify-between gap-4 px-6 pt-6">
        <RondoWordmark title="Rondo" className="h-7 w-auto" />
        <ThemeToggle />
      </header>
      <main className="mx-auto w-full max-w-2xl flex-1 px-6 py-10">
        <Card>
          <CardHeader>
            <CardTitle as="h1" className="text-xl sm:text-2xl">
              Documentation
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-base">
              The canonical Rondo documentation lives in{" "}
              <code className="rounded-sm border-2 border-border px-1 font-mono">.docs/</code>, at
              the repository root.
            </p>
          </CardContent>
        </Card>
      </main>
    </div>
  );
}
