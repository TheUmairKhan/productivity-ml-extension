import { describe, it, expect } from "vitest";
import { normalizeUrl } from "../src/utils/normalizeUrl";

describe("normalizeUrl", () => {
  const cases: Array<{ input: string; expected: string }> = [
    {
      input: "https://www.Example.com/docs/page?utm_source=twitter#section",
      expected: "example.com/docs/page",
    },
    {
      input: "http://example.com/page?fbclid=abc123",
      expected: "example.com/page",
    },
    {
      input: "https://example.com/page?a=1&b=2",
      expected: "example.com/page?a=1&b=2",
    },
    {
      input: "https://www.youtube.com/watch?v=dQw4w9WgXcQ&utm_medium=email",
      expected: "youtube.com/watch?v=dQw4w9WgXcQ",
    },
    {
      input: "https://en.wikipedia.org/wiki/Hash_function#Applications",
      expected: "en.wikipedia.org/wiki/Hash_function",
    },
  ];

  for (const { input, expected } of cases) {
    it(input, () => {
      expect(normalizeUrl(input)).toBe(expected);
    });
  }
});
