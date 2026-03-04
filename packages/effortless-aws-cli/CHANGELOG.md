# @effortless-aws/cli

## 0.3.0

### Minor Changes

- [`1bce89f`](https://github.com/kondaurovDev/effortless-aws/commit/1bce89fa5f7e132cd984579d0c41656fd7d9f1ae) Thanks [@kondaurovDev](https://github.com/kondaurovDev)! - Remove defineHttp, migrate defineApi to Lambda Function URLs, rewrite documentation

### Patch Changes

- Updated dependencies [[`1bce89f`](https://github.com/kondaurovDev/effortless-aws/commit/1bce89fa5f7e132cd984579d0c41656fd7d9f1ae)]:
  - effortless-aws@0.19.0

## 0.2.3

### Patch Changes

- [`0a0c4e7`](https://github.com/kondaurovDev/effortless-aws/commit/0a0c4e7fb362fb1c9f288b618e6949633c532108) Thanks [@kondaurovDev](https://github.com/kondaurovDev)! - fix: exclude AWS runtime packages (@aws-sdk/_, @smithy/_, @aws-crypto/_, @aws/_) from Lambda layer and lockfile hash

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
