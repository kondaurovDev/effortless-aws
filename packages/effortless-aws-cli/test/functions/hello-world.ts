import { defineApi } from "effortless-aws";

export default defineApi()({
  basePath: "/hello",
  routes: [
    {
      path: "GET /",
      onRequest: async ({ req }) => ({
        status: 200,
        body: { message: "Hello World!!!", path: req.path },
      }),
    },
  ],
});
