// Registers the resolve hook that swaps the four modules below for test stubs. Load it AFTER tsx:
//   node --test --import tsx --import ./src/marketplace/characterization/register-stubs.mjs <tests>
// Later-registered hooks run first, so this hook calls tsx's resolver and then remaps the final file.
import { register } from "node:module";
register("./stub-hooks.mjs", import.meta.url);
