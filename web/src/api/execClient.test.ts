import { describe, expect, it } from 'vitest';
import { toExecEvent, type ExecError } from './execClient';
import fixture from './__fixtures__/execError.json';

/**
 * Normalising the exec channel.
 *
 * The one thing worth guarding here is that `error` is overloaded by the server:
 * a STRING at the top level is a channel refusal (execution disabled, not an
 * administrator, bad CSRF), while an OBJECT inside a `finished` frame is a
 * Python traceback. Conflating them tells a user their script raised a
 * TypeError when what actually happened is that they lack a role.
 */
describe('toExecEvent', () => {
  it('reads a top-level string error as a channel refusal, not a script failure', () => {
    const event = toExecEvent({ error: 'Running scripts requires the Administrator role.' });
    expect(event).toEqual({
      kind: 'error',
      message: 'Running scripts requires the Administrator role.',
    });
  });

  it('reads an error OBJECT inside finished as the script traceback', () => {
    const event = toExecEvent({
      event: 'finished',
      executionId: 'x',
      ok: false,
      error: { type: 'TypeError', message: 'bad', frames: [] },
    });
    expect(event?.kind).toBe('finished');
    if (event?.kind !== 'finished') throw new Error('wrong kind');
    expect(event.result.error?.type).toBe('TypeError');
    expect(event.result.ok).toBe(false);
  });

  it('defaults every optional field on finished, so the UI never reads undefined', () => {
    const event = toExecEvent({ event: 'finished', executionId: 'x' });
    if (event?.kind !== 'finished') throw new Error('wrong kind');
    expect(event.result.stdout).toBe('');
    expect(event.result.stderr).toBe('');
    expect(event.result.truncated).toBe(false);
    expect(event.result.cancelled).toBe(false);
    // `ok` absent means NOT ok. Defaulting it true would report a failed run as
    // a success whenever the server omitted the field.
    expect(event.result.ok).toBe(false);
  });

  it('reads started and stopping', () => {
    expect(toExecEvent({ event: 'started', executionId: 'a' })).toEqual({
      kind: 'started',
      executionId: 'a',
    });
    expect(toExecEvent({ event: 'stopping', executionId: 'a', detail: 'interrupting' })).toEqual({
      kind: 'stopping',
      executionId: 'a',
      detail: 'interrupting',
    });
  });

  it('ignores anything it does not recognise rather than throwing', () => {
    // The socket is shared with the language server; an unexpected frame must
    // not take the console down.
    expect(toExecEvent(null)).toBeNull();
    expect(toExecEvent('nonsense')).toBeNull();
    expect(toExecEvent({ event: 'started' })).toBeNull(); // no executionId
    expect(toExecEvent({})).toBeNull();
  });

  it('reads an output frame, in order, ahead of finished', () => {
    // The 1.5.0 change: a run that prints for twenty seconds shows its first
    // line immediately instead of nothing until it ends.
    expect(toExecEvent({ event: 'output', executionId: 'a', stream: 'stdout', text: '0\n' }))
      .toEqual({ kind: 'output', executionId: 'a', stream: 'stdout', text: '0\n' });
    expect(toExecEvent({ event: 'output', executionId: 'a', stream: 'stderr', text: 'bad' }))
      .toEqual({ kind: 'output', executionId: 'a', stream: 'stderr', text: 'bad' });
  });

  it('treats an unknown stream name as stdout rather than dropping the text', () => {
    const event = toExecEvent({ event: 'output', executionId: 'a', stream: 'weird', text: 'x' });
    if (event?.kind !== 'output') throw new Error('wrong kind');
    expect(event.stream).toBe('stdout');
  });

  it('keeps an empty output chunk rather than inventing one', () => {
    // An empty string is a legal chunk; a MISSING text member is not a frame.
    expect(toExecEvent({ event: 'output', executionId: 'a', stream: 'stdout', text: '' }))
      .toEqual({ kind: 'output', executionId: 'a', stream: 'stdout', text: '' });
    expect(toExecEvent({ event: 'output', executionId: 'a', stream: 'stdout' })).toBeNull();
  });

  it('reads a reset acknowledgement', () => {
    expect(toExecEvent({ event: 'reset', project: 'Demo' }))
      .toEqual({ kind: 'reset', project: 'Demo' });
  });
});

/**
 * The wire contract, against the exact bytes the gateway produces.
 *
 * This is the test that would have caught the 1.4.3 defect. The client's frame
 * interface had invented `path`, `module`, `functionName` and `isTarget`; the
 * server has always sent `file`, `function`, `libraryModule` and `isSubmitted`.
 * Both halves compiled, both halves were self-consistent, and every traceback on
 * screen read "<console>, line N" with no function and no exception type.
 * TracebackFormatterTest asserts the same fixture from the other side.
 */
describe('the traceback wire contract', () => {
  it('parses a real ZeroDivisionError under the names the server sends', () => {
    const error = fixture.zeroDivision as ExecError;
    expect(error.type).toBe('ZeroDivisionError');
    expect(error.message).toBe('integer division or modulo by zero');
    expect(error.frames).toHaveLength(2);
    expect(error.frames[1].function).toBe('f');
    expect(error.frames[1].line).toBe(2);
    expect(error.frames[1].isSubmitted).toBe(true);
    expect(error.frames[1].libraryModule).toBeNull();
  });

  it('carries a library frame the client can turn into a resource path', () => {
    const frame = (fixture.libraryFrame as ExecError).frames[1];
    expect(frame.libraryModule).toBe('util.helpers');
    expect(frame.isSubmitted).toBe(false);
  });

  it('gives a syntax error a line, an offset and the source line', () => {
    const error = fixture.syntaxError as ExecError;
    expect(error.type).toBe('SyntaxError');
    // Not the raw PyTuple 1.4.3 printed, and no internal token anywhere in it.
    // The message quotes the offending token the way Python does, so the two
    // characters backslash-n are literal here — not a newline.
    expect(error.message).toBe("mismatched input '\\n' expecting COLON");
    expect(error.line).toBe(1);
    expect(error.offset).toBe(7);
    expect(error.text).toBe('if True\n');
    expect(JSON.stringify(error)).not.toContain('script-ide');
  });
});
