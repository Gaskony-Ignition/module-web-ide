import { beforeEach, describe, expect, it, vi } from 'vitest';

const send = vi.fn(() => true);

/**
 * The handlers the client registered, kept OUTSIDE the mocks.
 *
 * The client is a module singleton that wires itself up exactly once, so by the
 * time a later test looks, `beforeEach`'s `mockClear()` has already erased the
 * only call that ever recorded them.
 */
let channelHandler: ((msg: unknown) => void) | null = null;
let openHandler: (() => void) | null = null;

const on = vi.fn((channel: string, handler: (msg: unknown) => void) => {
  if (channel === 'presence') channelHandler = handler;
  return () => {};
});
const onOpen = vi.fn((handler: () => void) => {
  openHandler = handler;
  return () => {};
});

vi.mock('./lspTransport', () => ({
  sharedTransport: () => ({ send, on, onOpen }),
}));

import {
  describeCrowd,
  describePeer,
  EMPTY_PRESENCE,
  peerName,
  peersOn,
  presenceClient,
  type Peer,
} from './presence';

function peer(over: Partial<Peer> = {}): Peer {
  return {
    username: 'sam',
    host: 'sams-laptop',
    kind: 'designer',
    project: 'P',
    resources: ['ignition/script-python/util'],
    since: 1000,
    ...over,
  };
}

describe('peersOn', () => {
  it('matches the project as well as the path', () => {
    // `ignition/script-python/util` exists in every project on the gateway, so
    // matching on the path alone reports a clash between two people who are not
    // in the same file at all.
    const state = { ...EMPTY_PRESENCE, peers: [peer({ project: 'Other' })] };
    expect(peersOn(state, 'P', 'ignition/script-python/util')).toHaveLength(0);
  });

  it('finds a peer holding the path', () => {
    const state = { ...EMPTY_PRESENCE, peers: [peer()] };
    expect(peersOn(state, 'P', 'ignition/script-python/util')).toHaveLength(1);
  });
});

describe('naming', () => {
  it('never renders a blank name', () => {
    // An empty name in a warning reads as a bug in the warning.
    expect(peerName(peer({ username: '   ' }))).toBe('someone');
  });

  it('says where, because the same person is often in two places', () => {
    expect(describePeer(peer())).toBe('sam in the Designer on sams-laptop');
    expect(describePeer(peer({ kind: 'ide', host: '' }))).toBe('sam in the IDE');
  });

  it('names everybody rather than counting them', () => {
    // "2 others" makes you go looking; the point is that you already know who
    // to talk to.
    const crowd = describeCrowd([
      peer(),
      peer({ username: 'ana', kind: 'ide', host: 'ana-pc' }),
    ]);
    expect(crowd).toBe(
      'sam in the Designer on sams-laptop and ana in the IDE on ana-pc also have this open.'
    );
  });

  it('is empty for an empty crowd, so a caller can render it unconditionally', () => {
    expect(describeCrowd([])).toBe('');
  });
});

describe('reporting', () => {
  beforeEach(() => {
    send.mockClear();
    on.mockClear();
    onOpen.mockClear();
  });

  it('sends the full open list, sorted, once', () => {
    const client = presenceClient();
    client.report('P', ['b', 'a']);
    expect(send).toHaveBeenCalledWith('presence', { project: 'P', open: ['a', 'b'] });
  });

  it('does not re-send an unchanged list', () => {
    // Reported from an effect over the docs array, so this runs on every render.
    // A frame per keystroke would cost every other client a broadcast.
    const client = presenceClient();
    client.report('P', ['a']);
    send.mockClear();
    client.report('P', ['a']);
    expect(send).not.toHaveBeenCalled();
  });

  it('sends again when a tab closes, including down to nothing', () => {
    // An empty list is a real message: it is what a client sends when the last
    // tab closes, and dropping it leaves a name on a file nobody has.
    const client = presenceClient();
    client.report('P', ['a']);
    send.mockClear();
    client.report('P', []);
    expect(send).toHaveBeenCalledWith('presence', { project: 'P', open: [] });
  });

  it('re-announces on reconnect', () => {
    // The server's entry for us dies with the socket, so a client that
    // reconnected quietly would be invisible to everyone while believing itself
    // announced.
    const client = presenceClient();
    client.report('P', ['a']);
    send.mockClear();
    openHandler?.();
    expect(send).toHaveBeenCalledWith('presence', { project: 'P', open: ['a'] });
  });

  it('ignores a frame that is not a peer list', () => {
    const client = presenceClient();
    const seen: unknown[] = [];
    client.subscribe((state) => seen.push(state));
    channelHandler?.({ nonsense: true });
    channelHandler?.(undefined);
    // Only the immediate replay from subscribe().
    expect(seen).toHaveLength(1);
  });
});
