import esbuild from "esbuild";
const stubs = new URL("./prj03-stubs.mjs", import.meta.url).pathname;
const plugin = { name: "stub", setup(b) {
  b.onResolve({ filter: /^@workspace\/db$|^drizzle-orm$|middlewares\/auth$|lib\/event-hub$|^\.\/events$/ }, () => ({ path: stubs }));
}};
const [,, entry, out] = process.argv;
await esbuild.build({ entryPoints: [entry], bundle: true, platform: "node", format: "esm", outfile: out, plugins: [plugin], external: ["express"], logLevel: "error" });
