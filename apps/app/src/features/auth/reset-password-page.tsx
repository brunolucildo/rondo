import { Link, useRouter, useSearch } from "@tanstack/react-router";
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
import { Field } from "@repo/ui/field";
import { PasswordInput } from "@repo/ui/password-input";
import { Spinner } from "@repo/ui/spinner";
import { useEffect, useRef, useState, type ChangeEvent, type FormEvent } from "react";
import { AUTH_LINK_CLASS } from "./auth-styles";
import { describeResetPasswordFailure } from "./describe-reset-password-failure";
import {
  EMPTY_RESET_PASSWORD_VALUES,
  RESET_PASSWORD_FIELDS,
  validateResetPassword,
  type ResetPasswordErrors,
  type ResetPasswordField,
  type ResetPasswordValues,
} from "./reset-password-validation";
import { useResetPassword } from "./use-reset-password";

interface FieldConfig {
  label: string;
  visibilityLabel: string;
}

const FIELDS: Record<ResetPasswordField, FieldConfig> = {
  password: { label: "New password", visibilityLabel: "new password" },
  confirmPassword: { label: "Confirm new password", visibilityLabel: "password confirmation" },
};

function focusField(name: ResetPasswordField) {
  document.getElementById(`reset-password-${name}`)?.focus();
}

function firstInvalid(errors: ResetPasswordErrors): ResetPasswordField | undefined {
  return RESET_PASSWORD_FIELDS.find((name) => errors[name] !== undefined);
}

function InvalidLink() {
  return (
    <Card>
      <CardHeader>
        <CardTitle as="h1">This link is invalid or has expired</CardTitle>
        <CardDescription>Reset links work once and expire after 1 hour.</CardDescription>
      </CardHeader>
      <CardFooter>
        <Link to="/auth/forgot-password" className={AUTH_LINK_CLASS}>
          Request a new reset link
        </Link>
      </CardFooter>
    </Card>
  );
}

/**
 * Chooses a new password with the token of the e-mailed link. The token is read from the URL
 * once, kept in this component (memory only) and removed from the address bar right away, so it
 * does not stay in the history or leak through `Referer`; reloading therefore shows the
 * invalid-link state. On success the person goes to the sign-in page (no session is opened).
 */
export function ResetPasswordPage() {
  const router = useRouter();
  const search: { token?: unknown } = useSearch({ strict: false });
  const [token] = useState<string | null>(() =>
    typeof search.token === "string" && search.token !== "" ? search.token : null,
  );
  const hasTokenInUrl = search.token !== undefined;
  const resetPassword = useResetPassword();
  const [values, setValues] = useState<ResetPasswordValues>(EMPTY_RESET_PASSWORD_VALUES);
  const [submitted, setSubmitted] = useState(false);
  const [serverErrors, setServerErrors] = useState<ResetPasswordErrors>({});
  const [linkInvalid, setLinkInvalid] = useState(false);
  const [generalError, setGeneralError] = useState<string>();
  const stripped = useRef(false);

  // Drop the token from the URL as soon as the page loads (`replace`: no history entry keeps it).
  useEffect(() => {
    if (hasTokenInUrl && !stripped.current) {
      stripped.current = true;
      void router.navigate({ to: "/auth/reset-password", search: {}, replace: true });
    }
  }, [hasTokenInUrl, router]);

  const { isSuccess } = resetPassword;

  useEffect(() => {
    if (isSuccess) {
      void router.navigate({ to: "/auth/sign-in", search: { reset: "success" }, replace: true });
    }
  }, [isSuccess, router]);

  if (token === null || linkInvalid) {
    return <InvalidLink />;
  }

  if (isSuccess) {
    return (
      <Card>
        <CardHeader>
          <CardTitle as="h1">Choose a new password</CardTitle>
        </CardHeader>
        <CardContent>
          <Alert variant="success">Password updated. Taking you to sign in…</Alert>
        </CardContent>
      </Card>
    );
  }

  // Past the guard above the form only renders with a token.
  const linkToken: string = token;
  const clientErrors = validateResetPassword(values);
  const pending = resetPassword.isPending;

  function visibleError(name: ResetPasswordField): string | undefined {
    // Client errors appear after the first submit attempt (not on blur): an error that shows up
    // while the pointer is moving to the button would shift it and swallow the click.
    const clientError = submitted ? clientErrors[name] : undefined;

    return clientError ?? serverErrors[name];
  }

  function handleChange(event: ChangeEvent<HTMLInputElement>) {
    const name = event.target.name as ResetPasswordField;

    setValues((current) => ({ ...current, [name]: event.target.value }));
    setServerErrors((current) => ({ ...current, [name]: undefined }));
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitted(true);
    setGeneralError(undefined);
    setServerErrors({});

    const invalid = firstInvalid(clientErrors);

    if (invalid) {
      focusField(invalid);
      return;
    }

    resetPassword.mutate(
      { token: linkToken, ...values },
      {
        onError: (error) => {
          const failure = describeResetPasswordFailure(error);

          if (failure.linkInvalid) {
            setLinkInvalid(true);
            return;
          }

          setServerErrors(failure.fieldErrors);
          setGeneralError(failure.general);

          const invalidField = firstInvalid(failure.fieldErrors);

          if (invalidField) {
            focusField(invalidField);
          }
        },
      },
    );
  }

  function renderField(name: ResetPasswordField) {
    return (
      <Field
        key={name}
        id={`reset-password-${name}`}
        label={FIELDS[name].label}
        error={visibleError(name)}
      >
        {(control) => (
          <PasswordInput
            {...control}
            name={name}
            visibilityLabel={FIELDS[name].visibilityLabel}
            autoComplete="new-password"
            value={values[name]}
            onChange={handleChange}
            readOnly={pending}
            required
          />
        )}
      </Field>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle as="h1">Choose a new password</CardTitle>
        <CardDescription>
          Use 8 to 128 characters. We will sign you out everywhere once it is changed.
        </CardDescription>
      </CardHeader>

      <CardContent>
        <form noValidate onSubmit={handleSubmit} className="space-y-5">
          {generalError ? <Alert variant="error">{generalError}</Alert> : null}

          {renderField("password")}
          {renderField("confirmPassword")}

          <Button type="submit" size="lg" className="w-full" disabled={pending} aria-busy={pending}>
            {pending ? (
              <>
                <Spinner />
                Resetting…
              </>
            ) : (
              "Reset password"
            )}
          </Button>
        </form>
      </CardContent>

      <CardFooter>
        <Link to="/auth/sign-in" className={AUTH_LINK_CLASS}>
          Back to sign in
        </Link>
      </CardFooter>
    </Card>
  );
}
