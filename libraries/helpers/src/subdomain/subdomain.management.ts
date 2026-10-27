import { parse } from 'tldts';

export function getCookieUrlFromDomain(domain: string) {
  // Studio Caillou: browsers refuse a cookie set on a public suffix (hstgr.cloud
  // since May 2026), which the bundled tldts list does not know. COOKIE_DOMAIN
  // overrides the computed domain (gitroomhq/postiz-app#1143).
  const override = process.env.COOKIE_DOMAIN?.trim();
  if (override) {
    return override;
  }
  const url = parse(domain);
  return url.domain! ? '.' + url.domain! : url.hostname!;
}
