// Some numerical data is initialized as -1 even when it doesn't need initialization to help the JIT infer types

import wk from './node-worker';

// aliases for shorter compressed code (most minifers don't do this)
const u8 = Uint8Array, u16 = Uint16Array, i16 = Int16Array, u32 = Uint32Array;

// Huffman decoding table
interface HDT {
  // initial bits
  b: number;
  // symbols
  s: Uint8Array;
  // num bits
  n: Uint8Array;
}

// FSE decoding table
interface FSEDT extends HDT {
  // next state
  t: Uint16Array;
}

// decompress Zstandard state
interface DZstdState {
  // byte
  b: number;
  // dictionary ID
  readonly d: number;
  // window
  readonly w: Uint8Array;
  // max block size
  readonly m: number;
  // uncompressed size
  readonly u: number;
  // has checksum
  readonly c: number;
  // last huffman decoding table
  h?: HDT;
  // last block
  l: number;
}

// Walmart object spread
const mrg = <A, B>(a: A, b: B) => {
  const o = {} as Record<string, unknown>;
  for (const k in a) o[k] = a[k];
  for (const k in b) o[k] = b[k];
  return o as A & B;
}

const slc = <T extends Uint8Array | Uint16Array | Uint32Array>(v: T, s: number, e?: number): T => {
  // can't use .constructor in case user-supplied
  const ctr = v instanceof u8 ? u8 : v instanceof u16 ? u16 : u32;
  if (ctr.prototype.slice) return ctr.prototype.slice.call(v, s, e);
  if (s == null || s < 0) s = 0;
  if (e == null || e > v.length) e = v.length;
  const n = new (v instanceof u8 ? u8 : v instanceof u16 ? u16 : u32)(e - s) as T;
  n.set(v.subarray(s, e));
  return n;
}

const fill = <T extends Uint8Array | Uint16Array | Uint32Array>(v: T, n: number, s?: number, e?: number): T => {
  const ctr = v instanceof u8 ? u8 : v instanceof u16 ? u16 : u32;
  if (ctr.prototype.fill) return ctr.prototype.fill.call(v, n, s, e);
  if (s == null || s < 0) s = 0;
  if (e == null || e > v.length) e = v.length;
  for (; s < e; ++s) v[s] = n;
  return v;
}

/**
 * Codes for errors generated within this library
 */
export const ZstdErrorCode = {
  InvalidData: 0,
  WindowSizeTooLarge: 1,
  InvalidBlockSize: 2,
  InvalidBlockType: 3,
  FSEAccuracyTooHigh: 4
} as const;

type ZEC = (typeof ZstdErrorCode)[keyof typeof ZstdErrorCode];

// error codes
const ec: Record<ZEC, string | undefined> = [
  'invalid zstd data',
  'window size too large (>2046MB)',
  'invalid block size',
  'invalid block type',
  'FSE accuracy too high'
];

/**
 * An error generated within this library
 */
export interface ZstdError extends Error {
  /**
   * The code associated with this error
   */
  code: ZEC;
};

const err = (ind: ZEC, msg?: string | 0, nt?: 1) => {
  const e: Partial<ZstdError> = new Error(msg || ec[ind]);
  e.code = ind;
  if (Error.captureStackTrace) Error.captureStackTrace(e, err);
  if (!nt) throw e;
  return e as ZstdError;
}

const rb = (d: Uint8Array, b: number, n: number) => {
  let i = 0, o = 0;
  for (; i < n; ++i) o |= d[b++] << (i << 3);
  return o;
}

const b4 = (d: Uint8Array, b: number) => (d[b] | (d[b + 1] << 8) | (d[b + 2] << 16) | (d[b + 3] << 24)) >>> 0;

