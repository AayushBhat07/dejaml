// The tags both pages share (they must follow the page's import map, or the browser ignores the map): preload every three.js module the page imports (so they download together, not one after another)
// and the robot model. Used by build.mjs and research/build.mjs.
export const THREE_BASE = "https://cdn.jsdelivr.net/npm/three@0.169.0/";
export const preloads = (robot, extra = []) =>
  ["build/three.module.js", "examples/jsm/loaders/GLTFLoader.js", "examples/jsm/utils/SkeletonUtils.js", "examples/jsm/utils/BufferGeometryUtils.js", ...extra]
    .map((m) => `<link rel="modulepreload" href="${THREE_BASE}${m}" crossorigin>`)
    .concat(`<link rel="preload" href="${robot}" as="fetch" type="model/gltf-binary" crossorigin>`)
    .join("\n");
