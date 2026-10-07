# Self-hosted preview installation

This guide is for the local AI assistant performing the installation, as well as users who prefer manual setup. Use the files from the **same published release** at https://github.com/waooAI/waoowaoo/releases. Preview releases may not appear under GitHub's “latest stable” link.

## 1. Inspect the machine and choose a release

Check the OS, architecture, available disk/memory, existing containers, and occupied ports. Use a new directory and Compose project for a new install. Do not overwrite an existing `.env` or initialize an existing database as if it were empty.

Required host tools:

- Docker Engine or Docker Desktop, running Linux containers, with Docker Compose 2.24.4 or newer (including v5), supporting the `!reset` merge tag.
- Git and a POSIX shell.
- `flock`, required by the existing Worker rollout script. Linux typically provides it through `util-linux`; on macOS install a compatible `flock` package. Windows users should run the guide inside WSL2 with Docker Desktop integration.

Use official OS installation instructions and obtain administrator approval when required. A coding assistant cannot bypass OS prompts, Docker Desktop startup, or virtualization requirements. Docker socket access allows the application to create its per-project Assistant containers; use a trusted local installation.

Prebuilt images must support the host architecture. Verify the release image manifests; do not silently substitute emulation or an unrelated tag. If a required image is unavailable, stop and report it or explicitly choose the source-build path below.

Clone the public repository at the chosen release tag, or extract its source archive. The installed directory must include `.env.example`, both Compose files, `docker/caddy/Caddyfile`, and `scripts/temporal/worker-rollout.sh`. Do not mix files from `main` with an older release.

## 2. Configure the local environment

Copy `.env.example` to `.env` only for a new installation. Read every variable and replace placeholder credentials with distinct cryptographically random secrets. Never print the final `.env`, upload it, or include it in support logs. Keep it readable only by the installing account.

The default release path starts only the Web container and keeps MySQL,
Redis, Temporal, RustFS/S3 and the Temporal Worker external. Copy the example
file without filling infrastructure secrets; the Web container generates its
bootstrap secrets in `./data` and prints a one-time setup token.

Set at least:

| Setting | Value |
| --- | --- |
| `COMPOSE_FILE` | `docker-compose.yml:docker-compose.web.yml` |
| `COMPOSE_PATH_SEPARATOR` | `:` (run in a POSIX shell, including WSL2) |
| `DEPLOYMENT_EDITION` | `self-hosted` |
| `APP_IMAGE` | Optional when the Web overlay builds `Dockerfile` locally |
| `DOCKER_SOCKET_PATH` | Optional; omit it to keep Codex disabled until Docker is available |

When using published images, use the release's verified immutable references,
not the all-zero digests in the example file and not a mutable `latest`
reference. The default Web-only overlay builds the Web and local Codex Runtime
images from the release snapshot; Compose does not run the Runtime image as a
long-lived service.

The self-hosted overlay starts Caddy with the application and derives the application's `NEXTAUTH_URL` from `SELF_HOSTED_HOST` and `SELF_HOSTED_HTTPS_PORT`. Do not separately set a different browser origin for this release path. Caddy terminates HTTPS and forwards to `http://app:3000`; container-internal application traffic remains HTTP. Keep using the configured hostname in the browser so it matches the certificate and authentication origin.

Do not add a minimal bootstrap secret to the environment. During first boot open
`/setup?token=...` using the token printed by the Web container and enter the
external service URLs, the first administrator account, and optional Runtime
limits. The setup form tests MySQL, pushes the schema, creates the administrator,
and stores the encrypted configuration. Restart the Web container after saving;
MySQL changes made later also require a restart, while Redis, Temporal and S3
changes hot-reload.

MySQL credentials are entered in `/setup` or the administrator's personal
center, then encrypted under `./data`; they are no longer required in `.env`.

The runtime directory must refer to the same host path from both Docker and the application container. For Docker Desktop, ensure that path is shareable with Docker. Do not use a temporary directory for durable projects.

## 3. Start using the existing bootstrap entry

Run from the installation directory after copying `.env.example` to `.env`:

```sh
# Validate without printing the resolved configuration (which contains secrets).
docker compose config --quiet
# Build the Web image and run the only long-lived Compose service.
docker compose up -d --build
docker compose ps -a
```

Follow the printed setup URL. The Web process also attempts to build or reuse
the local Codex Runtime image with a source fingerprint; a failed build leaves
the settings and ordinary Web features usable and marks Codex unavailable.
Temporal Workers remain an independent deployment and read the shared encrypted
configuration file when it is mounted. To opt into the bundled MySQL/Redis/
Temporal/MinIO/Caddy stack, use `docker-compose.self-hosted.yml` and the legacy
immutable-image variables described below.

Inspect failing container logs without disclosing secrets. Confirm initialization services exited successfully, long-running services are healthy, and the Worker version is current. Complete certificate trust and browser verification below before considering installation successful.

The Web-only default is available at `http://localhost:13000` (or the
`APP_HOST_PORT` you chose). The following Caddy certificate and HTTP/2 checks
apply only when you explicitly select `docker-compose.self-hosted.yml`.

