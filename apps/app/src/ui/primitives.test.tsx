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
import {
  BallIcon,
  EyeIcon,
  EyeOffIcon,
  GoalIcon,
  MoonIcon,
  RedCardIcon,
  SunIcon,
  WhistleIcon,
  YellowCardIcon,
} from "@repo/ui/icons";
import { Input } from "@repo/ui/input";
import { Label } from "@repo/ui/label";
import { PasswordInput } from "@repo/ui/password-input";
import { FieldBackdrop, PixelFormation } from "@repo/ui/pitch";
import { Spinner } from "@repo/ui/spinner";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

describe("Button", () => {
  it("is a real button that does not submit by default and merges className", () => {
    render(<Button className="extra">Go</Button>);

    const button = screen.getByRole("button", { name: "Go" });

    expect(button).toHaveAttribute("type", "button");
    expect(button).toHaveClass("extra", "h-11");
  });

  it.each([
    ["default", "bg-primary"],
    ["secondary", "bg-secondary"],
    ["outline", "bg-background"],
    ["ghost", "bg-transparent"],
    ["destructive", "bg-destructive"],
  ] as const)("renders the %s variant", (variant, expected) => {
    render(<Button variant={variant}>Label</Button>);

    expect(screen.getByRole("button")).toHaveClass(expected);
  });

  it("keeps the touch target at 44px in the default and large sizes", () => {
    render(
      <>
        <Button>Default</Button>
        <Button size="lg">Large</Button>
        <Button size="icon" aria-label="Icon" />
      </>,
    );

    expect(screen.getByRole("button", { name: "Default" })).toHaveClass("h-11");
    expect(screen.getByRole("button", { name: "Large" })).toHaveClass("h-12");
    expect(screen.getByRole("button", { name: "Icon" })).toHaveClass("size-11");
  });

  it("shows a visible focus ring and stops reacting when disabled", async () => {
    const onClick = vi.fn();

    render(
      <Button disabled onClick={onClick}>
        Off
      </Button>,
    );

    const button = screen.getByRole("button", { name: "Off" });

    expect(button).toBeDisabled();
    expect(button).toHaveClass("focus-visible:ring-2", "disabled:opacity-50");
    await userEvent.setup().click(button);
    expect(onClick).not.toHaveBeenCalled();
  });

  it("supports asChild for links", () => {
    render(
      <Button asChild>
        <a href="/x">Link</a>
      </Button>,
    );

    expect(screen.getByRole("link", { name: "Link" })).toHaveAttribute("href", "/x");
  });
});

describe("Input and Label", () => {
  it("links the label to the field and marks an invalid field", () => {
    render(
      <>
        <Label htmlFor="e">Email</Label>
        <Input id="e" aria-invalid className="extra" />
      </>,
    );

    const input = screen.getByLabelText("Email");

    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(input).toHaveClass("extra", "h-11", "border-input");
  });
});

