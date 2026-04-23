import { assertEquals } from "https://deno.land/std@0.103.0/testing/asserts.ts";
import * as fzstd from "../src/index.ts";

// Regression test for an int32 bit-position overflow in the one-shot
// `decompress()` path — see docs/large-frame-overflow.md. Once the byte
// offset `bt` into the compressed buffer reaches 2^28 (256 MiB),
// `bt << 3` wraps negative in JavaScript and the sequence decoder reads
// the wrong bytes. We generate 6-bit-alphabet noise with a short marker
// planted every 1 KiB so `zstd -1` emits btype-2 blocks containing
// sequences (`ns > 0`) that exercise the bit-position math past the
// 2^28 threshold.
//
// Requires the `zstd` CLI on PATH.
// Run:  deno test --no-check --allow-run=zstd tests/large_frame_overflow_test.ts

Deno.test("decompress() handles frames > 256 MiB", async () => {
  const SIZE = 500 * 1024 * 1024;
  const THRESHOLD = 1 << 28;
  const MARK = new TextEncoder().encode("__fzstd_match_marker__");

  // 6-bit-alphabet random bytes + planted markers every 1 KiB.
  // Incompressible data would be emitted as raw blocks (btype 0), bypassing
  // the buggy path; markerless data would give `ns == 0` and skip the
  // sequence decoder. This recipe forces both to exercise the bug.
  const source = new Uint8Array(SIZE);
  for (let off = 0; off < SIZE; off += 65536) {
    crypto.getRandomValues(source.subarray(off, Math.min(off + 65536, SIZE)));
  }
  for (let i = 0; i < SIZE; i++) source[i] &= 0x3f;
  for (let j = 0; j + MARK.length <= SIZE; j += 1024) source.set(MARK, j);

  // Compress via the zstd CLI (generating a > 256 MiB frame with fzstd
  // itself would be circular). Stream stdin -> stdout to avoid temp files.
  const proc = new Deno.Command("zstd", {
    args: ["-1", "--single-thread"],
    stdin: "piped",
    stdout: "piped",
    stderr: "null",
    clearEnv: true,
  }).spawn();

  const stdoutChunks = (async () => {
    const chunks: Uint8Array[] = [];
    for await (const chunk of proc.stdout) chunks.push(chunk);
    return chunks;
  })();
  const writer = proc.stdin.getWriter();
  await writer.write(source);
  await writer.close();
  const chunks = await stdoutChunks;
  const { code } = await proc.status;
  assertEquals(code, 0);

  const compSize = chunks.reduce((s, c) => s + c.length, 0);
  const compressed = new Uint8Array(compSize);
  {
    let o = 0;
    for (const c of chunks) { compressed.set(c, o); o += c.length; }
  }
  // The bug only triggers when the compressed frame exceeds 2^28 bytes.
  // Fail loudly if zstd compresses better than expected and the test
  // would otherwise pass without exercising the bug.
  if (compressed.length <= THRESHOLD) {
    throw new Error(
      `compressed size ${compressed.length} <= 2^28; bug would not be exercised`,
    );
  }

  // Before the fix this throws `invalid zstd data`. After the fix, bytes
  // match the source.
  const decompressed = fzstd.decompress(compressed);
  assertEquals(decompressed.length, SIZE);
  const srcHash = new Uint8Array(await crypto.subtle.digest("SHA-256", source));
  const decHash = new Uint8Array(await crypto.subtle.digest("SHA-256", decompressed));
  assertEquals(decHash, srcHash);
});
