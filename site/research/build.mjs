// Builds the Research Road page (the project's timeline and research study) into one static page.
//   node site/research/build.mjs   → site/dist/research-paper/index.html
// Sources: index.src.html (head material, <!--BODY-->, page) and js/NN_*.js (concatenated, in order, into one module scope).
// progress.json holds the parts that change as the study moves: where "now" is, the smoke test, the paper's steps.
// three.js r169 loads from jsDelivr and the fonts from Google Fonts; the robot is fetched from the explainer's dist/models/ (../models/), preloaded with the modules.
import { readFileSync, writeFileSync, readdirSync, mkdirSync } from "node:fs";
import { preloads } from "../preload.mjs";

const here = new URL("./", import.meta.url);
const main = process.argv.find((x) => x.startsWith("--main="))?.slice(7) ?? "../";

const progress = JSON.parse(readFileSync(new URL("./progress.json", here), "utf8"));
delete progress._help;
const dir = new URL("./js/", here);
const parts = readdirSync(dir)
  .filter((f) => /^\d\d_.*\.js$/.test(f))
  .sort();
const js = parts.map((f) => `// ==== ${f} ====\n` + readFileSync(new URL(f, dir), "utf8")).join("\n");
// the robot (RobotExpressive by Tomás Laulhé, CC0, via three.js examples), shared with the explainer: site/build.mjs copies it to dist/models/
const robot = "../models/RobotExpressive.glb";
const code =
  `import * as THREE from 'three';\nconst ROBOT_GLB_URL = "${robot}";\n` +
  `const PROGRESS = ${JSON.stringify(progress).replace(/</g, "\\u003c")};\n` +
  js;
const base = "https://cdn.jsdelivr.net/npm/three@0.169.0/";
const importMap = `<script type="importmap">${JSON.stringify({ imports: { three: base + "build/three.module.js", "three/addons/": base + "examples/jsm/" } })}</script>`;
const page = readFileSync(new URL("./index.src.html", here), "utf8")
  .replace("<!--LOCALFONTS-->", "")
  .replace("<!--IMPORTMAP-->", () => importMap + "\n" + preloads(robot))   // preloads only after the import map, or the browser ignores the map
  .replace("//JS", () => code)
  .replaceAll("__MAIN_URL__", main);

const [head, body] = page.split("<!--BODY-->");
const doc =
  '<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n' +
  '<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">\n' +
  "<style>:root{padding:env(safe-area-inset-top,0px) 0 env(safe-area-inset-bottom,0px)}body{margin:0}img{max-width:100%}[hidden]{display:none!important}</style>\n" +
  head +
  "\n</head>\n<body>\n" +
  body +
  "\n</body>\n</html>\n";
mkdirSync(new URL("../dist/research-paper/", here), { recursive: true });
writeFileSync(new URL("../dist/research-paper/index.html", here), doc);
console.log(`site/dist/research-paper/index.html ${(doc.length / 1024).toFixed(0)} KB · ${parts.join(" + ")}`);
