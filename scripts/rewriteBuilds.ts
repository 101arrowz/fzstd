import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
const atClass = /\/\*\* \@class \*\//g, pure = '/*#__PURE__*/';

const libIndex = join(__dirname, '..', 'lib', 'index.js');
writeFileSync(libIndex, readFileSync(libIndex, 'utf-8')
  .replace(atClass, pure)
  .replace(/exports.__esModule = true;\n/, '')
  .replace(/exports\.(.*) = void 0;\n/, '')
);

const esmIndex = join(__dirname, '..', 'esm', 'index.js')
writeFileSync(esmIndex, readFileSync(esmIndex, 'utf-8').replace(atClass, pure));