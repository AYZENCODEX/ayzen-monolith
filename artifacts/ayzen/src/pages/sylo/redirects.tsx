/** Route component that exists only to keep a retired URL working. */
import { Redirect } from "wouter";
import { SYLO_HOME } from "@/lib/sylo-routes";

/** /vault/hub was the old card grid; the Console is its replacement. */
export default function VaultHubRedirect() {
  return <Redirect to={SYLO_HOME} replace />;
}
