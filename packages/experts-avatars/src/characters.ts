/**
 * The character sheets of the seven experts and the prompts built from them. The ids and the
 * fictional character names come from the API catalog (spec 0019); the same sheets are written in
 * `.docs/DESIGN.md` ("Characters of the experts"). Prompts never carry a name: the model could
 * paint it as text, and no real person, club or brand may be evoked.
 */
export interface AvatarCharacter {
  /** Expert `id` in the catalog; also the PNG file name. */
  id: string;
  /** Fictional character name (documentation only; never sent to the model). */
  characterName: string;
  /** Age range, build and face. */
  appearance: string;
  /** Clothes and props that tell the role. */
  outfit: string;
  /** Dominant colors, named after the Rondo palette. */
  colors: string;
}

export const AVATAR_CHARACTERS: readonly AvatarCharacter[] = [
  {
    id: "head-coach",
    characterName: "Arnaldo Pinheiro Lessa",
    appearance:
      "a veteran football coach in his sixties, short gray hair, a thick gray mustache, a calm confident look",
    outfit:
      "a zipped training jacket with a plain collar, a whistle on a cord around the neck, a blank clipboard under one arm",
    colors: "blaze orange jacket, ink black outline, warm paper skin highlights",
  },
  {
    id: "performance-analyst",
    characterName: "Lívia Taborda Reis",
    appearance:
      "a young woman in her late twenties, hair in a high ponytail, round glasses, a focused look",
    outfit:
      "a polo shirt, a headset around the neck, a tablet held in one hand showing a simple bar chart with no numbers",
    colors: "lime moss polo, golden glow chart bars, ink black outline",
  },
  {
    id: "sports-lawyer",
    characterName: "Heitor Camargo Valente",
    appearance:
      "a man in his forties, neat short dark hair, a trimmed beard, a serious and careful look",
    outfit:
      "a dark suit with a tie, a slim leather briefcase, a small brass scale of justice held in one hand",
    colors: "ink black suit, sunflower gold tie and scale, paper white shirt",
  },
  {
    id: "physiologist",
    characterName: "Marta Quintela Ribas",
    appearance: "a woman in her thirties, short curly hair, a friendly and curious look",
    outfit:
      "a sporty jacket, a stopwatch on a cord around the neck, a small heart-rate monitor on the wrist",
    colors: "forest moss jacket, golden glow stopwatch, ink black outline",
  },
  {
    id: "sports-physician",
    characterName: "Caio Menezes Aranha",
    appearance: "a man in his fifties, a short beard, kind tired eyes, a reassuring look",
    outfit:
      "a white doctor coat, a stethoscope around the neck, a plain green medical bag in one hand",
    colors: "paper white coat, lime moss bag, ink black outline",
  },
  {
    id: "physiotherapist",
    characterName: "Tainá Seabra Moura",
    appearance: "a woman in her thirties, a long braid, a warm encouraging smile",
    outfit:
      "a short-sleeve training shirt, a resistance band over the shoulders, a small foam roller held in one hand",
    colors: "sunflower gold shirt, blaze orange band, ink black outline",
  },
  {
    id: "football-manager",
    characterName: "Rogério Albuquerque Dantas",
    appearance:
      "a man in his forties, slicked-back dark hair, a confident and organized look, a hint of a smile",
    outfit:
      "a blazer over a shirt with an open collar, a wristwatch, a blank folder and a smartphone in the hands",
    colors: "forest moss blazer, paper white shirt, golden glow watch, ink black outline",
  },
];

/** Style lines shared by every prompt: the 8-bit look and what must never appear. */
const STYLE =
  "Pixel art, 8-bit retro video game character portrait, bust shot (head and shoulders), facing the viewer, centered, " +
  "drawn on a coarse pixel grid with hard square pixels, clean 1-pixel dark outline, flat shading, " +
  "a limited palette of at most 12 colors, no anti-aliasing, no gradients, no dithering, no blur. " +
  "Plain solid single-color light background with nothing else in it.";

const RULES =
  "No text, no letters, no numbers, no logos, no brand marks, no club crests, no flags, no watermark. " +
  "An original fictional character: not a real person and not based on any real person.";

export function buildPrompt(character: AvatarCharacter): string {
  return [
    STYLE,
    `The character is ${character.appearance}.`,
    `Outfit and props: ${character.outfit}.`,
    `Colors: ${character.colors}.`,
    RULES,
  ].join(" ");
}

export function findCharacter(id: string): AvatarCharacter | undefined {
  return AVATAR_CHARACTERS.find((character) => character.id === id);
}

/**
 * Words that must not appear in a prompt: real people, clubs, federations and brands. Matched as
 * whole words, ignoring case and accents. The list is a safety net, not a substitute for review.
 */
export const FORBIDDEN_TERMS: readonly string[] = [
  "pele",
  "maradona",
  "messi",
  "ronaldo",
  "ronaldinho",
  "neymar",
  "cristiano",
  "guardiola",
  "ancelotti",
  "mourinho",
  "klopp",
  "ferguson",
  "wenger",
  "tite",
  "felipao",
  "scolari",
  "abel ferreira",
  "flamengo",
  "corinthians",
  "palmeiras",
  "santos",
  "sao paulo",
  "vasco",
  "fluminense",
  "botafogo",
  "gremio",
  "cruzeiro",
  "real madrid",
  "barcelona",
  "manchester",
  "liverpool",
  "juventus",
  "bayern",
  "fifa",
  "cbf",
  "uefa",
  "conmebol",
  "nike",
  "adidas",
  "puma",
  "umbro",
  "kappa",
  "coca-cola",
  "red cross",
  "nintendo",
  "sega",
  "pokemon",
  "mario",
];

function plain(text: string): string {
  return text
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase();
}

/** The forbidden terms found in `text`, as whole words. */
export function findForbiddenTerms(text: string): string[] {
  const normalized = plain(text);

  return FORBIDDEN_TERMS.filter((term) =>
    new RegExp(`(^|[^a-z0-9])${term.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&")}([^a-z0-9]|$)`).test(
      normalized,
    ),
  );
}
