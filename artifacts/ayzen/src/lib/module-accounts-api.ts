/**
 * lib/module-accounts-api.ts — W1-P1 (req 1): the signed-in user's id in each AYZEN module
 * (SYL-000001, ...). Thin wrapper over GET /me/modules (routes/module-accounts.ts).
 */
import { useQuery } from "@tanstack/react-query";
import { customFetch } from "@workspace/api-client-react";
import { getApiBase } from "@/lib/api-base";

export interface ModuleAccountView {
  module: string;
  label: string;
  uidPrefix: string;
  /** null = no account in this module yet. */
  moduleUid: string | null;
  status: "active" | "suspended" | "closed" | null;
  createdAt: string | null;
}

export function useModuleAccounts(enabled = true) {
  return useQuery({
    queryKey: ["me", "modules"],
    enabled,
    staleTime: 5 * 60_000, // ids never change once minted
    queryFn: async () => {
      const res = await customFetch<{ modules: ModuleAccountView[] }>(`${getApiBase()}/api/me/modules`);
      return res.modules;
    },
  });
}
