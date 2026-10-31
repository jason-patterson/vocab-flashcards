// Puts the words from the "Max's SSAT Vocabulary List — Day N.md" notes into
// index.html, between the WORDS:BEGIN and WORDS:END markers.
// Run after editing a list:  node build-words.js
const fs = require("fs");
const path = require("path");

const dir = __dirname;
const sets = [];

for (const file of fs.readdirSync(dir)) {
  const m = file.match(/— Day (\d+)\.md$/);
  if (!m) continue;
  const text = fs.readFileSync(path.join(dir, file), "utf8");
  const words = [];
  for (const line of text.split(/\r?\n/)) {
    const cells = line.split("|").map((c) => c.trim());
    // Table rows look like: | Word | Definition |
    if (cells.length !== 4 || !cells[1] || cells[1] === "Word" || /^-+$/.test(cells[1])) continue;
    words.push([cells[1], cells[2]]);
  }
  sets.push({ day: Number(m[1]), words });
}

// Shuffle every word (the lists are alphabetical), then regroup into smaller
// study days. The shuffle is seeded so rebuilding keeps each day's words the
// same; change SEED to get a different mix.
const PER_DAY = 12;
const SEED = 2026;

function random(seed) {
  // mulberry32
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Example sentences live in examples.txt as "Word|Sentence" lines.
const examples = {};
for (const line of fs.readFileSync(path.join(dir, "examples.txt"), "utf8").split(/\r?\n/)) {
  const bar = line.indexOf("|");
  if (line.startsWith("#") || bar < 0) continue;
  examples[line.slice(0, bar).trim().toLowerCase()] = line.slice(bar + 1).trim();
}

sets.sort((a, b) => a.day - b.day);
const all = sets.flatMap((s) => s.words);
const missing = [];
for (const w of all) {
  const ex = examples[w[0].toLowerCase()];
  if (ex) w.push(ex);
  else missing.push(w[0]);
}
if (missing.length) console.log(`No example sentence for: ${missing.join(", ")}`);
const rand = random(SEED);
for (let i = all.length - 1; i > 0; i--) {
  const j = Math.floor(rand() * (i + 1));
  [all[i], all[j]] = [all[j], all[i]];
}
const out = [];
for (let i = 0; i < all.length; i += PER_DAY) {
  out.push({ name: "Day " + (out.length + 1), words: all.slice(i, i + PER_DAY) });
}
const json = JSON.stringify(out).replace(/\],\[/g, "],\n[").replace(/<\//g, "<\\/");
const htmlPath = path.join(dir, "index.html");
const html = fs.readFileSync(htmlPath, "utf8");
const marker = /(\/\* WORDS:BEGIN \*\/)[\s\S]*?(\/\* WORDS:END \*\/)/;
if (!marker.test(html)) throw new Error("WORDS:BEGIN / WORDS:END markers not found in index.html");
fs.writeFileSync(htmlPath, html.replace(marker, (_, begin, end) => `${begin}\nvar WORD_SETS = ${json};\n${end}`));
console.log(`${all.length} words in ${out.length} days of up to ${PER_DAY}`);
