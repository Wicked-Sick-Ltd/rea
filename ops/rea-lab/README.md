# REA at Wicked Sick: deployment and usage runbook

How we run REA (`rea-agents`) across projects. Internal to this fork; not part
of upstream.

## Shape

REA is a local **stdio** MCP server that the agent spawns
(`npx -y rea-agents@<version> mcp`). It is not a hosted service, so "where does
REA run" means "where does the Claude Code session run". REA's own docs state it
is **not a sandbox**: opening a binary hands parsing to Ghidra/Hopper with the
user's permissions, and process capture, browser and Electron observation run
the target.

| Tier        | Where               | Use it for                                                                                               |
| ----------- | ------------------- | -------------------------------------------------------------------------------------------------------- |
| 1 — Mac     | Your workstation    | Trusted, static only: our own builds, JS/Electron bundles, .NET, Go metadata, WASM, HAR files            |
| 2 — rea-lab | Isolated Proxmox VM | Anything third-party or untrusted; native binaries (Ghidra); APKs; firmware; process capture; live sites |

Docker is not used: there is no upstream image, a container shares the host
kernel (weak boundary for untrusted binaries), and REA's Hopper namespaces,
native PTY and Chrome sandbox all fight container defaults.

## Tier 1 — Mac setup

```bash
npx -y rea-agents@6.4.0 setup --client claude_code   # review the plan, approve, restart Claude Code
npx -y rea-agents@6.4.0 doctor --client claude_code --json
```

## Tier 2 — rea-lab VM

Ubuntu 24.04 on proxmox5, 8 vCPU / 32 GB / 200 GB on `vm-storage`, Node 24,
JDK 21, Ghidra 12.1.4 (digest-pinned), `rea-agents@6.4.0`, Claude Code. Two
users: `ops` (sudo, admin only) and `rea` (no sudo, runs all analysis).

### 1. Network (manual — UniFi + pfSense)

Suggested values; confirm the tag and subnet are free first.

- **VLAN** `1010` `rea-lab`, subnet `172.31.10.0/24`, pfSense gateway
  `172.31.10.1`, no DHCP (VM is static `172.31.10.10`).
- **UniFi:** create the VLAN-only network so the proxmox5 trunk carries tag 1010
  (trunks pass tagged VLANs by default).
- **pfSense:** add the VLAN interface `REA_LAB`, then rules on it, in order:
  1. Pass `REA_LAB net` → `REA_LAB address` TCP/UDP 53 (DNS resolver).
  2. Block `REA_LAB net` → alias `PRIVATE_NETS` = `10.0.0.0/8`,
     `172.16.0.0/12`, `192.168.0.0/16`, `100.64.0.0/10`, `192.33.132.0/24`.
  3. Pass `REA_LAB net` → any TCP 443 (npm, nodejs.org, GitHub, Anthropic,
     Ubuntu mirrors; also needs TCP 80 during first boot for apt — add and
     remove after provisioning, or keep if `apt upgrade` stays on).
  4. Everything else blocked (default deny).
- **Management in:** on your admin LAN interface, pass your admin host →
  `172.31.10.10` TCP 22. Do **not** give proxmox5 an address on VLAN 1010; the
  lab must not reach the hypervisor.

### 2. Create the VM (on proxmox5, as root)

```bash
scp -r ops/rea-lab root@10.10.101.5:/root/
ssh root@10.10.101.5
pvesm status            # confirm `local` lists snippets; if not:
# pvesm set local --content iso,vztmpl,backup,snippets
cd /root/rea-lab
VLAN=1010 IP=172.31.10.10/24 GW=172.31.10.1 SSH_KEY=/root/craig.pub ./provision-vm.sh
```

Wait for first boot, then take the clean snapshot:

```bash
ssh ops@172.31.10.10 cloud-init status --wait     # expect: status: done
qm shutdown 9101 && qm snapshot 9101 clean && qm start 9101
```

### 3. First login as `rea`

```bash
ssh rea@172.31.10.10
claude                                              # log in once, then exit
rea setup --client claude_code --dry-run            # review
rea setup --client claude_code --yes                # registers MCP + skill, saves Ghidra path
rea doctor --provider ghidra --json                 # expect healthy
```

Take a second snapshot (`qm snapshot 9101 ready`) once this passes.

### 4. Smoke test

Use something we own. Build a small Go or C binary from one of our repos on the
Mac, copy it in and ask Claude in `/srv/rea/work/smoke`:

```text
Open /srv/rea/targets/smoke/<binary> with REA and summarise main(), with evidence.
```

Pass = Ghidra session opens, pseudocode returned, session closes cleanly.

## Using it on a project

```bash
scp target.bin rea@172.31.10.10:/srv/rea/targets/<project>/
ssh rea@172.31.10.10
mkdir -p /srv/rea/work/<project> && cd /srv/rea/work/<project> && claude
```

Ask for findings in `/srv/rea/work/<project>/FINDINGS.md`, then copy **only
that write-up** back into the project repo (e.g. `docs/research/`). Never commit
targets, decompiled output or Ghidra/Hopper artefacts.

After analysing anything suspicious: `qm rollback 9101 ready`.

## Usage policy

- Only targets we own, or are authorised in writing to examine. Record the
  authorisation in the project's FINDINGS.md.
- **Clean room.** Describe the behaviour, then implement it independently.
  Never paste decompiled code or recovered assets into our codebases.
- No DRM, licence-check, anti-cheat or access-control circumvention (REA's
  `DISCLAIMER.md` applies in full).
- Commercial engines (Hopper, IDA, JEB) only under licences we hold. The VM
  uses Ghidra (free) by default.
- Nothing from Phalanx or other privileged matters goes on rea-lab.

## Updating

REA moves fast. Bump the pin deliberately in this file, `cloud-init.yaml` and
then:

```bash
ssh ops@172.31.10.10 sudo npm install --global rea-agents@<new>
ssh rea@172.31.10.10 bash -lc 'rea setup --client claude_code --yes'   # re-pins the MCP registration
qm snapshot 9101 ready-<new>
```

## Fork policy

This fork carries our security fixes (#1 SSRF hardening, #2 CodeQL sanitization
/ TOCTOU). Plan: offer both upstream to `morluto/rea`; once released, deploy the
npm package and keep this fork as a staging area only. Until then the pinned npm
release does not contain them.

## Later, if needed

- Optional engines on the VM: JADX (APKs), binwalk/unblob (firmware), a
  Chrome-family browser (website runtime), Hopper Linux demo (needs Xvfb).
- Driving the VM from a Mac session over `ssh rea@rea-lab rea mcp` as the MCP
  command — plausible for stdio, not covered by REA's docs.
- Registering rea-lab as a fleet sidecar so Jarvis can queue analysis jobs.
