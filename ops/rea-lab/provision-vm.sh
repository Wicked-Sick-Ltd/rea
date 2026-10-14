#!/usr/bin/env bash
# Create the REA analysis VM on a Proxmox node. Run as root on the node, e.g.
#   VLAN=1010 IP=172.31.10.10/24 GW=172.31.10.1 SSH_KEY=/root/craig.pub ./provision-vm.sh
# Needs cloud-init.yaml beside this script and `snippets` content enabled on
# $SNIPPET_STORAGE (pvesm set local --content iso,vztmpl,backup,snippets).
set -euo pipefail

VMID=${VMID:-9101}
NAME=${NAME:-rea-lab}
VLAN=${VLAN:?set VLAN to the isolated rea-lab tag}
IP=${IP:?set IP, e.g. 172.31.10.10/24}
GW=${GW:?set GW, the pfSense address on the rea-lab VLAN}
SSH_KEY=${SSH_KEY:?set SSH_KEY to a public key file}
STORAGE=${STORAGE:-vm-storage}
SNIPPET_STORAGE=${SNIPPET_STORAGE:-local}
SNIPPET_DIR=${SNIPPET_DIR:-/var/lib/vz/snippets}
DISK=${DISK:-200G}

if qm status "$VMID" >/dev/null 2>&1; then
  echo "VM $VMID already exists; choose another VMID" >&2
  exit 1
fi

img_dir=/var/lib/vz/template/iso
img=noble-server-cloudimg-amd64.img
(
  cd "$img_dir"
  base=https://cloud-images.ubuntu.com/noble/current
  curl -fsSLo SHA256SUMS.noble "$base/SHA256SUMS"
  [ -f "$img" ] || curl -fsSLO "$base/$img"
  grep " \*$img\$" SHA256SUMS.noble | sed 's/ \*/  /' | sha256sum -c
)

here=$(cd "$(dirname "$0")" && pwd)
key=$(<"$SSH_KEY")
install -d "$SNIPPET_DIR"
sed "s|__SSH_KEY__|\"$key\"|" "$here/cloud-init.yaml" >"$SNIPPET_DIR/$NAME.yaml"

qm create "$VMID" --name "$NAME" --ostype l26 --machine q35 --cpu host \
  --cores 8 --memory 32768 --agent enabled=1 \
  --scsihw virtio-scsi-single --serial0 socket --vga serial0 \
  --net0 "virtio,bridge=vmbr1,tag=$VLAN,firewall=1"
qm set "$VMID" --scsi0 "$STORAGE:0,import-from=$img_dir/$img,discard=on,iothread=1"
qm resize "$VMID" scsi0 "$DISK"
qm set "$VMID" --ide2 "$STORAGE:cloudinit" --boot order=scsi0 \
  --ipconfig0 "ip=$IP,gw=$GW" --nameserver "$GW" \
  --cicustom "user=$SNIPPET_STORAGE:snippets/$NAME.yaml"
qm start "$VMID"

echo "Started $NAME ($VMID). When 'cloud-init status --wait' reports done inside the VM:"
echo "  qm shutdown $VMID && qm snapshot $VMID clean && qm start $VMID"
