import { describe, expect, it } from 'vitest';
import { parseTagInput, tagPath } from './tags';

describe('parseTagInput', () => {
  it('reads booleans, accepting 1/0', () => {
    expect(parseTagInput('true', 'Boolean')).toBe(true);
    expect(parseTagInput('0', 'Boolean')).toBe(false);
    expect(parseTagInput('yes', 'Boolean')).toBeUndefined();
  });

  it('refuses text for a numeric tag instead of sending a string', () => {
    expect(parseTagInput('42', 'Int4')).toBe(42);
    expect(parseTagInput('4.5', 'Float8')).toBe(4.5);
    expect(parseTagInput('abc', 'Int4')).toBeUndefined();
    expect(parseTagInput('', 'Float4')).toBeUndefined();
  });

  it('passes a string tag through untouched, spaces included', () => {
    expect(parseTagInput(' hello ', 'String')).toBe(' hello ');
  });
});

describe('tagPath', () => {
  it('brackets the provider', () => {
    expect(tagPath('default', 'A/B')).toBe('[default]A/B');
  });
});
