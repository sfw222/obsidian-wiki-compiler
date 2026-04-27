import esbuild from "esbuild";
import process from "process";
import builtins from "builtin-modules";
import { copyFileSync } from "fs";

const prod = process.argv[2] === "production";

esbuild.build({
  banner: { js: "/* wiki-compiler */" },
  entryPoints: ["src/main.ts"],
  bundle: true,
  external: [
    "obsidian",
    "electron",
    "@codemirror/autocomplete",
    "@codemirror/collab",
    "@codemirror/commands",
    "@codemirror/language",
    "@codemirror/lint",
    "@codemirror/search",
    "@codemirror/state",
    "@codemirror/view",
    "@lezer/common",
    "@lezer/highlight",
    "@lezer/lr",
    ...builtins,
  ],
  format: "cjs",
  target: "es2018",
  logLevel: "info",
  sourcemap: prod ? false : "inline",
  treeShaking: true,
  outfile: prod ? "F:/mynote/.obsidian/plugins/wiki-compiler/main.js" : "main.js",
  minify: prod,
}).then(() => {
  if (prod) {
    const dest = "F:/mynote/.obsidian/plugins/wiki-compiler";
    copyFileSync("manifest.json", `${dest}/manifest.json`);
    copyFileSync("styles.css", `${dest}/styles.css`);
    console.log("Deployed manifest.json + styles.css");
  }
}).catch(() => process.exit(1));
