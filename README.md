![Octo Industries](./Octo-Industries/branding/horizontal-logo.png)

# Octo Industries™ Game Hub

Octo Industries is a touch-friendly game launcher with a Node.js service for the private admin panel and live catalog. The repository-root `index.html` remains the public homepage. The generated catalog still supports static previews, but secure admin access and live publishing require the Node service.

## Run the hub

The project tools and hub source live together in `Octo-Industries/BehindTheScenes/`. In VS Code, open **Run and Debug**, select **Run Game Hub**, and press **F5**. This regenerates the game catalog, starts a local web server from the repository root, and opens the hub in your browser instead of trying to download the HTML file.

To run the public-only static preview, generate the catalog and start a local web server:

```sh
npm --prefix Octo-Industries/BehindTheScenes run sync
python3 -m http.server 8080
```

Open `http://localhost:8080/`. This preview does not provide the private admin API. To run the admin-capable service, generate an admin password hash in an interactive terminal, set the printed hash as `OCTO_ADMIN_PASSWORD_HASH`, and start the Node service:

```sh
npm --prefix Octo-Industries/BehindTheScenes run admin:hash
export OCTO_ADMIN_PASSWORD_HASH='scrypt$...'
npm --prefix Octo-Industries/BehindTheScenes start
```

Open `http://localhost:3000/admin`. Admin state is stored under `.octo-data/` locally; set `OCTO_DATA_DIR` to a persistent directory in hosted deployments. The hash is not the password, and the service refuses to start if it is missing or malformed.

## Discover and add games

`npm --prefix Octo-Industries/BehindTheScenes run sync` reads `game.json` metadata when available and automatically detects top-level game folders with an `index.html`. It validates launch paths and regenerates `Octo-Industries/BehindTheScenes/hub/catalog.js`. Manifest metadata supplies its title, description, category, tags, thumbnail, launch path, optional featured status, and optional screenshot list. If `screenshots` is omitted, supported image files in the game's `screenshots/` folder are added to its hub gallery automatically. Invalid launch or screenshot paths stop the sync with an error.

Add a game directory directly beneath `Octo-Industries/` with an `index.html`; the catalog sync automatically creates a title from the directory name, an `Other` category, basic tags, and a description. For banner art, it prefers the first original screenshot in `screenshots/`, then looks for promotional artwork named `logo`, `cover`, `title`, or `icon` (SVG, PNG, WebP, JPEG). Add `game.json` with a curated `bannerSource` when needed; `bannerFit: "contain"` preserves transparent logo artwork, while the default cover fit fills the shared 16:9 banner. The hub provides a browsable screenshot gallery when local screenshots are available. Generated `hub-banner.svg` files embed their source art, so they load offline at a consistent aspect ratio; games without local artwork use the hub's no-image treatment instead of a fabricated banner. The sync runs locally with `npm --prefix Octo-Industries/BehindTheScenes run sync` and automatically during Render deployment.

## Game projects

- `Octo-Industries/Block-Blast/` — Unity WebGL puzzle game.
- `Octo-Industries/Endless-Siege/` — HTML5 tower defense game.
- `Octo-Industries/Idle-Mining-Empire/` — locally hosted original HTML5 idle-mining game.
- `Octo-Industries/Red-Ball-4/` — locally hosted original Unity WebGL platform game, with offline caching and a local screenshot gallery.
- `Octo-Industries/Subway-Surfers/` — locally hosted original Subway Surfers: New York browser game, with locally stored assets and offline caching.
- `Octo-Industries/Ragdoll-Archers/` — Unity WebGL archery game.
- `Octo-Industries/Stickman-Hook/` — browser-based swinging platform game.
- `Octo-Industries/Tiny-Fishing/` — hub wrapper for the online game at `tiny-fishing.bitbucket.io`; an internet connection is required.
- `Octo-Industries/Toss-The-Turtle/` — Flash game launched locally by the bundled Ruffle player.

The existing `Octo-Industries/BehindTheScenes/` folder contains the hub, scripts, and project configuration alongside the game folders. The playable project folders above are the current copies used by the hub.

Every Play link opens the launch path from the generated catalog as a regular static route. The hub stores recently played game IDs in local browser storage; it does not require an account or send play history to a server.

## Admin panel

The Node service adds a server-authenticated `/admin` control room with password hashing (PBKDF2 or legacy scrypt), expiring HTTP-only sessions, CSRF validation, same-origin checks, login throttling, audit events, and a persistent catalog overlay. Admin actions support editing game metadata, publishing/unpublishing catalog entries, file/metadata checks, and generating a hub HTML build. Only published games appear in the live hub catalog.

