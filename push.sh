#!/bin/bash -xeu

# Usage: ./push.sh <namespace>
NAMESPACE=${1:-default}

# Target ALL pods matching app=gitargo-dev or name containing gitargo-dev
PODS=$(kubectl -n $NAMESPACE get po -l "app=gitargo-dev" -o name 2>/dev/null | cut -d/ -f2 || true)

if [ -z "$PODS" ]; then
  PODS=$(kubectl -n $NAMESPACE get po -o name 2>/dev/null | grep -i gitargo-dev | cut -d/ -f2 || true)
fi

if [ -z "$PODS" ]; then
  echo "Error: No pods found matching label app=gitargo-dev or name containing gitargo-dev in namespace $NAMESPACE"
  exit 1
fi

echo "Building frontend..."
cd services/ui
npm install
npm run build
cd ../..

for POD in $PODS; do
  echo "--------------------------------------------------------"
  echo "Pushing services/api and built UI to pod: $POD in namespace $NAMESPACE..."

  # Copy backend files explicitly to /app
  kubectl cp services/api/server.js $NAMESPACE/${POD}:/app/server.js
  kubectl cp services/api/package.json $NAMESPACE/${POD}:/app/package.json

  # Copy built frontend dist files explicitly to /app/public/
  kubectl cp services/ui/dist/. $NAMESPACE/${POD}:/app/public/

  echo "Verifying /app/server.js inside $POD:"
  kubectl -n $NAMESPACE exec ${POD} -- ls -la /app/server.js

  # Touch both server.js and package.json to guarantee nodemon detects the file update
  echo "Notifying nodemon of updated files in $POD..."
  kubectl -n $NAMESPACE exec ${POD} -- sh -c "echo '' >> /app/server.js && touch /app/package.json" || true
  echo "Done updating $POD."
done

echo "========================================================"
echo "All development pods successfully updated and reloaded."
