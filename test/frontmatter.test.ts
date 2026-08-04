import { describe, expect, test } from "bun:test";
import {
  flattenFrontmatter,
  frontmatterTitle,
  parseFrontmatter,
} from "../src/frontmatter.ts";

const fm = (src: string) => parseFrontmatter(src);
const data = (src: string) => parseFrontmatter(src).data;

describe("fence detection", () => {
  test("no frontmatter leaves the document untouched", () => {
    const src = "# hello\n\n---\n\nrule\n";
    expect(fm(src)).toEqual({ data: {}, content: src, raw: "", format: null });
  });

  test("yaml fence splits data from body", () => {
    const r = fm("---\ntitle: Foo\n---\n# body\n");
    expect(r.format).toBe("yaml");
    expect(r.data).toEqual({ title: "Foo" });
    expect(r.content).toBe("# body\n");
  });

  test("toml fence", () => {
    const r = fm('+++\ntitle = "Foo"\n+++\n# body\n');
    expect(r.format).toBe("toml");
    expect(r.data).toEqual({ title: "Foo" });
    expect(r.content).toBe("# body\n");
  });

  test("crlf line endings", () => {
    const r = fm("---\r\ntitle: Foo\r\n---\r\n# body\r\n");
    expect(r.data).toEqual({ title: "Foo" });
    expect(r.content).toBe("# body\r\n");
  });

  test("leading byte order mark", () => {
    expect(data("﻿---\ntitle: Foo\n---\nbody\n")).toEqual({ title: "Foo" });
  });

  test("empty fence yields no data", () => {
    const r = fm("---\n---\n# body\n");
    expect(r.data).toEqual({});
    expect(r.content).toBe("# body\n");
  });

  test("unclosed fence is not frontmatter", () => {
    const src = "---\ntitle: Foo\n\n# body\n";
    expect(fm(src).format).toBeNull();
    expect(fm(src).content).toBe(src);
  });

  test("fence further down the document is ignored", () => {
    const src = "# t\n\ntext\n\n---\nkey: not fm\n---\n";
    expect(fm(src).format).toBeNull();
    expect(fm(src).content).toBe(src);
  });

  test("comment-only frontmatter", () => {
    const r = fm("---\n# just a comment\n---\nbody\n");
    expect(r.data).toEqual({});
    expect(r.content).toBe("body\n");
  });
});

describe("yaml scalars", () => {
  test("types", () => {
    expect(data("---\ns: text\nn: 3\nf: 1.5\ne: 2e3\nneg: -4\nb: true\nb2: false\nz: null\nt: ~\n---\n")).toEqual({
      s: "text",
      n: 3,
      f: 1.5,
      e: 2000,
      neg: -4,
      b: true,
      b2: false,
      z: null,
      t: null,
    });
  });

  test("dates and times stay strings", () => {
    expect(data("---\nd: 2026-08-05\nt: 12:30\n---\n")).toEqual({
      d: "2026-08-05",
      t: "12:30",
    });
  });

  test("quoted values keep colons and hashes", () => {
    expect(data('---\na: "A: B"\nb: \'it\'\'s\'\nc: "hash # inside"\n---\n')).toEqual({
      a: "A: B",
      b: "it's",
      c: "hash # inside",
    });
  });

  test("unquoted url keeps its fragment", () => {
    expect(data("---\nurl: https://example.com/x#y\n---\n")).toEqual({
      url: "https://example.com/x#y",
    });
  });

  test("trailing comment stripped", () => {
    expect(data("---\nk: v # note\n---\n")).toEqual({ k: "v" });
  });

  test("double-quote escapes", () => {
    expect(data('---\ns: "tab\\there \\u00e9 \\"q\\" \\\\ end"\n---\n')).toEqual({
      s: 'tab\there é "q" \\ end',
    });
  });

  test("empty value is null", () => {
    expect(data("---\nk:\n---\n")).toEqual({ k: null });
  });
});

