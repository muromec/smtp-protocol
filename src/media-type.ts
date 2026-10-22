// ── What kind of file a name says it is ─────────────────────────────────────
//
// A caller that hands over bytes and a filename has already said what the file is; this reads it
// back only when the caller did not name a media type itself.  A closed list on purpose: an
// unknown extension is `application/octet-stream`, which every client accepts and none guesses
// from — a wrong guess about a picture is worse than an honest "bytes".

const BY_EXTENSION: Record<string, string> = {
  // images
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  bmp: 'image/bmp',
  tiff: 'image/tiff',
  // documents
  pdf: 'application/pdf',
  txt: 'text/plain',
  md: 'text/markdown',
  html: 'text/html',
  htm: 'text/html',
  csv: 'text/csv',
  json: 'application/json',
  xml: 'application/xml',
  ics: 'text/calendar',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  odt: 'application/vnd.oasis.opendocument.text',
  ods: 'application/vnd.oasis.opendocument.spreadsheet',
  // archives and media
  zip: 'application/zip',
  gz: 'application/gzip',
  tar: 'application/x-tar',
  mp3: 'audio/mpeg',
  ogg: 'audio/ogg',
  wav: 'audio/wav',
  mp4: 'video/mp4',
  webm: 'video/webm',
};

/** The media type of a filename, by its extension, or `application/octet-stream`. */
export function mimeTypeOf(filename: string): string {
  const dot = filename.lastIndexOf('.');
  if (dot <= 0 || dot === filename.length - 1) return 'application/octet-stream';
  return BY_EXTENSION[filename.slice(dot + 1).toLowerCase()] ?? 'application/octet-stream';
}