// read Zstandard frame header
const rzfh = (dat: Uint8Array): number | DZstdState => {
  const n3 = dat[0] | (dat[1] << 8) | (dat[2] << 16);
  if (n3 == 0x2FB528 && dat[3] == 253) {
    // Zstandard
    const flg = dat[4];
    //    single segment       checksum             dict flag     frame content flag
    const ss = (flg >> 5) & 1, cc = (flg >> 2) & 1, df = flg & 3, fcf = flg >> 6;
    if (flg & 8) err(0);
    // byte
    let bt = 5 + ss;
    // dict bytes
    const db = df == 3 ? 4 : df;
    // dictionary id
    const di = rb(dat, bt, db);
    bt += db;
    // frame size bytes
    const fsb = fcf ? ss : (1 << fcf);
    // frame source size
    const fss = rb(dat, bt, fsb) + ((fcf == 1) && 256);
    // window size
    let ws = fss;
    if (ss) {
      // window descriptor
      const wb = 1 << (10 + (dat[5] >> 3));
      ws = wb + (wb >> 3) * (dat[5] & 7);
    }
    if (ws > 2145386496) err(1);
    return {
      b: bt + fsb,
      l: 0,
      d: di,
      w: new u8(ws),
      u: fss,
      c: cc,
      m: Math.min(131072, ws)
    };
  } else if (((n3 >> 4) | (dat[3] << 20)) == 0x184D2A5) {
    // skippable
    return b4(dat, 4) + 8;
  }
  err(0);
}

// most significant bit for nonzero
const msb = (val: number) => {
  let bits = 0;
  for (; (1 << bits) <= val; ++bits);
  return bits - 1;
}

// read finite state entropy
const rfse = (dat: Uint8Array, bt: number, mal: number): [number, FSEDT] => {
  // table pos
  let tpos = (bt << 3) + 4;
  // accuracy log
  const al = (dat[bt] & 15) + 5;
  if (al > mal) err(4);
  // size
  const sz = 1 << al;
  // probabilities symbols  repeat   index   high threshold
  let probs = sz, sym = -1, re = -1, i = -1, ht = sz;
  // optimization: single allocation is much faster
  const buf = new ArrayBuffer(512 + (sz << 2));
  const freq = new i16(buf, 0, 256);
  // same view as freq
  const dstate = new u16(buf, 0, 256);
  const nstate = new u16(buf, 512, sz);
  const bb1 = 512 + (sz << 1);
  const syms = new u8(buf, bb1, sz);
  const nbits = new u8(buf, bb1 + sz);
  while (sym < 255 && probs > 0) {
    const bits = msb(probs + 1);
    const cbt = tpos >> 3;
    // mask
    const msk = (1 << (bits + 1)) - 1;
    let val = ((dat[cbt] | (dat[cbt + 1] << 8) | (dat[cbt + 2] << 16)) >> (tpos & 7)) & msk;
    // mask (1 fewer bit)
    const msk1fb = (1 << bits) - 1;
    // max small value
    const msv = msk - probs - 1;
    // small value
    const sval = val & msk1fb;
    if (sval < msv) tpos += bits, val = sval;
    else {
      tpos += bits + 1;
      if (val > msk1fb) val -= msv;
    }
    freq[++sym] = --val;
    if (val == -1) {
      probs += val;
      syms[--ht] = sym;
    } else probs -= val;
    if (!val) {
      do {
        // repeat byte
        const rbt = tpos >> 3;
        re = ((dat[rbt] | (dat[rbt + 1] << 8)) >> (tpos & 7)) & 3;
        tpos += 2;
        sym += re;
      } while (re == 3);
    }
  }
  if (sym > 255 || probs) err(0);
  let sympos = 0;
  // sym step (coprime with sz - formula from zstd source)
  const sstep = (sz >> 1) + (sz >> 3) + 3;
  // sym mask
  const smask = sz - 1;
  for (let s = 0; s <= sym; ++s) {
    const sf = freq[s];
    if (sf <= 0) {
      dstate[s] = -sf;
      continue;
    }
    // This is split into two loops in zstd to avoid branching, but as JS is higher-level that is unnecessary
    for (i = 0; i < sf; ++i) {
      syms[sympos] = s;
      do {
        sympos = (sympos + sstep) & smask;
      } while (sympos >= ht);
    }
  }
  // After spreading symbols, should be zero again
  if (sympos) err(0);
  for (i = 0; i < sz; ++i) {
    // next state
    const ns = dstate[syms[i]]++;
    // num bits
    const nb = nbits[i] = al - msb(ns);
    nstate[i] = (ns << nb) - sz;
  }
  return [(tpos + 7) >> 3, {
    b: al,
    s: syms,
    n: nbits,
    t: nstate
  }];
}

