import { build } from "esbuild";

await build({
  entryPoints: ["src/server.ts"],
  bundle: true,
  platform: "node",
  target: "node20",
  format: "esm",
  outfile: "plugins/ask-user/dist/server.js",
  banner: { js: "#!/usr/bin/env node" },
  legalComments: "none",
});
