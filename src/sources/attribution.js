// Provider attribution as data. The backend supplies { name, url }; the browser only validates and
// displays it. The provider is never named, and no provider URL is hard-coded, anywhere in src/.

const KEYS = ['name', 'url'];
const NAME = /^[A-Za-z0-9][A-Za-z0-9 .&'-]*$/;
const HOST = /^[a-z0-9.-]+$/i;

/**
 * Strict check of a wire attribution. Anything that is not exactly a plain {name, url} object with a
 * short plain name and an https URL without credentials gives null. Never throws.
 * @param {unknown} a
 * @returns {{name:string, url:string}|null}
 */
export function readAttribution(a) {
  try {
    if (a === null || typeof a !== 'object' || Array.isArray(a)) return null;
    const proto = Object.getPrototypeOf(a);
    if (proto !== Object.prototype && proto !== null) return null;
    const have = Object.keys(a);
    if (have.length !== KEYS.length || !KEYS.every((k) => have.includes(k))) return null;
    if (typeof a.name !== 'string' || typeof a.url !== 'string') return null;
    const name = a.name.trim();
    if (name.length < 1 || name.length > 40 || !NAME.test(name)) return null;
    if (a.url.length > 200) return null;
    const u = new URL(a.url);
    if (u.protocol !== 'https:' || u.username !== '' || u.password !== '' || !HOST.test(u.hostname)) return null;
    return Object.freeze({ name, url: u.href });
  } catch {
    return null;
  }
}
