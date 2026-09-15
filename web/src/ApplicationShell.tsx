import { useLocation } from "react-router-dom";
import App from "./App";
import LoginPage from "./LoginPage";

// Keep the receiver/audio mounted while /login renders as a separate page.
export default function ApplicationShell() {
  const login = useLocation().pathname.replace(/\/$/, "") === "/login";
  return (
    <>
      <div hidden={login}>
        <App active={!login} />
      </div>
      {login && <LoginPage />}
    </>
  );
}
