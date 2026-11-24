import { createContext, useContext } from "react";

/** True inside <SyloShell>. Console kit components switch to the Sylo look when set. */
export const InSylo = createContext(false);
export const useInSylo = () => useContext(InSylo);
