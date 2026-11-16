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
import { describeResendConfirmationFailure } from "./describe-resend-confirmation-failure";
import {
  EMPTY_RESEND_CONFIRMATION_VALUES,
  validateResendConfirmation,
} from "./resend-confirmation-validation";
import { useResendConfirmation } from "./use-resend-confirmation";

const EMAIL_FIELD_ID = "resend-confirmation-email";

/** Same text for every address: the page must not reveal which e-mails have an account. */
const SUCCESS_MESSAGE =
  "If an account exists for that email and is not confirmed, we sent a new link.";

export function ResendConfirmationPage() {
  const resend = useResendConfirmation();
  const [values, setValues] = useState(EMPTY_RESEND_CONFIRMATION_VALUES);
  const [submitted, setSubmitted] = useState(false);
  const [serverError, setServerError] = useState<string>();
  const [generalError, setGeneralError] = useState<string>();

  const pending = resend.isPending;
  const clientError = submitted ? validateResendConfirmation(values).email : undefined;
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

    if (validateResendConfirmation(values).email) {
      document.getElementById(EMAIL_FIELD_ID)?.focus();
      return;
    }

    resend.mutate(values, {
      onError: (error) => {
        const failure = describeResendConfirmationFailure(error);

        setServerError(failure.emailError);
        setGeneralError(failure.general);

        if (failure.emailError) {
          document.getElementById(EMAIL_FIELD_ID)?.focus();
        }
      },
    });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle as="h1">Resend confirmation email</CardTitle>
        {resend.isSuccess ? null : (
          <CardDescription>
            Enter the email you signed up with. If the account is not confirmed yet, we will send a
            new link. Older links stop working.
          </CardDescription>
        )}
      </CardHeader>

      <CardContent>
        {resend.isSuccess ? (
          <Alert variant="success">{SUCCESS_MESSAGE}</Alert>
        ) : (
          <form noValidate onSubmit={handleSubmit} className="space-y-5">
            {generalError ? <Alert variant="error">{generalError}</Alert> : null}

            <Field id={EMAIL_FIELD_ID} label="Email" error={emailError}>
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
                "Send new link"
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
