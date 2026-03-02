const wrap = (code: string) => (s: string) => `\x1b[${code}m${s}\x1b[0m`;

export const c = {
  bold: wrap("1"),
  dim: wrap("2"),
  red: wrap("31"),
  green: wrap("32"),
  yellow: wrap("33"),
  blue: wrap("34"),
  cyan: wrap("36"),
} as const;
