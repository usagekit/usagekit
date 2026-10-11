import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { Ajv } from "ajv";
import { blockNames, variantSpecific, variants } from "./index.js";
import { legacy, sheets, styleMap, styleSource, styles } from "../styles/styles.mjs";

const root = resolve(import.meta.dirname, "..");
const repo = resolve(root, "../..");
const read = (path: string) => JSON.parse(readFileSync(path, "utf8"));
const version = (name: string) => read(join(repo, "packages", name, "package.json")).version;
const primitives = ["table", "card", "badge", "tooltip", "select", "button", "input", "label"];
/** Source as a style publishes it: that style's sheet baked into the tokens. */
const styled = (path: string, sheet: (typeof sheets)[number]) =>
  styleSource(readFileSync(path, "utf8"), styleMap(sheet));
const sheetOf = (name: string) => styles.find((style) => style.name === name)!.sheet;
let out: string;

beforeAll(() => {
  out = mkdtempSync(join(tmpdir(), "usagekit-registry-"));
  execFileSync(process.execPath, [join(repo, "scripts/registry-build.mjs"), "--out", out], {
    cwd: repo,
    stdio: "pipe",
  });
});
afterAll(() => rmSync(out, { recursive: true, force: true }));

describe("registry build", () => {
  test("writes all defaults, one directory per variant and one per shadcn style", () => {
    expect(readdirSync(join(out, "r")).sort()).toEqual(
      [...blockNames.map((n) => `${n}.json`), "base", "radix", "styles"].sort(),
    );
    expect(readdirSync(join(out, "r", "styles")).sort()).toEqual(
      styles.map((style) => style.name).sort(),
    );
    for (const style of styles)
      expect(readdirSync(join(out, "r", "styles", style.name)).sort()).toEqual(
        [...blockNames.map((n) => `${n}.json`), "registry.json"].sort(),
      );
    for (const variant of variants)
      expect(readdirSync(join(out, "r", variant)).sort()).toEqual(
        [...blockNames.map((n) => `${n}.json`), "registry.json"].sort(),
      );
    for (const name of blockNames)
      expect(read(join(out, "r", `${name}.json`))).toEqual(
        read(join(out, "r", "radix", `${name}.json`)),
      );
  });
  test("every output validates against the vendored shadcn schemas", () => {
    const ajv = new Ajv({ strict: false, allErrors: true });
    // The vendored files name the https draft-07 meta-schema, which Ajv registers under http.
    const schema = (file: string) => {
      const { $schema: _, ...rest } = read(join(root, "schema", file));
      return rest;
    };
    const itemSchema = schema("registry-item.json");
    ajv.addSchema(itemSchema, "https://ui.shadcn.com/schema/registry-item.json");
    const item = ajv.getSchema("https://ui.shadcn.com/schema/registry-item.json")!;
    const index = ajv.compile(schema("registry.json"));
    expect(index(read(join(root, "registry.json"))), JSON.stringify(index.errors)).toBe(true);
    const dirs = [...variants, ...styles.map((style) => `styles/${style.name}`)];
    for (const dir of dirs) {
      expect(index(read(join(out, "r", dir, "registry.json")))).toBe(true);
      for (const name of blockNames) {
        const data = read(join(out, "r", dir, `${name}.json`));
        expect(item(data), `${dir}/${name} ${JSON.stringify(item.errors)}`).toBe(true);
      }
    }
  });
  test("registry blocks use host primitives, pinned usagekit dependencies and docs", () => {
    const pins = ["react", "views", "core"].map((n) => `@usagekit/${n}@${version(n)}`);
    for (const variant of variants)
      for (const name of blockNames) {
        const data = read(join(out, "r", variant, `${name}.json`));
        expect(data).toMatchObject({ name, type: "registry:block" });
        expect(data.dependencies).toEqual(pins);
        expect(data.registryDependencies.length).toBeGreaterThan(0);
        for (const dep of data.registryDependencies) {
          expect(primitives).toContain(dep);
          expect(data.docs).toContain(`@/components/ui/${dep}`);
        }
        for (const file of data.files) {
          expect(file.type).toBe("registry:component");
          expect(file.target).toMatch(/^@components\/usagekit\/[a-z-]+\.tsx$/);
          expect(file.path).toMatch(new RegExp(`^registry/${variant}/[a-z-]+/[a-z-]+\\.tsx$`));
          expect(file.target).toBe(`@components/usagekit/${file.path.split("/").at(-1)}`);
          expect(file.content).toBe(styled(join(root, file.path), sheetOf(legacy[variant])));
        }
      }
  });
});