// read huffman
const rhu = (dat: Uint8Array, bt: number): [number, HDT] => {
  //  index  weight count
  let i = 0, wc = -1;
  //    buffer             header byte
  const buf = new u8(292), hb = dat[bt];
  // huffman weights
  const hw = buf.subarray(0, 256);
  // rank count
  const rc = buf.subarray(256, 268);
  // rank index
  const ri = new u16(buf, 268);
  // NOTE: at this point bt is 1 less than expected
  if (hb < 128) {
    // end byte, fse decode table
    const [ebt, fdt] = rfse(dat, bt + 1, 6);
    bt += hb;
    const epos = ebt << 3;
    // last byte
    const lb = dat[bt];
    if (!lb) err(0);
    //  state1   state2   state1 bits   state2 bits
    let st1 = 0, st2 = 0, btr1 = fdt.b, btr2 = btr1
    // fse pos
    // pre-increment to account for original deficit of 1
    let fpos = (++bt << 3) - 16 + msb(lb);
    for (;;) {
      fpos -= btr1;
      if (fpos < epos) break;
      let cbt = fpos >> 3;
      st1 += ((dat[cbt] | (dat[cbt + 1] << 8)) >> (fpos & 7)) & ((1 << btr1) - 1);
      hw[++wc] = fdt.s[st1];
      fpos -= btr2;
      if (fpos < epos) break;
      cbt = fpos >> 3;
      st2 += ((dat[cbt] | (dat[cbt + 1] << 8)) >> (fpos & 7)) & ((1 << btr2) - 1);
      hw[++wc] = fdt.s[st2];
      btr1 = fdt.n[st1];
      st1 = fdt.t[st1];
      btr2 = fdt.n[st2];
      st2 = fdt.t[st2];
    }
    if (++wc > 255) err(0);
  } else {
    wc = hb - 127;
    for (; i < wc; i += 2) {
      const byte = dat[++bt];
      hw[i] = byte >> 4;
      hw[i + 1] = byte & 15;
    }
    ++bt;
  }
  // weight exponential sum
  let wes = 0;
  for (i = 0; i < wc; ++i) {
    const wt = hw[i];
    if (wt > 11) err(0);
    wes += wt && (1 << (wt - 1));
  }
  // max bits
  const mb = msb(wes) + 1;
  // table size
  const ts = 1 << mb;
  // remaining sum
  const rem = ts - wes;
  // must be power of 2, mb must be at most 11
  if (rem & (rem - 1)) err(0);
  hw[wc++] = msb(rem) + 1;
  for (i = 0; i < wc; ++i) {
    const wt = hw[i];
    ++rc[hw[i] = wt && (mb + 1 - wt)];
  }
  // huf buf
  const hbuf = new u8(ts << 1);
  //    symbols                      num bits
  const syms = hbuf.subarray(0, ts), nb = hbuf.subarray(ts);
  ri[mb] = 0;
  for (i = mb; i > 0; --i) {
    const pv = ri[i];
    fill(nb, i, pv, ri[i - 1] = pv + rc[i] * (1 << (mb - i)));
  }
  if (ri[0] != ts) err(0);
  for (i = 0; i < wc; ++i) {
    const bits = hw[i];
    if (bits) {
      const code = ri[bits];
      fill(syms, i, code, ri[bits] = code + (1 << (mb - bits)));
    }
  }
  return [bt, {
    n: nb,
    b: mb,
    s: syms
  }];
}

