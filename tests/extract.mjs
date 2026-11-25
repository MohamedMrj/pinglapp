// Pulls one marked block (/*NAME-START*/ … /*NAME-END*/) out of index.html and runs it, so the pure parts of Ping
// can be tested in Node without a browser. Pass `globals` for anything the block expects to find.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

export const INDEX = fileURLToPath(new URL('../index.html', import.meta.url));
export const html = () => readFileSync(INDEX, 'utf8');

export function block(name) {
  const src = html(), a = src.indexOf(`/*${name}-START*/`), b = src.indexOf(`/*${name}-END*/`);
  if (a < 0 || b < 0) throw new Error(`block ${name} not found in index.html`);
  return src.slice(a, b);
}

// Runs the block (or several, in order, e.g. ['SYNC', 'CLOUD']) and returns the named top-level bindings
// (const/let/function) they define.
export function load(name, exportsList, globals = {}) {
  const names = [].concat(name);
  const ctx = vm.createContext(Object.assign({ console }, globals));
  vm.runInContext(names.map(block).join('\n') + `\n;globalThis.__out = { ${exportsList.join(', ')} };`, ctx, { filename: `index.html#${names.join('+')}` });
  return ctx.__out;
}
