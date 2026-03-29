#!/usr/bin/env bash
# Run AFTER you finish GitHub OAuth + install the Cloud Build GitHub App for connection jnotes-github.
#   ./infra/gcp/finish-github-setup.sh
#
# Prerequisites: ./infra/gcp/setup.sh, ./infra/gcp/iam-cloud-build.sh, secrets SESSION_SECRET + GOOGLE_CLIENT_ID,
# and: gcloud builds connections create github jnotes-github ... (see CLOUD_BUILD.md).
set -euo pipefail

PROJECT_ID="${PROJECT_ID:-freenotes-491520}"
REGION="${REGION:-us-central1}"
CONN="${GITHUB_CONNECTION:-jnotes-github}"
REPO_LOCAL_ID="${REPO_LOCAL_ID:-Jnotes}"
REMOTE_URI="${GITHUB_REMOTE_URI:-https://github.com/jkjaeschke/Jnotes.git}"
TRIGGER_NAME="${TRIGGER_NAME:-jnotes-push-main}"

gcloud config set project "${PROJECT_ID}"

echo "Checking connection ${CONN}…"
STATE="$(gcloud builds connections describe "${CONN}" --region="${REGION}" --format='value(installationState.stage)' 2>/dev/null || true)"
if [[ "${STATE}" != "COMPLETE" ]]; then
  echo "Connection is not COMPLETE yet (installationState.stage=${STATE:-unknown})."
  echo "Open the OAuth link from 'gcloud builds connections create github ...' and install the GitHub App, then re-run this script."
  exit 1
fi

echo "Linking repository ${REMOTE_URI}…"
if gcloud builds repositories describe "${REPO_LOCAL_ID}" --connection="${CONN}" --region="${REGION}" &>/dev/null; then
  echo "Repository ${REPO_LOCAL_ID} already linked."
else
  gcloud builds repositories create "${REPO_LOCAL_ID}" \
    --remote-uri="${REMOTE_URI}" \
    --connection="${CONN}" \
    --region="${REGION}"
fi

REPO_FULL="$(gcloud builds repositories describe "${REPO_LOCAL_ID}" --connection="${CONN}" --region="${REGION}" --format='value(name)')"
echo "Repository resource: ${REPO_FULL}"

if gcloud builds triggers describe "${TRIGGER_NAME}" --region="${REGION}" --project="${PROJECT_ID}" &>/dev/null; then
  echo "Trigger ${TRIGGER_NAME} already exists. Delete it in the console or pick a new TRIGGER_NAME."
  exit 0
fi

VITE="$(gcloud secrets versions access latest --secret=GOOGLE_CLIENT_ID --project="${PROJECT_ID}")"
if [[ -z "${VITE}" ]]; then
  echo "GOOGLE_CLIENT_ID secret is empty."
  exit 1
fi

echo "Creating trigger ${TRIGGER_NAME} (push to main)…"
gcloud builds triggers create github "${TRIGGER_NAME}" \
  --repository="${REPO_FULL}" \
  --branch-pattern='^main$' \
  --build-config=cloudbuild.yaml \
  --region="${REGION}" \
  --project="${PROJECT_ID}" \
  --substitutions="_VITE_GOOGLE_CLIENT_ID=${VITE}"

echo ""
echo "Done. Push to main to run a build, or run:"
echo "  gcloud builds triggers run ${TRIGGER_NAME} --region=${REGION} --branch=main"