// decode huffman stream
const dhu = (dat: Uint8Array, out: Uint8Array, hu: HDT) => {
  const len = dat.length, ss = out.length, lb = dat[len - 1];
  if (!lb) err(0);
  let st = 0, btr = hu.b, pos = (len << 3) - 16 + msb(lb), i = -1;
  for (; pos > 0 && i < ss;) {
    const cbt = pos >> 3;
    const val = (dat[cbt] | (dat[cbt + 1] << 8) | (dat[cbt + 2] << 16)) >> (pos & 7);
    st = ((st << btr) | val) & ((1 << btr) - 1);
    out[++i] = hu.s[st];
    btr = hu.n[st];
  }
  if (i + 1 != ss) err(0);
}

// decode huffman stream 4x
// TODO: use workers to parallelize
const dhu4 = (dat: Uint8Array, out: Uint8Array, hu: HDT) => {
  let bt = 6;
  const ss = out.length, sz1 = (ss + 3) >> 2, sz2 = sz1 << 1, sz3 = sz1 + sz2;
  dhu(dat.subarray(bt, bt += dat[0] | (dat[1] << 8)), out.subarray(0, sz1), hu);
  dhu(dat.subarray(bt, bt += dat[2] | (dat[3] << 8)), out.subarray(sz1, sz2), hu);
  dhu(dat.subarray(bt, bt += dat[4] | (dat[5] << 8)), out.subarray(sz2, sz3), hu);
  dhu(dat.subarray(bt), out.subarray(sz3), hu);
}

// read Zstandard block
const rzb = (dat: Uint8Array, st: DZstdState) => {
  let bt = st.b;
  //    byte 0        block type
  const b0 = dat[bt], btype = (b0 >> 1) & 3;
  st.l = b0 & 1;
  const sz = (b0 >> 3) | (dat[bt + 1] << 5) | (dat[bt + 2] << 13);
  if (sz > st.m) err(2);
  bt += 3;
  if (btype == 0) return slc(dat, bt, st.b = bt + sz);
  if (btype == 1) {
    st.b = bt + 1;
    return fill(new u8(sz), dat[bt]);
  }
  if (btype == 2) {
    //    byte 3        lit btype     size format
    const b3 = dat[bt], lbt = b3 & 3, sf = (b3 >> 2) & 3;
    // lit src size  lit cmp sz 4 streams
    let lss = b3 >> 4, lcs = 0, s4 = 0;
    if (lbt < 2) {
      if (sf & 1) lss |= (dat[++bt] << 4) | ((sf & 2) && (dat[++bt] << 12));
      else lss = b3 >> 3;
    } else {
      s4 = sf;
      if (sf < 2) lss |= ((dat[++bt] & 63) << 4), lcs = (dat[bt] >> 6) | (dat[++bt] << 2);
      else if (sf == 2) lss |= (dat[++bt] << 4) | ((dat[++bt] & 3) << 12), lcs = (dat[bt] >> 2) | (dat[++bt] << 6);
      else lss |= (dat[++bt] << 4) | ((dat[++bt] & 63) << 12), lcs = (dat[bt] >> 6) | (dat[++bt] << 2) | (dat[++bt] << 10);
    }
    ++bt;
    const buf = new u8(sz);
    // starting point for literals
    const spl = sz - lss;
    if (lbt == 0) buf.set(dat.subarray(bt, bt += lss), spl);
    else if (lbt == 1) fill(buf, dat[bt++], spl, sz);
    else {
      // huffman table
      let hu: HDT;
      if (lbt == 2) {
        const hud = rhu(dat, bt);
        // subtract description length
        lcs += bt - (bt = hud[0]);
        hu = hud[1];
      }
      else if (st.h) hu = st.h
      else err(0);
      (s4 ? dhu4 : dhu)(dat.subarray(bt, bt += lcs), buf.subarray(spl), hu);
    }
    // num sequences
    let ns = dat[bt++];
    if (ns) {
      if (ns == 255) ns = (dat[bt++] | (dat[bt++] << 8)) + 0x7F00;
      else if (ns > 127) ns = ((ns - 128) << 8) | dat[bt++];
      // symbol compression modes
      const scm = dat[bt++];
      
    } else if (spl) err(0);
    return buf;
  }
  err(3);
}  