describe("PasswordInput", () => {
  it("starts hidden and toggles with an accessible, pressed button", async () => {
    const user = userEvent.setup();

    render(<PasswordInput id="p" defaultValue="secret" visibilityLabel="new password" />);

    const input = document.getElementById("p") as HTMLInputElement;
    const toggle = screen.getByRole("button", { name: "Show new password" });

    expect(input).toHaveAttribute("type", "password");
    expect(toggle).toHaveAttribute("aria-pressed", "false");
    expect(toggle).toHaveAttribute("aria-controls", "p");

    await user.click(toggle);

    expect(input).toHaveAttribute("type", "text");
    expect(screen.getByRole("button", { name: "Hide new password" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });
});

describe("Card", () => {
  it("is a section with header, title, description, content and footer slots", () => {
    render(
      <Card className="extra">
        <CardHeader>
          <CardTitle as="h1">Title</CardTitle>
          <CardDescription>Description</CardDescription>
        </CardHeader>
        <CardContent>Body</CardContent>
        <CardFooter>Foot</CardFooter>
      </Card>,
    );

    expect(screen.getByRole("heading", { level: 1, name: "Title" })).toHaveClass("font-display");
    expect(screen.getByText("Description")).toHaveClass("text-muted-foreground");
    expect(screen.getByText("Body").closest("[data-slot=card]")).toHaveClass("extra");
    expect(screen.getByText("Foot")).toBeInTheDocument();
  });

  it("uses h2 for the title by default", () => {
    render(<CardTitle>Inside</CardTitle>);

    expect(screen.getByRole("heading", { level: 2, name: "Inside" })).toBeInTheDocument();
  });
});

describe("Alert", () => {
  it.each([
    ["error", "alert"],
    ["warning", "alert"],
    ["success", "status"],
    ["info", "status"],
  ] as const)("the %s alert has the %s role, an icon and its text", (variant, role) => {
    render(
      <Alert variant={variant} className="extra">
        Message
      </Alert>,
    );

    const alert = screen.getByRole(role);

    expect(alert).toHaveTextContent("Message");
    expect(alert).toHaveAttribute("data-variant", variant);
    expect(alert).toHaveClass("extra");
    expect(alert.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
  });

  it("is informative by default", () => {
    render(<Alert>Note</Alert>);

    expect(screen.getByRole("status")).toHaveAttribute("data-variant", "info");
  });
});

describe("Field", () => {
  it("links label, control and error text", () => {
    render(
      <Field id="name" label="Name" error="Required.">
        {(control) => <Input {...control} />}
      </Field>,
    );

    const input = screen.getByLabelText("Name");
    const error = screen.getByText("Required.");

    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(input).toHaveAttribute("aria-describedby", error.id);
    expect(input).toHaveAccessibleDescription("Required.");
  });

  it("renders no error markup and no aria wiring without an error", () => {
    render(
      <Field id="name" label="Name">
        {(control) => <Input {...control} />}
      </Field>,
    );

    const input = screen.getByLabelText("Name");

    expect(input).not.toHaveAttribute("aria-invalid");
    expect(input).not.toHaveAttribute("aria-describedby");
  });

  it("shows extra content after the error", () => {
    render(
      <Field id="name" label="Name" error="Taken." errorAction={<a href="/in">Sign in</a>}>
        {(control) => <Input {...control} />}
      </Field>,
    );

    expect(screen.getByRole("link", { name: "Sign in" })).toBeInTheDocument();
  });
});

describe("Spinner", () => {
  it("is decorative, accepts className and stops with reduced motion", () => {
    const { container } = render(<Spinner className="extra" />);
    const svg = container.querySelector("svg");

    expect(svg).toHaveAttribute("aria-hidden", "true");
    expect(svg).toHaveClass("extra", "animate-pixel-spin", "motion-reduce:animate-none");
  });
});

describe("pixel icons and pitch", () => {
  it.each([
    ["eye", EyeIcon],
    ["eye off", EyeOffIcon],
    ["sun", SunIcon],
    ["moon", MoonIcon],
    ["red card", RedCardIcon],
    ["yellow card", YellowCardIcon],
    ["goal", GoalIcon],
    ["whistle", WhistleIcon],
    ["ball", BallIcon],
  ])("the %s icon is crisp, decorative and takes className", (_name, Icon) => {
    const { container } = render(<Icon className="extra" />);
    const svg = container.querySelector("svg");

    expect(svg).toHaveAttribute("shape-rendering", "crispEdges");
    expect(svg).toHaveAttribute("aria-hidden", "true");
    expect(svg).toHaveClass("extra");
    expect(svg?.querySelectorAll("rect").length).toBeGreaterThan(0);
  });

  it("keeps the compact-logo viewBox free for the logo alone (brand tests count it)", () => {
    const { container } = render(
      <>
        <BallIcon />
        <RedCardIcon />
        <PixelFormation />
        <FieldBackdrop />
      </>,
    );

    expect(container.querySelectorAll("svg[viewBox='0 0 28 28']")).toHaveLength(0);
  });

  it("draws the pitch decoratively, with or without the ball", () => {
    const withBall = render(<FieldBackdrop className="extra" />);

    expect(withBall.container.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
    expect(withBall.container.querySelector("svg")).toHaveClass("extra");
    expect(withBall.container.querySelector("svg svg")).not.toBeNull();

    const without = render(<FieldBackdrop ball={false} />);

    expect(without.container.querySelector("svg svg")).toBeNull();
  });

  it("draws the formation with eleven players", () => {
    const { container } = render(<PixelFormation />);

    expect(container.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
    expect(container.querySelectorAll("g")).toHaveLength(11);
  });
});
