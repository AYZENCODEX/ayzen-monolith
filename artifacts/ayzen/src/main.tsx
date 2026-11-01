import "./lib/api-routing-boot";
import { createRoot } from "react-dom/client";
import App from "./App";
import { initPosthog } from "./lib/posthog";
import "./index.css";

initPosthog();

createRoot(document.getElementById("root")!).render(<App />);
