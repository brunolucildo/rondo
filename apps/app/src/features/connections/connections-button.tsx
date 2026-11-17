import { Button } from "@repo/ui/button";
import { useState } from "react";
import { ConnectionsPanel } from "./connections-panel";

/**
 * The floating "Your connections" button, next to "Add connection": it opens the panel with the
 * list of what the experts know, where each connection can be deleted. A real button (keyboard and
 * screen reader friendly), 44 px high; the parent positions it above the composer.
 */
export function ConnectionsButton({ className }: { className?: string }) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <Button
        variant="outline"
        className={className}
        aria-haspopup="dialog"
        onClick={() => setOpen(true)}
      >
        Your connections
      </Button>
      {open ? <ConnectionsPanel onClose={() => setOpen(false)} /> : null}
    </>
  );
}
