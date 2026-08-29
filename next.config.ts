import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  eslint: { ignoreDuringBuilds: true },
  // pdfjs-dist ships a worker we load from /public; keep it out of the server bundle.
  serverExternalPackages: ["pdfjs-dist"],
};

export default nextConfig;
