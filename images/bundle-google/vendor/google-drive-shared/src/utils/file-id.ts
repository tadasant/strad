/**
 * A Drive file or folder id, from an id or from any URL a human would paste.
 *
 * Accepted:
 *   1A2b3C...                                         (a bare id, or the alias `root`)
 *   https://drive.google.com/file/d/<id>/view
 *   https://drive.google.com/open?id=<id>
 *   https://drive.google.com/drive/folders/<id>       (and /drive/u/0/folders/<id>)
 *   https://docs.google.com/document/d/<id>/edit      (and spreadsheets/, presentation/, forms/)
 */
const ID = /^[A-Za-z0-9_-]+$/;

export function parseFileId(input: string): string {
  const trimmed = input.trim();
  if (ID.test(trimmed)) return trimmed;

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error(
      `"${input}" is neither a Drive file id nor a Drive or Docs URL. ` +
        'Pass the id (search_files returns it) or the link copied from Drive.'
    );
  }

  const fromPath = /\/(?:d|folders)\/([A-Za-z0-9_-]{10,})/.exec(url.pathname)?.[1];
  const fromQuery = url.searchParams.get('id');
  const id = fromPath ?? (fromQuery && ID.test(fromQuery) ? fromQuery : undefined);
  if (!id) {
    throw new Error(
      `No file id found in "${input}". Expected a link such as ` +
        'https://drive.google.com/file/d/<id>/view or https://docs.google.com/document/d/<id>/edit.'
    );
  }
  return id;
}
