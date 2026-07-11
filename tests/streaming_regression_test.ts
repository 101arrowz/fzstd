// Regression tests for streaming decompression (issue #19 scenario) and
// for large backreference offsets that cross a 4-byte bit-reading window.
// Run with: bun test tests/streaming_regression_test.ts
// The embedded frames are real zstd CLI output; expected payloads are
// regenerated in JS, so no zstd binary is needed for the core tests.
import { describe, it, expect } from 'bun:test';
import * as fzstd from '../src/index.ts';

const hex = (s: string) => new Uint8Array(s.match(/../g).map(b => parseInt(b, 16)));
const enc = new TextEncoder();

// "hello world " * 11000 (= 132000 B: blocks of 131072 + 928), zstd -3,
// single-segment frame WITH xxh64 checksum. Same bytes as Go stdlib fixture
// testdata/f2a8e35c.helloworld-11000x.zst (golang.org/cl/531255).
const HW11000_CHECK = hex(
  '28b52ffda4a0030200ac00006868656c6c6f20776f726c6420680100f0ffcfcb173d00000001009d5f1520d2e9d158'
);
// Same payload, zstd -3 --no-check via stdin: window-descriptor frame,
// no content size, NO checksum. Frames like this ended exactly at the last
// block and starved the pre-0.1.1 push() gate (fixed in 807a854).
const HW11000_NOCHECK = hex(
  '28b52ffd0058a400006068656c6c6f20776f726c64200100f1ffcf4b12450000087201009c2b2004'
);
// "hello world " * 21845 (= 262140 B: 131072 + 131068), zstd -3 --no-check.
const HW21845_NOCHECK = hex(
  '28b52ffd0058a400006068656c6c6f20776f726c64200100f1ffcf4b124d000008720100f8ff391002'
);

const CASES: [string, Uint8Array, Uint8Array][] = [
  ['hw11000+checksum', HW11000_CHECK, enc.encode('hello world '.repeat(11000))],
  ['hw11000 no-check', HW11000_NOCHECK, enc.encode('hello world '.repeat(11000))],
  ['hw21845 no-check', HW21845_NOCHECK, enc.encode('hello world '.repeat(21845))],
];

// Streams data into a Decompress instance and returns the joined output.
// mode: 'final-on-last' | 'empty-final' | 'never-final'
const stream = (chunks: Uint8Array[], mode: string) => {
  const parts: Uint8Array[] = [];
  let sawFinal = false;
  const d = new fzstd.Decompress((c, f) => { parts.push(c); if (f) sawFinal = true; });
  for (let i = 0; i < chunks.length; ++i) {
    d.push(chunks[i], mode == 'final-on-last' && i == chunks.length - 1);
  }
  if (mode == 'empty-final') d.push(new Uint8Array(0), true);
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return { out, sawFinal };
};

describe('issue #19 scenario: >128KiB output via streaming', () => {
  for (const [name, zst, want] of CASES) {
    it(`${name}: one-shot`, () => {
      expect(fzstd.decompress(zst)).toEqual(want);
    });

    it(`${name}: single push with final=true`, () => {
      const { out, sawFinal } = stream([zst], 'final-on-last');
      expect(out).toEqual(want);
      expect(sawFinal).toBe(true);
    });

    it(`${name}: push all, then empty final push`, () => {
      const { out, sawFinal } = stream([zst], 'empty-final');
      expect(out).toEqual(want);
      expect(sawFinal).toBe(true);
    });

    it(`${name}: push without ever sending final`, () => {
      // The #19 reporter's adapter never pushed final; all data must still
      // be delivered through ondata.
      expect(stream([zst], 'never-final').out).toEqual(want);
    });

    it(`${name}: every two-chunk split, all final modes`, () => {
      // Splits at/after the last block's start starved fzstd <= 0.1.0 on
      // checksum-less frames: silent truncation to 131072 bytes without
      // final, "unexpected EOF" with final.
      for (let s = 1; s < zst.length; ++s) {
        const chunks = [zst.subarray(0, s), zst.subarray(s)];
        for (const mode of ['final-on-last', 'empty-final', 'never-final']) {
          expect(stream(chunks, mode).out).toEqual(want);
        }
      }
    });

    it(`${name}: one byte per push`, () => {
      const chunks: Uint8Array[] = [];
      for (let i = 0; i < zst.length; ++i) chunks.push(zst.subarray(i, i + 1));
      expect(stream(chunks, 'empty-final').out).toEqual(want);
    });
  }
});

describe('multi-frame streams', () => {
  const a = CASES[0], b = CASES[1];
  const joined = new Uint8Array(a[1].length + b[1].length);
  joined.set(a[1], 0), joined.set(b[1], a[1].length);
  const want = new Uint8Array(a[2].length + b[2].length);
  want.set(a[2], 0), want.set(b[2], a[2].length);

  it('decodes both frames one-shot', () => {
    expect(fzstd.decompress(joined)).toEqual(want);
  });

  it('decodes both frames streaming at every two-chunk split', () => {
    for (let s = 1; s < joined.length; ++s) {
      const chunks = [joined.subarray(0, s), joined.subarray(s)];
      expect(stream(chunks, 'empty-final').out).toEqual(want);
    }
  });
});

// The first affected distance is 2^26 + 2^25 - 3 (about 96 MiB): the 4-byte
// offset read supplies only 32 - (spos & 7) bits. The test can use up to
// ~800 MB peak RAM and needs zstd on PATH, so it is opt-in.
const bigTest = process.env.FZSTD_BIG_TESTS ? it : it.skip;
describe('large backreference offsets (opt-in large test)', () => {
  bigTest('decodes a --long=27 frame with ~100MB match distances', async () => {
    const { spawnSync } = await import('child_process');
    const probe = spawnSync('zstd', ['--version']);
    if (probe.error) throw new Error('zstd CLI not found on PATH; cannot run big offset test');
    // 100 MiB of seeded SplitMix32 noise + 500 short copies scattered from near the
    // start: each copy needs a fresh ~100 MiB offset (no repeat-offset reuse),
    // so offset code 26 gets read at many bit alignments, some straddling the
    // 4-byte window that pre-fix code was limited to.
    const M = 1 << 20;
    const size = 100 * M;
    const buf = new Uint8Array(size + 500 * 4000);
    // splitmix32: unlike an LCG, has no short-period low/mid bits that zstd
    // would match at small offsets
    for (let i = 0, z = 0; i < size; ++i) {
      z = (z + 0x9E3779B9) | 0;
      let x = z;
      x = Math.imul(x ^ (x >>> 16), 0x21F0AAAD);
      x = Math.imul(x ^ (x >>> 15), 0x735A2D97);
      buf[i] = x ^ (x >>> 15);
    }
    for (let i = 0; i < 500; ++i) {
      buf.set(buf.subarray(i * 4096, i * 4096 + 4000), size + i * 4000);
    }
    const z = spawnSync('zstd', ['-1', '--long=27', '-c'], { input: buf, maxBuffer: 1 << 30 });
    if (z.status !== 0) throw new Error('zstd failed: ' + z.stderr);
    const out = fzstd.decompress(new Uint8Array(z.stdout));
    expect(out.length).toBe(buf.length);
    expect(Buffer.compare(out, buf)).toBe(0);
  }, 300000);
});
