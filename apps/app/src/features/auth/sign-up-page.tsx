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
import { PasswordInput } from "@repo/ui/password-input";
import { Spinner } from "@repo/ui/spinner";
import { useState, type ChangeEvent, type FormEvent } from "react";
import { AUTH_LINK_CLASS } from "./auth-styles";
import { describeSignUpFailure } from "./describe-sign-up-failure";
import {
  EMPTY_SIGN_UP_VALUES,
  SIGN_UP_FIELDS,
  validateSignUp,
  type SignUpErrors,
  type SignUpField,
  type SignUpValues,
} from "./sign-up-validation";
import { useSignUp } from "./use-sign-up";

interface FieldConfig {
  label: string;
  type: "text" | "email" | "password";
  autoComplete: string;
  /** Only for password fields: what the show/hide toggle reveals, used in its accessible name. */
  visibilityLabel?: string;
}

const FIELDS: Record<SignUpField, FieldConfig> = {
  firstName: { label: "First name", type: "text", autoComplete: "given-name" },
  lastName: { label: "Last name", type: "text", autoComplete: "family-name" },
  email: { label: "Email", type: "email", autoComplete: "email" },
  password: {
    label: "Password",
    type: "password",
    autoComplete: "new-password",
    visibilityLabel: "password",
  },
  confirmPassword: {
    label: "Confirm password",
    type: "password",
    autoComplete: "new-password",
    visibilityLabel: "password confirmation",
  },
};

function focusField(name: SignUpField) {
  document.getElementById(`sign-up-${name}`)?.focus();
}

function firstInvalid(errors: SignUpErrors): SignUpField | undefined {
  return SIGN_UP_FIELDS.find((name) => errors[name] !== undefined);
}

export function SignUpPage() {
  const signUp = useSignUp();
  const [values, setValues] = useState<SignUpValues>(EMPTY_SIGN_UP_VALUES);
  const [submitted, setSubmitted] = useState(false);
  const [serverErrors, setServerErrors] = useState<SignUpErrors>({});
  const [emailTaken, setEmailTaken] = useState(false);
  const [generalError, setGeneralError] = useState<string>();

  if (signUp.isSuccess) {
    return (
      <Card>
        <CardHeader>
          <CardTitle
            as="h1"
            ref={(element) => element?.focus()}
            tabIndex={-1}
            className="focus-visible:outline-none"
          >
            Check your email
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-base">
            We sent a confirmation link to{" "}
            <strong className="break-all">{signUp.data.email}</strong>. Open it to confirm your
            account. The link expires in 24 hours.
          </p>
        </CardContent>
        <CardFooter>
          <p className="text-base">
            Already confirmed?{" "}
            <Link to="/auth/sign-in" className={AUTH_LINK_CLASS}>
              Sign in
            </Link>
          </p>
        </CardFooter>
      </Card>
    );
  }

  const clientErrors = validateSignUp(values);
  const pending = signUp.isPending;

  function visibleError(name: SignUpField): string | undefined {
    // Client errors appear after the first submit attempt (not on blur): an error that shows up
    // while the pointer is moving to the button would shift it and swallow the click.
    const clientError = submitted ? clientErrors[name] : undefined;

    return clientError ?? serverErrors[name];
  }

  function handleChange(event: ChangeEvent<HTMLInputElement>) {
    const name = event.target.name as SignUpField;

    setValues((current) => ({ ...current, [name]: event.target.value }));
    setServerErrors((current) => ({ ...current, [name]: undefined }));

    if (name === "email") {
      setEmailTaken(false);
    }
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitted(true);
    setGeneralError(undefined);
    setServerErrors({});
    setEmailTaken(false);

    const invalid = firstInvalid(clientErrors);

    if (invalid) {
      focusField(invalid);
      return;
    }

    signUp.mutate(values, {
      onError: (error) => {
        const failure = describeSignUpFailure(error);

        setServerErrors(failure.fieldErrors);
        setEmailTaken(failure.emailTaken);
        setGeneralError(failure.general);

        const invalidField = firstInvalid(failure.fieldErrors);

        if (invalidField) {
          focusField(invalidField);
        }
      },
    });
  }

  function renderField(name: SignUpField) {
    const field = FIELDS[name];

    return (
      <Field
        key={name}
        id={`sign-up-${name}`}
        label={field.label}
        error={visibleError(name)}
        errorAction={
          name === "email" && emailTaken ? (
            <>
              {" "}
              <Link to="/auth/sign-in" className={AUTH_LINK_CLASS}>
                Sign in
              </Link>
            </>
          ) : undefined
        }
      >
        {(control) =>
          field.type === "password" ? (
            <PasswordInput
              {...control}
              name={name}
              visibilityLabel={field.visibilityLabel}
              autoComplete={field.autoComplete}
              value={values[name]}
              onChange={handleChange}
              readOnly={pending}
              required
            />
          ) : (
            <Input
              {...control}
              name={name}
              type={field.type}
              spellCheck={field.type === "email" ? false : undefined}
              autoComplete={field.autoComplete}
              value={values[name]}
              onChange={handleChange}
              readOnly={pending}
              required
            />
          )
        }
      </Field>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle as="h1">Create your account</CardTitle>
        <CardDescription>
          Use your email to get started. We will ask you to confirm it.
        </CardDescription>
      </CardHeader>

      <CardContent>
        <form noValidate onSubmit={handleSubmit} className="space-y-5">
          {generalError ? <Alert variant="error">{generalError}</Alert> : null}

          <div className="grid gap-5 sm:grid-cols-2">
            {renderField("firstName")}
            {renderField("lastName")}
          </div>
          {renderField("email")}
          {renderField("password")}
          {renderField("confirmPassword")}

          <Button type="submit" size="lg" className="w-full" disabled={pending} aria-busy={pending}>
            {pending ? (
              <>
                <Spinner />
                Creating account…
              </>
            ) : (
              "Create account"
            )}
          </Button>
        </form>
      </CardContent>

      <CardFooter>
        <p className="text-base">
          Already have an account?{" "}
          <Link to="/auth/sign-in" className={AUTH_LINK_CLASS}>
            Sign in
          </Link>
        </p>
      </CardFooter>
    </Card>
  );
}
