import { normalizeDpnsLabel } from '../../kinds/dpns';

/**
 * Which characters of a spelling differ from the name it registers as:
 * Platform folds case, o to 0, and i and l to 1, so "Bob" and "b0b" contest
 * the same name. Hyphens and digits already in that form never differ.
 * All false when the two cannot be lined up character by character.
 */
export function homographMask(label: string, registered = normalizeDpnsLabel(label)): boolean[] {
  const chars = [...label];
  if (chars.length !== [...registered].length) return chars.map(() => false);
  const target = [...registered];
  return chars.map((char, i) => {
    const lower = char.toLowerCase();
    return lower !== target[i] && normalizeDpnsLabel(lower) === target[i];
  });
}

/**
 * Contested usernames exist because of homograph collisions. Render the
 * characters that Platform rewrites (o→0, i/l→1) in a highlight colour, so
 * the reason the name is contested is visible in the name itself.
 * `registered`: the normalized label the contest is for, when known.
 */
export function ContestedName({ label, registered }: { label: string; registered?: string }) {
  const mask = homographMask(label, registered);
  const parts: { text: string; homograph: boolean }[] = [];
  [...label].forEach((char, i) => {
    const last = parts[parts.length - 1];
    if (last && last.homograph === mask[i]) last.text += char;
    else parts.push({ text: char, homograph: mask[i] });
  });
  return (
    <span className="contested-name">
      {parts.map((part, i) =>
        part.homograph ? (
          <em key={i} className="homograph" title={`Registers as ${normalizeDpnsLabel(part.text)}`}>
            {part.text}
          </em>
        ) : (
          <span key={i}>{part.text}</span>
        ),
      )}
    </span>
  );
}
