import esbuild from "esbuild";
const stubs = new URL("./prj04-stubs.mjs", import.meta.url).pathname;
const plugin = { name: "stub", setup(b) { b.onResolve({ filter: /^@workspace\/db$|^drizzle-orm$|^crypto$/ }, () => ({ path: stubs })); } };
const [,, entry, out] = process.argv;
await esbuild.build({ entryPoints: [entry], bundle: true, platform: "node", format: "esm", outfile: out, plugins: [plugin], external: ["express"], logLevel: "error" });
