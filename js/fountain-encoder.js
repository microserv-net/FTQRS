import { dropletIndexes, solitonCDF, xorInto } from './oqtp.js';

/**
 * Turns a byte array into an endless stream of droplets.
 *
 * Seeds 0..K-1 are the systematic pass (one plain chunk each). Seeds K and
 * up are random XOR combinations. The stream never runs out, so the sender
 * needs no feedback channel: it just keeps transmitting until the person
 * watching the receiver says stop.
 */
export class FountainEncoder {
  constructor(bytes, chunkSize) {
    this.bytes = bytes;
    this.chunkSize = chunkSize;
    this.K = Math.max(1, Math.ceil(bytes.length / chunkSize));
    this.cdf = solitonCDF(this.K);
    this.scratch = new Uint8Array(chunkSize);
  }

  chunk(i) {
    const start = i * this.chunkSize;
    return this.bytes.subarray(start, Math.min(start + this.chunkSize, this.bytes.length));
  }

  /** Payload for a given seed. The returned array is reused — copy if you keep it. */
  droplet(seed) {
    const out = this.scratch;
    out.fill(0);
    const idxs = dropletIndexes(seed, this.K, this.cdf);
    for (let i = 0; i < idxs.length; i++) xorInto(out, this.chunk(idxs[i]));
    return out;
  }

  /** How many chunks a given seed touches — used for the live degree readout. */
  degree(seed) {
    return dropletIndexes(seed, this.K, this.cdf).length;
  }
}
