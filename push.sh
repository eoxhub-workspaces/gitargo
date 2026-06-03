#!/bin/bash -xeu

# Usage: ./push.sh <namespace>
NAMESPACE=${1:-default}

# Find the pod
POD=$(kubectl -n $NAMESPACE get po -l "app.kubernetes.io/name=gitargo" -o name | head -n2 | tail -n1 | cut -d/ -f2)

if [ -z "$POD" ]; then
  echo "Error: No pod found matching label app.kubernetes.io/name=gitargo"
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
cp -r services/ui/build /tmp/gitargo-push/public

# Copy the staged files to the container
kubectl cp /tmp/gitargo-push/ $NAMESPACE/${POD}:/srv/service 

# Clean up
rm -rf /tmp/gitargo-push

# Signal the process to reload
kubectl -n $NAMESPACE exec -it ${POD} -- sh -c "kill -HUP 1"

echo "Done."