describe("registry styles", () => {
  const files = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? files(join(dir, e.name)) : [join(dir, e.name)],
    );
  const sources = files(join(root, "registry")).filter((file) => file.endsWith(".tsx"));
  const tokens = new Set(
    sources.flatMap((file) =>
      [...readFileSync(file, "utf8").matchAll(/\bcn-usage-[a-z0-9]+(?:-[a-z0-9]+)*\b/g)].map(
        ([token]) => token,
      ),
    ),
  );
  test("every sheet defines exactly the tokens the sources use", () => {
    expect(tokens.size).toBeGreaterThan(30);
    for (const sheet of sheets)
      expect(Object.keys(styleMap(sheet)).sort(), sheet).toEqual([...tokens].sort());
  });
  test("sheets follow shadcn's format, name semantic colors and add no motion", () => {
    for (const sheet of sheets) {
      const text = readFileSync(join(root, "styles", `${sheet}.css`), "utf8");
      expect(text, sheet).toMatch(new RegExp(`^/\\*[^\\n]*\\*/\\n\\.style-${sheet} \\{`));
      expect(text, sheet).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(|oklch\(/);
      for (const classes of Object.values(styleMap(sheet))) {
        expect(classes, sheet).not.toMatch(
          /\b(bg|text|border|ring)-(red|orange|amber|yellow|green|blue|gray|zinc|neutral|black|white)(-\d+)?\b/,
        );
        expect(classes, sheet).not.toMatch(/\b(transition|animate|duration|delay)(-|\b)/);
      }
    }
  });
  test("each published style bakes its sheet into every file", () => {
    for (const style of styles)
      for (const name of blockNames) {
        const data = read(join(out, "r", "styles", style.name, `${name}.json`));
        for (const file of data.files) {
          expect(file.path).toMatch(new RegExp(`^registry/${style.variant}/`));
          expect(file.content).not.toMatch(/cn-usage-/);
          expect(file.content).toBe(styled(join(root, file.path), style.sheet));
        }
      }
  });
});

