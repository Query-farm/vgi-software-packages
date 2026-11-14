import { expect, test } from "bun:test";
import { CATALOG } from "../../src/catalog.ts";
import { CONTAINER_CATALOG } from "../../src/container_worker.ts";
import { COMPOSED_EXAMPLES } from "../../src/software/composed_examples.ts";
import { loadSettings } from "../../src/software/config.ts";
import { capabilityRows } from "../../src/software/service.ts";

const catalogs = { packages: CATALOG, containers: CONTAINER_CATALOG };

for (const [name, catalog] of Object.entries(catalogs) as [keyof typeof catalogs, typeof CATALOG][]) {
  test(`${name} composed examples are on their driving object and the schema list`, () => {
    const schema = catalog.schemas[0];
    const schemaList = JSON.parse(schema?.tags?.["vgi.example_queries"] ?? "[]") as { sql: string }[];
    for (const [object, examples] of Object.entries(COMPOSED_EXAMPLES[name])) {
      const fn = schema?.functions?.find((f) => f.meta.name === object);
      const list = JSON.parse(fn?.meta.tags?.["vgi.example_queries"] ?? "[]") as { sql: string }[];
      for (const example of examples) {
        expect(list.slice(0, 5).map((e) => e.sql)).toContain(example.sql);
        expect(schemaList.map((e) => e.sql)).toContain(example.sql);
        expect(example.sql).toContain(`${name}.main.`);
        expect(example.sql).toContain("ORDER BY");
        expect(example.sql).not.toContain(";");
      }
    }
  });
}

test("search guidance names every name-only index", () => {
  const search = CATALOG.schemas[0]?.functions?.find((f) => f.meta.name === "search");
  const doc = search?.meta.tags?.["vgi.doc_llm"] ?? "";
  const nameOnly = capabilityRows(loadSettings(), false)
    .filter((r) => r.operation === "search" && r.searched_fields === "name")
    .map((r) => String(r.ecosystem));
  expect(nameOnly.sort()).toEqual(["go", "pub", "pypi"]);
  expect(doc).toContain("PyPI, Go and pub search names only");
});
