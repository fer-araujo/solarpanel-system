import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClientProvider } from "@tanstack/react-query";
import { App } from "./app/App";
import { createQueryClient } from "./api/queries";
import { AuthGate } from "./features/auth/AuthGate";
import "./ui/tokens/theme.css";

const host = document.getElementById("root");
if (!host) throw new Error("Root element #root not found");

createRoot(host).render(
  <StrictMode>
    <QueryClientProvider client={createQueryClient()}>
      <AuthGate>
        <App />
      </AuthGate>
    </QueryClientProvider>
  </StrictMode>,
);
