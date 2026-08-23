// Fixed-capacity FIFO with O(1) push (overwrites oldest when full).
//
// Replaces the original `arr.push(); if (arr.length > cap) arr.shift()` cache,
// whose shift() is O(n) on every overflow — at cap 1000 + a chatty page that's
// a 1000-element memmove per event. A ring buffer makes push amortized O(1).
//
// Every element gets a monotonic sequence number so a reader can pull
// incrementally instead of re-copying the whole buffer, and can tell when it
// missed something. Overwriting the oldest entry is silent at the buffer level;
// `truncated` is how that silence becomes visible to the caller.

export class RingBuffer {
  /** @param {number} cap */
  constructor(cap) {
    this.cap = cap;
    /** @type {Array<any>} */
    this.buf = new Array(cap);
    this.start = 0; // index of oldest element
    this.length = 0; // number of live elements (≤ cap)
    this.pushed = 0; // total ever pushed; also the seq of the newest element
  }

  /** @param {any} x */
  push(x) {
    this.pushed++;
    const end = (this.start + this.length) % this.cap;
    if (this.length < this.cap) {
      this.buf[end] = x;
      this.length++;
    } else {
      // full: overwrite oldest, advance start
      this.buf[this.start] = x;
      this.start = (this.start + 1) % this.cap;
    }
  }

  /** How many elements were overwritten before a reader could see them. */
  get dropped() {
    return this.pushed - this.length;
  }

  /** Sequence number of the oldest element still held (1-based; 1 when empty). */
  get oldestSeq() {
    return this.pushed - this.length + 1;
  }

  /**
   * Elements newer than `since`, each tagged with its seq.
   * @param {number} [since] the `nextSeq` from a previous read; 0 for everything held
   * @param {(x:any)=>boolean} [match] optional per-element filter
   * @returns {{events:any[], nextSeq:number, dropped:number, truncated:boolean}}
   */
  readSince(since = 0, match) {
    const oldest = this.oldestSeq;
    // The reader wanted everything after `since`, but the oldest we still hold is
    // newer than that: the gap in between is gone for good.
    const truncated = oldest > since + 1;
    const from = Math.max(0, since - oldest + 1); // index offset into live elements
    const events = [];
    for (let i = from; i < this.length; i++) {
      const x = this.buf[(this.start + i) % this.cap];
      if (match && !match(x)) continue;
      events.push({ seq: oldest + i, ...x });
    }
    return { events, nextSeq: this.pushed, dropped: this.dropped, truncated };
  }

  /** @returns {Array<any>} elements oldest→newest */
  toArray() {
    const out = new Array(this.length);
    for (let i = 0; i < this.length; i++) {
      out[i] = this.buf[(this.start + i) % this.cap];
    }
    return out;
  }

  clear() {
    this.buf = new Array(this.cap);
    this.start = 0;
    this.length = 0;
    this.pushed = 0;
  }
}
