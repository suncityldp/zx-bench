# ZxBench v0.2.11 — selective runtime preparation and reproducible deployment

New installations can prepare only the images their selected questions need. Public Python, Node and GCC images are pulled by verified frozen digest; five custom runtimes are distributed as separate release assets with SHA-256, byte counts, platform and image identities in `docker/execution-images/runtime.json`. Existing matching images and verified archive caches are reused. The former complete image bundle is not required.

## Deployment changes

- `pnpm runtime:prepare --check` produces a read-only plan. `pnpm runtime:prepare` applies it without interactive prompts, with optional repeated `--dimension`, `--scenario` or `--image` filters and an offline `--cache-dir`.
- A pulled public image is verified before its required local tag is restored. Archives must match the release checksum and size before loading; loaded images must match the expected identity and platform afterward.
- Missing or drifted tags are restored directly from an already-cached frozen ID before any registry or archive download is considered.
- Archive downloads respect HTTP_PROXY/HTTPS_PROXY/NO_PROXY on supported Node versions, including Node 22, without changing global proxy settings or disabling TLS checks.
- Classic/config-ID and containerd/OCI-target-ID differences are diagnosed before unnecessary downloads. The installer does not change Docker's global store, accept another frozen ID or rewrite question hashes.
- Explicit task image contracts are checked before candidate generation. A missing or mismatched image pauses an evaluation using the existing `DOCKER_NOT_READY` recovery path and does not consume a candidate request. Docker sessions launch using the inspected immutable ID, preventing a concurrent tag change from altering their execution image.
- `pnpm setup:env` creates a local `.env` with a random key, preserves existing configuration and never prints the key. The server now resolves PORT/HOST after loading `.env` and health/version APIs report the actual application version.
- `pnpm deploy:check` verifies API versions, frontend HTML/JavaScript assets and the synchronized released bank using only read requests.
- Chinese and English READMEs document a complete ordered deployment, background service startup, bank sync, selective runtime setup, success criteria and upgrade recovery.

## Assets and scope

The custom archives are `cli-verifier.tar`, `python-node.tar`, `workflow.tar`, `bash.tar` and `java.tar`. Python/Node/GCC use public registry digests instead of duplicate release uploads. The manifest is versioned independently of mutable tags; release validation and `SHA256SUMS` identify the uploaded bytes.

Preparation covers explicit question-bank image contracts. It does not claim every language runtime embedded in a grader, mount or network dependency has been exercised. All current frozen execution images were verified on linux/amd64 with the containerd image store. A successful `docker load` alone is not sufficient: actual IDs must still match, particularly across Docker image-store modes.

The application bank remains 803 source questions and 920 execution instances. No question definitions, frozen IDs, old audit snapshots, existing scores or model generation budgets are changed by this release. Saved environment-error results are not automatically rescored. Deployment and release verification use no real candidate-model or Judge requests.

## Validation

The release validation asset records build/regression/deployment test counts, source fingerprint verification, and a fresh database deployment following the documented commands. Optional container tests skipped by the standard suite remain explicitly reported. The fresh deployment validates `.env` port handling, 920 synchronized definitions, the served frontend and eight ready explicit image contracts.
