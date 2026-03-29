# Cloud Build setup (GitHub → Artifact Registry → Cloud Run)

Project example: `freenotes-491520`. Repo: [jkjaeschke/Jnotes](https://github.com/jkjaeschke/Jnotes).

## Prerequisites

- [Billing](https://console.cloud.google.com/billing?project=freenotes-491520) enabled on the project.
- [APIs enabled](https://console.cloud.google.com/apis/dashboard?project=freenotes-491520): Cloud Build, Artifact Registry, Cloud Run, Secret Manager, Firestore (and Storage if you use GCS). Running `./infra/gcp/setup.sh` enables most of these.
- [Firestore](https://console.cloud.google.com/firestore?project=freenotes-491520) in Native mode (create database if needed).
- Secrets in [Secret Manager](https://console.cloud.google.com/security/secret-manager?project=freenotes-491520):
  - `SESSION_SECRET` — long random string.
  - `GOOGLE_CLIENT_ID` — OAuth **Web client** ID (same value you use for `_VITE_GOOGLE_CLIENT_ID` on the trigger).

## One-time: IAM for Cloud Build

From the repo root (after `./infra/gcp/setup.sh` so `freenotes-api@…` exists):

```bash
gcloud config set project freenotes-491520
./infra/gcp/iam-cloud-build.sh
```

This grants the default Cloud Build service account (`PROJECT_NUMBER@cloudbuild.gserviceaccount.com`) permission to push images, deploy Cloud Run, read secrets, and attach the runtime service account `freenotes-api@freenotes-491520.iam.gserviceaccount.com`. It also grants the **Cloud Build P4SA** (`service-PROJECT_NUMBER@gcp-sa-cloudbuild.iam.gserviceaccount.com`) `roles/secretmanager.admin`, which is **required** so Google can store the GitHub OAuth token when you create a GitHub connection.

## Connect GitHub (CLI) and finish the trigger

1. Create a connection (prints an OAuth URL — open it in your browser and sign in to GitHub):

   ```bash
   gcloud config set project freenotes-491520
   gcloud builds connections create github jnotes-github --region=us-central1
   ```

2. In GitHub, **install the Google Cloud Build** app for your account/org and grant access to **jkjaeschke/Jnotes** when prompted.

3. Wait until the connection reaches `COMPLETE`:

   ```bash
   gcloud builds connections describe jnotes-github --region=us-central1 \
     --format='value(installationState.stage)'
   ```

4. Link the repo and create the push trigger (reads `GOOGLE_CLIENT_ID` from Secret Manager for `_VITE_GOOGLE_CLIENT_ID`):

   ```bash
   ./infra/gcp/finish-github-setup.sh
   ```

## Connect GitHub and create a trigger (console)

1. Open [Cloud Build → Repositories / Connections](https://console.cloud.google.com/cloud-build/repositories/2nd-gen?project=freenotes-491520) (or **Triggers** → **Connect repository**).
2. Connect **GitHub** (install the Google Cloud Build app for your org/user if prompted).
3. Select the repository **jkjaeschke/Jnotes** and the branch you want (e.g. `main`).
4. Create a **trigger**:
   - **Event:** Push to a branch → `main` (or your default branch).
   - **Configuration:** Cloud Build configuration file (yaml or json).
   - **Location:** Repository root, file `cloudbuild.yaml`.
5. **Substitution variables** (required for the web build):
   - `_VITE_GOOGLE_CLIENT_ID` = your OAuth Web client ID (must match Secret `GOOGLE_CLIENT_ID`).

   Optional overrides:

   | Variable              | Default (in `cloudbuild.yaml`)   |
   |-----------------------|----------------------------------|
   | `_REGION`             | `us-central1`                    |
   | `_SERVICE`            | `freenotes-api`                  |
   | `_AR_REPO`            | `freenotes`                      |
   | `_GCS_BUCKET`         | `freenotes-491520-freenotes-data` |

6. Save the trigger.

## OAuth client (after first successful deploy)

1. Open [Cloud Run](https://console.cloud.google.com/run?project=freenotes-491520) and copy the **HTTPS URL** of `freenotes-api`.
2. In [Google Cloud Console → APIs & Services → Credentials](https://console.cloud.google.com/apis/credentials?project=freenotes-491520), edit your OAuth **Web client**.
3. Under **Authorized JavaScript origins**, add that URL (scheme + host only, no path).

## Verify

Push a commit to `main` and open [Cloud Build history](https://console.cloud.google.com/cloud-build/builds?project=freenotes-491520). A green build should end with a new Cloud Run revision and the app at the service URL.

## Manual build (optional)

```bash
gcloud config set project freenotes-491520
gcloud builds submit --config=cloudbuild.yaml \
  --substitutions=_VITE_GOOGLE_CLIENT_ID=YOUR_CLIENT_ID.apps.googleusercontent.com
```

`.gcloudignore` reduces upload size for `gcloud builds submit`; GitHub triggers clone the full repository.
