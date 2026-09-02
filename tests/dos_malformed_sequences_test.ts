import { assertThrows } from "https://deno.land/std@0.103.0/testing/asserts.ts";
import * as fzstd from "../src/index.ts";

// A 17-byte frame with a compressed block whose sequence section uses RLE-mode
// FSE tables to force every sequence to emit match-length code 52 (baseline
// 65539). The declared regenerated size (window) is 240 bytes, so the sequences
// claim far more output than the block can hold. A conformant decoder rejects
// this; without a bound the sequence loop performs unbounded out-of-bounds
// copies (CPU denial-of-service).
Deno.test("Malformed sequence overflow is rejected", () => {
  const data = [
    0x28, 0xB5, 0x2F, 0xFD, 0x20, 0xF0, 0x45, 0x00, 0x00,
    0x01, 0x00, 0x7F, 0x54, 0x00, 0x00, 0x34, 0x80
  ];
  assertThrows(() => fzstd.decompress(new Uint8Array(data)));
});
