# fzstd
High performance Zstandard decompression in a pure JavaScript, 8kB package

## Usage

Import:
```js
// I will assume that you use the following for the rest of this guide
import * as fzstd from 'fzstd';
```

If your environment doesn't support ES Modules (e.g. Node.js):
```js
const fzstd = require('fzstd');
```

If you want to load from a CDN in the browser:
```html
<!--
You should use either UNPKG or jsDelivr (i.e. only one of the following)

You may also want to specify the version, e.g. with fzstd@0.01
-->
<script src="https://unpkg.com/fzstd"></script>
<script src="https://cdn.jsdelivr.net/npm/fzstd/umd/index.js"></script>
<!-- Now, the global variable fzstd contains the library -->

<!-- If you're going buildless but want ESM, import from Skypack -->
<script type="module">
  import * as fzstd from 'https://cdn.skypack.dev/fzstd?min';
</script>
```

If you are using Deno:
```js
// Don't use the ?dts Skypack flag; it isn't necessary for Deno support
// The @deno-types comment adds TypeScript typings

// @deno-types="https://cdn.skypack.dev/fzstd/lib/index.d.ts"
import * as fzstd from 'https://cdn.skypack.dev/fzstd?min';
```

And use:
```js
// This is an ArrayBuffer of data
const compressedBuf = await fetch('/compressedData.zst').then(
  res => res.arrayBuffer()
);
// To use fzstd, you need a Uint8Array
const compressed = new Uint8Array(compressedBuf);
// Note that Node.js Buffers work just fine as well:
// const massiveFile = require('fs').readFileSync('aMassiveFile.txt');

const decompressed = fzstd.decompress(compressed);

// Second argument is optional: custom output buffer
const outBuf = new Uint8Array(100000);
// IMPORTANT: fzstd will assume the buffer is sufficiently sized, so it
// will yield corrupt data if the buffer is too small. It is highly
// recommended to only specify this if you know the maximum output size.
fzstd.decompress(compressed, outBuf);
```

You can also use data streams to minimize memory usage while decompressing.
```js
let outChunks = [];
const stream = new fzstd.Decompress((chunk, isLast) => {
  // Add to list of output chunks
  outChunks.push(chunk);
  // Log after all chunks decompressed
  if (isLast) {
    console.log('Output chunks:', outChunks);
  }
});

// You can also attach the data handler separately if you don't want to
// do so in the constructor.
stream.ondata = (chunk, final) => { ... }

// Since this is synchronous, all errors will be thrown by stream.push()
stream.push(chunk1);
stream.push(chunk2);
...
// Last chunk must have the second parameter true
stream.push(chunkLast, true);

// Alternatively, you can push every data chunk normally and push an empty
// chunk at the end:
// stream.push(chunkLast);
// stream.push(new Uint8Array(0), true);
```

## Considerations
Unlike my Zlib implementation [`fflate`](https://github.com/101arrowz/fflate), WebAssembly ports of Zstandard are usually significantly (40-50%) faster than `fzstd`. However, they fail to decompress most archives without the decompressed size provided in advance. Moreover, they do not support streaming and thereby allocate a large amount of memory that cannot be freed. Lastly, `fzstd` is absolutely tiny: at 8kB minified and 3.8kB after gzipping, it's much smaller than most WASM implementations.

Please note that unlike the reference implementation, `fzstd` only supports a maximum backreference distance of 2<sup>25</sup> bytes. If you need to decompress files with an "ultra" compression level (20 or greater) AND if your files can be above 32MB decompressed, `fzstd` *might* fail to decompress properly. Consider using a WebAssembly port for files this large (though this may be difficult if you don't know the decompressed size).