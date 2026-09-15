# deploy/

Reserved for environment-specific manifests — Kubernetes, Terraform, a Fly or
Render config — none of which exist yet.

What does exist lives with the thing it deploys:

- `apps/api/Dockerfile`
- `apps/admin/Dockerfile`
- `docker-compose.yml` at the repository root, for running the whole stack locally
- `docs/04-deployment.md` for what runs where, what fails closed, and what is unverified
