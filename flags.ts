export type FlagDetector = (
  lines: string[],
  raw: string,
  result: { qualityGateFailed: boolean },
) => boolean;

function countHeadings(text: string): number {
  return (text.match(/^#{2,6} /gm) || []).length;
}

export function isInsideCodeBlock(lines: string[], lineIdx: number): boolean {
  let fenceCount = 0;
  for (let i = 0; i < lineIdx; i++) {
    if (/^```/.test(lines[i].trim())) fenceCount++;
  }
  return fenceCount % 2 === 1;
}

export function someOutsideCode(
  lines: string[],
  test: (line: string) => boolean,
): boolean {
  return lines.some((l, i) => test(l) && !isInsideCodeBlock(lines, i));
}

export const FLAG_DETECTORS: Record<string, FlagDetector> = {
  GATE: (_lines, _raw, result) => result.qualityGateFailed,
  FIDELITY: (lines, raw) => {
    const rawH = countHeadings(raw);
    if (rawH < 4) return false;
    const cleanH = countHeadings(lines.join("\n"));
    const headingRatio = cleanH / rawH;
    const rawW = raw.split(/\s+/).filter((w) => w.length > 0).length;
    const cleanW = lines
      .join("\n")
      .split(/\s+/)
      .filter((w) => w.length > 0).length;
    const wordRatio = rawW > 0 ? cleanW / rawW : 1;
    return headingRatio < 0.4 && wordRatio < 0.5;
  },
  OTP: (lines) =>
    someOutsideCode(lines, (l) => /^on this page/i.test(l.trim())),
  BC: (lines) => {
    let consecutive = 0;
    for (let i = 0; i < lines.length; i++) {
      const t = lines[i].trim();
      if (
        /^\d+\.\s+\[/.test(t) &&
        t.length < 100 &&
        !isInsideCodeBlock(lines, i)
      ) {
        consecutive++;
        if (consecutive >= 3) return true;
      } else if (t !== "") {
        consecutive = 0;
      }
    }
    return false;
  },
  FOOTER: (lines) => {
    const half = Math.floor(lines.length / 2);
    return lines
      .slice(half)
      .some(
        (l, i) =>
          /^last (?:modified|updated)/i.test(l.trim()) &&
          !isInsideCodeBlock(lines, half + i),
      );
  },
  JINA: (lines) =>
    someOutsideCode(
      lines,
      (l) => /^Title:/i.test(l.trim()) && !l.startsWith("  "),
    ),
  SKIP: (lines) =>
    someOutsideCode(lines, (l) =>
      /skip to (?:main )?content/i.test(l.trim()),
    ),
  COOKIE: (lines) =>
    someOutsideCode(
      lines,
      (l) => /\bcookie\b/i.test(l) && l.trim().length < 120,
    ),
};

export function detectFlags(
  lines: string[],
  raw: string,
  result: { qualityGateFailed: boolean },
): string[] {
  const flags: string[] = [];
  for (const [name, detect] of Object.entries(FLAG_DETECTORS)) {
    if (detect(lines, raw, result)) flags.push(name);
  }
  return flags;
}
