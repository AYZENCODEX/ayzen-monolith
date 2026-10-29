// One-off CLI for repairWalletEntriesWithoutJournal (FIN-WP-7). Safe to re-run.
//   pnpm --filter @workspace/api-server repair:finance-wallet-journals
import { repairWalletEntriesWithoutJournal } from "./wallet-bridge";

const result = await repairWalletEntriesWithoutJournal();
console.log(JSON.stringify(result));
process.exit(result.failed > 0 ? 1 : 0);
