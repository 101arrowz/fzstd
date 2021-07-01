import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { minify, MinifyOptions } from 'terser';
import { join } from 'path';

const p = (...fns: string[]) => join(__dirname, '..', ...fns);

const src = readFileSync(p('lib', 'index.js'), 'utf8');

const opts: MinifyOptions = {
  mangle: {
    toplevel: true,
  },
  compress: {
    passes: 5,
    unsafe: true,
    pure_getters: true
  },
  sourceMap: false
};

minify(src, opts).then(out => {
  const res = "!function(f){typeof module!='undefined'&&typeof exports=='object'?module.exports=f():typeof define!='undefined'&&define.amd?define(['fzstd',f]):(typeof self!='undefined'?self:this).fzstd=f()}(function(){var _e={};" +
    out.code!.replace(/exports\.(.*) = void 0;\n/, '').replace(/exports\./g, '_e.') + 'return _e})';
  if (!existsSync(p('umd'))) mkdirSync(p('umd'));
  writeFileSync(p('umd', 'index.js'), res);
});