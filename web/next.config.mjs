/** @type {import('next').NextConfig} */
const noindex = { key: "X-Robots-Tag", value: "noindex, nofollow" };
export default {
  outputFileTracingRoot: import.meta.dirname,
  async headers() {
    return [{ source: "/:path*", headers: [noindex] }];
  },
};
