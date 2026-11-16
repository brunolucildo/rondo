import { Link } from "@tanstack/react-router";
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
import { Spinner } from "@repo/ui/spinner";
import { useState, type ChangeEvent, type FormEvent } from "react";
import { AUTH_LINK_CLASS } from "./auth-styles";
import { describeForgotPasswordFailure } from "./describe-forgot-password-failure";
import { EMPTY_FORGOT_PASSWORD_VALUES, validateForgotPassword } from "./forgot-password-validation";
import { useForgotPassword } from "./use-forgot-password";

/** Same text for every address: the page must not reveal which e-mails have an account. */
const SUCCESS_MESSAGE =
  "If an account exists for that email, we sent instructions to reset your password.";

export function ForgotPasswordPage() {
  const forgotPassword = useForgotPassword();
  const [values, setValues] = useState(EMPTY_FORGOT_PASSWORD_VALUES);
  const [submitted, setSubmitted] = useState(false);
  const [serverError, setServerError] = useState<string>();
  const [generalError, setGeneralError] = useState<string>();

  const pending = forgotPassword.isPending;
  const clientError = submitted ? validateForgotPassword(values).email : undefined;
  const emailError = clientError ?? serverError;

  function handleChange(event: ChangeEvent<HTMLInputElement>) {
    setValues({ email: event.target.value });
    setServerError(undefined);
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitted(true);
    setGeneralError(undefined);
    setServerError(undefined);

    if (validateForgotPassword(values).email) {
      document.getElementById("forgot-password-email")?.focus();
      return;
    }

    forgotPassword.mutate(values, {
      onError: (error) => {
        const failure = describeForgotPasswordFailure(error);

        setServerError(failure.emailError);
        setGeneralError(failure.general);

        if (failure.emailError) {
          document.getElementById("forgot-password-email")?.focus();
        }
      },
    });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle as="h1">Forgot your password?</CardTitle>
        {forgotPassword.isSuccess ? null : (
          <CardDescription>
            Enter the email you signed up with. We will send you a link to choose a new password.
          </CardDescription>
        )}
      </CardHeader>

      <CardContent>
        {forgotPassword.isSuccess ? (
          <Alert variant="success">{SUCCESS_MESSAGE}</Alert>
        ) : (
          <form noValidate onSubmit={handleSubmit} className="space-y-5">
            {generalError ? <Alert variant="error">{generalError}</Alert> : null}

            <Field id="forgot-password-email" label="Email" error={emailError}>
              {(control) => (
                <Input
                  {...control}
                  name="email"
                  type="email"
                  spellCheck={false}
                  autoComplete="email"
                  value={values.email}
                  onChange={handleChange}
                  readOnly={pending}
                  required
                />
              )}
            </Field>

            <Button
              type="submit"
              size="lg"
              className="w-full"
              disabled={pending}
              aria-busy={pending}
            >
              {pending ? (
                <>
                  <Spinner />
                  Sending…
                </>
              ) : (
                "Send reset link"
              )}
            </Button>
          </form>
        )}
      </CardContent>

      <CardFooter>
        <Link to="/auth/sign-in" className={AUTH_LINK_CLASS}>
          Back to sign in
        </Link>
      </CardFooter>
    </Card>
  );
}
