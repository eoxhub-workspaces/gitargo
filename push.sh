#!/bin/bash -xeu

# Usage: ./push.sh <namespace>
NAMESPACE=${1:-default}

# Find the pod
POD=$(kubectl -n $NAMESPACE get po -l "app.kubernetes.io/name=eoxhub-gateway" -o name | head -n2 | tail -n1 | cut -d/ -f2)

if [ -z "$POD" ]; then
  echo "Error: No pod found matching label app.kubernetes.io/name=eoxhub-gateway"
  exit 1
fi

echo "Building frontend..."
cd services/ui
npm install --legacy-peer-deps
npm run build
cd ../..

echo "Pushing services/api and built UI to $POD in $NAMESPACE..."

# Create a temporary staging area to match the production container layout
rm -rf /tmp/argo-manager-push
mkdir -p /tmp/argo-manager-push
cp -r services/api/* /tmp/argo-manager-push/
cp -r services/ui/build /tmp/argo-manager-push/public

# Copy the staged files to the container's working directory (/app)
kubectl cp /tmp/argo-manager-push/. $NAMESPACE/${POD}:/app

# Clean up
rm -rf /tmp/argo-manager-push

# Kill the node process. If the pod is running a dev loop (e.g., 'while true; do node server.js; done'),
# this will cause the server to restart internally without destroying the container and the copied files.
kubectl -n $NAMESPACE exec -it ${POD} -- sh -c "killall node"

echo "Done. If the pod is running a dev loop, the server has restarted internally."