### Optional: trust the self-hosted Caddy certificate

Caddy creates a local certificate authority. Trust inside its container does not automatically apply to your browser's host. Export **only its public root certificate** to a new local directory:

```sh
certificate_export_dir=$(mktemp -d)
docker compose cp caddy:/data/caddy/pki/authorities/local/root.crt "$certificate_export_dir/root.crt"
```

The AI installer must explain that trusting this CA changes the host's certificate trust, identify the certificate from this installation, and obtain the user's **explicit approval** before importing it. Show its certificate fingerprint for confirmation. Never export `root.key`, copy the whole CA directory, disable TLS verification, or use the browser's certificate-warning bypass as a successful installation.

| Browser host | Trust step after approval |
| --- | --- |
| macOS | Import `root.crt` into Keychain Access and explicitly trust this certificate for SSL; approve any required system prompt. |
| Linux | Use the distribution's CA installation procedure, such as `update-ca-certificates` on Debian/Ubuntu or `update-ca-trust` on Fedora, and check the browser's trust settings. |
| Windows | Import `root.crt` into the intended Windows user's Trusted Root Certification Authorities store; obtain administrator approval if using the machine-wide store instead. |
| Windows browser with installation in WSL2 | Export in WSL, then import the public certificate into Windows. Trusting WSL's Linux store alone does not trust it in a Windows browser. |

A browser with a separate certificate store may need its own import. See [Caddy's Docker certificate guidance](https://caddyserver.com/docs/running#local-https-with-docker). Keep the certificate private key in Caddy's persistent storage; never attach it to support requests.

### Optional: verify the Caddy browser connection

Open **https://localhost:1443** without a certificate warning. `http://localhost:13000` should redirect there while preserving the path. If you changed the host or ports, use the configured values instead.

In browser developer tools, enable the Network panel's **Protocol** column and reload. Verify that requests to the application, including its event streams, use **`h2`**. An HTTPS address or a successful command-line request alone does not prove the browser negotiated HTTP/2.

Open several application tabs and verify that navigation and event updates remain responsive while streams are open. Multiple SSE subscriptions are transport connections, not additional AI generation slots; this check neither changes nor measures the configured AI task concurrency limit. Do not launch paid jobs just to fill tabs.

Then sign in/register and configure OpenRouter under the profile's API configuration. Verify a non-generating conversation only after the user has configured credentials and agreed to any conversation API charges. Ask before paid media generation.

No public IP, domain, public MinIO endpoint, or tunnel is required for supported inline image-reference requests. AI APIs still require Internet access and provider funds.

## 4. Backups and updates

Back up the database, MinIO volume, `data` directory, runtime host directory, and `.env` secrets before upgrading. Preserve the `caddy_data` and `caddy_config` named volumes mounted at `/data` and `/config`; deleting them can replace the CA already trusted by users. Treat any backup of Caddy's private state as secret material, not a certificate export. Restoring only media or only the database is not a complete recovery plan. Never run `docker compose down -v` as an upgrade.

Read the target release's migration notes first. An old installation may require an explicit migration; do not run `db:push --accept-data-loss` or assume an early preview database can be upgraded without review.

For a versioned Worker upgrade, keep the current slot running. Configure the idle slot with the new application digest, a new unique build ID, and replicas `1`, then:

```sh
sh scripts/temporal/worker-rollout.sh promote green
# After promotion succeeds, set APP_IMAGE to the new digest and update Web.
docker compose up -d
sh scripts/temporal/worker-rollout.sh status
# Only after the old version reports drained, persist blue replicas=0 in .env:
sh scripts/temporal/worker-rollout.sh retire blue
```

Alternate blue and green on subsequent upgrades. The same env file, Compose file set, and project name must be used throughout. Follow the release notes for runtime image updates; do not terminate active Assistant containers blindly.

## 5. Optional: build from source

For a customized release, build **both** `Dockerfile` and `Dockerfile.codex-runtime`, publish them to a registry you control, and resolve their immutable digests. Feed those digests into the same installation process above. The versioned Compose path uses immutable images and does not build Worker slots from a local source directory.

For a local Web-only image, prebuild the project-scoped Codex runtime before
starting Compose. The image name must match `CODEX_RUNTIME_IMAGE` in the Web
overlay environment:

```sh
CODEX_RUNTIME_BUILD_IMAGE=waoowaoo-codex-runtime:local npm run runtime:codex:build
docker compose -f docker-compose.yml -f docker-compose.web.yml up -d
```

For source development, install Node.js 22+ and npm, create and configure `.env`, set `NEXTAUTH_URL=http://localhost:3001`, then run:

```sh
npm ci
npm run dev
```

The existing development launcher builds its Docker images and initializes dependencies before starting the application and Worker. This development path continues to use **http://localhost:3001**; the release Compose HTTPS default does not change `npm run dev`. Use a separate development project and database; do not point it at a versioned release's Temporal namespace. Source builds are slower and are not the default end-user installation path.
