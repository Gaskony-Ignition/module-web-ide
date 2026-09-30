import { describe, expect, it } from 'vitest';
import { apiUrl, gatewayLoginUrl, resolveApiBase, resolveWsUrl } from './urls';

describe('resolveApiBase', () => {
  it('derives the gateway mount base from the SPA path', () => {
    expect(resolveApiBase('/data/scriptide/')).toBe('/data/scriptide');
  });

  it('keeps the base stable on a client-side sub-route', () => {
    expect(resolveApiBase('/data/scriptide/scripts/MyProject/util')).toBe('/data/scriptide');
  });

  it('is empty in standalone dev, where the SPA is served from the root', () => {
    expect(resolveApiBase('/')).toBe('');
  });
});

describe('apiUrl', () => {
  it('joins the base and the route', () => {
    expect(apiUrl('/api/auth/session', '/data/scriptide/')).toBe(
      '/data/scriptide/api/auth/session'
    );
  });
});

describe('resolveWsUrl', () => {
  // The socket is NOT under the API base: WebResourceManager servlets live at
  // /system/<path>, outside /data/<alias>. Getting this wrong yields a 404
  // upgrade that looks like a broken module.
  it('points at /system/<alias>, not the API base', () => {
    const url = resolveWsUrl({ protocol: 'http:', host: 'gw:8088' } as Location);
    expect(url).toBe('ws://gw:8088/system/scriptide');
  });

  it('upgrades to wss on an https page', () => {
    const url = resolveWsUrl({ protocol: 'https:', host: 'gw:8043' } as Location);
    expect(url).toBe('wss://gw:8043/system/scriptide');
  });
});

describe('gatewayLoginUrl', () => {
  it('is a full-page gateway login on the same origin', () => {
    expect(gatewayLoginUrl({ origin: 'http://gw:8088' } as Location)).toBe(
      'http://gw:8088/web/login'
    );
  });
});
