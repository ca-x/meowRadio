import { lazy, Suspense } from "react";
const SourcesPage = lazy(() => import("./SourcesPage"));
import { useLocation } from "react-router-dom";
import App from "./App";
import LoginPage from "./LoginPage";

// Keep the receiver/audio mounted while /login renders as a separate page.
export default function ApplicationShell() {
  const path = useLocation().pathname.replace(/\/$/, "");
  const login = path === "/login";
  const sources = path === "/sources";
  return (
    <>
      <div hidden={login || sources}>
        <App active={!login && !sources} />
      </div>
      {login && <LoginPage />}
      {sources && (
        <Suspense
          fallback={
            <div className="sources-loading" role="status">
              …
            </div>
          }
        >
          <SourcesPage />
        </Suspense>
      )}
    </>
  );
}
