/**
 * The generated avatar of each expert, by expert `id`. The files are `assets/experts/<id>.png`
 * (made once by `bun run experts:avatars`); Vite gives each one a hashed URL at build time. The
 * API does not know these names, so it never returns an avatar. An expert without a file is not
 * an error: the interface falls back to the pixel-art placeholder.
 */
const FILES = import.meta.glob<string>("../../assets/experts/*.png", {
  eager: true,
  query: "?url",
  import: "default",
});

export function avatarIdOf(path: string): string {
  return (path.split("/").pop() ?? path).replace(/\.png$/, "");
}

export const AVATAR_IMAGES: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(FILES).map(([path, url]) => [avatarIdOf(path), url]),
);
