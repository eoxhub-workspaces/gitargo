#!/bin/bash -xeu

# Usage: ./push.sh <namespace>
NAMESPACE=${1:-default}

# Find the pod
POD=$(kubectl -n $NAMESPACE get po -l "app=gitargo" -o name | head -n1 | cut -d/ -f2)

if [ -z "$POD" ]; then
  echo "Error: No pod found matching label app=gitargo"
  exit 1
fi

echo "Building frontend..."
cd services/ui
npm install --legacy-peer-deps
npm run build
cd ../..

echo "Pushing services/api and built UI to $POD in $NAMESPACE..."

# Create a temporary staging area to match the production container layout
rm -rf /tmp/gitargo-push
mkdir -p /tmp/gitargo-push
cp -r services/api/* /tmp/gitargo-push/
# Remove the stub index.html and copy the built frontend assets
rm -rf /tmp/gitargo-push/public/*
cp -r services/ui/build/* /tmp/gitargo-push/public/

# Copy the staged files to the container's working directory (/app)
kubectl cp /tmp/gitargo-push/. $NAMESPACE/${POD}:/app

# Clean up
rm -rf /tmp/gitargo-push

# Restart the server
echo "IMPORTANT: To apply changes, delete the pod so it restarts and runs the new files (if your volume setup supports it),"
echo "OR ensure your container command runs 'npm run dev' (nodemon) which will auto-restart."
kubectl -n $NAMESPACE exec ${POD} -- sh -c "echo 'Restarting server...' && touch /app/server.js" || true

echo "Done. If the pod is running a dev loop, the server has restarted internally."
