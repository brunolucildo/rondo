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
import { Field } from "@repo/ui/field";
import { Input } from "@repo/ui/input";
import { PasswordInput } from "@repo/ui/password-input";
import { Spinner } from "@repo/ui/spinner";
import { useState, type ChangeEvent, type FormEvent } from "react";
import { AUTH_LINK_CLASS } from "./auth-styles";
import { describeSignInFailure } from "./describe-sign-in-failure";
import {
  EMPTY_SIGN_IN_VALUES,
  SIGN_IN_FIELDS,
  validateSignIn,
  type SignInErrors,
  type SignInField,
  type SignInValues,
} from "./sign-in-validation";
import { useRedirect } from "./use-redirect";
import { useSignIn } from "./use-sign-in";

interface FieldConfig {
  label: string;
  type: "email" | "password";
  autoComplete: string;
}

const FIELDS: Record<SignInField, FieldConfig> = {
  email: { label: "Email", type: "email", autoComplete: "email" },
  password: { label: "Password", type: "password", autoComplete: "current-password" },
};

function focusField(name: SignInField) {
  document.getElementById(`sign-in-${name}`)?.focus();
}

function firstInvalid(errors: SignInErrors): SignInField | undefined {
  return SIGN_IN_FIELDS.find((name) => errors[name] !== undefined);
}

export function SignInPage() {
  const signIn = useSignIn();
  const search: { reset?: unknown } = useSearch({ strict: false });
  const passwordWasReset = search.reset === "success";
  const [values, setValues] = useState<SignInValues>(EMPTY_SIGN_IN_VALUES);
  const [submitted, setSubmitted] = useState(false);
  const [serverErrors, setServerErrors] = useState<SignInErrors>({});
  const [unconfirmed, setUnconfirmed] = useState(false);
  const [generalError, setGeneralError] = useState<string>();

  // Success only stores the token (in the hook); the page then leaves for the home.
  useRedirect(signIn.isSuccess ? "/app" : null);

  const clientErrors = validateSignIn(values);
  const pending = signIn.isPending;

  function visibleError(name: SignInField): string | undefined {
    // Client errors appear after the first submit attempt (not on blur): an error that shows up
    // while the pointer is moving to the button would shift it and swallow the click.
    const clientError = submitted ? clientErrors[name] : undefined;

    return clientError ?? serverErrors[name];
  }

  function handleChange(event: ChangeEvent<HTMLInputElement>) {
    const name = event.target.name as SignInField;

    setValues((current) => ({ ...current, [name]: event.target.value }));
    setServerErrors((current) => ({ ...current, [name]: undefined }));
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitted(true);
    setGeneralError(undefined);
    setServerErrors({});
    setUnconfirmed(false);

    const invalid = firstInvalid(clientErrors);

    if (invalid) {
      focusField(invalid);
      return;
    }

    signIn.mutate(values, {
      onError: (error) => {
        const failure = describeSignInFailure(error);

        setServerErrors(failure.fieldErrors);
        setUnconfirmed(failure.unconfirmed);
        setGeneralError(failure.general);
        // A rejected password is never kept in the form.
        setValues((current) => ({ ...current, password: "" }));
        setSubmitted(false);
        focusField(firstInvalid(failure.fieldErrors) ?? "password");
      },
    });
  }

  function renderField(name: SignInField) {
    const field = FIELDS[name];

    return (
      <Field key={name} id={`sign-in-${name}`} label={field.label} error={visibleError(name)}>
        {(control) => {
          const inputProps = {
            ...control,
            name,
            autoComplete: field.autoComplete,
            value: values[name],
            onChange: handleChange,
            readOnly: pending,
            required: true,
          };

          return field.type === "password" ? (
            <PasswordInput {...inputProps} visibilityLabel="password" />
          ) : (
            <Input {...inputProps} type={field.type} spellCheck={false} />
          );
        }}
      </Field>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle as="h1">Sign in</CardTitle>
        <CardDescription>Use the email and password of your account.</CardDescription>
      </CardHeader>

      <CardContent className="space-y-5">
        {passwordWasReset ? (
          <Alert variant="success">
            Your password was updated. Sign in with your new password.
          </Alert>
        ) : null}

        <form noValidate onSubmit={handleSubmit} className="space-y-5">
          {generalError ? (
            <Alert variant="error">
              {generalError}
              {unconfirmed ? (
                <>
                  {" "}
                  <Link to="/auth/resend-confirmation" className={AUTH_LINK_CLASS}>
                    Resend confirmation email
                  </Link>
                </>
              ) : null}
            </Alert>
          ) : null}

          {renderField("email")}
          {renderField("password")}

          <Button type="submit" size="lg" className="w-full" disabled={pending} aria-busy={pending}>
            {pending ? (
              <>
                <Spinner />
                Signing in…
              </>
            ) : (
              "Sign in"
            )}
          </Button>
        </form>
      </CardContent>

      <CardFooter className="flex flex-col items-start">
        <Link to="/auth/forgot-password" className={AUTH_LINK_CLASS}>
          Forgot your password?
        </Link>
        <Link to="/auth/sign-up" className={AUTH_LINK_CLASS}>
          Create an account
        </Link>
      </CardFooter>
    </Card>
  );
}
