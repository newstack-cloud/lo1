# Changelog

## [0.6.0](https://github.com/newstack-cloud/lo1/compare/cli/v0.5.1...cli/v0.6.0) (2026-11-18)


### Features

* **cli:** link to the troubleshooting page from lo1 doctor ([f49eb2f](https://github.com/newstack-cloud/lo1/commit/f49eb2f390cc65b780609f3b325dc8f8cea757b9))


### Bug Fixes

* **cli:** fix type error in hosts file write ([a0b474a](https://github.com/newstack-cloud/lo1/commit/a0b474ae28fdae8b352e43c5825079986af9ae47))

## [0.5.1](https://github.com/newstack-cloud/lo1/compare/cli/v0.5.0...cli/v0.5.1) (2026-11-18)


### Bug Fixes

* **cli:** trust the local CA in browsers on Linux and elevate hosts writes on Windows ([83bf947](https://github.com/newstack-cloud/lo1/commit/83bf9471a9b308e753813286d5c7ee0edc2540ec))

## [0.5.0](https://github.com/newstack-cloud/lo1/compare/cli/v0.4.0...cli/v0.5.0) (2026-11-17)


### Features

* **cli:** add lo1 doctor and fail lo1 up early on port conflicts ([e7d3f68](https://github.com/newstack-cloud/lo1/commit/e7d3f6816bdc143d507f55a5756cc5b028268ff8))
* **cli:** add lo1 restart and follow plugin watchForChanges ([53cccf4](https://github.com/newstack-cloud/lo1/commit/53cccf4bd06f7baa8a51f822b5836d57b02aea67))
* **cli:** detach dev processes, load the workspace .env, require Node 24 ([2f3cd1d](https://github.com/newstack-cloud/lo1/commit/2f3cd1d454f15ccf936085671e861e2257b078cc))
* **cli:** make lo1 up and lo1 status dependable for scripts and agents ([6f8cadb](https://github.com/newstack-cloud/lo1/commit/6f8cadb2aec17cd28fc0399c28600a98519cfa70))


### Bug Fixes

* **cli:** create the workspace network when no infrastructure does ([501022e](https://github.com/newstack-cloud/lo1/commit/501022e2c5a2ea659a4877cc64d793f7389f892d))
* **cli:** honour hostPort, service preStop hooks and container-only compose files ([62b2df5](https://github.com/newstack-cloud/lo1/commit/62b2df5794ecb45950bd0348db427f8cbed12295))
* **cli:** keep existing extra_hosts when adding the host gateway mapping ([f93b819](https://github.com/newstack-cloud/lo1/commit/f93b81914be93ec1bcbb37c5872f2298ec90dfd3))
* **cli:** leave the hosts file alone and skip sudo when the proxy is disabled ([33edf27](https://github.com/newstack-cloud/lo1/commit/33edf2751cb47c26727a6306204a406dbb88b942))
* **cli:** make lo1 status, restarts and the workspace lock hold up under review ([50af91e](https://github.com/newstack-cloud/lo1/commit/50af91ebfcd9f496eeb81ce3b7ef9e1b5a2bcd13))
* **cli:** make restarts safe to repeat, run concurrently and interrupt ([6d0f7ac](https://github.com/newstack-cloud/lo1/commit/6d0f7ac2d6b1d175a2df9c1e872075cc244517a3))
* **cli:** publish a plugin container's port where discovery advertises it ([00e500c](https://github.com/newstack-cloud/lo1/commit/00e500c39b24083f74191601370640ad3eee45c0))
* **cli:** put compose-file services on the workspace network ([d516b52](https://github.com/newstack-cloud/lo1/commit/d516b526f069a0d97d39b833237d0d053efcef6e))
* **cli:** restart from the recorded process when lo1 restart replaced a watched service ([3e4f0d8](https://github.com/newstack-cloud/lo1/commit/3e4f0d88799ccdf53c3a6a895f4ed61431ecf062))
* **cli:** show each line of a service's output with its own prefix ([971dc2e](https://github.com/newstack-cloud/lo1/commit/971dc2e4d05131f47a1ed549b2a08aa33f645a2d))
* **cli:** start init tasks and container services in dependency order ([9fab5fd](https://github.com/newstack-cloud/lo1/commit/9fab5fd6db88d4e603120dc58cb47bb3e6ddfe1e))
* **cli:** stop compose from re-running lo1 services a compose service depends on ([64505ac](https://github.com/newstack-cloud/lo1/commit/64505ac863461182c677f7c1da8c129e8155cef8))


### Dependencies

* **repo:** fix high severity audit findings ([92c4001](https://github.com/newstack-cloud/lo1/commit/92c400143f2c11f536005f8cd58ec6763887bdbf))

## [0.4.0](https://github.com/newstack-cloud/lo1/compare/cli/v0.3.0...cli/v0.4.0) (2026-08-24)


### Features

* **cli:** add support for real public tls certs ([6a49c72](https://github.com/newstack-cloud/lo1/commit/6a49c723b6425558195e961e941debeaa67a8b00))

## [0.3.0](https://github.com/newstack-cloud/lo1/compare/cli/v0.2.3...cli/v0.3.0) (2026-07-01)


### Features

* **cli:** add support for multiple domains for a single service ([fb89e01](https://github.com/newstack-cloud/lo1/commit/fb89e01069b72fb06b08c612fcad219ccb65e5eb))


### Bug Fixes

* **cli:** add missing licenses and use dynamic version from package manifest ([6468252](https://github.com/newstack-cloud/lo1/commit/6468252db451f5a70ea98741f1583627ea13c23d))

## [0.2.3](https://github.com/newstack-cloud/lo1/compare/cli/v0.2.2...cli/v0.2.3) (2026-02-16)


### Bug Fixes

* **cli:** add fix for internal package dependencies ([f56adf0](https://github.com/newstack-cloud/lo1/commit/f56adf056649ff79d7e14a00f29a985849dafd7f))

## [0.2.2](https://github.com/newstack-cloud/lo1/compare/cli/v0.2.1...cli/v0.2.2) (2026-02-16)


### Bug Fixes

* **cli:** add missing repository information for provenance ([4e19625](https://github.com/newstack-cloud/lo1/commit/4e1962536d584d82e09c49f26f00b3fbb8d124c0))

## [0.2.1](https://github.com/newstack-cloud/lo1/compare/cli/v0.2.0...cli/v0.2.1) (2026-02-16)


### Bug Fixes

* **cli:** bump up from broken release ([156accf](https://github.com/newstack-cloud/lo1/commit/156accf077f1ecf5d23b5547eeea2fea41991529))

## [0.2.0](https://github.com/newstack-cloud/lo1/compare/cli/v0.1.0...cli/v0.2.0) (2026-02-16)


### Features

* **cli:** add config loader, dependency graph builder and repo initialisation ([f11a1bf](https://github.com/newstack-cloud/lo1/commit/f11a1bf6fbaf20ecd4dd5ec7bf50b8db08f3e9a5))
* **cli:** add functionality for compose, domain and tls setup ([b6b247e](https://github.com/newstack-cloud/lo1/commit/b6b247e4df1b8daabe8dcd96bc8684db189a0f0d))
* **cli:** add plugin loader, service discovery and service execution ([20312f7](https://github.com/newstack-cloud/lo1/commit/20312f77dcbf562fda969ab19f22e643486455d6))
* **cli:** add status command, debug logs and error handling ([5b48727](https://github.com/newstack-cloud/lo1/commit/5b48727ac33381c6c5a2b8cba473538eab771d76))
* **cli:** complete initial orchestration functionality ([32a204f](https://github.com/newstack-cloud/lo1/commit/32a204f48f39440ffe4c79b5462f7e2047c0f943))
* **cli:** implement the orchestration layer for a workspace ([7549d42](https://github.com/newstack-cloud/lo1/commit/7549d42ea499ae2e97540b944c23fd1dad12747b))
