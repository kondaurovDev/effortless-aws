#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# --- Configuration ---
S3_URL="${EFF_CODE_URL:-}"
AWS_PROFILE_NAME="${AWS_PROFILE:-}"
AWS_REGION_NAME="${AWS_REGION:-eu-central-1}"

if [ -z "$S3_URL" ]; then
  echo "Usage: EFF_CODE_URL=s3://bucket/key [AWS_PROFILE=profile] [AWS_REGION=region] $0"
  echo ""
  echo "Environment variables:"
  echo "  EFF_CODE_URL   (required) S3 URL to the worker code zip"
  echo "  AWS_PROFILE    AWS profile to use for credentials"
  echo "  AWS_REGION     AWS region (default: eu-central-1)"
  echo ""
  echo "Any extra EFF_* variables from your environment will be passed to the container."
  exit 1
fi

# --- Build image ---
echo "Building effortless-runner image..."
docker build -t effortless-runner "$SCRIPT_DIR"

# --- Resolve AWS credentials ---
AWS_DOCKER_ARGS=()

if [ -n "${AWS_ACCESS_KEY_ID:-}" ]; then
  # Env vars already set — pass them through
  AWS_DOCKER_ARGS+=(-e AWS_ACCESS_KEY_ID -e AWS_SECRET_ACCESS_KEY)
  [ -n "${AWS_SESSION_TOKEN:-}" ] && AWS_DOCKER_ARGS+=(-e AWS_SESSION_TOKEN)
elif [ -n "$AWS_PROFILE_NAME" ]; then
  # Resolve credentials from profile into env vars
  echo "Resolving credentials from profile: $AWS_PROFILE_NAME"
  eval "$(aws configure export-credentials --profile "$AWS_PROFILE_NAME" --format env)"
  AWS_DOCKER_ARGS+=(-e AWS_ACCESS_KEY_ID -e AWS_SECRET_ACCESS_KEY)
  [ -n "${AWS_SESSION_TOKEN:-}" ] && AWS_DOCKER_ARGS+=(-e AWS_SESSION_TOKEN)
elif [ -d "$HOME/.aws" ]; then
  # Mount ~/.aws directory for file-based credentials
  echo "Mounting ~/.aws for credentials"
  AWS_DOCKER_ARGS+=(-v "$HOME/.aws:/root/.aws:ro")
fi

# Collect all EFF_* env vars to pass through
EFF_ENVS=()
while IFS='=' read -r name value; do
  EFF_ENVS+=(-e "$name=$value")
done < <(env | grep '^EFF_' || true)

# --- Run ---
echo "Starting container..."
docker run --rm \
  "${EFF_ENVS[@]}" \
  "${AWS_DOCKER_ARGS[@]}" \
  -e AWS_REGION="$AWS_REGION_NAME" \
  effortless-runner