The dashboard includes the **Octo AI Game Agent**, powered by Google Gemini 3.1 Flash-Lite by default (override with `OCTO_GEMINI_MODEL`). Google AI Studio's free availability and quotas depend on the selected model and project; rate limits apply, and free-tier terms may allow submitted content to be used to improve Google products. Do not send secrets or sensitive personal information. On the Render Node service, the assistant can prepare code patches and register a game manifest for an existing game folder with an existing launch file. It cannot download game files, modify dependencies or authentication/hosting configuration, or deploy changes. Every proposal is previewed and requires explicit approval before the server opens a GitHub pull request. The PR is never merged or deployed automatically; review its diff and checks on GitHub. The Cloudflare Pages chatbot remains read-only. Configure `GEMINI_API_KEY` and `GITHUB_TOKEN` as Render server-side secrets. Never put either key in browser code or commit it.

The Node deployment's game URL scanner is intentionally a bounded source inspection: it blocks private/reserved IP ranges and non-standard ports, follows only a few redirects, and limits response size and time. The Cloudflare deployment disables external page scanning. Neither version downloads or rewrites games, identifies every runtime dependency, runs browser gameplay tests, verifies rights, or establishes offline readiness. "Offline verified" is only counted when explicitly present in the library data; file health checks do not claim gameplay or offline validation. Full preservation/download workflows, media approval, automated browser tests, and global branding controls are not implemented yet.

The generated standalone hub embeds the current published catalog but uses the site's existing static CSS, JavaScript, and game files; it is not a self-contained bundle. It is available at `/masterstandalone.html` after the admin build job completes.

## Suggestions and issues

The public hub footer and navigation include a no-account inquiry form and a **My Tickets** portal. New submissions receive a sequential ticket number and a private access token saved in that browser; users can check status and reply there. Clearing browser site data removes access, and old anonymous inquiries cannot be claimed retroactively. No name, email, full user agent, or raw IP address is stored. The admin inbox supports ticket conversations, the nine public workflow statuses, priority, private notes, device/browser/OS/language/timezone/screen details, archive/restore, soft delete, and ticket activity history. Admin and portal timestamps display in Bahrain time. Attachments, email notifications, and ticket-specific analytics are not configured yet. Failed admin requests include a request ID that can be matched with the server-side timestamp, endpoint, status, and failure reason in service logs.

Ticket data is stored in the existing Cloudflare D1 database. For a new database, apply `migrations/0001_admin.sql`, `migrations/0002_feedback.sql`, and `migrations/0003_ticketing.sql` in order. Runtime requests only check the existing ticket schema; they never create tables or apply migrations. For a database still on the `0002_feedback.sql` schema, first create and verify a protected D1 export, inspect the live schema and inquiry counts, then apply `migrations/0003_ticketing.sql` through the reviewed deployment procedure. The migration preserves existing messages and private notes, maps statuses to the ticket workflow, and retains old archived inquiries.

## Hosting

The free Cloudflare Pages deployment publishes the static hub and its Functions API. If the `pages.dev` domain is blocked on a device or network, deploy the Node service to Render Free instead. Render Static Sites cannot run the Node admin server; use a **Web Service**. Render Free sleeps after inactivity and its local disk is temporary, so this configuration stores admin changes durably in the existing Cloudflare D1 database through the Cloudflare API. This means the game site itself is served from Render, not `pages.dev`.

To build the Cloudflare Pages assets locally, run `npm run pages:build` from the repository root. The build refreshes the catalog and gzips any oversized static files; if another file cannot fit Cloudflare Pages' 25 MiB per-file limit after compression, the build stops and identifies it. Game files remain static assets. The build excludes server source, tests, and dependencies from the published output.

### Cloudflare Pages setup

1. In the Cloudflare dashboard, create a D1 database named `octo-industries-admin`. Open its SQL console and run `migrations/0001_admin.sql`, followed by `migrations/0002_feedback.sql` and `migrations/0003_ticketing.sql`.
2. Under **Workers & Pages**, create a **Pages** application connected to this GitHub repository. Set the root directory to `/`, the build command to `npm run pages:build`, and the build output directory to `.cloudflare-dist`. Deploy the `main` branch.
3. In the Pages project, open **Settings → Functions → D1 database bindings**. Add a binding named `ADMIN_DB` and select `octo-industries-admin`, save, then redeploy.
4. In **Settings → Variables and Secrets**, add the production secret with key/name `OCTO_ADMIN_PASSWORD_HASH`. Generate it locally with `npm --prefix Octo-Industries/BehindTheScenes run admin:hash` in an interactive terminal. In Cloudflare's **Value** box, paste only the part after `OCTO_ADMIN_PASSWORD_HASH=` (it starts with `pbkdf2$`); never expose or commit the password. Add another secret named `GEMINI_API_KEY` if you want the chatbot enabled. Optionally set `OCTO_GEMINI_MODEL`; the default is `gemini-3.1-flash-lite`.
5. Redeploy after setting the secrets and bindings. Open `https://<your-project>.pages.dev/admin/`; the public hub's **Admin sign in** button points to that panel.

