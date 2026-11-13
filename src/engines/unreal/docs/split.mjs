// Writes a document that is larger than a byte limit as several parts. A reader that takes a
// page whole, as a language model does, should not have to take a megabyte to find one
// function.

import { basename, dirname } from "./text.mjs";

export const MAX_BYTES = 100_000;

const TITLE_LINE = /^title: "(.*)"$/s;

function bytes(text) {
  return Buffer.byteLength(text, "utf8");
}

/** The first `title: "..."` line of the front matter: { index, title } or null. */
function findTitle(lines) {
  for (let i = 0; i < lines.length; i += 1) {
    const match = TITLE_LINE.exec(lines[i]);
    if (match) return { index: i, title: match[1] };
  }
  return null;
}

/**
 * Cuts a document that is larger than `limit` bytes into parts, each a document of its own.
 * Returns [{ file, text }]; the first keeps the name, the others are <name>.part2.md and so on.
 *
 * A cut falls between two lines, at a heading where one is near; a section larger than the
 * limit is cut at line boundaries and continues under "<heading> (continued)". A code block or
 * table that is cut is closed in one part and opened again in the next, the table with its
 * header row, so every part reads on its own. The first part lists every part and each later
 * part links to the first. With `options.linkNext`, every part but the last also ends with a
 * link to the part after it.
 */
export function splitDocument(text, file, limit = MAX_BYTES, options = {}) {
  if (bytes(text) <= limit) return [{ file, text }];
  let front = "";
  let body = text;
  if (text.startsWith("---\n") && text.indexOf("\n---\n", 4) >= 0) {
    const end = text.indexOf("\n---\n", 4) + 5;
    front = text.slice(0, end);
    body = text.slice(end);
  }
  const frontLines = front.split("\n");
  const titleMatch = findTitle(frontLines);
  const title = titleMatch ? titleMatch.title : basename(file);
  let start = 0;
  let stop = body.length;
  while (start < stop && body[start] === "\n") start += 1;
  while (stop > start && body[stop - 1] === "\n") stop -= 1;
  const lines = body.slice(start, stop).split("\n");
  // Room for the front matter, the part heading and the list of parts.
  const budget = Math.max(200, limit - bytes(front) - 420);
  const cost = (line) => bytes(line) + 1;

  const chunks = [];
  let current = [];
  let size = 0;
  let heading = null;
  let fence = null;
  let table = null;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const isHeading = fence === null && (line.startsWith("## ") || line.startsWith("### "));
    const closesFence = fence !== null && line.startsWith("```");
    const mayCut = current.length > 0 && !closesFence && !line.startsWith("|---");
    if (mayCut && ((isHeading && size > budget * 0.6) || size + cost(line) > budget)) {
      if (fence) current.push("```");
      chunks.push(current);
      current = [];
      size = 0;
      if (!isHeading) {
        const opening = heading ? [heading + " (continued)", ""] : [];
        if (fence) opening.push(fence);
        else if (table) opening.push(...table);
        current.push(...opening);
        size = opening.reduce((sum, entry) => sum + cost(entry), 0);
      }
    }
    if (closesFence) fence = null;
    else if (fence === null && line.startsWith("```")) fence = line;
    if (isHeading) {
      heading = line;
      table = null;
    } else if (fence === null) {
      if (line.startsWith("|") && index + 1 < lines.length && lines[index + 1].startsWith("|---")) table = [line, lines[index + 1]];
      else if (!line.startsWith("|")) table = null;
    }
    current.push(line);
    size += cost(line);
  }
  chunks.push(current);

  const stem = file.endsWith(".md") ? file.slice(0, -3) : file;
  const names = [file];
  for (let number = 2; number <= chunks.length; number += 1) names.push(`${stem}.part${number}.md`);
  const total = chunks.length;
  const next = (number) => (options.linkNext && number < total ? [`Continued in [part ${number + 1}](${basename(names[number])}).`] : []);
  const out = [];
  chunks.forEach((chunk, i) => {
    const number = i + 1;
    let lines = chunk;
    if (number === 1) {
      const links = [];
      for (let n = 2; n <= total; n += 1) links.push(`[part ${n}](${basename(names[n - 1])})`);
      const note = `This document is split into ${total} parts: ` + links.join(", ") + ".";
      const place = lines.findIndex((line) => line.startsWith("# ")) + 1;
      lines = [...lines.slice(0, place), "", note, ...lines.slice(place)];
      const tail = next(number);
      const joined = trimNewlines(lines.join("\n")) + (tail.length ? "\n\n" + tail[0] : "");
      out.push({ file: names[0], text: front + joined + "\n" });
    } else {
      const partTitle = `${title} (part ${number} of ${total})`;
      let partFront = front;
      if (titleMatch) {
        const replaced = [...frontLines];
        replaced[titleMatch.index] = `title: "${partTitle}"`;
        partFront = replaced.join("\n");
      }
      const intro = `# ${partTitle}\n\nContinues [${title}](${basename(names[0])}).\n\n`;
      const tail = next(number);
      const joined = trimNewlines(lines.join("\n")) + (tail.length ? "\n\n" + tail[0] : "");
      out.push({ file: names[number - 1], text: partFront + intro + joined + "\n" });
    }
  });
  return out;
}

function trimNewlines(text) {
  let end = text.length;
  while (end > 0 && text[end - 1] === "\n") end -= 1;
  return text.slice(0, end);
}

/**
 * Writes every document of `docs` over `docs.maxBytes` as several parts: each later part
 * becomes a document with its own search record and folder index entry.
 */
export function splitLarge(docs) {
  const recordOf = new Map();
  for (const record of docs.records) recordOf.set(record.file, record);
  for (const file of [...docs.files.keys()]) {
    const parts = splitDocument(docs.files.get(file), file, docs.maxBytes, docs.splitOptions);
    if (parts.length < 2) continue;
    const original = recordOf.get(file) ?? { kind: "document", title: file };
    parts.forEach(({ file: name, text }, i) => {
      const number = i + 1;
      docs.files.set(name, text);
      if (number === 1) return;
      const title = `${original.title} (part ${number} of ${parts.length})`;
      const summary = `part ${number} of ${parts.length} of ${original.title}`;
      docs.records.push({ id: name, kind: original.kind, title, file: name, summary, keywords: [] });
      docs.addToFolder(dirname(name).replaceAll("\\", "/"), [title, name, summary]);
    });
  }
}
