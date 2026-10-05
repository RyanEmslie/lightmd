import assert from "node:assert/strict";
import { test } from "node:test";
import { parseFrontmatter } from "../src/frontmatter.js";

test("a leading BOM does not hide the frontmatter, and the body loses it too", () => {
  const parsed = parseFrontmatter("﻿---\ntitle: A\n---\n# Body\n");
  assert.equal(parsed.hasFrontmatter, true, "BOM + --- must still be frontmatter");
  assert.deepEqual(parsed.frontmatter, { title: "A" });
  assert.equal(parsed.body, "# Body\n");
});

test("a BOM-prefixed document without frontmatter renders from a BOM-free body", () => {
  const parsed = parseFrontmatter("﻿# Title\n");
  assert.equal(parsed.hasFrontmatter, false);
  assert.equal(parsed.body, "# Title\n", "a BOM before # would stop the heading from parsing");
});

test("an empty block (--- then ---) is frontmatter with no keys", () => {
  const parsed = parseFrontmatter("---\n---\n# Body\n");
  assert.equal(parsed.hasFrontmatter, true);
  assert.deepEqual(parsed.frontmatter, {});
  assert.equal(parsed.body, "# Body\n");
});

test("... closes the block like YAML's document end marker", () => {
  const parsed = parseFrontmatter("---\ntitle: A\n...\n# Body\n");
  assert.equal(parsed.hasFrontmatter, true);
  assert.deepEqual(parsed.frontmatter, { title: "A" });
  assert.equal(parsed.body, "# Body\n");
});

test("a document that starts with a horizontal rule is not swallowed as frontmatter", () => {
  const text = "---\n\nIntro paragraph that matters.\n\n---\n\n# Real content\n";
  const parsed = parseFrontmatter(text);
  assert.equal(parsed.hasFrontmatter, false, "a block with no key: line is not frontmatter");
  assert.deepEqual(parsed.frontmatter, {});
  assert.equal(parsed.body, text, "the intro paragraph must stay in the body");
});

test("a URL-only line is not mistaken for a key", () => {
  const text = "---\nhttps://example.com\n---\nrest\n";
  assert.equal(parseFrontmatter(text).hasFrontmatter, false);
});

test("existing shapes keep working: CRLF, closing at EOF, later --- in the body, list values", () => {
  const crlf = parseFrontmatter("---\r\ntitle: A\r\n---\r\n# Body\r\n");
  assert.equal(crlf.hasFrontmatter, true);
  assert.deepEqual(crlf.frontmatter, { title: "A" });
  assert.equal(crlf.body, "# Body\r\n");

  const eof = parseFrontmatter("---\ntitle: A\n---");
  assert.equal(eof.hasFrontmatter, true);
  assert.equal(eof.body, "");

  const later = parseFrontmatter("---\ntitle: A\n---\n# Body\n\n---\n\nmore\n");
  assert.equal(later.body, "# Body\n\n---\n\nmore\n");

  const lists = parseFrontmatter("---\ntags:\n  - a\n  - b\ntitle: T\n---\nx");
  assert.equal(lists.hasFrontmatter, true);
  assert.equal(lists.frontmatter.title, "T");
  assert.equal(lists.body, "x");

  const unclosed = parseFrontmatter("---\ntitle: A\n# Body\n");
  assert.equal(unclosed.hasFrontmatter, false);
});
