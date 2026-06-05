// Fixed-capacity FIFO with O(1) push (overwrites oldest when full).
//
// Replaces the original `arr.push(); if (arr.length > cap) arr.shift()` cache,
// whose shift() is O(n) on every overflow — at cap 1000 + a chatty page that's
// a 1000-element memmove per event. A ring buffer makes push amortized O(1).

export class RingBuffer {
  /** @param {number} cap */
  constructor(cap) {
    this.cap = cap;
    /** @type {Array<any>} */
    this.buf = new Array(cap);
    this.start = 0; // index of oldest element
    this.length = 0; // number of live elements (≤ cap)
  }

  /** @param {any} x */
  push(x) {
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
  }
}
