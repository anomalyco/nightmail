import { hostedDomain, hostedHosts, supportHost } from './brand.js';

// The dashboard opens a socket to the hosted support Worker beside it, so connect-src names each one. The desktop
// homepage plays its renders from each stage's R2 media host (infra/pulumi: media.nightmail.dev, media.dev.nightmail.dev)
// and reads which set is current there, so media-src and connect-src name both. No other imports: the Worker's fast
// /health path applies these without loading the rest of the API.
const supportSources = hostedHosts.flatMap(host => [`https://${supportHost(host)}`, `wss://${supportHost(host)}`]).join(' ');
const mediaSources = [hostedDomain, `dev.${hostedDomain}`].map(host => `https://media.${host}`).join(' ');
export const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  'Content-Security-Policy': `default-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; script-src 'self' 'sha256-KR8oxv/piV2tVuY/BDtT/MaYc89vuvcpMliZqOKhXmc='; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; font-src 'self' data:; media-src 'self' ${mediaSources}; connect-src 'self' ${supportSources} ${mediaSources}; frame-src 'self' blob:; worker-src 'self' blob:; form-action 'self'`,
  'X-Frame-Options': 'DENY',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
};
/** The hosted homepage's Permissions-Policy (worker.ts sets it on "/" alone): its television's glass may show the visitor
 *  from their camera, asked for when they switch the set off (app/src/features/home/tv/crt/mirror.ts). Only the camera
 *  differs; every other page and response keeps SECURITY_HEADERS' camera=(). */
export const HOME_PERMISSIONS_POLICY = 'camera=(self), microphone=(), geolocation=(), payment=(), usb=()';
