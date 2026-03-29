#!/usr/bin/env bash
# Build the Docker image locally or use an existing Artifact Registry tag, then deploy to Cloud Run.
# Prereqs: gcloud auth, PROJECT_ID set, infra/gcp/setup.sh run once, Firestore created, secrets created.
#
# Usage:
#   export PROJECT_ID=freenotes-491520
#   export REGION=us-central1
#   export VITE_GOOGLE_CLIENT_ID=xxxx.apps.googleusercontent.com   # same as GOOGLE_CLIENT_ID secret
#   ./infra/gcp/deploy-cloud-run.sh
#
# Or after Cloud Build pushed :latest:
#   export IMAGE=us-central1-docker.pkg.dev/freenotes-491520/freenotes/freenotes-api:latest
#   ./infra/gcp/deploy-cloud-run.sh
set -euo pipefail

PROJECT_ID="${PROJECT_ID:-freenotes-491520}"
REGION="${REGION:-us-central1}"
SERVICE="${SERVICE:-freenotes-api}"
AR_REPO="${AR_REPO:-freenotes}"
GCS_BUCKET="${GCS_BUCKET:-${PROJECT_ID}-freenotes-data}"
RUN_SA="freenotes-api@${PROJECT_ID}.iam.gserviceaccount.com"

IMAGE="${IMAGE:-}"

if [[ -z "${IMAGE}" ]]; then
  if [[ -z "${VITE_GOOGLE_CLIENT_ID:-}" ]]; then
    echo "Set VITE_GOOGLE_CLIENT_ID (OAuth Web client id) or set IMAGE= to an existing image."
    exit 1
  fi
  echo "Building image (requires Docker)..."
  docker build \
    --build-arg "VITE_GOOGLE_CLIENT_ID=${VITE_GOOGLE_CLIENT_ID}" \
    -t "${REGION}-docker.pkg.dev/${PROJECT_ID}/${AR_REPO}/${SERVICE}:manual" \
    "$(dirname "$0")/../.."
  IMAGE="${REGION}-docker.pkg.dev/${PROJECT_ID}/${AR_REPO}/${SERVICE}:manual"
  echo "Pushing ${IMAGE} (run once: gcloud auth configure-docker ${REGION}-docker.pkg.dev)..."
  docker push "${IMAGE}"
fi

gcloud config set project "${PROJECT_ID}"

gcloud run deploy "${SERVICE}" \
  --image "${IMAGE}" \
  --region "${REGION}" \
  --platform managed \
  --allow-unauthenticated \
  --service-account "${RUN_SA}" \
  --set-env-vars "GOOGLE_CLOUD_PROJECT=${PROJECT_ID},GCS_BUCKET=${GCS_BUCKET},NODE_ENV=production" \
  --set-secrets "SESSION_SECRET=SESSION_SECRET:latest,GOOGLE_CLIENT_ID=GOOGLE_CLIENT_ID:latest"

URL="$(gcloud run services describe "${SERVICE}" --region="${REGION}" --format='value(status.url)')"
gcloud run services update "${SERVICE}" --region="${REGION}" --update-env-vars "FRONTEND_ORIGIN=${URL}"

echo ""
echo "Deployed: ${URL}"
echo "Add this URL under Google OAuth → OAuth client → Authorized JavaScript origins."
echo "Then open ${URL} in the browser."
