/**
 * Contested usernames exist because of homograph collisions: 0/o, 1/l/i and
 * hyphens normalize to the same name. Render those characters in a highlight
 * color so the reason the name is contested is visible in the name itself.
 */
export function ContestedName({ label }: { label: string }) {
  const parts: { text: string; homograph: boolean }[] = [];
  for (const char of label) {
    const homograph = char === '0' || char === '1' || char === '-';
    const last = parts[parts.length - 1];
    if (last && last.homograph === homograph) last.text += char;
    else parts.push({ text: char, homograph });
  }
  return (
    <span className="contested-name">
      {parts.map((part, i) =>
        part.homograph ? (
          <em key={i} className="homograph">
            {part.text}
          </em>
        ) : (
          <span key={i}>{part.text}</span>
        ),
      )}
    </span>
  );
}
