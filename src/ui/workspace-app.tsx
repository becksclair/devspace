// Entry point of the DevSpace workspace card widget (MCP Apps resource).

import { createRoot } from "react-dom/client";
import { WorkspaceApp } from "./workspace-root.js";
import "./workspace-app.css";

const root = document.querySelector<HTMLElement>("#app");
if (!root) throw new Error("Missing #app root element.");

createRoot(root).render(<WorkspaceApp />);
