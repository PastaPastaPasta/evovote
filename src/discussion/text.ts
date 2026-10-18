/**
 * Comments are plain text. React escapes everything it renders, so nothing
 * here is HTML-escaped; this removes what plain text can still use to
 * deceive a reader: control characters and the bidirectional overrides that
 * make text read in another order than it is written, and runs of blank
 * lines that push other comments off screen.
 */
// eslint-disable-next-line no-control-regex
const CONTROLS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g;
const BIDI = /[؜‎‏‪-‮⁦-⁩]/g;

export function displayText(body: string): string {
  return body
    .replace(/\r\n?/g, '\n')
    .replace(CONTROLS, '')
    .replace(BIDI, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
