import esbuild from "esbuild";
const stubs = new URL("./prj05-stubs.mjs", import.meta.url).pathname;
const re = /^@workspace\/db$|^drizzle-orm$|^crypto$|middlewares\/auth$|services\/credit-meter$|lib\/policy\/pep\/middleware$|lib\/policy\/pep$|lib\/policy\/policy-engine$|lib\/policy\/resource$|lib\/activity-log$|vault\/security\/kyc-ownership$|vault\/application\/kyc\/enrollment$|lib\/receipt-theme$|lib\/event-hub$|^\.\/events$|services\/sync$|lib\/telegram$|lib\/auth-utils$/;
const plugin = { name: "stub", setup(b) { b.onResolve({ filter: re }, () => ({ path: stubs })); } };
const [,, entry, out] = process.argv;
await esbuild.build({ entryPoints: [entry], bundle: true, platform: "node", format: "esm", outfile: out, plugins: [plugin], external: ["express"], logLevel: "error" });
