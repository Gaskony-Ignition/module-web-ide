import { useEffect, useState } from 'react';
import { ANONYMOUS, fetchSession, type SessionInfo } from './api/session';
import { gatewayLoginUrl } from './api/urls';
import Workspace from './workspace/Workspace';
import ScriptConsole from './components/ScriptConsole';
import QueryBrowser from './components/QueryBrowser';
import ThemePicker, { applyTheme, readStoredTheme } from './components/ThemePicker';
// The module version, from the ONE file the build maintains: Gradle's
// `syncVersion` rewrites web/package.json before `assembleModlStructure`, so the
// number here is the module's by construction. Imported rather than pushed in
// through a Vite `define` because an import is checked by the compiler and needs
// no build config to be true under vitest, `npm run dev` and a gateway build
// alike — a define is invisible to all three until it is wrong. Vite emits JSON
// as named exports, so nothing but this string reaches the bundle.
import { version } from '../package.json';
import './themes.generated.css';
import './App.css';

type Status = 'loading' | 'ready' | 'unreachable';

/**
 * The application shell.
 *
 * Its first job is still the P0 one: prove the module serves the SPA, the SPA
 * reaches the API on the same origin, and the Gateway session cookie identifies
 * the user. The three non-authenticated branches below are unchanged from P0 and
 * are deliberately kept apart — an unreachable backend and a signed-out user look
 * identical to a naive client, and telling them apart is the whole point of the
 * probe. Once the session says authenticated, the editor workspace takes over.
 */
export default function App() {
  const [status, setStatus] = useState<Status>('loading');
  const [session, setSession] = useState<SessionInfo>(ANONYMOUS);
  const [error, setError] = useState<string>('');

  // Applied before the first paint of anything themed, so the page never shows
  // the default palette for a frame and then swap.
  useEffect(() => {
    applyTheme(readStoredTheme());
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetchSession()
      .then((info) => {
        if (cancelled) return;
        setSession(info);
        setStatus('ready');
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : String(e));
        setStatus('unreachable');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const signedIn = status === 'ready' && session.authenticated;

  // The popped-out console and Query Browser: same origin, same session, same
  // socket, but no tree and no editor. Read from the query string rather than
  // a router — this app has a handful of views and adding a router for the
  // popped-out ones would be more moving parts than the feature.
  const params = new URLSearchParams(window.location.search);
  const consoleOnly = params.get('view') === 'console';
  const queryOnly = params.get('view') === 'query';
  const poppedOutProject = params.get('project') ?? '';
  // The console's OWN picker starts here but is independent from then on (the
  // console prop of the same name never changes) — this is told the picker's
  // current choice via onProjectChange, exactly how onDatasourceChange tells
  // us the Query Browser's.
  const [consoleProject, setConsoleProject] = useState(poppedOutProject);
  const [poppedOutDatasource, setPoppedOutDatasource] = useState('');

  // Several of these tabs are often open at once; the tab title and the header
  // say which one this is. The main workspace sets its own title per project.
  const context = consoleOnly
    ? `Script Console${consoleProject ? ` · ${consoleProject}` : ''}`
    : queryOnly
      ? `Database Query Browser${poppedOutDatasource ? ` · ${poppedOutDatasource}` : ''}`
      : '';
  useEffect(() => {
    if (context) {
      document.title = `${context} — Web IDE`;
    }
  }, [context]);

  return (
    <div className="app">
      <header className="app-header">
        <h1>Web IDE</h1>
        <span className="app-version">v{version}</span>
        {context && <span className="app-context">{context}</span>}
        <span className="app-header-gap" />
        <ThemePicker />
        {signedIn && (
          <span className="app-user">
            {session.username}
            {session.writable ? '' : ' · read-only'}
          </span>
        )}
      </header>

      {signedIn && consoleOnly ? (
        <main className="app-main app-main-console">
          <ScriptConsole
            project={poppedOutProject}
            csrfToken={session.csrfToken}
            canExecute={session.canExecute !== false && session.writable}
            onProjectChange={setConsoleProject}
          />
        </main>
      ) : signedIn && queryOnly ? (
        <main className="app-main app-main-query">
          <QueryBrowser
            project={poppedOutProject}
            csrfToken={session.csrfToken}
            isAdmin={session.writable}
            executionEnabled={session.executionEnabled !== false}
            onDatasourceChange={setPoppedOutDatasource}
          />
        </main>
      ) : signedIn ? (
        <Workspace session={session} />
      ) : (
        <main className="app-main">
          {status === 'loading' && <p className="muted">Checking your Gateway session…</p>}

          {/* An unreachable backend is a different problem from being signed out,
              and the probe is designed so we can tell them apart. Say which. */}
          {status === 'unreachable' && (
            <div className="notice-card notice-card-error">
              <h2>Cannot reach the Gateway API</h2>
              <p className="muted">{error}</p>
            </div>
          )}

          {status === 'ready' && !session.authenticated && (
            <div className="notice-card">
              <h2>You are not signed in</h2>
              <p className="muted">
                The Web IDE uses your Gateway session. Sign in, then return to this page.
              </p>
              <a className="button" href={gatewayLoginUrl()}>
                Sign in to the Gateway
              </a>
            </div>
          )}
        </main>
      )}
    </div>
  );
}
