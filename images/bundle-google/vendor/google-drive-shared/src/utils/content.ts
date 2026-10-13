/** The bytes a write tool was handed, as text or as base64, under one cap. */

/**
 * The largest file `create_file` and `replace_file_content` upload, decoded.
 * Through strad, core's 4MB `/mcp` body is the tighter bound on
 * `content_base64` anyway.
 */
export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;

/** Exactly one of `content` (UTF-8 text) and `content_base64` is set; the caller's schema checks that. */
export function decodeContent(
  content: string | undefined,
  contentBase64: string | undefined,
  tool: string
): Uint8Array {
  let bytes: Uint8Array;
  if (content !== undefined) {
    bytes = Buffer.from(content, 'utf8');
  } else {
    const b64 = (contentBase64 ?? '').replace(/\s+/g, '');
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(b64) || b64.length % 4 === 1) {
      throw new Error('content_base64 is not valid base64.');
    }
    bytes = Buffer.from(b64, 'base64');
  }
  if (bytes.byteLength > MAX_UPLOAD_BYTES) {
    throw new Error(
      `The content is ${(bytes.byteLength / (1024 * 1024)).toFixed(1)}MB, past the ` +
        `${MAX_UPLOAD_BYTES / (1024 * 1024)}MB ${tool} uploads.`
    );
  }
  return bytes;
}
