import { test } from 'node:test';
import assert from 'node:assert/strict';
import { html, raw, escapeHtml, isSafeHtml } from '../src/lib/html.js';

test('interpolated values are escaped', () => {
  const hostile = `<img src=x onerror="alert(1)">'\`&`;
  const out = html`<p title="${hostile}">${hostile}</p>`.toString();
  assert.ok(!out.includes('<img'), out);
  assert.ok(!out.includes('"alert'), out);
  assert.equal(escapeHtml(`<>&"'\``), '&lt;&gt;&amp;&quot;&#39;&#96;');
});

test('roster-shaped strings cannot inject markup', () => {
  const flight = { flightNumber: 'DE<script>', origin: 'FRA"><b', destination: 'YYZ' };
  const out = html`<span>${flight.flightNumber} ${flight.origin}→${flight.destination}</span>`.toString();
  assert.equal(out, '<span>DE&lt;script&gt; FRA&quot;&gt;&lt;b→YYZ</span>');
});

test('nested templates and arrays compose without double-escaping', () => {
  const items = ['a<b', 'c'];
  const out = html`<ul>${items.map((item) => html`<li>${item}</li>`)}</ul>`.toString();
  assert.equal(out, '<ul><li>a&lt;b</li><li>c</li></ul>');
});

test('null, undefined and false render as empty; numbers render', () => {
  assert.equal(html`${null}${undefined}${false}${0}`.toString(), '0');
});

test('raw() is the only way to pass trusted markup', () => {
  assert.ok(isSafeHtml(raw('<svg/>')));
  assert.equal(html`${raw('<svg/>')}`.toString(), '<svg/>');
  assert.ok(!isSafeHtml('<svg/>'));
});
