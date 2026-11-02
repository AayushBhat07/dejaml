// Builds the "Inside DéjàML" explainer and its Research Road page.
//   node site/build.mjs                    → site/dist/index.html + site/dist/research-paper/index.html (see research/build.mjs)
//   node site/build.mjs --paper=URL        points the "Research paper" links somewhere else; --paper=none hides them
// Sources: index.src.html (markup + CSS, page head before the skip link) and js/NN_*.js (concatenated, in order, into one module scope).
// three.js r169 loads from jsDelivr and the fonts from Google Fonts. The robot, the SimReady props and the Poly Haven trees and textures are copied to dist/models/ and
// fetched after the page shows, so the HTML stays small; the three.js modules and the robot are preloaded in parallel.
import { readFileSync, writeFileSync, readdirSync, mkdirSync, copyFileSync } from "node:fs";
import { preloads, THREE_BASE as three } from "./preload.mjs";

const here = new URL("./", import.meta.url);
const arg = (k) => process.argv.find((x) => x.startsWith(`--${k}=`))?.slice(k.length + 3);
const paper = arg("paper") ?? "research-paper/";

const dir = new URL("./js/", here);
const parts = readdirSync(dir)
  .filter((f) => /^\d\d_.*\.js$/.test(f))
  .sort();
const js = parts.map((f) => `// ==== ${f} ====\n` + readFileSync(new URL(f, dir), "utf8")).join("\n");

// models: the agents' robot (RobotExpressive by Tomás Laulhé, CC0, via three.js examples) and the web-sized SimReady props (CC BY 4.0)
const dist = new URL("./dist/", here);
mkdirSync(new URL("./models/simready/", dist), { recursive: true });
copyFileSync(new URL("./models/RobotExpressive.glb", here), new URL("./models/RobotExpressive.glb", dist));
const web = new URL("./models/simready/web/", here);
const props = readdirSync(web).filter((f) => f.endsWith(".glb"));
for (const f of props) copyFileSync(new URL(f, web), new URL(`./models/simready/${f}`, dist));
copyFileSync(new URL("./models/simready/CREDITS.md", here), new URL("./models/simready/CREDITS.md", dist));
// the trees and surface textures (Poly Haven, CC0)
mkdirSync(new URL("./models/polyhaven/", dist), { recursive: true });
const ph = readdirSync(new URL("./models/polyhaven/", here)).filter((f) => /\.(glb|webp)$/.test(f));
for (const f of ph) copyFileSync(new URL(`./models/polyhaven/${f}`, here), new URL(`./models/polyhaven/${f}`, dist));
copyFileSync(new URL("./models/CREDITS.md", here), new URL("./models/CREDITS.md", dist));

let html = readFileSync(new URL("./index.src.html", here), "utf8").replace(
  "/*__APP__*/",
  () => `const ROBOT_GLB_URL = "models/RobotExpressive.glb", SIMREADY_URL = "models/simready/", POLYHAVEN_URL = "models/polyhaven/";\n` + js,
);
html = html.replace(
  /<script type="importmap">[\s\S]*?<\/script>/,
  () =>
    `<script type="importmap">{ "imports": { "three": "${three}build/three.module.js", "three/addons/": "${three}examples/jsm/" } }</script>\n` +
    preloads("models/RobotExpressive.glb", ["examples/jsm/libs/meshopt_decoder.module.js"]),
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
writeFileSync(new URL("./index.html", dist), doc);
console.log(`site/dist/index.html ${(doc.length / 1024).toFixed(0)} KB · ${parts.join(" + ")} · ${props.length} SimReady props · ${ph.length} Poly Haven files`);

// the Research Road page, linked from the explainer
await import("./research/build.mjs");
