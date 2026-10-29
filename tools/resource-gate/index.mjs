import { readJson, gate } from "../enforcement-lib.mjs";
const budgets = readJson("config/resources/budgets.json");
console.log(JSON.stringify(gate("resource-to-circuit", budgets.unsafeStateAction === "block-and-create-gap" && budgets.sharedEnginesMustBeReused, budgets), null, 2));