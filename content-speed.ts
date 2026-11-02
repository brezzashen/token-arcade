/** Counts visible content between first and last chunks; only aggregate estimates leave the probe. */
export class ContentSpeed {
  private text = '';
  private firstTokens = 0;
  private first: number | null = null;
  private last: number | null = null;
  private chunks = 0;
  private count: (text: string) => number;
  constructor(count: (text: string) => number) { this.count = count; }
  accept(delta: string, at: number) {
    if (!delta) return;
    this.text += delta;
    if (this.first === null) {
      this.first = at;
      this.firstTokens = this.count(this.text);
    }
    this.last = at;
    this.chunks++;
  }
  reading() {
    const tokens = this.count(this.text);
    const outputMs = this.first === null || this.last === null ? null : this.last - this.first;
    const measuredTokens = Math.max(0, tokens - this.firstTokens);
    return { estimatedTokens: tokens, measuredTokens, outputMs, chunks: this.chunks,
      tokensPerSecond: this.chunks > 1 && outputMs !== null && outputMs >= 250 && measuredTokens > 0
        ? measuredTokens / (outputMs / 1000) : null };
  }
}
