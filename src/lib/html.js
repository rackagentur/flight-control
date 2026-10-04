// Escaping HTML template helper.
// Every interpolated value is escaped unless it is a SafeHtml produced by html`` or raw().
// Use raw() only for trusted, static markup (e.g. bundled SVG icons), never for data.

class SafeHtml {
  constructor(value) { this.value = value; }
  toString() { return this.value; }
}

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '`': '&#96;' };

export function escapeHtml(value) {
  return String(value).replace(/[&<>"'`]/g, (ch) => ESCAPES[ch]);
}

function serialize(value) {
  if (value === null || value === undefined || value === false) return '';
  if (value instanceof SafeHtml) return value.value;
  if (Array.isArray(value)) return value.map(serialize).join('');
  return escapeHtml(value);
}

export function html(strings, ...values) {
  let out = strings[0];
  for (let i = 0; i < values.length; i += 1) out += serialize(values[i]) + strings[i + 1];
  return new SafeHtml(out);
}

export function raw(trustedMarkup) {
  return new SafeHtml(String(trustedMarkup));
}

export function isSafeHtml(value) {
  return value instanceof SafeHtml;
}

export function render(element, template) {
  if (!(template instanceof SafeHtml)) throw new TypeError('render() requires html`` output');
  element.innerHTML = template.value;
}
