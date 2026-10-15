import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import TagBrowser, { qualityCode } from './TagBrowser';

function mockFetch(routes: Record<string, unknown>) {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const key = Object.keys(routes).find((k) => String(url).includes(k));
    return new Response(JSON.stringify(key ? routes[key] : {}), { status: key ? 200 : 404 });
  }));
}

afterEach(() => vi.unstubAllGlobals());

describe('TagBrowser', () => {
  it('lists providers for an administrator', async () => {
    mockFetch({ '/api/tags/providers': { providers: ['default', 'edge'] } });
    render(<TagBrowser csrfToken="t" isAdmin executionEnabled visible={false} />);
    await waitFor(() => expect(screen.getByText('edge')).toBeTruthy());
    expect(screen.getByText('default')).toBeTruthy();
  });

  it('says why it is empty to a non-administrator, and calls nothing', () => {
    mockFetch({});
    render(<TagBrowser csrfToken="t" isAdmin={false} executionEnabled visible />);
    expect(screen.getByText(/Administrator role/)).toBeTruthy();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('does not poll values while hidden', async () => {
    mockFetch({ '/api/tags/providers': { providers: ['default'] } });
    render(<TagBrowser csrfToken="t" isAdmin executionEnabled visible={false} />);
    await waitFor(() => expect(screen.getByText('default')).toBeTruthy());
    const read = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls
      .filter(([url]) => String(url).includes('/api/tags/read'));
    expect(read).toHaveLength(0);
  });
});

describe('qualityCode', () => {
  it('drops the diagnostic text so a bad quality fits on its row', () => {
    expect(qualityCode('Bad_NodeIdUnknown("CreateMonitoredItems failed")')).toBe('Bad_NodeIdUnknown');
    expect(qualityCode('Good')).toBe('Good');
  });
});
