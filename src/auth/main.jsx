import React from "react";
import { createRoot } from "react-dom/client";
import AccountAuth from "./AccountAuth.jsx";
import "./auth-ui.css";

const mount = document.querySelector("#auth-app");

if (mount) {
  createRoot(mount).render(<AccountAuth />);
}
