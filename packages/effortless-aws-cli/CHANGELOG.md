# @effortless-aws/cli

## 0.2.2

### Patch Changes

- [`f82734a`](https://github.com/kondaurovDev/effortless-aws/commit/f82734a3afa4bd68ad1e260ee0403cb8de65d5bc) Thanks [@kondaurovDev](https://github.com/kondaurovDev)! - fix: switch Lambda Function URL to AuthType NONE to fix POST requests through CloudFront OAC

## 0.2.1

### Patch Changes

- [`b14cdb8`](https://github.com/kondaurovDev/effortless-aws/commit/b14cdb874e2f5cdbf04f05e7c2594a0c2b4625a3) Thanks [@kondaurovDev](https://github.com/kondaurovDev)! - fix: expand CloudFront route patterns so `/prefix/*` also covers bare `/prefix` path

- [`e08d8cd`](https://github.com/kondaurovDev/effortless-aws/commit/e08d8cdf28e33486e1126d85bd94b45e90a03106) Thanks [@kondaurovDev](https://github.com/kondaurovDev)! - Warn about TypeScript entry points in production dependencies that cause ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING at runtime; show dependency warnings in `eff status` output; fail deploy early when a handler deps key references a missing table/bucket/mailer handler

## 0.2.0

### Minor Changes

- [`cf986fa`](https://github.com/kondaurovDev/effortless-aws/commit/cf986fa18b24eee8d503b6c9bdb02805178a4973) Thanks [@kondaurovDev](https://github.com/kondaurovDev)! - Add `root` config option for monorepo support, add `routes` to `defineApp` for CloudFront→API Gateway proxying, add `cleanup --orphaned` flag, add dependency warnings in layer commands, compact CLI help output with better descriptions, refactor config loading to Effect and introduce ProjectConfig service

### Patch Changes

- Updated dependencies [[`cf986fa`](https://github.com/kondaurovDev/effortless-aws/commit/cf986fa18b24eee8d503b6c9bdb02805178a4973)]:
  - effortless-aws@0.18.0

## 0.1.1

### Patch Changes

- [`175e517`](https://github.com/kondaurovDev/effortless-aws/commit/175e5172cbd4c463a810e663a670461e1d8cc2f9) Thanks [@kondaurovDev](https://github.com/kondaurovDev)! - Add README

- Updated dependencies [[`477f35e`](https://github.com/kondaurovDev/effortless-aws/commit/477f35e6269c82c7b1372129b3c9f9542c027030)]:
  - effortless-aws@0.17.0
