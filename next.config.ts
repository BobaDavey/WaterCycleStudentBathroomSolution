import type { NextConfig } from "next";
import { validateDeploymentBuild } from "./src/lib/database-policy";
validateDeploymentBuild(process.env);
const codespaceOrigin = process.env.CODESPACE_NAME
  ? `${process.env.CODESPACE_NAME}-3000.${process.env.GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN || "app.github.dev"}`
  : null;
const nextConfig: NextConfig = {
  allowedDevOrigins: ["127.0.0.1", "localhost", ...(codespaceOrigin ? [codespaceOrigin] : [])],
  distDir: process.env.NEXT_DIST_DIR || ".next",
  serverExternalPackages: ["@electric-sql/pglite", "pg"],
  poweredByHeader: false,
  async headers() {
    return [{ source: "/:path*", headers: [
      { key: "X-Content-Type-Options", value: "nosniff" },
      { key: "X-Frame-Options", value: "DENY" },
      { key: "Referrer-Policy", value: "same-origin" },
      { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" }
    ] }];
  }
};
export default nextConfig;
