import { Link, useSearch } from "@tanstack/react-router";
import { Alert } from "@repo/ui/alert";
import { Button } from "@repo/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@repo/ui/card";
import { Spinner } from "@repo/ui/spinner";
import { useEffect, useRef } from "react";
import { ApiError } from "../../lib/api-client";
import { AUTH_LINK_CLASS } from "./auth-styles";
import { useConfirmAccount } from "./use-confirm-account";
import { useRedirect } from "./use-redirect";

/** Any answer that says "this token will never work" (the API does not say which reason). */
function isDeadLink(error: unknown): boolean {
  return error instanceof ApiError && error.status === 400;
}

function InvalidLink() {
  return (
    <Card>
      <CardHeader>
        <CardTitle as="h1">This link is invalid or has expired</CardTitle>
        <CardDescription>Confirmation links work once and expire after 24 hours.</CardDescription>
      </CardHeader>
      <CardFooter>
        <Link to="/auth/resend-confirmation" className={AUTH_LINK_CLASS}>
          Request a new confirmation email
        </Link>
      </CardFooter>
    </Card>
  );
}

/**
 * Confirms the account when it opens: a `POST` with the token of the link (never a `GET`, so a
 * mail scanner that only fetches the URL does not use the link up). It runs once per visit, even
 * when React StrictMode mounts the page twice, stores the session token and goes to `/app`.
 */
export function ConfirmAccountPage() {
  const search: { token?: unknown } = useSearch({ strict: false });
  const token = typeof search.token === "string" && search.token !== "" ? search.token : null;
  const confirm = useConfirmAccount();
  const { mutate } = confirm;
  // A ref survives the unmount/remount StrictMode simulates, so the call is made once.
  const started = useRef(false);

  useEffect(() => {
    if (token !== null && !started.current) {
      started.current = true;
      mutate(token);
    }
  }, [token, mutate]);

  useRedirect(confirm.isSuccess ? "/app" : null);

  if (token === null || (confirm.isError && isDeadLink(confirm.error))) {
    return <InvalidLink />;
  }

  if (confirm.isError) {
    const tooMany = confirm.error instanceof ApiError && confirm.error.status === 429;

    return (
      <Card>
        <CardHeader>
          <CardTitle as="h1">We couldn&apos;t confirm your account</CardTitle>
        </CardHeader>
        <CardContent className="space-y-5">
          <Alert variant="error">
            {tooMany
              ? "Too many attempts. Try again in a few minutes."
              : "Check your connection and try again."}
          </Alert>
          <Button size="lg" onClick={() => mutate(token)}>
            Try again
          </Button>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle as="h1">Confirm your account</CardTitle>
      </CardHeader>
      <CardContent>
        <p role="status" className="flex items-center gap-3 text-base font-bold">
          <Spinner />
          Confirming your account…
        </p>
      </CardContent>
    </Card>
  );
}
