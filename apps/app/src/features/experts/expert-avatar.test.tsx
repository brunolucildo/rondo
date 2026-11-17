import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AVATAR_IMAGES, avatarIdOf } from "./avatar-images";
import { ExpertAvatar } from "./expert-avatar";

/** The ids of the catalog (`GET /api/v1/experts`); the avatars tool checks them against the API. */
const CATALOG_IDS = [
  "head-coach",
  "performance-analyst",
  "sports-lawyer",
  "physiologist",
  "sports-physician",
  "physiotherapist",
  "football-manager",
];

const IMAGES = { "head-coach": "/assets/head-coach-abc123.png" };

describe("ExpertAvatar", () => {
  it("shows the expert's picture, sharp and decorative, when there is a file", () => {
    const { container } = render(
      <ExpertAvatar expertId="head-coach" images={IMAGES} className="size-12" />,
    );
    const image = container.querySelector("img");

    expect(image).toHaveAttribute("src", IMAGES["head-coach"]);
    expect(image).toHaveAttribute("alt", "");
    expect(image?.className).toContain("[image-rendering:pixelated]");
    expect(image?.className).toContain("size-12");
    expect(image?.className).not.toContain("object-cover");
  });

  it("describes the picture only when asked to", () => {
    render(
      <ExpertAvatar expertId="head-coach" images={IMAGES} alt="Head Coach, a veteran coach" />,
    );

    expect(screen.getByRole("img", { name: "Head Coach, a veteran coach" })).toBeInTheDocument();
  });

  it("falls back to the pixel-art placeholder when the expert has no file", () => {
    const { container } = render(<ExpertAvatar expertId="sports-lawyer" images={IMAGES} />);

    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector('[data-slot="pixel-avatar"]')).toBeInTheDocument();
  });

  it("does not treat an inherited property as a file", () => {
    const { container } = render(<ExpertAvatar expertId="toString" images={IMAGES} />);

    expect(container.querySelector("img")).toBeNull();
  });

  it("falls back to the placeholder when the file fails to load", () => {
    const { container } = render(<ExpertAvatar expertId="head-coach" images={IMAGES} />);
    const image = container.querySelector("img");

    expect(image).not.toBeNull();

    fireEvent.error(image as HTMLImageElement);

    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector('[data-slot="pixel-avatar"]')).toBeInTheDocument();
  });
});

describe("the app's avatar map", () => {
  it("is keyed by the file name, which is the expert id", () => {
    expect(avatarIdOf("../../assets/experts/head-coach.png")).toBe("head-coach");
  });

  it("only has catalog ids", () => {
    for (const id of Object.keys(AVATAR_IMAGES)) {
      expect(CATALOG_IDS).toContain(id);
    }
  });

  // Needs the seven pictures from the manual run (`bun run experts:avatars`); opt in with
  // REQUIRE_ALL_AVATARS=1 once they are generated and approved.
  it.runIf(process.env.REQUIRE_ALL_AVATARS === "1")("has a picture for every catalog id", () => {
    expect(Object.keys(AVATAR_IMAGES).sort()).toEqual([...CATALOG_IDS].sort());
  });
});