Cloudflare's Free plan has request, compute, D1, build, file-count, and file-size quotas; this is not unlimited hosting. The admin state and sessions are stored in D1. External page scanning is disabled in this deployment. Google Gemini also has project/model-dependent quotas; without a `GEMINI_API_KEY`, the chatbot explains that it is not configured.

### Render Free setup (alternative when Pages is blocked)

1. Create a Cloudflare API token with **D1: Edit** permission scoped to this account. Keep the token secret.
2. In Render, create a **New → Blueprint Instance** connected to this repository and apply `render.yaml`. It includes the main Node service (`octo-industries-hub-web`) and a compatibility redirect service (`octo-industries`) that forwards the old hostname to the main one. If an existing Render service still uses either name, resolve that naming conflict in Render before applying the Blueprint; do not replace or delete the main Node service or Static Site.
3. When prompted, set `OCTO_ADMIN_PASSWORD_HASH` to the generated `pbkdf2$...` hash, `CF_D1_API_TOKEN` to the Cloudflare API token, `GEMINI_API_KEY` to your Google AI Studio key, and `GITHUB_TOKEN` to a fine-grained token scoped only to `nv24191/Personal` with **Contents: Read and write** and **Pull requests: Read and write** permissions. The account and database IDs are already in `render.yaml`. Do not enter the raw admin password, and do not commit secrets.
4. For a new D1 database configured by `CF_D1_DATABASE_ID`, apply `migrations/0001_admin.sql`, `migrations/0002_feedback.sql`, and `migrations/0003_ticketing.sql` in order. An existing database on the `0002_feedback.sql` schema is upgraded automatically on its first ticket request after deployment.
5. Wait for both Node **Web Services** to become Live. The old `https://octo-industries.onrender.com` hostname redirects to `https://octo-industries-hub-web.onrender.com`, preserving the requested path and query string so both entry points use one browser origin and the same persistent D1-backed app. Free services can take about a minute to wake after 15 minutes idle. Catalog edits and activity persist in D1 across sleeps/redeploys. Gemini remains optional and subject to Google's free-tier quota.

Run `npm --prefix Octo-Industries/BehindTheScenes run sync` after changing game metadata or adding a game, then commit the generated `Octo-Industries/BehindTheScenes/hub/catalog.js`. The Cloudflare Pages build runs this sync automatically before deployment.

## Branding assets

The existing artwork in `Octo-Industries/branding/octo-industries-logo-source.jpg` remains the source of truth. The transparent, color-preserving octopus cutout powers the complete logo system:

- `primary-logo.svg` / `.png` — stacked octopus and wordmark for splash screens and branding.
- `horizontal-logo.svg` / `.png` — octopus plus wordmark for hub headers and navigation.
- `home-button.svg` / `.png` — circular, text-free, clickable in-game home mark.
- `icon-only.svg` / `.png` — octopus-only icon for app marks, badges, and metadata.
- `watermark-logo.svg` / `.png` — transparent, text-free watermark artwork.
- `favicon.svg`, `favicon.png`, and `favicon.ico` — browser and app icon sizes, including `apple-touch-icon.png`.

Game pages use the circular home button, linking back to the hub, and a non-interactive icon-only watermark at 15% opacity. The shared corner defaults are configured in `game-branding.js` through `window.OCTO_GAME_BRANDING_CONFIG` (`hubButtonPosition` and `watermarkPosition`); changing them updates every game that loads the shared overlay. Players can still drag the home button to any corner; that personal preference is saved and shared between games. Keyboard users can focus the button and use the arrow keys to change corners. The shared overlay is maintained by `game-branding.css` and `game-branding.js`. Keep the branding directory with the game projects when hosting or packaging the site.

| Logo variant | Preview |
| --- | --- |
| Primary | <img src="./Octo-Industries/branding/primary-logo.png" width="90" alt="Primary Octo Industries logo"> |
| Circular home button | <img src="./Octo-Industries/branding/home-button.png" width="64" alt="Circular Octo Industries home button"> |
| Icon only | <img src="./Octo-Industries/branding/icon-only.png" width="64" alt="Octo Industries icon"> |
| Watermark | <img src="./Octo-Industries/branding/watermark-logo.png" width="64" alt="Octo Industries watermark"> |
| Horizontal hub logo | <img src="./Octo-Industries/branding/horizontal-logo.png" width="160" alt="Horizontal Octo Industries logo"> |
