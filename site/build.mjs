// Builds the "Inside DéjàML" explainer and its Research Road page.
//   node site/build.mjs                    → site/dist/index.html + site/dist/research-paper/index.html (see research/build.mjs)
//   node site/build.mjs --paper=URL        points the "Research paper" links somewhere else; --paper=none hides them
// Sources: index.src.html (markup + CSS, page head before the skip link) and js/NN_*.js (concatenated, in order, into one module scope).
// three.js r169 loads from jsDelivr and the fonts from Google Fonts; the robot model is embedded, so the page needs no other files.
import { readFileSync, writeFileSync, readdirSync, mkdirSync } from "node:fs";

const here = new URL("./", import.meta.url);
const arg = (k) => process.argv.find((x) => x.startsWith(`--${k}=`))?.slice(k.length + 3);
const paper = arg("paper") ?? "research-paper/";

const dir = new URL("./js/", here);
const parts = readdirSync(dir)
  .filter((f) => /^\d\d_.*\.js$/.test(f))
  .sort();
const js = parts.map((f) => `// ==== ${f} ====\n` + readFileSync(new URL(f, dir), "utf8")).join("\n");
// the agents' robot (RobotExpressive by Tomás Laulhé, CC0, via three.js examples)
const robot = readFileSync(new URL("./models/RobotExpressive.glb", here)).toString("base64");
let html = readFileSync(new URL("./index.src.html", here), "utf8").replace(
  "/*__APP__*/",
  () => `const ROBOT_GLB_B64 = "${robot}";\n` + js,
);
html = html.replace(
  /<script type="importmap">[\s\S]*?<\/script>/,
  () =>
    '<script type="importmap">{ "imports": { "three": "https://cdn.jsdelivr.net/npm/three@0.169.0/build/three.module.js", "three/addons/": "https://cdn.jsdelivr.net/npm/three@0.169.0/examples/jsm/" } }</script>',
);
html = paper !== "none"
  ? html.replaceAll("__PAPER_URL__", paper)
  : html
      .replace(/<li><a href="__PAPER_URL__">[^<]*<\/a><\/li>/g, "")
      .replace(/<a class="btn ghost" href="__PAPER_URL__">[^<]*<\/a>/g, "");
if (html.includes("__PAPER_URL__")) throw new Error("a Research paper link was left without a URL");

// index.src.html is a page body with its head material first; wrap it in a full document
const [head, ...rest] = html.split(/(?=<a class="skip")/);
const doc =
  '<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n' +
  '<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">\n' +
  "<style>:root{padding:env(safe-area-inset-top,0px) 0 env(safe-area-inset-bottom,0px)}body{margin:0}img{max-width:100%}[hidden]{display:none!important}</style>\n" +
  head +
  "\n</head>\n<body>\n" +
  rest.join("") +
  "\n</body>\n</html>\n";
mkdirSync(new URL("./dist/", here), { recursive: true });
writeFileSync(new URL("./dist/index.html", here), doc);
console.log(`site/dist/index.html ${(doc.length / 1024).toFixed(0)} KB · ${parts.join(" + ")}`);

// the Research Road page, linked from the explainer
await import("./research/build.mjs");
