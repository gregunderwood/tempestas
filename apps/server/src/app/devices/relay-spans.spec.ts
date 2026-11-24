import { findStateAt, type Span } from './relay-spans';

function span(state: Span['state'], fromMs: number, toMs: number): Span {
  return { deviceId: 'heater', state, fromMs, toMs, ending: 'transition' };
}

describe('findStateAt', () => {
  const spans = [span('off', 0, 100), span('on', 100, 200)];

  it('reads the state of the span covering the instant', () => {
    expect(findStateAt(spans, 50)).toBe('off');
    expect(findStateAt(spans, 150)).toBe('on');
  });

  it('gives a shared boundary to the later span', () => {
    expect(findStateAt(spans, 100)).toBe('on');
  });

  it('calls an instant with no span unknown, never off', () => {
    expect(findStateAt(spans, 250)).toBe('unknown');
    expect(findStateAt([], 50)).toBe('unknown');
  });
});
