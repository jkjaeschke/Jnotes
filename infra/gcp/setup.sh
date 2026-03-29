#!/usr/bin/env bash
# One-time GCP provisioning for FreeNotes (adjust names/region as needed).
# Prerequisites: gcloud CLI, billing enabled, owner/editor on the project.
set -euo pipefail

PROJECT_ID="${PROJECT_ID:-$(gcloud config get-value project 2>/dev/null)}"
REGION="${REGION:-us-central1}"
BUCKET="${BUCKET:-${PROJECT_ID}-freenotes-data}"
SA="freenotes-api@${PROJECT_ID}.iam.gserviceaccount.com"
AR_REPO="${AR_REPO:-freenotes}"

if [[ -z "${PROJECT_ID}" || "${PROJECT_ID}" == "(unset)" ]]; then
  echo "Set PROJECT_ID or run: gcloud config set project YOUR_PROJECT"
  exit 1
fi

gcloud config set project "${PROJECT_ID}"

gcloud services enable \
  run.googleapis.com \
  firestore.googleapis.com \
  storage.googleapis.com \
  secretmanager.googleapis.com \
  artifactregistry.googleapis.com \
  cloudbuild.googleapis.com \
  iamcredentials.googleapis.com

gcloud artifacts repositories describe "${AR_REPO}" --location="${REGION}" &>/dev/null || \
  gcloud artifacts repositories create "${AR_REPO}" \
    --repository-format=docker \
    --location="${REGION}" \
    --description="FreeNotes images"

gsutil mb -p "${PROJECT_ID}" -l "${REGION}" "gs://${BUCKET}" 2>/dev/null || true

gcloud iam service-accounts describe "${SA}" &>/dev/null || \
  gcloud iam service-accounts create freenotes-api \
    --display-name="FreeNotes API"

gcloud projects add-iam-policy-binding "${PROJECT_ID}" \
  --member="serviceAccount:${SA}" \
  --role="roles/secretmanager.secretAccessor" --quiet || true

gcloud projects add-iam-policy-binding "${PROJECT_ID}" \
  --member="serviceAccount:${SA}" \
  --role="roles/datastore.user" --quiet || true

gsutil iam ch "serviceAccount:${SA}:objectAdmin" "gs://${BUCKET}" 2>/dev/null || true

echo ""
echo "Done base setup for project ${PROJECT_ID}."
echo "Next steps (manual):"
echo "  1) Create Firestore database (Native mode) in this project if you have not."
echo "  2) Deploy composite indexes: gcloud firestore indexes create --project=${PROJECT_ID} (or use firestore.indexes.json from repo root)."
echo "  3) Secret Manager: SESSION_SECRET, GOOGLE_CLIENT_ID (optional: ALLOWLIST_EMAILS via --set-env-vars on deploy)."
echo "  4) Cloud Build: ./infra/gcp/iam-cloud-build.sh then follow infra/gcp/CLOUD_BUILD.md (GitHub trigger + _VITE_GOOGLE_CLIENT_ID)."
echo "     Or deploy once with: ./infra/gcp/deploy-cloud-run.sh"
echo "  5) After deploy, add the Cloud Run HTTPS URL to Google OAuth → Authorized JavaScript origins."
echo ""
echo "Optional alerting: Cloud Console → Monitoring → Alerting → create policy on Cloud Run 5xx rate or error log metrics."
