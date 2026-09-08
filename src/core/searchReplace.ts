/**
 * SEARCH/REPLACE diff application for replace_in_file.
 *
 * Extracted from filePreview.ts as a pure, VS Code-free function so it can
 * be unit-tested directly. filePreview re-exports it for its preview flow.
 */

const SEARCH_REPLACE_RE =
  /<<<<<<< SEARCH\n([\s\S]*?)\n=======\n([\s\S]*?)\n>>>>>>> REPLACE/g;

export function applySearchReplace(original: string, diff: string): string {
  // FIX (CRLF): normalize line endings so SEARCH blocks written with \n
  // match CRLF files. The final content stays in \n form (commitPreview
  // writes exactly this string, so output is consistent).
  let result = original.replace(/\r\n/g, '\n');
  let matches = 0;
  let m: RegExpExecArray | null;
  SEARCH_REPLACE_RE.lastIndex = 0;
  while ((m = SEARCH_REPLACE_RE.exec(diff)) !== null) {
    const [, search, replace] = m;
    const firstIdx = result.indexOf(search);
    if (firstIdx === -1) {
      throw new Error(
        `SEARCH block not found. Make sure the text matches the file exactly:\n${search.slice(0, 120)}…`
      );
    }
    // FIX (ambiguity): if the SEARCH text occurs more than once, refuse to
    // guess — previously every identical block silently hit the FIRST spot.
    if (result.indexOf(search, firstIdx + 1) !== -1) {
      throw new Error(
        `SEARCH block matched ${result.split(search).length - 1} locations — it must be unique. Include more surrounding lines to disambiguate:\n${search.slice(0, 120)}…`
      );
    }
    result = result.slice(0, firstIdx) + replace + result.slice(firstIdx + search.length);
    matches++;
  }
  if (matches === 0) {
    throw new Error('No valid SEARCH/REPLACE block found.');
  }
  return result;
}
