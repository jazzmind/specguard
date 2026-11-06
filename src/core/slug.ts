/**
 * Slugs: lowercase ASCII words joined by hyphens. History entry ids and the
 * heading anchors of generated documentation share this one function, so a
 * heading's anchor is stable for as long as its text is.
 *
 * Spec: specs/capabilities/documentation-api.md
 */

export function slugify(text: string, max = 40, fallback = 'entry'): string {
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, max)
      .replace(/-+$/g, '') || fallback
  );
}

/** A slug unique among `taken` (which it is added to): a repeat gets `-2`, `-3`, ... */
export function uniqueSlug(text: string, taken: Set<string>, max = 60): string {
  const base = slugify(text, max, 'section');
  let slug = base;
  for (let n = 2; taken.has(slug); n += 1) slug = `${base}-${n}`;
  taken.add(slug);
  return slug;
}
