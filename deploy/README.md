# Deploying Outsmart

Outsmart runs on a plain Linux VM with root access. It cannot run on managed
container platforms (Render, Fly, App Runner, Netlify).

**Why:** the harness executes generated code inside a bubblewrap sandbox, which
works by creating unprivileged Linux user namespaces. Managed platforms block
that operation, because tenant-created namespaces are a container-escape
surface. Without it there is no sandbox, and sandboxed execution is the point.

A second constraint shapes the design: TrueForge's OIDC login only works in
hosted mode, and hosted mode disables the local sandbox. The two features are
mutually exclusive. So the harness runs in standalone mode bound to localhost,
and Caddy provides TLS and authentication at the edge.

## 1. Launch a VM

Ubuntu Server 24.04 LTS. On AWS EC2:

- **Instance type** — `t3.small` (2 GB). `t3.micro` is free-tier eligible but has
  only 1 GB; `setup.sh` adds 2 GB of swap to make it survivable.
- **Key pair** — create one and download the `.pem`.
- **Security group** — allow inbound `22` from your IP, and `80` + `443` from
  anywhere. Ports 80 and 443 are required for Let's Encrypt to issue a
  certificate.
- **Storage** — 20 GB. Sandboxes clone repositories and run `npm install`.

Then:

```bash
chmod 400 outsmart.pem
ssh -i outsmart.pem ubuntu@<PUBLIC_IP>
```

## 2. Provision

```bash
sudo apt-get update && sudo apt-get install -y git
git clone https://github.com/Harsh-bugs4ever/Outsmart.git
cd Outsmart
sudo ./deploy/setup.sh
```

`setup.sh` installs Node 22, bubblewrap, socat, ripgrep and python3-venv,
enables unprivileged user namespaces, adds swap, installs TrueForge into
`/opt/outsmart`, applies the sandbox allowlist patch, and installs Caddy.

It verifies bubblewrap can actually create a namespace and **fails loudly** if
not — that check is what tells you a host is unsuitable, rather than
discovering it later when every sandbox turn dies.

## 3. Run the harness

`setup.sh` already installed the unit, substituting the user it provisioned as.
If you ran it under an account other than `ubuntu`, that is the account the
service uses — set `OUTSMART_USER` when provisioning to choose explicitly.

```bash
sudo systemctl enable --now trueforge
journalctl -u trueforge -f
```

The unit sets `HOST=127.0.0.1`, so the harness listens on loopback only and is
reachable exclusively through Caddy. **Never open port 8790 in the security
group** — the harness has no authentication of its own, so anything that
reaches it directly can execute code and spend your model credits.

Look for this line. If it says *unavailable*, stop and fix it before going on:

```
info Local sandbox fallback is available {"platform":"linux",...}
```

## 4. Put TLS and auth in front

You do not need to buy a domain. `sslip.io` maps an IP into a hostname, and
Let's Encrypt will issue for it: an instance at `13.49.1.2` is reachable as
`13-49-1-2.sslip.io`.

```bash
caddy hash-password            # copy the hash
sudo cp deploy/Caddyfile /etc/caddy/Caddyfile
sudo nano /etc/caddy/Caddyfile # set HOSTNAME and the password hash
sudo systemctl reload caddy
```

Then open `https://<your-hostname>` and log in.

## 5. Configure the harness

Model providers, the GitHub connector and the saved agent live in
`~/.local/share/trueforge/db/db.sqlite`, which is per-instance. A fresh
deployment starts empty.

Add providers and the GitHub connector through Settings in the UI, then
register the skills and load the agent definition, in that order:

```bash
./scripts/load-skills.sh
./scripts/load-agent.sh
```

Order matters: the agent references skills by name, so a skill the harness has
not been told about leaves the agent advertising a capability it cannot use.

`load-skills.sh` registers this repository as the skill source — the harness
clones it and materialises the skill under `/opt/tfy/skills/<name>` inside the
sandbox when the model decides it is relevant. Nothing is copied to the host.
It reads the repository URL from the `origin` remote and pins `main`; override
with `OUTSMART_REPO_URL` and `OUTSMART_REPO_REF` when deploying from a fork or
a tag.

## Security notes

- The harness has **no authentication of its own**. If Caddy is not in front of
  it, anyone who finds the URL can execute code in your sandbox and spend your
  model credits. Never open port 8790 in the security group.
- API keys live in the harness database on the VM, never in this repository.
- The GitHub token is a classic PAT scoped to `public_repo`, so the agent
  cannot reach private repositories.
