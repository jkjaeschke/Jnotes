#!/usr/bin/env bash
# Grant the default Cloud Build service account permission to build, push, deploy, and use secrets.
# Run once per project after ./infra/gcp/setup.sh (so freenotes-api@… exists).
#
#   export PROJECT_ID=freenotes-491520
#   ./infra/gcp/iam-cloud-build.sh
set -euo pipefail

PROJECT_ID="${PROJECT_ID:-$(gcloud config get-value project 2>/dev/null)}"
REGION="${REGION:-us-central1}"
AR_REPO="${AR_REPO:-freenotes}"

if [[ -z "${PROJECT_ID}" || "${PROJECT_ID}" == "(unset)" ]]; then
  echo "Set PROJECT_ID or run: gcloud config set project YOUR_PROJECT"
  exit 1
fi

PROJECT_NUMBER="$(gcloud projects describe "${PROJECT_ID}" --format='value(projectNumber)')"
CB_SA="${PROJECT_NUMBER}@cloudbuild.gserviceaccount.com"
RUN_SA="freenotes-api@${PROJECT_ID}.iam.gserviceaccount.com"

echo "Project: ${PROJECT_ID}"
echo "Cloud Build SA: ${CB_SA}"
echo "Cloud Run runtime SA: ${RUN_SA}"
echo ""

bind_project_role() {
  local role="$1"
  echo "Grant ${role} to Cloud Build…"
  gcloud projects add-iam-policy-binding "${PROJECT_ID}" \
    --member="serviceAccount:${CB_SA}" \
    --role="${role}" \
    --quiet
}

# Deploy Cloud Run revisions
bind_project_role "roles/run.admin"

# Push images to Artifact Registry
bind_project_role "roles/artifactregistry.writer"

# Attach secrets to Cloud Run (--set-secrets)
bind_project_role "roles/secretmanager.secretAccessor"

# Act as the runtime service account when deploying Cloud Run
echo "Grant iam.serviceAccountUser on ${RUN_SA} to Cloud Build…"
gcloud iam service-accounts add-iam-policy-binding "${RUN_SA}" \
  --member="serviceAccount:${CB_SA}" \
  --role="roles/iam.serviceAccountUser" \
  --project="${PROJECT_ID}" \
  --quiet

echo ""
echo "Done. Next: create a Cloud Build trigger (see infra/gcp/CLOUD_BUILD.md)."
