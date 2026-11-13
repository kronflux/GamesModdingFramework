// The reflection pages: one per game class, struct and enum, the engine stubs, and the
// "Referenced by" part that points back from a type to the game types that use it.

import { get, getOr, leaf, md, num, pyHex, pyStr, pyStrip, readable, sortedBy, sortedPy, sortedStrings, truthy } from "../text.mjs";
import { usedBySection } from "./scripts.mjs";

const PROPERTY_FLAGS = [
  ["CPF_Edit", "Edit"], ["CPF_BlueprintVisible", "BP"], ["CPF_BlueprintReadOnly", "BP read-only"],
  ["CPF_Net", "Replicated"], ["CPF_Config", "Config"], ["CPF_SaveGame", "SaveGame"],
  ["CPF_Transient", "Transient"], ["CPF_BlueprintAssignable", "BP assignable"],
];
const FUNCTION_FLAGS = [
  ["FUNC_Static", "static"], ["FUNC_BlueprintCallable", "BP callable"], ["FUNC_BlueprintPure", "pure"],
  ["FUNC_BlueprintEvent", "BP event"], ["FUNC_Exec", "exec"], ["FUNC_NetServer", "server RPC"],
  ["FUNC_NetClient", "client RPC"], ["FUNC_NetMulticast", "multicast RPC"], ["FUNC_Const", "const"],
];
const SCALAR_TYPES = new Map(Object.entries({
  BoolProperty: "bool", IntProperty: "int32", Int8Property: "int8", Int16Property: "int16",
  Int64Property: "int64", UInt16Property: "uint16", UInt32Property: "uint32", UInt64Property: "uint64",
  FloatProperty: "float", DoubleProperty: "double", StrProperty: "FString", NameProperty: "FName",
  TextProperty: "FText", Utf8StrProperty: "FUtf8String", AnsiStrProperty: "FAnsiString",
  FieldPathProperty: "FFieldPath",
}));

/** The C++-like type of a property, with links to the documents of the types it names. */
export function typeName(docs, prop, fromFile, owner = null) {
  const kind = getOr(prop, "type", "");
  const ref = (key, fallback = "UObject") => {
    const target = get(prop, key);
    if (!truthy(target)) return fallback;
    if (owner) {
      if (!docs.referencedBy.has(target)) docs.referencedBy.set(target, new Set());
      docs.referencedBy.get(target).add(owner);
    }
    return docs.link(target, fromFile);
  };
  const inner = (key) => {
    const child = get(prop, key);
    return truthy(child) ? typeName(docs, child, fromFile, owner) : "?";
  };
  if (SCALAR_TYPES.has(kind)) return SCALAR_TYPES.get(kind);
  switch (kind) {
    case "StructProperty": return ref("struct", "struct");
    case "EnumProperty": return ref("enum", "enum");
    case "ByteProperty": return truthy(get(prop, "enum")) ? ref("enum") : "uint8";
    case "ObjectProperty": return ref("class") + "*";
    case "ClassProperty": return `TSubclassOf<${truthy(get(prop, "meta_class")) ? ref("meta_class") : ref("class")}>`;
    case "SoftObjectProperty": return `TSoftObjectPtr<${ref("class")}>`;
    case "SoftClassProperty": return `TSoftClassPtr<${truthy(get(prop, "meta_class")) ? ref("meta_class") : ref("class")}>`;
    case "WeakObjectProperty": return `TWeakObjectPtr<${ref("class")}>`;
    case "LazyObjectProperty": return `TLazyObjectPtr<${ref("class")}>`;
    case "InterfaceProperty": return `TScriptInterface<${ref("interface")}>`;
    case "ArrayProperty": return `TArray<${inner("inner")}>`;
    case "SetProperty": return `TSet<${inner("element")}>`;
    case "MapProperty": {
      const key = inner("key");
      return `TMap<${key}, ${inner("value")}>`;
    }
    case "OptionalProperty": return `TOptional<${inner("inner")}>`;
    default: break;
  }
  if (kind.endsWith("DelegateProperty")) {
    const signature = get(prop, "signature");
    const word = kind.includes("Multicast") ? "multicast delegate" : "delegate";
    return pyStrip(`${word} ${truthy(signature) ? docs.link(signature, fromFile) : ""}`);
  }
  return kind.replaceAll("Property", "");
}

