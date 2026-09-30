/**
 * A Web Dev endpoint's per-method settings — the Designer's endpoint config.
 *
 * One method at a time, matching how it is stored and how the server writes it:
 * the write is a read-modify-write of a single method's object, so any key this
 * build does not know about survives. Editing the whole document here would mean
 * sending back keys we do not understand, which is how a future Ignition field
 * gets silently deleted by an older client.
 *
 * `require-auth` off is a real exposure and is called out in the UI rather than
 * left as an unlabelled checkbox — an endpoint with auth off is reachable by
 * anyone who can reach the gateway.
 */
import { useEffect, useState } from 'react';
import {
  DEFAULT_METHOD_SETTINGS,
  WEBDEV_METHODS,
  readWebDevConfig,
  saveWebDevConfig,
  type MethodSettings,
  type WebDevMethod,
} from '../api/webdev';
import './NewScriptDialog.css';
import './WebDevConfigDialog.css';

export interface WebDevConfigDialogProps {
  project: string;
  path: string;
  name: string;
  csrfToken?: string;
  readOnly: boolean;
  onClose: () => void;
}

export default function WebDevConfigDialog({
  project,
  path,
  name,
  csrfToken,
  readOnly,
  onClose,
}: WebDevConfigDialogProps) {
  const [method, setMethod] = useState<WebDevMethod>('doGet');
  const [settings, setSettings] = useState<MethodSettings>(DEFAULT_METHOD_SETTINGS);
  const [signature, setSignature] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    readWebDevConfig(project, path)
      .then((body) => {
        if (cancelled) return;
        setSignature(body.signature);
        // A method absent from the file has never been configured; show the
        // Designer's defaults rather than blanks.
        setSettings({ ...DEFAULT_METHOD_SETTINGS, ...(body.config[method] ?? {}) });
        setError(null);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [project, path, method]);

  function set<K extends keyof MethodSettings>(key: K, value: MethodSettings[K]) {
    setSettings((current) => ({ ...current, [key]: value }));
    setStatus(null);
  }

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const result = await saveWebDevConfig({
        project,
        path,
        method,
        settings,
        baseSignature: signature,
        csrfToken,
      });
      if (result.signature) setSignature(result.signature);
      setStatus(`Saved ${method}.`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="newscript-backdrop" role="presentation">
      <div
        className="newscript-dialog wdc-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="wdc-title"
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.stopPropagation();
            onClose();
          }
        }}
      >
        <h2 id="wdc-title">{name} — endpoint settings</h2>

        <label className="wdc-row">
          <span className="wdc-label">HTTP method</span>
          <select
            value={method}
            onChange={(event) => setMethod(event.target.value as WebDevMethod)}
            disabled={busy}
          >
            {WEBDEV_METHODS.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </label>

        {loading ? (
          <p className="muted">Loading…</p>
        ) : (
          <>
            <label className="wdc-check">
              <input
                type="checkbox"
                checked={settings.enabled}
                onChange={(event) => set('enabled', event.target.checked)}
                disabled={readOnly || busy}
              />
              <span>Enabled</span>
            </label>

            <label className="wdc-check">
              <input
                type="checkbox"
                checked={settings['require-auth']}
                onChange={(event) => set('require-auth', event.target.checked)}
                disabled={readOnly || busy}
              />
              <span>Require authentication</span>
            </label>
            {!settings['require-auth'] && settings.enabled && (
              <p className="wdc-warn" role="status">
                With authentication off, anyone who can reach this gateway can call
                this endpoint.
              </p>
            )}

            <label className="wdc-check">
              <input
                type="checkbox"
                checked={settings['require-https']}
                onChange={(event) => set('require-https', event.target.checked)}
                disabled={readOnly || busy}
              />
              <span>Require HTTPS</span>
            </label>

            <label className="wdc-row">
              <span className="wdc-label">Required roles</span>
              <input
                type="text"
                value={settings['required-roles']}
                placeholder="comma separated, blank for any"
                onChange={(event) => set('required-roles', event.target.value)}
                disabled={readOnly || busy}
              />
            </label>

            <label className="wdc-row">
              <span className="wdc-label">User source</span>
              <input
                type="text"
                value={settings['user-source']}
                placeholder="blank for the project default"
                onChange={(event) => set('user-source', event.target.value)}
                disabled={readOnly || busy}
              />
            </label>

            <label className="wdc-row">
              <span className="wdc-label">Max retry attempts</span>
              <input
                type="number"
                min={0}
                max={100}
                value={settings['max-retry-attempts']}
                onChange={(event) =>
                  set('max-retry-attempts', Number(event.target.value))
                }
                disabled={readOnly || busy}
              />
            </label>
          </>
        )}

        {error && (
          <p className="newscript-problem" role="alert">
            {error}
          </p>
        )}
        {status && <p className="wdc-status muted">{status}</p>}

        <div className="newscript-actions">
          <button type="button" onClick={onClose} disabled={busy}>
            Close
          </button>
          <button
            type="button"
            className="primary"
            onClick={() => void save()}
            disabled={readOnly || busy || loading}
          >
            {busy ? 'Saving…' : `Save ${method}`}
          </button>
        </div>
      </div>
    </div>
  );
}