describe("registry sources", () => {
  const sources = variants.flatMap((variant) =>
    blockNames.map((name) => ({
      variant,
      name,
      path: join(root, "registry", variant, name, `${name}.tsx`),
    })),
  );
  const allFiles = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
      entry.isDirectory() ? allFiles(join(dir, entry.name)) : [join(dir, entry.name)],
    );
  test("registry copies fit the Vega formatted 300-line budget", async () => {
    const { format } = await import("prettier");
    const oversized: string[] = [];
    for (const path of allFiles(join(root, "registry"))) {
      if (!path.endsWith(".tsx") || path.endsWith("/budget-editor.tsx")) continue;
      const content = await format(styled(path, "vega"), {
        printWidth: 100,
        trailingComma: "all",
        filepath: path,
      });
      const lines = content
        .replace(/\/\*[\s\S]*?\*\//g, (comment) => "\n".repeat(comment.split("\n").length - 1))
        .split("\n")
        .filter((line) => line.trim() && !line.trim().startsWith("//")).length;
      if (lines > 300) oversized.push(`${path}: ${lines}`);
    }
    expect(oversized).toEqual([]);
  });
  test("registry blocks never use useEffect", () => {
    const offenders = allFiles(join(root, "registry")).filter((path) =>
      /\buseEffect\b/.test(readFileSync(path, "utf8")),
    );
    expect(offenders).toEqual([]);
  });
  test("registry uses imported views types", () => {
    const offenders = allFiles(join(root, "registry")).filter((path) =>
      /import\("@usagekit\/views"\)/.test(readFileSync(path, "utf8")),
    );
    expect(offenders).toEqual([]);
  });
  test("identical files are shared; only primitive API differences are variant files", () => {
    for (const name of blockNames) {
      const base = join(root, "registry", "base", name, `${name}.tsx`);
      const radix = join(root, "registry", "radix", name, `${name}.tsx`);
      expect(existsSync(base) && existsSync(radix)).toBe(true);
      if (variantSpecific.includes(name)) {
        expect(lstatSync(base).isSymbolicLink()).toBe(false);
        expect(readFileSync(base, "utf8")).not.toBe(readFileSync(radix, "utf8"));
      } else {
        expect(lstatSync(base).isSymbolicLink()).toBe(true);
        expect(readFileSync(base, "utf8")).toBe(readFileSync(radix, "utf8"));
      }
    }
  });
  test("imports go through host primitives and usagekit packages only", () => {
    const index = read(join(root, "registry.json")).items as {
      name: string;
      registryDependencies: string[];
      files: { path: string; target: string }[];
    }[];
    for (const { name, variant } of sources) {
      const definition = index.find((i) => i.name === name)!;
      const text = definition.files
        .map((file) =>
          readFileSync(join(root, file.path.replace("/radix/", `/${variant}/`)), "utf8"),
        )
        .join("\n");
      expect(text).not.toMatch(/@radix-ui|@base-ui|from "radix-ui"/);
      const deps = index.find((i) => i.name === name)!.registryDependencies;
      const specifiers = [...text.matchAll(/from "([^"]+)"/g)].map((m) => m[1]!);
      for (const s of specifiers) {
        const ui = /^@\/components\/ui\/([a-z-]+)$/.exec(s);
        if (ui) expect(deps).toContain(ui[1]);
        else if (s.startsWith("@/components/usagekit/")) {
          const bundled = read(join(root, "registry.json")).items.find(
            (i: { name: string }) => i.name === name,
          ).files;
          expect(
            bundled.some((f: { target: string }) => f.target === s.replace("@/", "@") + ".tsx"),
          ).toBe(true);
        } else expect(s).toMatch(/^(react|@usagekit\/(core|views|react))$/);
      }
      for (const dep of deps) expect(specifiers).toContain(`@/components/ui/${dep}`);
    }
  });
  test("styling uses semantic tokens only and ships no CSS", () => {
    const palette =
      /\b(bg|text|border|ring|fill|stroke|from|to|via|outline|decoration|divide)-(red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|slate|gray|zinc|neutral|stone|black|white)(-\d+)?\b/;
    for (const { path } of sources) {
      const text = readFileSync(path, "utf8");
      expect(text, path).not.toMatch(palette);
      expect(text, path).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(|oklch\(/);
      expect(text, path).not.toMatch(/\bNumber\(/);
    }
    const files = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
        e.isDirectory() ? files(join(dir, e.name)) : [join(dir, e.name)],
      );
    expect(files(join(root, "registry")).filter((f) => !f.endsWith(".tsx"))).toEqual([]);
  });
  test("every transition and animation stops for reduced motion", () => {
    const files = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
        e.isDirectory() ? files(join(dir, e.name)) : [join(dir, e.name)],
      );
    const moving = /(^|[\s"`])(transition(-\S+)?|animate-(spin|pulse|ping|bounce))(?=[\s"`]|$)/;
    for (const file of files(join(root, "registry/radix"))) {
      const text = readFileSync(file, "utf8");
      for (const [literal] of text.matchAll(/"[^"\n]*"|`[^`]*`/g))
        if (moving.test(literal))
          expect(literal, `${file}: ${literal}`).toMatch(/motion-reduce:(transition|animate)-none/);
    }
  });
  test("copy is host text with English defaults", () => {
    for (const { name, variant, path } of sources) {
      const entry = readFileSync(path, "utf8");
      // Only the public block's props contract counts. A bundled helper's labels
      // must not conceal a block that stopped accepting host copy.
      const delegated: Record<string, { block: string; props: string }> = {
        "provider-connect-form": { block: "provider-credential-controls", props: "ConnectProps" },
        "provider-allocation-editor": {
          block: "provider-allocation-policy",
          props: "AllocationProps",
        },
      };
      const contract = delegated[name];
      if (!contract) {
        expect(entry, `${variant}/${name}`).toMatch(/labels\?: Partial</);
        continue;
      }
      expect(entry, `${variant}/${name} public props`).toMatch(
        new RegExp(
          `export type \\{[^}]*\\b${contract.props}\\b[^}]*\\} from "@/components/usagekit/${contract.block}"`,
        ),
      );
      const definition = readFileSync(
        join(root, "registry", variant, contract.block, `${contract.block}.tsx`),
        "utf8",
      );
      expect(definition, `${variant}/${name} delegated props`).toMatch(
        new RegExp(`export type ${contract.props} = \\{[^]*?\\n\\}`),
      );
      const props = definition.match(
        new RegExp(`export type ${contract.props} = \\{([^]*?)\\n\\}`),
      )![1]!;
      expect(props, `${variant}/${name} host labels`).toMatch(/labels\?: Partial</);
    }
  });
});
