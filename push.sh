#!/bin/bash -xeu

# Usage: ./push.sh <namespace>
NAMESPACE=${1:-default}

# Target ONLY the gitargo-dev pod (never touch the stable gitargo pod)
POD=$(kubectl -n $NAMESPACE get po -l "app=gitargo-dev" -o name 2>/dev/null | head -n1 | cut -d/ -f2 || true)

if [ -z "$POD" ]; then
  POD=$(kubectl -n $NAMESPACE get po -o name 2>/dev/null | grep -i gitargo-dev | head -n1 | cut -d/ -f2 || true)
fi

if [ -z "$POD" ]; then
  echo "Error: No pod found matching label app=gitargo-dev or name containing gitargo-dev in namespace $NAMESPACE"
  exit 1
fi

echo "Targeting development pod: $POD in namespace $NAMESPACE"

echo "Building frontend..."
cd services/ui
npm install
npm run build
cd ../..

echo "Pushing services/api and built UI to $POD in $NAMESPACE..."

# Create a temporary staging area to match the container layout
rm -rf /tmp/gitargo-push
mkdir -p /tmp/gitargo-push
cp -r services/api/* /tmp/gitargo-push/
# Remove the stub index.html and copy the built frontend assets
rm -rf /tmp/gitargo-push/public/*
cp -r services/ui/dist/* /tmp/gitargo-push/public/

# Copy the staged files to the container's working directory (/app)
kubectl cp /tmp/gitargo-push/. $NAMESPACE/${POD}:/app

# Clean up staging directory
rm -rf /tmp/gitargo-push

# Signal nodemon via file touch (avoiding process kill & EADDRINUSE port collisions)
echo "Notifying nodemon of updated files in $POD..."
kubectl -n $NAMESPACE exec ${POD} -- sh -c "touch /app/server.js" || true

echo "Done. Code copied and nodemon notified in $POD."
