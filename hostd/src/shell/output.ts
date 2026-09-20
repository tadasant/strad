/**
 * A command's captured output: the first half of the budget and the last half,
 * with the middle dropped and counted. `find /` must not be able to grow the
 * daemon without bound, and of a long output the start (what ran) and the end
 * (how it finished) are the parts anyone reads.
 */
export class HeadTailBuffer {
  private head = "";
  private tail = "";
  private dropped = 0;
  private total = 0;
  private readonly half: number;

  constructor(maxBytes: number) {
    this.half = Math.max(1, Math.floor(maxBytes / 2));
  }

  append(chunk: string): void {
    this.total += chunk.length;
    if (this.head.length < this.half) {
      const room = this.half - this.head.length;
      this.head += chunk.slice(0, room);
      chunk = chunk.slice(room);
    }
    if (chunk.length === 0) return;
    this.tail += chunk;
    if (this.tail.length > this.half) {
      const over = this.tail.length - this.half;
      this.tail = this.tail.slice(over);
      this.dropped += over;
    }
  }

  get totalChars(): number {
    return this.total;
  }

  toString(): string {
    if (this.dropped === 0) return this.head + this.tail;
    return `${this.head}\n[… ${this.dropped} characters dropped by the daemon's capture limit …]\n${this.tail}`;
  }
}

/** Cut a string to `max` characters for a RESPONSE, keeping both ends. */
export function clip(
  s: string,
  max: number,
): { text: string; truncated: boolean } {
  if (s.length <= max) return { text: s, truncated: false };
  const half = Math.floor(max / 2);
  const cut = s.length - half * 2;
  return {
    text: `${s.slice(0, half)}\n[… ${cut} characters omitted; re-read with a larger max_output_chars or a narrower command …]\n${s.slice(-half)}`,
    truncated: true,
  };
}