function propertyTable(docs, item, file) {
  const rows = [];
  for (const prop of getOr(item, "properties", [])) {
    const flagNames = getOr(prop, "flag_names", []);
    const flags = PROPERTY_FLAGS.filter(([flag]) => flagNames.includes(flag)).map(([, label]) => label);
    const name = get(prop, "name");
    const shown = `\`${readable(name)}\`` + (readable(name) !== name ? ` (raw \`${name}\`)` : "");
    const dim = num(getOr(prop, "array_dim", 1)) > 1 ? `[${pyStr(get(prop, "array_dim"))}]` : "";
    rows.push(`| ${shown} | ${typeName(docs, prop, file, get(item, "path"))}${dim} | 0x${pyHex(getOr(prop, "offset", 0))} `
      + `| ${pyStr(getOr(prop, "size", 0))} | ${flags.join(", ")} |`);
  }
  if (!rows.length) return "";
  return "| Name | Type | Offset | Size | Flags |\n|---|---|---|---|---|\n" + rows.join("\n") + "\n";
}

function signature(docs, fn) {
  const params = [];
  let returns = "void";
  for (const prop of getOr(fn, "parameters", [])) {
    // A signature is shown as code, where markdown links are not followed.
    const kind = typeName(docs, prop, null);
    if (truthy(get(prop, "return"))) returns = kind;
    else params.push(`${truthy(get(prop, "out")) ? "out " : ""}${kind} ${readable(get(prop, "name"))}`);
  }
  return `${returns} ${get(fn, "name")}(${params.join(", ")})`;
}

function functionTable(docs, ownerPath) {
  const functions = sortedBy(docs.functionsOf.get(ownerPath) ?? [], (f) => get(f, "name"));
  if (!functions.length) return ["", []];
  const rows = [];
  const hooks = { native: "yes, before and after", blueprint: "yes, after", delegate: "no, delegate signature" };
  for (const fn of functions) {
    const flagNames = getOr(fn, "flag_names", []);
    const flags = FUNCTION_FLAGS.filter(([flag]) => flagNames.includes(flag)).map(([, label]) => label);
    const kind = docs.hookKind.get(get(fn, "path"));
    const where = truthy(get(fn, "native")) ? "native" : "Blueprint";
    const hook = Object.hasOwn(hooks, kind) ? hooks[kind] : "no";
    rows.push(`| \`${md(signature(docs, fn))}\` | ${where}${flags.length ? ", " : ""}${flags.join(", ")} | ${hook} |`);
  }
  const table = `The name to pass to \`RegisterHook\` is \`${ownerPath}:<FunctionName>\`.\n\n`
    + "| Signature | Kind | Hookable |\n|---|---|---|\n" + rows.join("\n") + "\n";
  return [table, functions.map((f) => get(f, "name"))];
}

function writeClasses(docs) {
  for (const item of docs.classes) {
    const path = get(item, "path");
    const file = docs.docOf.get(path);
    if (!file) continue;
    const name = get(item, "name");
    const parents = docs.chain(path);
    const lineage = [`**${name}**`, ...parents.map((p) => docs.link(p, file))].join(" → ");
    const kindWord = truthy(get(item, "native")) ? "Native class" : "Blueprint class";
    const body = [`# ${name}\n`, `${kindWord} \`${path}\`.\n`, `**Inheritance:** ${lineage}\n`,
      `**Size:** ${pyStr(getOr(item, "size", 0))} bytes. **Default object:** \`${pyStr(truthy(get(item, "default_object")) ? get(item, "default_object") : "none")}\`\n`];
    if (truthy(get(item, "interfaces"))) {
      body.push("**Implements:** " + get(item, "interfaces").map((i) => docs.link(i, file)).join(", ") + "\n");
    }
    const derived = sortedStrings((docs.children.get(path) ?? []).filter((p) => docs.docOf.has(p)));
    if (derived.length) {
      body.push("**Derived classes:** " + derived.slice(0, 60).map((p) => docs.link(p, file)).join(", ")
        + (derived.length > 60 ? ` and ${derived.length - 60} more` : "") + "\n");
    }
    body.push(...(docs.classNotes.get(path) ?? []));
    const table = propertyTable(docs, item, file);
    body.push(`## Properties\n\n${table || "None of its own."}\n`);
    const counted = parents.map((p) => [p, getOr(docs.byPath.get(p) ?? {}, "properties", []).length]);
    const inherited = counted.filter(([, n]) => n).map(([p, n]) => `${docs.link(p, file)} (${n})`);
    if (inherited.length) body.push("Inherited properties are listed with the class that declares them: " + inherited.join(", ") + ".\n");
    const [functions, names] = functionTable(docs, path);
    body.push(`## Functions\n\n${functions || "None of its own."}\n`);
    const usedBy = usedBySection(docs, item, file);
    if (usedBy) body.push(usedBy);
    const defaultValues = docs.defaults.classSection(item, file);
    if (defaultValues) body.push(defaultValues);
    const hookable = names.length && (docs.functionsOf.get(path) ?? []).some((f) => ["native", "blueprint"].includes(docs.hookKind.get(get(f, "path"))));
    body.push("## Use from a UE4SS Lua mod\n\n```lua\n"
      + `local objects = FindAllOf("${name}")\n`
      + (hookable ? `RegisterHook("${path}:${names[0]}", function(self, ...) end)\n` : "")
      + "```\n");
    const properties = getOr(item, "properties", []);
    const summary = `${kindWord}, parent ${parents.length ? leaf(parents[0]) : "none"}, ${properties.length} properties, ${names.length} functions`;
    docs.add(file, "class", name, path, summary, body.join("\n"), [...properties.map((p) => get(p, "name")), ...names],
      { parent: parents.length ? parents[0] : null, native: truthy(get(item, "native")) });
  }
}

