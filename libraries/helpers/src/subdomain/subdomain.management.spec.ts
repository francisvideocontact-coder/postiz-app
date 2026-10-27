// Studio Caillou: tests of the cookie domain helper.
// The repository has no jest project for the helpers, so this file runs with
// the Node test runner (type stripping, Node 23.6 or later):
//   node --test libraries/helpers/src/subdomain/subdomain.management.spec.ts
// It is excluded from every build by the `**/*spec.ts` pattern.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { getCookieUrlFromDomain } from './subdomain.management.ts';

const saved = process.env.COOKIE_DOMAIN;
afterEach(() => {
  if (saved === undefined) {
    delete process.env.COOKIE_DOMAIN;
  } else {
    process.env.COOKIE_DOMAIN = saved;
  }
});

test('without COOKIE_DOMAIN, the registrable domain is kept (official behaviour)', () => {
  delete process.env.COOKIE_DOMAIN;
  assert.equal(getCookieUrlFromDomain('https://app.example.com'), '.example.com');
});

test('without COOKIE_DOMAIN, an IP or localhost gives the hostname', () => {
  delete process.env.COOKIE_DOMAIN;
  assert.equal(getCookieUrlFromDomain('http://127.0.0.1:4200'), '127.0.0.1');
  assert.equal(getCookieUrlFromDomain('http://localhost:4200'), 'localhost');
});

test('COOKIE_DOMAIN replaces a domain the browsers refuse (public suffix hstgr.cloud)', () => {
  process.env.COOKIE_DOMAIN = 'postiz.srv1323925.hstgr.cloud';
  assert.equal(
    getCookieUrlFromDomain('https://postiz.srv1323925.hstgr.cloud'),
    'postiz.srv1323925.hstgr.cloud'
  );
});

test('COOKIE_DOMAIN is read at each call, not once at import', () => {
  process.env.COOKIE_DOMAIN = 'first.example.org';
  assert.equal(getCookieUrlFromDomain('https://app.example.com'), 'first.example.org');
  process.env.COOKIE_DOMAIN = 'second.example.org';
  assert.equal(getCookieUrlFromDomain('https://app.example.com'), 'second.example.org');
});

test('COOKIE_DOMAIN is trimmed', () => {
  process.env.COOKIE_DOMAIN = '  postiz.example.net  ';
  assert.equal(getCookieUrlFromDomain('https://postiz.example.net'), 'postiz.example.net');
});

test('an empty or blank COOKIE_DOMAIN is ignored', () => {
  process.env.COOKIE_DOMAIN = '';
  assert.equal(getCookieUrlFromDomain('https://app.example.com'), '.example.com');
  process.env.COOKIE_DOMAIN = '   ';
  assert.equal(getCookieUrlFromDomain('https://app.example.com'), '.example.com');
});
