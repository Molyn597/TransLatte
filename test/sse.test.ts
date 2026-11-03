import { describe, expect, it } from 'vitest';
import { parseDelta, sseData } from '../src/main/lmstudio';

describe('sseData', () => {
  it('vrátí hotové data řádky a nedokončený zbytek', () => {
    const { data, rest } = sseData('data: {"a":1}\n\n: komentář\ndata: [DONE]\r\ndata: {"b"');
    expect(data).toEqual(['{"a":1}', '[DONE]']);
    expect(rest).toBe('data: {"b"');
  });
});

describe('parseDelta', () => {
  it('čte content, úvahy a cenu', () => {
    expect(parseDelta('{"choices":[{"delta":{"content":"ahoj"}}]}')).toMatchObject({ content: 'ahoj' });
    expect(parseDelta('{"choices":[{"delta":{"reasoning_content":"hm"}}]}')).toMatchObject({ reasoning: 'hm' });
    expect(parseDelta('{"choices":[],"usage":{"cost":0.002}}')).toMatchObject({ cost: 0.002 });
  });
  it('rozpozná konec, chybu a nesmysl', () => {
    expect(parseDelta('[DONE]')).toEqual({ done: true });
    expect(parseDelta('{"error":{"message":"x"}}')).toEqual({ error: 'x' });
    expect(parseDelta('nejson')).toEqual({});
  });
});
