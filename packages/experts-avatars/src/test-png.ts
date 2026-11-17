import { PNG } from "pngjs";

/**
 * A synthetic "AI answer" for tests: a flat background with a smooth gradient disc and a few
 * stripes, so it has many more colors than a palette allows and a background to clear.
 */
export function syntheticPicture(width = 512, height = 384): Uint8Array {
  const png = new PNG({ width, height });
  const centerX = width / 2;
  const centerY = height / 2;
  const radius = Math.min(width, height) * 0.35;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const at = (y * width + x) * 4;
      const distance = Math.hypot(x - centerX, y - centerY);
      const inside = distance < radius;

      png.data[at] = inside ? Math.round((x / width) * 255) : 240;
      png.data[at + 1] = inside ? Math.round((y / height) * 255) : 230;
      png.data[at + 2] = inside ? Math.round((distance / radius) * 255) : 210;
      png.data[at + 3] = 255;
    }
  }

  return new Uint8Array(PNG.sync.write(png));
}
