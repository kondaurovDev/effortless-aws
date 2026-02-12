import { defineSite } from "effortless-aws";

export const docs = defineSite({
  path: "/",
  dir: "dist",
  build: "pnpm run build",
  spa: false,
});
