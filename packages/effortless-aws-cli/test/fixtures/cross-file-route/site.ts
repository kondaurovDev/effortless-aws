import { defineStaticSite } from "effortless-aws";
import { siteApi2 } from "./api";

// Reproduces the bug: API handler imported from another file
// is not found via reference equality in extractStaticSiteRoutes
export const crossFileSite = defineStaticSite({ dir: "site" })
  .route("/site-api/*", siteApi2)
  .build();
