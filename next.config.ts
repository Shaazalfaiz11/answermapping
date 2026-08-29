import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // pdfjs-dist ships a worker we load from /public; keep it out of the server bundle.
  serverExternalPackages: ["pdfjs-dist"],
  async rewrites() {
    const backendUrl = process.env.NEXT_PUBLIC_BACKEND_URL || process.env.BACKEND_URL;
    if (backendUrl) {
      return [
        {
          source: "/api/:path*",
          destination: `${backendUrl}/api/:path*`,
        },
      ];
    }
    return [];
  },
};

export default nextConfig;