function writeStructs(docs) {
  for (const item of docs.structs) {
    const path = get(item, "path");
    const file = docs.docOf.get(path);
    if (!file) continue;
    const name = get(item, "name");
    const parents = docs.chain(path);
    const body = [`# ${name}\n`, `${truthy(get(item, "native")) ? "Native" : "Blueprint"} struct \`${path}\`, ${pyStr(getOr(item, "size", 0))} bytes.\n`];
    if (parents.length) body.push("**Inheritance:** " + [`**${name}**`, ...parents.map((p) => docs.link(p, file))].join(" → ") + "\n");
    body.push(`## Members\n\n${propertyTable(docs, item, file) || "None."}\n`);
    const properties = getOr(item, "properties", []);
    docs.add(file, "struct", name, path, `struct, ${properties.length} members`, body.join("\n"), properties.map((p) => get(p, "name")));
  }
}

function writeEnums(docs) {
  for (const item of docs.enums) {
    const path = get(item, "path");
    const file = docs.docOf.get(path);
    if (!file) continue;
    const name = get(item, "name");
    const values = getOr(item, "entries", []);
    const rows = values.map((e) => `| \`${md(get(e, "name"))}\` | ${pyStr(get(e, "value"))} |`).join("\n");
    const body = `# ${name}\n\nEnum \`${path}\`.\n\n| Entry | Value |\n|---|---|\n${rows}\n`;
    docs.add(file, "enum", name, path, `enum, ${values.length} entries`, body, values.map((e) => get(e, "name")));
  }
}

/** The reflection section: classes, structs and enums of the game. */
export function write(docs) {
  writeClasses(docs);
  writeStructs(docs);
  writeEnums(docs);
}

/** One line per engine type the game refers to, grouped by engine module. */
export function writeEngineStubs(docs) {
  const wanted = new Set(docs.engineRefs);
  for (const path of [...docs.docOf.keys()]) {
    for (const p of docs.chain(path)) if (!docs.isGame(p)) wanted.add(p);
  }
  const modules = new Map();
  for (const path of sortedStrings(wanted)) {
    const item = docs.byPath.get(path);
    if (!item) continue;
    const module = path.startsWith("/Script/") ? path.split("/")[2].split(".")[0] : "Other";
    const parents = docs.chain(path).map(leaf).join(" → ") || "none";
    const name = get(item, "name");
    let line;
    if (docs.kind(item) === "enum") {
      const values = getOr(item, "entries", []).slice(0, 40).map((e) => `${leaf(get(e, "name").replaceAll("::", "."))}=${pyStr(get(e, "value"))}`).join(", ");
      line = `- **${name}** \`${path}\`: enum. ${md(values)}`;
    } else {
      line = `- **${name}** \`${path}\`: ${docs.kind(item)}, parents ${parents}, `
        + `${getOr(item, "properties", []).length} properties, ${(docs.functionsOf.get(path) ?? []).length} functions`;
    }
    if (!modules.has(module)) modules.set(module, []);
    modules.get(module).push([name, line]);
  }
  for (const [module, lines] of modules) {
    const body = `# Engine module ${module}\n\nEngine and plugin types the game derives from or refers to. Each is a stub:`
      + " the full description is in the dump's `Reflection` folder and in the engine's own documentation.\n\n"
      + sortedPy(lines).map(([, line]) => line).join("\n") + "\n";
    docs.add(`engine/${module}.md`, "engine_stubs", `Engine module ${module}`, null,
      `${lines.length} engine types the game refers to`, body, lines.map(([name]) => name));
  }
}

/** Adds a "Referenced by" section to documents other game types point at. */
export function writeReferencedBy(docs) {
  for (const [target, owners] of docs.referencedBy) {
    const file = docs.docOf.get(target);
    if (!file || !docs.files.has(file)) continue;
    const links = sortedStrings(owners).filter((o) => docs.docOf.has(o) && o !== target).map((o) => docs.link(o, file));
    if (links.length) {
      const more = links.length > 40 ? ` and ${links.length - 40} more` : "";
      docs.files.set(file, docs.files.get(file) + `\n## Referenced by\n\n${links.slice(0, 40).join(", ")}${more}\n`);
    }
  }
}
