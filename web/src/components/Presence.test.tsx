import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { PresenceBadge, PresenceBar, PresenceList } from './Presence';
import type { Peer } from '../api/presence';

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

describe('PresenceBadge', () => {
  it('renders nothing at all when a file is yours alone', () => {
    // It sits inside a tab. A badge that renders an empty span still costs
    // layout, and the ordinary case is nobody there.
    const { container } = render(<PresenceBadge peers={[]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('shows an initial per person and collapses the rest to a count', () => {
    const peers = [peer(), peer({ username: 'ana' }), peer({ username: 'joe' })];
    render(<PresenceBadge peers={peers} max={2} />);
    expect(screen.getByText('S')).toBeInTheDocument();
    expect(screen.getByText('A')).toBeInTheDocument();
    expect(screen.getByText('+1')).toBeInTheDocument();
  });

  it('carries the full list in a text alternative, not colour alone', () => {
    render(<PresenceBadge peers={[peer()]} />);
    expect(screen.getByLabelText(/sam in the Designer on sams-laptop/)).toBeInTheDocument();
  });

  it('shows a dot rather than a blank circle for an unnamed session', () => {
    render(<PresenceBadge peers={[peer({ username: '' })]} />);
    expect(screen.getByText('•')).toBeInTheDocument();
  });
});

describe('PresenceBar', () => {
  it('is absent when nobody else has the file', () => {
    // An always-present bar saying "nobody else is here" costs a row of the
    // editor forever and trains the eye to skip the row that matters.
    const { container } = render(<PresenceBar peers={[]} designerFeed />);
    expect(container).toBeEmptyDOMElement();
  });

  it('names who and where, and says plainly that saving is not blocked', () => {
    render(<PresenceBar peers={[peer()]} designerFeed />);
    expect(screen.getByRole('status').textContent)
      .toContain('sam in the Designer on sams-laptop also has this open.');
    expect(screen.getByText(/Saving is not blocked/)).toBeInTheDocument();
  });

  it('admits when Designer files are not visible on this gateway', () => {
    // "Nobody else is here" and "I cannot see half of who is here" are
    // different statements, and only one should give you confidence to edit.
    render(<PresenceBar peers={[peer()]} designerFeed={false} />);
    expect(screen.getByText(/these are sessions only/)).toBeInTheDocument();
  });

  it('does not add the caveat when the only peers are other browsers', () => {
    render(<PresenceBar peers={[peer({ kind: 'ide' })]} designerFeed={false} />);
    expect(screen.queryByText(/sessions only/)).not.toBeInTheDocument();
  });
});

describe('PresenceList', () => {
  it('says so when the project is empty rather than rendering a blank box', () => {
    render(<PresenceList peers={[]} />);
    expect(screen.getByText(/Nobody else has this project open/)).toBeInTheDocument();
  });

  it('counts a session with nothing open as exactly that', () => {
    // A Designer open on a project having opened no script is invisible to the
    // per-file feed and still worth knowing about.
    render(<PresenceList peers={[peer({ resources: [] })]} />);
    expect(screen.getByText('no script open')).toBeInTheDocument();
  });

  it('counts open scripts with the right plural', () => {
    render(<PresenceList peers={[peer({ resources: ['a', 'b'] })]} />);
    expect(screen.getByText('2 scripts open')).toBeInTheDocument();
  });
});
