# ORIGINVAULT

Static frontend for the ORIGINVAULT media-integrity application.

## Hosting

This repository is prepared for a Render Static Site using the included `render.yaml` Blueprint. The frontend is served from the repository root; there is no framework build step.

## Backend

The application continues to use the existing Supabase project for authentication, private object storage, analysis records, and the `analyze-media` Edge Function. The browser uses a Supabase publishable key. Server-side secrets are not stored in this repository.

## Migration notes

- The original Wix-hosted site remains unchanged as the production fallback.
- This repository is a staging copy. Do not switch the public domain until the Render deployment and Supabase origin/CORS settings have been verified.
- Smaug inference is a separate provider integration and is not deployed by this static-site configuration.
