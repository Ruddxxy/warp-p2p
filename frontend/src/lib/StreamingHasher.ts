import { sha256 } from 'js-sha256';

/**
 * StreamingHasher computes SHA-256 incrementally.
 * Accepts chunks of arbitrary size without buffering the full file in memory.
 * Memory usage is constant (~1KB internal state) regardless of total data size.
 */
export class StreamingHasher {
  private hasher = sha256.create();

  update(chunk: Uint8Array): void {
    this.hasher.update(chunk);
  }

  digest(): string {
    return this.hasher.hex();
  }

  reset(): void {
    this.hasher = sha256.create();
  }
}
