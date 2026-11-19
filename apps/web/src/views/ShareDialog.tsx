import { useEffect, useState } from 'react';
import { Copy, Globe, Home, RefreshCw, Settings } from 'lucide-react';
import type { LinkMode } from '@watchroom/protocol';
import { Button } from '../components/Button';
import { Modal, Spinner } from '../components/misc';
import { copyText } from '../lib/clipboard';
import { toast } from '../state/room';
import type { HostControls } from './RoomView';
import s from './ShareDialog.module.css';

function useQr(text: string | null): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    if (!text) {
      setUrl(null);
      return;
    }
    void import('qrcode').then((QR) => QR.toDataURL(text, { margin: 0, errorCorrectionLevel: 'M', width: 232, color: { dark: '#0b0b0e', light: '#ffffff' } }))
      .then((u) => { if (!cancelled) setUrl(u); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [text]);
  return url;
}

const MODES: { id: LinkMode; label: string; hint: string; icon: typeof Globe }[] = [
  { id: 'tunnel', label: 'Internet', hint: 'Friends anywhere', icon: Globe },
  { id: 'lan', label: 'Same network', hint: 'Home Wi-Fi only', icon: Home },
  { id: 'custom', label: 'Custom', hint: 'Your own address', icon: Settings },
];

export function ShareDialog({ host, onClose }: { host: HostControls; onClose(): void }) {
  const link = host.status?.link;
  const url = link?.shareUrl ?? null;
  const qr = useQr(url);
  const [custom, setCustom] = useState(link?.customBase ?? 'https://');
  const [busy, setBusy] = useState(false);
  const canSwitch = Boolean(host.setLinkMode);

  const switchMode = async (mode: LinkMode) => {
    if (!host.setLinkMode || mode === link?.mode) return;
    if (mode === 'custom' && !/^https?:\/\/[^\s/]+/.test(custom)) {
      toast('info', 'Enter your public address below, then press Use.');
      return;
    }
    setBusy(true);
    const err = await host.setLinkMode(mode, mode === 'custom' ? custom : null);
    setBusy(false);
    if (err) toast('error', err);
  };

  const copy = async () => {
    if (url && await copyText(url)) toast('success', 'Link copied. Send it to your friends.');
  };

  return (
    <Modal title="Invite friends" onClose={onClose} width={560}>
      {canSwitch && (
        <div className={s.modes} role="radiogroup" aria-label="How friends connect">
          {MODES.map((m) => (
            <button
              key={m.id} role="radio" aria-checked={link?.mode === m.id} disabled={busy}
              className={`${s.mode} ${link?.mode === m.id ? s.modeActive : ''}`}
              onClick={() => void switchMode(m.id)}
            >
              <m.icon size={16} /> {m.label}<small>{m.hint}</small>
            </button>
          ))}
        </div>
      )}

      {link?.mode === 'custom' && (
        <div className={s.row} style={{ marginBottom: 12 }}>
          <input className={s.input} value={custom} onChange={(e) => setCustom(e.target.value)} placeholder="https://watch.example.com" aria-label="Public address" />
          <Button size="sm" onClick={async () => {
            const err = await host.setLinkMode?.('custom', custom);
            if (err) toast('error', err);
          }}>Use</Button>
        </div>
      )}

      {url ? (
        <div className={s.row}>
          <div className={s.link}>{url}</div>
          <Button variant="primary" icon={<Copy size={15} />} onClick={copy}>Copy</Button>
        </div>
      ) : link?.mode === 'tunnel' && link.tunnel.state === 'error' ? (
        <div className={`${s.state} ${s.error}`}>
          <strong>The internet link isn't working right now.</strong>
          <span className={s.small}>{link.tunnel.error}</span>
          <span className={s.small}>{link.tunnel.detail}</span>
          {host.retryTunnel && <Button size="sm" icon={<RefreshCw size={13} />} onClick={host.retryTunnel}>Try again</Button>}
        </div>
      ) : (
        <div className={s.state}><Spinner size={15} /> {link?.tunnel.detail ?? 'Preparing your link…'}</div>
      )}

      {url && (
        <div className={s.qrWrap}>
          <div className={s.qr}>{qr && <img src={qr} alt="QR code of the invite link" />}</div>
          <div className={s.notes}>
            <span><strong>On a phone?</strong> Scan this code with the camera.</span>
            {link?.mode === 'tunnel' && <span>This link works from anywhere. It changes each time you restart Watchroom.</span>}
            {link?.mode === 'lan' && <span>Only devices on the same Wi-Fi or network can open this link.</span>}
            <span>Anyone with the link can join, so share it only with people you trust.</span>
          </div>
        </div>
      )}

      {link?.mode !== 'tunnel' && link && link.lanUrls.length > 1 && (
        <div className={s.lanList}>
          {link.lanUrls.slice(1).map((l) => (
            <div key={l.url} className={s.lanItem}><span>{l.label}</span><code>{l.url}</code></div>
          ))}
        </div>
      )}

      <div className={s.footer}>
        <span className={s.small}>Each friend picks their own quality. Your upload speed is the limit for everyone combined.</span>
        {host.regenerateLink && (
          <Button size="sm" variant="ghost" icon={<RefreshCw size={13} />} onClick={() => {
            if (window.confirm('Create a new link? The old link stops working. People already in the room stay.')) host.regenerateLink?.();
          }}>New link</Button>
        )}
      </div>
    </Modal>
  );
}
