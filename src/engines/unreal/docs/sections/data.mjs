// Data pages: data tables, data assets, curves, configured defaults and widget trees.

import {
  cmpNatural, entries, get, getOr, isDict, isList, keys, leaf, md, naturalKey, or, pyDumps, pyStr, readable, size,
  sortedBy, truthy,
} from "../text.mjs";

/** Nested values as a markdown list; deep or long parts fall back to inline JSON. */
export function valueLines(value, depth = 0) {
  const pad = "  ".repeat(depth);
  if (isDict(value) && size(value) && depth < 3) {
    const out = [];
    for (const [key, item] of entries(value)) {
      if ((isDict(item) || isList(item)) && truthy(item) && depth < 2) {
        out.push(`${pad}- **${readable(key)}:**`);
        out.push(...valueLines(item, depth + 1));
      } else {
        out.push(`${pad}- **${readable(key)}:** \`${md(pyDumps(item))}\``);
      }
    }
    return out;
  }
  if (isList(value) && value.length && depth < 3) {
    const out = [];
    value.slice(0, 50).forEach((item, index) => {
      if ((isDict(item) || isList(item)) && truthy(item) && depth < 2) {
        out.push(`${pad}- [${index}]`);
        out.push(...valueLines(item, depth + 1));
      } else {
        out.push(`${pad}- \`${md(pyDumps(item))}\``);
      }
    });
    if (value.length > 50) out.push(`${pad}- and ${value.length - 50} more`);
    return out;
  }
  return [`${pad}- \`${md(pyDumps(value))}\``];
}

function writeDataTables(docs) {
  const index = or(docs.load("DataTables/_index.json"), {});
  for (const entry of getOr(index, "tables", [])) {
    const table = docs.load("DataTables/" + get(entry, "file"));
    if (!truthy(table)) continue;
    const path = get(entry, "path");
    const rowStruct = get(entry, "row_struct") ?? null;
    const name = leaf(path);
    const file = docs.fileFor("data_tables", path);
    docs.docOf.set(path, file);
    const keyed = getOr(table, "rows", []).map((row) => ({ row, key: naturalKey(getOr(row, "name", "")) }));
    keyed.sort((a, b) => cmpNatural(a.key, b.key));
    const rows = keyed.map((entry) => entry.row);
    const columns = rows.length && isDict(get(rows[0], "values")) ? keys(get(rows[0], "values")) : [];
    const flat = columns.length && columns.length <= 8 && rows.every((r) => isDict(get(r, "values"))
      && !entries(get(r, "values")).some(([, v]) => (isDict(v) || isList(v)) && truthy(v)));
    const body = [`# ${name}\n`, `Data table \`${pyStr(path)}\`, ${rows.length} rows. Row struct: ${docs.link(rowStruct, file)}.\n`];
    const raw = columns.filter((c) => readable(c) !== c);
    if (raw.length) body.push("Raw member names: " + raw.map((c) => `\`${readable(c)}\` is \`${c}\``).join(", ") + ".\n");
    if (flat) {
      body.push("| Row | " + columns.map(readable).join(" | ") + " |\n|" + "---|".repeat(columns.length + 1));
      for (const row of rows) {
        const values = get(row, "values");
        const cells = columns.map((c) => md(pyDumps(get(values, c))));
        body.push(`| \`${md(get(row, "name"))}\` | ` + cells.join(" | ") + " |");
      }
      body.push("");
    } else {
      for (const row of rows) {
        body.push(`## ${pyStr(get(row, "name"))}\n`);
        body.push(...valueLines(get(row, "values")));
        body.push("");
      }
    }
    docs.add(file, "data_table", name, path, `data table, ${rows.length} rows of ${leaf(rowStruct)}`, body.join("\n"),
      [...rows.map((r) => get(r, "name")), ...columns.map(readable)], { row_struct: rowStruct });
  }
}

function writeValueObjects(docs, relative, section, kind, word) {
  docs.lines(relative, (item) => {
    const path = get(item, "path");
    const classPath = get(item, "class");
    const name = leaf(path);
    const className = leaf(classPath);
    let file;
    let title;
    if (section === "config") {
      file = [section, className.replace(/[<>:"|?*\\/]/g, "_")].join("/") + ".md";
      title = className;
    } else {
      file = docs.fileFor(section, path);
      title = name;
    }
    if (!docs.docOf.has(path)) docs.docOf.set(path, file);
    const values = or(get(item, "values"), {});
    const body = [`# ${title}\n`, `${word} \`${pyStr(path)}\` of class ${docs.link(classPath, file)}.\n`, "## Values\n"];
    body.push(...valueLines(values));
    const names = keys(values).map(readable);
    docs.add(file, kind, title, path, `${word.toLowerCase()} of class ${className}, ${names.length} values`, body.join("\n"), names,
      { class: classPath ?? null });
  });
}

function writeWidgets(docs) {
  const trees = getOr(or(docs.load("UI/widget_trees.json"), {}), "trees", []);
  for (const tree of trees) {
    if (!truthy(get(tree, "is_template")) || !truthy(get(tree, "widgets"))) continue;
    const owner = get(tree, "owner");
    const widgets = get(tree, "widgets");
    const file = docs.fileFor("ui", owner);
    const children = new Map();
    for (const widget of widgets) {
      const parent = or(get(widget, "parent"), "");
      if (!children.has(parent)) children.set(parent, []);
      children.get(parent).push(widget);
    }
    const lines = [];
    const walk = (parent, depth) => {
      for (const widget of sortedBy(children.get(parent) ?? [], (w) => get(w, "name"))) {
        lines.push(`${"  ".repeat(depth)}- \`${get(widget, "name")}\` (${docs.link(get(widget, "class"), file)})`);
        if (depth < 40) walk(get(widget, "name"), depth + 1);
      }
    };
    let roots = widgets.filter((w) => get(w, "name") === get(tree, "root"));
    if (!roots.length) roots = children.get("") ?? [];
    for (const root of roots) {
      lines.push(`- \`${get(root, "name")}\` (${docs.link(get(root, "class"), file)})`);
      walk(get(root, "name"), 1);
    }
    const placed = new Set(lines.map((line) => line.split("`")[1]));
    const loose = widgets.filter((w) => !placed.has(get(w, "name")));
    const body = [`# ${leaf(owner)} widget tree\n`, `Layout of the widget Blueprint ${docs.link(owner, file)}, ${widgets.length} widgets.\n`,
      "## Hierarchy\n", lines.join("\n"), ""];
    if (loose.length) {
      body.push("## Widgets outside the hierarchy\n\n" + sortedBy(loose, (w) => get(w, "name"))
        .map((w) => `- \`${get(w, "name")}\` (${docs.link(get(w, "class"), file)})`).join("\n") + "\n");
    }
    docs.add(file, "widget_tree", leaf(owner), owner, `widget tree, ${widgets.length} widgets`, body.join("\n"),
      widgets.map((w) => get(w, "name")), { class: owner });
  }
}

/** The data section: data tables, data assets, curves, configured defaults, widget trees. */
export function write(docs) {
  writeDataTables(docs);
  writeValueObjects(docs, "DataAssets/data_assets.jsonl", "data_assets", "data_asset", "Data asset");
  writeValueObjects(docs, "DataAssets/curves.jsonl", "curves", "curve", "Curve");
  writeValueObjects(docs, "Config/config_objects.jsonl", "config", "config", "Configured defaults");
  writeWidgets(docs);
}
