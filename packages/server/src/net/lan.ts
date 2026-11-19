import { networkInterfaces } from 'node:os';

export interface LanAddress {
  label: string;
  address: string;
}

const VIRTUAL = /^(docker|br-|veth|virbr|vmnet|vboxnet|lxc|lxd|podman|cni|flannel|kube|zt)/i;

/** IPv4 addresses other devices could reach us on, most likely first. */
export function lanAddresses(): LanAddress[] {
  const out: LanAddress[] = [];
  for (const [name, addrs] of Object.entries(networkInterfaces())) {
    if (!addrs || VIRTUAL.test(name)) continue;
    for (const a of addrs) {
      if (a.family !== 'IPv4' || a.internal) continue;
      const tailscale = name.startsWith('tailscale') || a.address.startsWith('100.');
      out.push({ label: tailscale ? `Tailscale (${name})` : `Local network (${name})`, address: a.address });
    }
  }
  const rank = (a: LanAddress) => (a.address.startsWith('192.168.') ? 0 : a.address.startsWith('10.') ? 1 : a.label.startsWith('Tailscale') ? 3 : 2);
  return out.sort((a, b) => rank(a) - rank(b));
}