describe("yaml collections", () => {
  test("inline and block sequences", () => {
    expect(data("---\na: [x, y]\nb:\n  - x\n  - y\n---\n")).toEqual({
      a: ["x", "y"],
      b: ["x", "y"],
    });
  });

  test("block sequence at the key's own indentation", () => {
    expect(data("---\ntitle: T\ntags:\n- a\n- b\nauthor: R\n---\n")).toEqual({
      title: "T",
      tags: ["a", "b"],
      author: "R",
    });
  });

  test("unindented sequence nested under a map", () => {
    expect(data("---\nmeta:\n  tags:\n  - a\n  - b\n  status: draft\n---\n")).toEqual({
      meta: { tags: ["a", "b"], status: "draft" },
    });
  });

  test("unindented sequence of maps", () => {
    expect(data("---\npeople:\n- name: A\n  role: editor\n- name: B\nk: v\n---\n")).toEqual({
      people: [{ name: "A", role: "editor" }, { name: "B" }],
      k: "v",
    });
  });

  test("flow sequence spanning lines", () => {
    expect(data("---\ntags: [a,\n  b,\n  c]\n---\n")).toEqual({ tags: ["a", "b", "c"] });
  });

  test("nested maps", () => {
    expect(data("---\nmeta:\n  status: draft\n  deep:\n    k: v\n---\n")).toEqual({
      meta: { status: "draft", deep: { k: "v" } },
    });
  });

  test("sequence of maps", () => {
    expect(data("---\npeople:\n  - name: A\n    role: editor\n  - name: B\n    role: reviewer\n---\n")).toEqual({
      people: [
        { name: "A", role: "editor" },
        { name: "B", role: "reviewer" },
      ],
    });
  });

  test("inline map", () => {
    expect(data("---\nm: {a: 1, b: two}\n---\n")).toEqual({ m: { a: 1, b: "two" } });
  });

  test("comments between entries", () => {
    expect(data("---\na: 1\n# note\nb: 2\n---\n")).toEqual({ a: 1, b: 2 });
  });
});

describe("multi-line scalars", () => {
  test("plain scalar continuation folds onto one line", () => {
    expect(data("---\ndesc: a long value\n  continued here\n---\n")).toEqual({
      desc: "a long value continued here",
    });
  });

  test("continuation stops at the next key", () => {
    expect(data("---\na: one\n  two\nb: three\n---\n")).toEqual({
      a: "one two",
      b: "three",
    });
  });

  test("literal block keeps newlines and clips trailing", () => {
    expect(data("---\ns: |\n  one\n  two\n\n---\n")).toEqual({ s: "one\ntwo\n" });
  });

  test("literal block strip chomp", () => {
    expect(data("---\ns: |-\n  one\n  two\n---\n")).toEqual({ s: "one\ntwo" });
  });

  test("literal block keep chomp", () => {
    expect(data("---\ns: |+\n  one\n\n\n---\n")).toEqual({ s: "one\n\n\n" });
  });

  test("explicit indentation indicator preserves leading spaces", () => {
    expect(data("---\ns: |2\n    indented\n---\n")).toEqual({ s: "  indented\n" });
  });

  test("folded block joins lines, blank line breaks paragraph", () => {
    expect(data("---\ns: >\n  one\n  two\n\n  three\n---\n")).toEqual({
      s: "one two\nthree\n",
    });
  });

  test("folded strip chomp", () => {
    expect(data("---\ns: >-\n  one\n  two\n---\n")).toEqual({ s: "one two" });
  });
});

describe("toml", () => {
  test("scalars, arrays and tables", () => {
    expect(
      data('+++\ntitle = "Post"\ndraft = false\nweight = 10\ntags = ["a", "b"]\n[params]\nauthor = "R"\n[params.social]\nx = "@r"\n+++\n')
    ).toEqual({
      title: "Post",
      draft: false,
      weight: 10,
      tags: ["a", "b"],
      params: { author: "R", social: { x: "@r" } },
    });
  });

  test("comments ignored", () => {
    expect(data('+++\n# note\nk = "v" # trailing\n+++\n')).toEqual({ k: "v" });
  });
});

describe("resilience", () => {
  test("garbage frontmatter does not throw and keeps the body", () => {
    const r = fm("---\n\t\t: : :\n  ][\n---\nbody\n");
    expect(r.content).toBe("body\n");
    expect(typeof r.data).toBe("object");
  });

  test("anchored map is kept, anchor name dropped", () => {
    expect(data("---\nbase: &b\n  x: 1\n---\n")).toEqual({ base: { x: 1 } });
  });

  test("duplicate keys: last wins", () => {
    expect(data("---\nk: 1\nk: 2\n---\n")).toEqual({ k: 2 });
  });

  test("body containing a horizontal rule survives", () => {
    expect(fm("---\nk: v\n---\n\nintro\n\n---\n\nrest\n").content).toBe(
      "\nintro\n\n---\n\nrest\n"
    );
  });
});

describe("display helpers", () => {
  test("flatten nests with dots and joins arrays", () => {
    expect(
      flattenFrontmatter({
        title: "T",
        tags: ["a", "b"],
        meta: { status: "draft", n: 2 },
        empty: null,
      })
    ).toEqual([
      ["title", "T"],
      ["tags", "a, b"],
      ["meta.status", "draft"],
      ["meta.n", "2"],
      ["empty", ""],
    ]);
  });

  test("flatten trims trailing block-scalar newline", () => {
    expect(flattenFrontmatter({ s: "one\ntwo\n" })).toEqual([["s", "one\ntwo"]]);
  });

  test("title helper", () => {
    expect(frontmatterTitle({ title: "  T  " })).toBe("T");
    expect(frontmatterTitle({ title: 3 })).toBeUndefined();
    expect(frontmatterTitle({})).toBeUndefined();
  });
});
